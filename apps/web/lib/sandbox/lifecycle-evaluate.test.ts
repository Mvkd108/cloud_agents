import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

interface TestSessionRecord {
  id: string;
  status: "running" | "completed" | "failed" | "archived";
  lifecycleState:
    | "provisioning"
    | "active"
    | "hibernating"
    | "hibernated"
    | "restoring"
    | "archived"
    | "failed";
  sandboxState:
    | {
        type: "vercel";
        sandboxName: string;
        expiresAt: number;
      }
    | {
        type: "e2b";
        sandboxId: string;
        repoPath?: string;
        expiresAt: number;
      };
  hibernateAfter: Date | null;
  lastActivityAt: Date | null;
  sandboxExpiresAt: Date | null;
  updatedAt: Date;
}

let sessionRecord: TestSessionRecord | null = null;
let chatsInSession: Array<{ id: string; activeStreamId: string | null }> = [];

const stopSpy = mock(async () => undefined);

const spies = {
  getChatsBySessionId: mock(
    async (_sessionId: string) => chatsInSession as never,
  ),
  getSessionById: mock(async (_sessionId: string) => sessionRecord as never),
  updateSession: mock(
    async (_sessionId: string, patch: Record<string, unknown>) => patch,
  ),
  connectSandbox: mock(async () => ({
    stop: stopSpy,
  })),
  stop: stopSpy,
};

mock.module("@/lib/db/sessions", () => ({
  getChatsBySessionId: spies.getChatsBySessionId,
  getSessionById: spies.getSessionById,
  updateSession: spies.updateSession,
}));

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: spies.connectSandbox,
  resolveSandboxProvider: (value: unknown) =>
    value === "e2b" ? "e2b" : "vercel",
}));

const { evaluateSandboxLifecycle } = await import("./lifecycle");

function makeDueSession(): TestSessionRecord {
  const nowMs = Date.now();

  return {
    id: "session-1",
    status: "running",
    lifecycleState: "active",
    sandboxState: {
      type: "vercel",
      sandboxName: "session_session-1",
      expiresAt: nowMs + 5 * 60_000,
    },
    hibernateAfter: new Date(nowMs - 1_000),
    lastActivityAt: new Date(nowMs - 60_000),
    sandboxExpiresAt: null,
    updatedAt: new Date(nowMs - 60_000),
  };
}

function makeDueE2BSession(): TestSessionRecord {
  const nowMs = Date.now();

  return {
    id: "session-1",
    status: "running",
    lifecycleState: "active",
    sandboxState: {
      type: "e2b",
      sandboxId: "e2b-sandbox-1",
      repoPath: "/home/user/repo",
      expiresAt: nowMs + 5 * 60_000,
    },
    hibernateAfter: new Date(nowMs - 1_000),
    lastActivityAt: new Date(nowMs - 60_000),
    sandboxExpiresAt: null,
    updatedAt: new Date(nowMs - 60_000),
  };
}

beforeEach(() => {
  sessionRecord = makeDueSession();
  chatsInSession = [];

  Object.values(spies).forEach((spy) => spy.mockClear());
});

describe("evaluateSandboxLifecycle", () => {
  test("skips hibernation whenever any chat still has an activeStreamId", async () => {
    chatsInSession = [{ id: "chat-1", activeStreamId: "wrun-running-1" }];

    const result = await evaluateSandboxLifecycle(
      "session-1",
      "status-check-overdue",
    );

    expect(result).toEqual({ action: "skipped", reason: "active-workflow" });
    expect(spies.connectSandbox).not.toHaveBeenCalled();
    expect(spies.updateSession).not.toHaveBeenCalled();
    expect(spies.stop).not.toHaveBeenCalled();
  });

  test("rechecks for activeStreamId before stopping and restores active lifecycle state", async () => {
    spies.connectSandbox.mockImplementationOnce(async () => {
      chatsInSession = [{ id: "chat-1", activeStreamId: "wrun-raced-in-1" }];
      return {
        stop: stopSpy,
      };
    });

    const result = await evaluateSandboxLifecycle(
      "session-1",
      "status-check-overdue",
    );

    expect(result).toEqual({ action: "skipped", reason: "active-workflow" });
    expect(spies.getChatsBySessionId).toHaveBeenCalledTimes(2);
    expect(spies.stop).not.toHaveBeenCalled();

    const updateCalls = spies.updateSession.mock.calls as unknown[][];
    const firstPatch = updateCalls[0]?.[1] as Record<string, unknown>;
    const finalPatch = updateCalls.at(-1)?.[1] as Record<string, unknown>;

    expect(firstPatch).toEqual({
      lifecycleState: "hibernating",
      lifecycleError: null,
    });
    expect(finalPatch.lifecycleState).toBe("active");
    expect(finalPatch.lifecycleError).toBeNull();
    expect(finalPatch.sandboxExpiresAt).toBeInstanceOf(Date);
    expect(finalPatch).not.toHaveProperty("lastActivityAt");
    expect(finalPatch).not.toHaveProperty("hibernateAfter");
  });

  test("skips hibernation when lifecycle timing is refreshed before stopping", async () => {
    spies.connectSandbox.mockImplementationOnce(async () => {
      if (!sessionRecord) {
        throw new Error("sessionRecord must be set");
      }

      const refreshedAt = new Date();
      sessionRecord = {
        ...sessionRecord,
        lastActivityAt: refreshedAt,
        hibernateAfter: new Date(refreshedAt.getTime() + 60_000),
      };

      return {
        stop: stopSpy,
      };
    });

    const result = await evaluateSandboxLifecycle(
      "session-1",
      "status-check-overdue",
    );

    expect(result).toEqual({ action: "skipped", reason: "not-due-yet" });
    expect(spies.stop).not.toHaveBeenCalled();

    const updateCalls = spies.updateSession.mock.calls as unknown[][];
    const firstPatch = updateCalls[0]?.[1] as Record<string, unknown>;
    const finalPatch = updateCalls.at(-1)?.[1] as Record<string, unknown>;

    expect(firstPatch).toEqual({
      lifecycleState: "hibernating",
      lifecycleError: null,
    });
    expect(finalPatch.lifecycleState).toBe("active");
    expect(finalPatch.lifecycleError).toBeNull();
    expect(finalPatch.sandboxExpiresAt).toBeInstanceOf(Date);
    expect(finalPatch).not.toHaveProperty("lastActivityAt");
    expect(finalPatch).not.toHaveProperty("hibernateAfter");
  });

  test("hibernates by stopping the persistent sandbox session", async () => {
    const result = await evaluateSandboxLifecycle(
      "session-1",
      "status-check-overdue",
    );

    expect(result).toEqual({ action: "hibernated" });
    expect(spies.connectSandbox).toHaveBeenCalledTimes(1);
    expect(spies.stop).toHaveBeenCalledTimes(1);

    const updateCalls = spies.updateSession.mock.calls as unknown[][];
    const firstPatch = updateCalls[0]?.[1] as Record<string, unknown>;
    const finalPatch = updateCalls.at(-1)?.[1] as Record<string, unknown>;

    expect(firstPatch.lifecycleState).toBe("hibernating");
    expect(finalPatch).toEqual(
      expect.objectContaining({
        lifecycleState: "hibernated",
        snapshotUrl: null,
        snapshotCreatedAt: null,
        sandboxState: {
          type: "vercel",
          sandboxName: "session_session-1",
        },
      }),
    );
  });

  test("hibernates an E2B session by pausing and preserving its sandboxId", async () => {
    sessionRecord = makeDueE2BSession();

    const result = await evaluateSandboxLifecycle(
      "session-1",
      "status-check-overdue",
    );

    expect(result).toEqual({ action: "hibernated" });
    expect(spies.connectSandbox).toHaveBeenCalledTimes(1);
    const connectCalls = spies.connectSandbox.mock.calls as unknown[][];
    expect(connectCalls[0]?.[0]).toEqual(
      expect.objectContaining({ type: "e2b" }),
    );
    expect(spies.stop).toHaveBeenCalledTimes(1);

    const updateCalls = spies.updateSession.mock.calls as unknown[][];
    const finalPatch = updateCalls.at(-1)?.[1] as Record<string, unknown>;

    expect(finalPatch).toEqual(
      expect.objectContaining({
        lifecycleState: "hibernated",
        snapshotUrl: null,
        snapshotCreatedAt: null,
        sandboxState: {
          type: "e2b",
          sandboxId: "e2b-sandbox-1",
        },
      }),
    );
  });

  test("skips E2B hibernation when a chat still has an active stream", async () => {
    sessionRecord = makeDueE2BSession();
    chatsInSession = [{ id: "chat-1", activeStreamId: "wrun-running-1" }];

    const result = await evaluateSandboxLifecycle(
      "session-1",
      "status-check-overdue",
    );

    expect(result).toEqual({ action: "skipped", reason: "active-workflow" });
    expect(spies.connectSandbox).not.toHaveBeenCalled();
    expect(spies.stop).not.toHaveBeenCalled();
  });
});
