import { connectSandbox } from "@open-agents/sandbox";
import {
  requireAuthenticatedUser,
  requireOwnedSession,
  requireOwnedSessionWithSandboxGuard,
  type SessionRecord,
} from "@/app/api/sessions/_lib/session-context";
import { updateSession } from "@/lib/db/sessions";
import {
  DEFAULT_SANDBOX_PORTS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  DEFAULT_SANDBOX_VCPUS,
} from "@/lib/sandbox/config";
import {
  buildActiveLifecycleUpdate,
  buildHibernatedLifecycleUpdate,
  getNextLifecycleVersion,
} from "@/lib/sandbox/lifecycle";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import { isSandboxProviderEnabled } from "@/lib/sandbox/provider-policy";
import {
  canOperateOnSandbox,
  clearSandboxResumeState,
  clearSandboxState,
  getResumableSandboxName,
  getSessionSandboxName,
  hasResumableSandboxState,
  hasRuntimeSandboxState,
  isSandboxNotFoundError,
} from "@/lib/sandbox/utils";

interface CreateSnapshotRequest {
  sessionId: string;
}

interface RestoreSnapshotRequest {
  sessionId: string;
}

async function resumeE2BSandbox(params: {
  sessionId: string;
  sessionRecord: SessionRecord;
  sandboxType: string;
}): Promise<Response> {
  const { sessionId, sessionRecord, sandboxType } = params;
  const resumeState = sessionRecord.sandboxState;

  if (!resumeState || !hasResumableSandboxState(resumeState)) {
    console.error(
      `[Snapshot Restore] session=${sessionId} error=no_resume_state sandboxType=${sandboxType}`,
    );
    return Response.json(
      { error: "No sandbox available for resume" },
      { status: 404 },
    );
  }

  try {
    const sandbox = await connectSandbox(resumeState);
    const restoredState = (sandbox.getState?.() ?? resumeState) as Parameters<
      typeof updateSession
    >[1]["sandboxState"];

    await updateSession(sessionId, {
      sandboxState: restoredState,
      snapshotUrl: null,
      snapshotCreatedAt: null,
      lifecycleVersion: getNextLifecycleVersion(sessionRecord.lifecycleVersion),
      ...buildActiveLifecycleUpdate(restoredState),
    });

    kickSandboxLifecycleWorkflow({
      sessionId,
      reason: "snapshot-restored",
    });

    console.log(
      `[Snapshot Restore] session=${sessionId} success=true sandboxType=${sandboxType} sandboxId=${resumeState.sandboxId}`,
    );

    return Response.json({
      success: true,
      restoredFrom: resumeState.sandboxId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (isSandboxNotFoundError(message)) {
      await updateSession(sessionId, {
        sandboxState: clearSandboxResumeState(resumeState),
        ...buildHibernatedLifecycleUpdate(),
      });
      console.error(
        `[Snapshot Restore] session=${sessionId} success=false error=${message}`,
      );
      return Response.json(
        {
          error: "Saved sandbox is no longer available. Create a new sandbox.",
        },
        { status: 404 },
      );
    }

    console.error(
      `[Snapshot Restore] session=${sessionId} success=false error=${message}`,
    );
    return Response.json(
      { error: `Failed to resume sandbox: ${message}` },
      { status: 500 },
    );
  }
}

/**
 * POST - Compatibility pause endpoint.
 * Stops the current persistent sandbox session and preserves resumability via sandboxName.
 */
export async function POST(req: Request) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  let body: CreateSnapshotRequest;
  try {
    body = (await req.json()) as CreateSnapshotRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId } = body;

  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const sessionContext = await requireOwnedSessionWithSandboxGuard({
    userId: authResult.userId,
    sessionId,
    sandboxGuard: canOperateOnSandbox,
    sandboxErrorMessage: "Sandbox not initialized",
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;
  const sandboxState = sessionRecord.sandboxState;
  if (!sandboxState) {
    return Response.json({ error: "Sandbox not initialized" }, { status: 400 });
  }

  try {
    const sandbox = await connectSandbox(sandboxState);
    await sandbox.stop();

    const clearedState = clearSandboxState(sessionRecord.sandboxState);
    await updateSession(sessionId, {
      snapshotUrl: null,
      snapshotCreatedAt: null,
      sandboxState: clearedState,
      lifecycleVersion: getNextLifecycleVersion(sessionRecord.lifecycleVersion),
      ...buildHibernatedLifecycleUpdate(),
    });

    return Response.json({
      snapshotId:
        getResumableSandboxName(clearedState) ??
        sessionRecord.snapshotUrl ??
        null,
      createdAt: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: `Failed to pause sandbox: ${message}` },
      { status: 500 },
    );
  }
}

/**
 * PUT - Compatibility resume endpoint.
 * Resumes a named persistent sandbox, or lazily migrates a legacy snapshot-backed session.
 */
export async function PUT(req: Request) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  let body: RestoreSnapshotRequest;
  try {
    body = (await req.json()) as RestoreSnapshotRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId } = body;

  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const sessionContext = await requireOwnedSession({
    userId: authResult.userId,
    sessionId,
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;
  const sandboxType = sessionRecord.sandboxState?.type ?? "vercel";

  if (hasRuntimeSandboxState(sessionRecord.sandboxState)) {
    const restoredFrom =
      getResumableSandboxName(sessionRecord.sandboxState) ??
      sessionRecord.snapshotUrl ??
      undefined;
    console.log(
      `[Snapshot Restore] session=${sessionId} already_running=true sandboxType=${sandboxType}`,
    );
    return Response.json({
      success: true,
      alreadyRunning: true,
      restoredFrom,
    });
  }

  // E2B pause/resume parity: a paused E2B sandbox is resumed through its
  // persisted sandboxId. Vercel-native snapshot restore (legacy snapshot URLs)
  // remains unavailable for E2B sessions.
  if (sandboxType === "e2b") {
    if (!isSandboxProviderEnabled("e2b")) {
      return Response.json(
        {
          error: "The E2B sandbox provider is not enabled on this deployment",
        },
        { status: 503 },
      );
    }
    return resumeE2BSandbox({
      sessionId,
      sessionRecord,
      sandboxType,
    });
  }

  const persistentSandboxName = getResumableSandboxName(
    sessionRecord.sandboxState,
  );
  const legacySnapshotId = sessionRecord.snapshotUrl;

  if (!persistentSandboxName && !legacySnapshotId) {
    console.error(
      `[Snapshot Restore] session=${sessionId} error=no_resume_state sandboxType=${sandboxType}`,
    );
    return Response.json(
      { error: "No sandbox available for resume" },
      { status: 404 },
    );
  }

  const restoreLegacySnapshot = () =>
    connectSandbox(
      {
        type: sandboxType,
        sandboxName: getSessionSandboxName(sessionId),
        snapshotId: legacySnapshotId ?? undefined,
      },
      {
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        vcpus: DEFAULT_SANDBOX_VCPUS,
        ports: DEFAULT_SANDBOX_PORTS,
        resume: true,
        createIfMissing: true,
        persistent: true,
      },
    );

  try {
    let restoredFrom = legacySnapshotId ?? persistentSandboxName;

    const sandbox = persistentSandboxName
      ? await (async () => {
          try {
            restoredFrom = persistentSandboxName;
            return await connectSandbox(
              { type: sandboxType, sandboxName: persistentSandboxName },
              {
                timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
                vcpus: DEFAULT_SANDBOX_VCPUS,
                ports: DEFAULT_SANDBOX_PORTS,
                resume: true,
              },
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (!legacySnapshotId || !isSandboxNotFoundError(message)) {
              throw error;
            }

            restoredFrom = legacySnapshotId;
            return restoreLegacySnapshot();
          }
        })()
      : await restoreLegacySnapshot();

    const newState = sandbox.getState?.();
    const restoredState = (newState ?? {
      type: sandboxType,
      sandboxName: persistentSandboxName ?? getSessionSandboxName(sessionId),
    }) as Parameters<typeof updateSession>[1]["sandboxState"];

    await updateSession(sessionId, {
      sandboxState: restoredState,
      snapshotUrl: null,
      snapshotCreatedAt: null,
      lifecycleVersion: getNextLifecycleVersion(sessionRecord.lifecycleVersion),
      ...buildActiveLifecycleUpdate(restoredState),
    });

    kickSandboxLifecycleWorkflow({
      sessionId,
      reason: "snapshot-restored",
    });

    const restoredSandboxName =
      getResumableSandboxName(restoredState) ?? "unknown";
    const restoredFromLabel = restoredFrom ?? "unknown";
    console.log(
      `[Snapshot Restore] session=${sessionId} success=true sandboxType=${sandboxType} sandboxName=${restoredSandboxName} restoredFrom=${restoredFromLabel}`,
    );

    return Response.json({
      success: true,
      restoredFrom,
      sandboxId: "id" in sandbox ? sandbox.id : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (
      persistentSandboxName &&
      !legacySnapshotId &&
      isSandboxNotFoundError(message)
    ) {
      await updateSession(sessionId, {
        sandboxState: clearSandboxResumeState(sessionRecord.sandboxState),
        ...buildHibernatedLifecycleUpdate(),
      });
      console.error(
        `[Snapshot Restore] session=${sessionId} success=false error=${message}`,
      );
      return Response.json(
        {
          error: "Saved sandbox is no longer available. Create a new sandbox.",
        },
        { status: 404 },
      );
    }

    console.error(
      `[Snapshot Restore] session=${sessionId} success=false error=${message}`,
    );
    return Response.json(
      { error: `Failed to restore snapshot: ${message}` },
      { status: 500 },
    );
  }
}
