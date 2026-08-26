import "server-only";

import {
  connectSandbox,
  type ConnectOptions,
  type Sandbox,
  type SandboxState,
  type VercelState,
} from "@open-agents/sandbox";
import {
  getSessionById,
  updateSessionIfNotArchived,
  type SessionRecord,
} from "@/lib/db/sessions";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import {
  verifyRepoAccess,
  getRepoAccessErrorMessage,
} from "@/lib/github/access";
import {
  mintInstallationToken,
  revokeInstallationToken,
  type ScopedInstallationToken,
} from "@/lib/github/app";
import { getGitHubUserProfile } from "@/lib/github/users";
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
  getDefaultSandboxProvider,
  isSandboxProviderEnabled,
} from "@/lib/sandbox/provider-policy";
import {
  getResumableSandboxName,
  getSessionSandboxName,
  isSandboxActive,
} from "@/lib/sandbox/utils";
import { eq } from "drizzle-orm";

type UserRecord = {
  id: string;
  username: string;
  name: string | null;
  email: string | null;
};

export type ProvisionSessionSandboxResult = {
  sandboxState: SandboxState;
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
  didSetupWorkspace: boolean;
  session: SessionRecord;
};

export class SessionArchivedDuringProvisioningError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} was archived during sandbox provisioning`);
    this.name = "SessionArchivedDuringProvisioningError";
  }
}

function isSandboxState(value: unknown): value is SandboxState {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "vercel" || value.type === "e2b")
  );
}

async function getUserById(userId: string): Promise<UserRecord | null> {
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user ?? null;
}

function buildSandboxSource(session: SessionRecord): SandboxState["source"] {
  if (!session.cloneUrl) {
    return undefined;
  }

  const branchExistsOnOrigin = session.prNumber != null;
  const shouldCreateNewBranch = session.isNewBranch && !branchExistsOnOrigin;

  return {
    repo: session.cloneUrl,
    ...(shouldCreateNewBranch
      ? { newBranch: session.branch ?? undefined }
      : { branch: session.branch ?? "main" }),
  };
}

type VercelSandboxState = { type: "vercel" } & VercelState;

function isVercelSandboxState(
  state: SandboxState | null | undefined,
): state is VercelSandboxState {
  return state?.type === "vercel";
}

/**
 * Build the provider-specific sandbox state for a session. The persisted
 * `sandboxState.type` is the source of truth once a session exists; an explicit
 * requested type wins for brand-new sessions; otherwise the deployment default
 * applies. Vercel sessions keep their named persistent sandbox, E2B sessions
 * keep their E2B fields and never gain a Vercel sandboxName.
 */
export function buildSandboxState(params: {
  session: Pick<SessionRecord, "id" | "sandboxState">;
  sandboxType?: SandboxState["type"];
  source?: SandboxState["source"];
}): SandboxState {
  const existingState = params.session.sandboxState;
  const type =
    existingState?.type ?? params.sandboxType ?? getDefaultSandboxProvider();

  if (type === "e2b") {
    return {
      ...(existingState?.type === "e2b" ? existingState : { type: "e2b" }),
      ...(params.source ? { source: params.source } : {}),
    };
  }

  const sandboxName =
    getResumableSandboxName(existingState) ??
    getSessionSandboxName(params.session.id);

  return {
    ...(isVercelSandboxState(existingState)
      ? existingState
      : { type: "vercel" }),
    sandboxName,
    ...(params.source ? { source: params.source } : {}),
  };
}

/**
 * Build provider-specific connect options. Vercel keeps the named
 * persistent-sandbox behavior (resume/create-if-missing); E2B does not use
 * Vercel base snapshots, vCPU sizing, or named persistence options.
 */
export function buildSandboxConnectOptions(params: {
  sandboxType: SandboxState["type"];
  githubToken?: string;
  gitUser: { name: string; email: string };
  timeout: number;
  vcpus: number;
  ports: number[];
  baseSnapshotId?: string;
}): ConnectOptions {
  if (params.sandboxType === "e2b") {
    return {
      githubToken: params.githubToken,
      gitUser: params.gitUser,
      timeout: params.timeout,
      ports: params.ports,
    };
  }

  return {
    githubToken: params.githubToken,
    gitUser: params.gitUser,
    timeout: params.timeout,
    vcpus: params.vcpus,
    ports: params.ports,
    baseSnapshotId: params.baseSnapshotId,
    persistent: true,
    resume: true,
    createIfMissing: true,
  };
}

async function getGitUser(user: UserRecord) {
  const profile = await getGitHubUserProfile(user.id);
  const githubNoreplyEmail =
    profile?.externalUserId && profile.username
      ? `${profile.externalUserId}+${profile.username}@users.noreply.github.com`
      : undefined;

  return {
    name: user.name ?? profile?.username ?? user.username,
    email:
      githubNoreplyEmail ??
      user.email ??
      `${user.username}@users.noreply.github.com`,
  };
}

async function getSetupToken(params: {
  userId: string;
  session: SessionRecord;
}): Promise<ScopedInstallationToken | undefined> {
  if (!params.session.cloneUrl) {
    return undefined;
  }
  if (!params.session.repoOwner || !params.session.repoName) {
    throw new Error("Session is missing repository metadata");
  }

  const access = await verifyRepoAccess({
    userId: params.userId,
    owner: params.session.repoOwner,
    repo: params.session.repoName,
  });
  if (!access.ok) {
    throw new Error(getRepoAccessErrorMessage(access.reason));
  }

  return mintInstallationToken({
    installationId: access.installationId,
    repositoryIds: [access.repositoryId],
    permissions: { contents: "read" },
  });
}

async function stopSandboxAfterArchiveRace(params: {
  sessionId: string;
  sandbox: Awaited<ReturnType<typeof connectSandbox>>;
}): Promise<never> {
  try {
    await params.sandbox.stop();
  } catch (error) {
    console.error(
      `Failed to stop sandbox after session ${params.sessionId} was archived during provisioning:`,
      error,
    );
  }

  throw new SessionArchivedDuringProvisioningError(params.sessionId);
}

export async function provisionSessionSandbox(params: {
  sessionId: string;
  userId?: string;
}): Promise<ProvisionSessionSandboxResult> {
  const session = await getSessionById(params.sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  if (params.userId && session.userId !== params.userId) {
    throw new Error("Unauthorized");
  }
  if (session.status === "archived") {
    throw new Error("Session is archived");
  }

  const sandboxState = buildSandboxState({
    session,
    source: buildSandboxSource(session),
  });
  if (sandboxState.type === "e2b" && !isSandboxProviderEnabled("e2b")) {
    throw new Error(
      "The E2B sandbox provider is not enabled on this deployment",
    );
  }

  const didSetupWorkspace = !isSandboxActive(session.sandboxState);
  const user = await getUserById(session.userId);
  if (!user) {
    throw new Error("User not found");
  }

  const gitUser = await getGitUser(user);
  const setupToken = await getSetupToken({
    userId: session.userId,
    session,
  });

  let sandbox: Sandbox;
  try {
    sandbox = await connectSandbox({
      state: sandboxState,
      options: buildSandboxConnectOptions({
        sandboxType: sandboxState.type,
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

  const rawSandboxState = sandbox.getState?.();
  const provisionedSandboxState = isSandboxState(rawSandboxState)
    ? rawSandboxState
    : sandboxState;

  const updatedSession = await updateSessionIfNotArchived(params.sessionId, {
    sandboxState: provisionedSandboxState,
    snapshotUrl: null,
    snapshotCreatedAt: null,
    lifecycleVersion: getNextLifecycleVersion(session.lifecycleVersion),
    lifecycleError: null,
    ...buildActiveLifecycleUpdate(provisionedSandboxState),
  });

  if (!updatedSession) {
    await stopSandboxAfterArchiveRace({
      sessionId: params.sessionId,
      sandbox,
    });
  }

  kickSandboxLifecycleWorkflow({
    sessionId: params.sessionId,
    reason: "sandbox-created",
  });

  return {
    sandboxState: provisionedSandboxState,
    workingDirectory: sandbox.workingDirectory,
    currentBranch: sandbox.currentBranch,
    environmentDetails: sandbox.environmentDetails,
    didSetupWorkspace,
    session: updatedSession ?? session,
  };
}
