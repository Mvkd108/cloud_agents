import { connectSandbox, type SandboxState } from "@open-agents/sandbox";
import {
  requireAuthenticatedUser,
  requireOwnedSession,
  type SessionRecord,
} from "@/app/api/sessions/_lib/session-context";
import { checkBotProtection } from "@/lib/botid";
import { getGitHubUserProfile } from "@/lib/github/users";
import { updateSession } from "@/lib/db/sessions";
import { parseGitHubHttpsUrl } from "@/lib/github/urls";
import {
  verifyRepoAccess,
  getRepoAccessErrorMessage,
} from "@/lib/github/access";
import {
  mintInstallationToken,
  revokeInstallationToken,
  type ScopedInstallationToken,
} from "@/lib/github/app";
import {
  DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
  DEFAULT_SANDBOX_PORTS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  DEFAULT_SANDBOX_VCPUS,
} from "@/lib/sandbox/config";
import {
  buildActiveLifecycleUpdate,
  getNextLifecycleVersion,
} from "@/lib/sandbox/lifecycle";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import {
  buildSandboxConnectOptions,
  buildSandboxState,
} from "@/lib/sandbox/provisioning";
import {
  getDefaultSandboxProvider,
  isSandboxProviderEnabled,
} from "@/lib/sandbox/provider-policy";
import {
  canOperateOnSandbox,
  clearSandboxState,
  hasResumableSandboxState,
} from "@/lib/sandbox/utils";
import type { SandboxType } from "@/components/sandbox-selector-compact";
import { getServerSession } from "@/lib/session/get-server-session";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
// import { buildDevelopmentDotenvFromVercelProject } from "@/lib/vercel/projects";
// import { getUserVercelToken } from "@/lib/vercel/token";

interface CreateSandboxRequest {
  repoUrl?: string;
  branch?: string;
  isNewBranch?: boolean;
  sessionId?: string;
  sandboxType?: SandboxType;
}

// async function syncVercelProjectEnvVarsToSandbox(params: {
//   userId: string;
//   sessionRecord: SessionRecord;
//   sandbox: Awaited<ReturnType<typeof connectSandbox>>;
// }): Promise<void> {
//   if (!params.sessionRecord.vercelProjectId) {
//     return;
//   }
//
//   const token = await getUserVercelToken(params.userId);
//   if (!token) {
//     return;
//   }
//
//   const dotenvContent = await buildDevelopmentDotenvFromVercelProject({
//     token,
//     projectIdOrName: params.sessionRecord.vercelProjectId,
//     teamId: params.sessionRecord.vercelTeamId,
//   });
//   if (!dotenvContent) {
//     return;
//   }
//
//   await params.sandbox.writeFile(
//     `${params.sandbox.workingDirectory}/.env.local`,
//     dotenvContent,
//     "utf-8",
//   );
// }

export async function POST(req: Request) {
  let body: CreateSandboxRequest;
  try {
    body = (await req.json()) as CreateSandboxRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    body.sandboxType !== undefined &&
    body.sandboxType !== "vercel" &&
    body.sandboxType !== "e2b"
  ) {
    return Response.json({ error: "Invalid sandbox type" }, { status: 400 });
  }

  const { repoUrl, branch = "main", isNewBranch = false, sessionId } = body;

  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  // Get session for auth
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const botVerification = await checkBotProtection();
  if (botVerification.isBot) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const limited = await checkRateLimit({
    key: rateLimitKey(["sandbox-create", session.user.id]),
    limit: 20,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  // Validate session ownership before minting any short-lived setup tokens.
  let sessionRecord: SessionRecord | undefined;
  const sessionContext = await requireOwnedSession({
    userId: session.user.id,
    sessionId,
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  sessionRecord = sessionContext.sessionRecord;

  const persistedType = sessionRecord.sandboxState?.type;
  if (persistedType && body.sandboxType && persistedType !== body.sandboxType) {
    return Response.json(
      { error: "This session uses a different sandbox type" },
      { status: 409 },
    );
  }

  const sandboxType: SandboxState["type"] =
    persistedType ?? body.sandboxType ?? getDefaultSandboxProvider();

  if (sandboxType === "e2b" && !isSandboxProviderEnabled("e2b")) {
    return Response.json(
      { error: "The E2B sandbox provider is not enabled on this deployment" },
      { status: 400 },
    );
  }

  const source = repoUrl
    ? {
        repo: repoUrl,
        branch: isNewBranch ? undefined : branch,
        newBranch: isNewBranch ? branch : undefined,
      }
    : undefined;

  // verify repo access (user permissions ∩ installation scope) and get
  // a repo-scoped read token for clone/setup when a repo is provided
  let setupToken: ScopedInstallationToken | undefined;

  if (repoUrl) {
    const parsedRepo = parseGitHubHttpsUrl(repoUrl);
    if (!parsedRepo) {
      return Response.json(
        { error: "Invalid GitHub repository URL" },
        { status: 400 },
      );
    }

    const access = await verifyRepoAccess({
      userId: session.user.id,
      owner: parsedRepo.owner,
      repo: parsedRepo.repo,
    });

    if (!access.ok) {
      return Response.json(
        { error: getRepoAccessErrorMessage(access.reason) },
        { status: 403 },
      );
    }

    setupToken = await mintInstallationToken({
      installationId: access.installationId,
      repositoryIds: [access.repositoryId],
      permissions: { contents: "read" },
    });
  }

  // ============================================
  // CREATE OR RESUME: Create a named persistent sandbox for this session.
  // ============================================
  const startTime = Date.now();

  let sandbox: Awaited<ReturnType<typeof connectSandbox>>;
  try {
    const ghProfile = await getGitHubUserProfile(session.user.id);
    const githubNoreplyEmail =
      ghProfile?.externalUserId && ghProfile.username
        ? `${ghProfile.externalUserId}+${ghProfile.username}@users.noreply.github.com`
        : undefined;

    const gitUser = {
      name: session.user.name ?? ghProfile?.username ?? session.user.username,
      email:
        githubNoreplyEmail ??
        session.user.email ??
        `${session.user.username}@users.noreply.github.com`,
    };

    sandbox = await connectSandbox({
      state: buildSandboxState({
        session: sessionRecord,
        sandboxType,
        source,
      }),
      options: buildSandboxConnectOptions({
        sandboxType,
        githubToken: setupToken?.token,
        gitUser,
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        vcpus: DEFAULT_SANDBOX_VCPUS,
        ports: DEFAULT_SANDBOX_PORTS,
        baseSnapshotId: DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
      }),
    });
  } finally {
    if (setupToken) {
      await revokeInstallationToken(setupToken.token);
    }
  }

  let persistedSandboxType: SandboxState["type"] = sandboxType;
  if (sessionId && sandbox.getState) {
    const nextState = sandbox.getState() as SandboxState;
    persistedSandboxType = nextState.type;
    await updateSession(sessionId, {
      sandboxState: nextState,
      snapshotUrl: null,
      snapshotCreatedAt: null,
      lifecycleVersion: getNextLifecycleVersion(
        sessionRecord?.lifecycleVersion,
      ),
      ...buildActiveLifecycleUpdate(nextState),
    });

    kickSandboxLifecycleWorkflow({
      sessionId,
      reason: "sandbox-created",
    });
  }

  const readyMs = Date.now() - startTime;

  return Response.json({
    createdAt: Date.now(),
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    currentBranch: repoUrl ? branch : undefined,
    mode: persistedSandboxType,
    timing: { readyMs },
  });
}

export async function DELETE(req: Request) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const botVerification = await checkBotProtection();
  if (botVerification.isBot) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const limited = await checkRateLimit({
    key: rateLimitKey(["sandbox-delete", authResult.userId]),
    limit: 10,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("sessionId" in body) ||
    typeof (body as Record<string, unknown>).sessionId !== "string"
  ) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const { sessionId } = body as { sessionId: string };

  const sessionContext = await requireOwnedSession({
    userId: authResult.userId,
    sessionId,
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;

  // If there's no sandbox to stop, return success (idempotent)
  if (!canOperateOnSandbox(sessionRecord.sandboxState)) {
    return Response.json({ success: true, alreadyStopped: true });
  }

  // Connect and stop using unified API
  const sandbox = await connectSandbox(sessionRecord.sandboxState);
  await sandbox.stop();

  const clearedState = clearSandboxState(sessionRecord.sandboxState);
  await updateSession(sessionId, {
    sandboxState: clearedState,
    snapshotUrl: null,
    snapshotCreatedAt: null,
    lifecycleState:
      hasResumableSandboxState(clearedState) || !!sessionRecord.snapshotUrl
        ? "hibernated"
        : "provisioning",
    sandboxExpiresAt: null,
    hibernateAfter: null,
    lifecycleRunId: null,
    lifecycleError: null,
  });

  return Response.json({ success: true });
}
