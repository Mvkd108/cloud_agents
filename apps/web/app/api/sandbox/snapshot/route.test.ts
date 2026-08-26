import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

type TestSandboxState =
  | {
      type: "vercel";
      sandboxName?: string;
      expiresAt?: number;
    }
  | {
      type: "e2b";
      sandboxId?: string;
      expiresAt?: number;
    };

type TestSessionRecord = {
  id: string;
  userId: string;
  sandboxState: TestSandboxState | null;
  snapshotUrl: string | null;
  snapshotCreatedAt: Date | null;
  lifecycleVersion: number;
  lifecycleState: string | null;
  sandboxExpiresAt: Date | null;
  hibernateAfter: Date | null;
  lastActivityAt: Date | null;
};

const connectCalls: Array<{
  state: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}> = [];
const updateCalls: Array<Record<string, unknown>> = [];
const kickCalls: Array<{ sessionId: string; reason: string }> = [];

let stopCallCount = 0;
let connectSandboxResumeError: Error | null = null;
let sessionRecord: TestSessionRecord;
const originalE2BFlag = process.env.E2B_SANDBOX_ENABLED;
const originalE2BApiKey = process.env.E2B_API_KEY;

mock.module("@/app/api/sessions/_lib/session-context", () => ({
  requireAuthenticatedUser: async () => ({
    ok: true as const,
    userId: "user-1",
  }),
  requireOwnedSession: async () => ({ ok: true as const, sessionRecord }),
  requireOwnedSessionWithSandboxGuard: async ({
    sandboxGuard,
  }: {
    sandboxGuard: (state: TestSandboxState | null) => boolean;
  }) =>
    sandboxGuard(sessionRecord.sandboxState)
      ? ({ ok: true as const, sessionRecord } as const)
      : ({
          ok: false as const,
          response: Response.json(
            { error: "Sandbox not initialized" },
            { status: 400 },
          ),
        } as const),
}));

mock.module("@/lib/db/sessions", () => ({
  getChatsBySessionId: async () => [],
  getSessionById: async () => sessionRecord,
  updateSession: async (_sessionId: string, patch: Record<string, unknown>) => {
    updateCalls.push(patch);
    sessionRecord = {
      ...sessionRecord,
      ...(patch as Partial<TestSessionRecord>),
    };
    return sessionRecord;
  },
}));

mock.module("@/lib/sandbox/lifecycle-kick", () => ({
  kickSandboxLifecycleWorkflow: (input: {
    sessionId: string;
    reason: string;
  }) => {
    kickCalls.push(input);
  },
}));

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: async (
    state: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => {
    connectCalls.push({ state, options });

    if (
      connectSandboxResumeError &&
      options?.resume === true &&
      typeof state.sandboxName === "string" &&
      state.snapshotId === undefined
    ) {
      throw connectSandboxResumeError;
    }

    const sandboxName =
      typeof state.sandboxName === "string"
        ? state.sandboxName
        : "session_session-1";
    return {
      id: "runtime-1",
      expiresAt: Date.now() + 120_000,
      workingDirectory: "/vercel/sandbox",
      stop: async () => {
        stopCallCount += 1;
      },
      getState: () =>
        state.type === "e2b"
          ? {
              type: "e2b" as const,
              sandboxId: "e2b-sandbox-1",
              repoPath: "/home/user/repo",
              expiresAt: Date.now() + 120_000,
            }
          : {
              type: "vercel" as const,
              sandboxName,
              expiresAt: Date.now() + 120_000,
            },
    };
  },
}));

const routeModulePromise = import("./route");

function makeSessionRecord(
  overrides: Partial<TestSessionRecord> = {},
): TestSessionRecord {
  return {
    id: "session-1",
    userId: "user-1",
    sandboxState: {
      type: "vercel",
      sandboxName: "session_session-1",
      expiresAt: Date.now() + 60_000,
    },
    snapshotUrl: null,
    snapshotCreatedAt: null,
    lifecycleVersion: 2,
    lifecycleState: "active",
    sandboxExpiresAt: new Date(Date.now() + 60_000),
    hibernateAfter: new Date(Date.now() + 30_000),
    lastActivityAt: new Date(),
    ...overrides,
  };
}

describe("/api/sandbox/snapshot", () => {
  beforeEach(() => {
    connectCalls.length = 0;
    updateCalls.length = 0;
    kickCalls.length = 0;
    stopCallCount = 0;
    connectSandboxResumeError = null;
    sessionRecord = makeSessionRecord();
    delete process.env.E2B_SANDBOX_ENABLED;
    delete process.env.E2B_API_KEY;
  });

  afterEach(() => {
    if (originalE2BFlag === undefined) {
      delete process.env.E2B_SANDBOX_ENABLED;
    } else {
      process.env.E2B_SANDBOX_ENABLED = originalE2BFlag;
    }
    if (originalE2BApiKey === undefined) {
      delete process.env.E2B_API_KEY;
    } else {
      process.env.E2B_API_KEY = originalE2BApiKey;
    }
  });

  test("POST pauses a named persistent sandbox without writing a legacy snapshot", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      new Request("http://localhost/api/sandbox/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1" }),
      }),
    );
    const payload = (await response.json()) as {
      snapshotId: string | null;
    };

    expect(response.ok).toBe(true);
    expect(stopCallCount).toBe(1);
    expect(payload.snapshotId).toBe("session_session-1");
    expect(connectCalls[0]).toMatchObject({
      state: {
        type: "vercel",
        sandboxName: "session_session-1",
      },
    });
    expect(updateCalls[0]).toEqual(
      expect.objectContaining({
        snapshotUrl: null,
        snapshotCreatedAt: null,
        sandboxState: {
          type: "vercel",
          sandboxName: "session_session-1",
        },
        lifecycleVersion: 3,
        lifecycleState: "hibernated",
      }),
    );
  });

  test("PUT resumes an existing named persistent sandbox", async () => {
    const { PUT } = await routeModulePromise;

    sessionRecord = makeSessionRecord({
      sandboxState: {
        type: "vercel",
        sandboxName: "session_session-1",
      },
      lifecycleState: "hibernated",
      sandboxExpiresAt: null,
      hibernateAfter: null,
    });

    const response = await PUT(
      new Request("http://localhost/api/sandbox/snapshot", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1" }),
      }),
    );

    expect(response.ok).toBe(true);
    expect(connectCalls[0]).toMatchObject({
      state: {
        type: "vercel",
        sandboxName: "session_session-1",
      },
      options: {
        resume: true,
      },
    });
    expect(updateCalls[0]).toEqual(
      expect.objectContaining({
        sandboxState: expect.objectContaining({
          type: "vercel",
          sandboxName: "session_session-1",
        }),
        snapshotUrl: null,
        snapshotCreatedAt: null,
        lifecycleVersion: 3,
      }),
    );
    expect(kickCalls).toEqual([
      { sessionId: "session-1", reason: "snapshot-restored" },
    ]);
  });

  test("PUT clears a broken persistent sandbox handle after a 404", async () => {
    const { PUT } = await routeModulePromise;

    sessionRecord = makeSessionRecord({
      sandboxState: {
        type: "vercel",
        sandboxName: "session_session-1",
      },
      snapshotUrl: null,
      lifecycleState: "hibernated",
      sandboxExpiresAt: null,
      hibernateAfter: null,
    });
    connectSandboxResumeError = new Error("Status code 404 is not ok");

    const response = await PUT(
      new Request("http://localhost/api/sandbox/snapshot", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1" }),
      }),
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(payload.error).toContain("Saved sandbox is no longer available");
    expect(updateCalls[0]).toEqual(
      expect.objectContaining({
        sandboxState: {
          type: "vercel",
        },
        lifecycleState: "hibernated",
      }),
    );
  });

  test("PUT rejects E2B resume when the provider is unavailable", async () => {
    const { PUT } = await routeModulePromise;

    sessionRecord = makeSessionRecord({
      sandboxState: {
        type: "e2b",
        sandboxId: "e2b-sandbox-1",
      },
      lifecycleState: "hibernated",
      sandboxExpiresAt: null,
      hibernateAfter: null,
    });

    const response = await PUT(
      new Request("http://localhost/api/sandbox/snapshot", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1" }),
      }),
    );

    expect(response.status).toBe(503);
    expect(connectCalls).toHaveLength(0);
  });

  test("PUT resumes a paused E2B sandbox through its sandboxId", async () => {
    const { PUT } = await routeModulePromise;
    process.env.E2B_SANDBOX_ENABLED = "true";
    process.env.E2B_API_KEY = "e2b-test-key";

    sessionRecord = makeSessionRecord({
      sandboxState: {
        type: "e2b",
        sandboxId: "e2b-sandbox-1",
      },
      lifecycleState: "hibernated",
      sandboxExpiresAt: null,
      hibernateAfter: null,
    });

    const response = await PUT(
      new Request("http://localhost/api/sandbox/snapshot", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1" }),
      }),
    );
    const payload = (await response.json()) as {
      success?: boolean;
      restoredFrom?: string;
    };

    expect(response.ok).toBe(true);
    expect(payload.success).toBe(true);
    expect(payload.restoredFrom).toBe("e2b-sandbox-1");
    expect(connectCalls[0]).toMatchObject({
      state: {
        type: "e2b",
        sandboxId: "e2b-sandbox-1",
      },
    });
    expect(updateCalls[0]).toEqual(
      expect.objectContaining({
        sandboxState: expect.objectContaining({
          type: "e2b",
          sandboxId: "e2b-sandbox-1",
        }),
        snapshotUrl: null,
        snapshotCreatedAt: null,
        lifecycleVersion: 3,
      }),
    );
    expect(kickCalls).toEqual([
      { sessionId: "session-1", reason: "snapshot-restored" },
    ]);
  });

  test("PUT lazily migrates a legacy snapshot-backed session on first resume", async () => {
    const { PUT } = await routeModulePromise;

    sessionRecord = makeSessionRecord({
      sandboxState: { type: "vercel" },
      snapshotUrl: "snap-legacy-1",
      lifecycleState: "hibernated",
      sandboxExpiresAt: null,
      hibernateAfter: null,
    });

    const response = await PUT(
      new Request("http://localhost/api/sandbox/snapshot", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1" }),
      }),
    );

    expect(response.ok).toBe(true);
    expect(connectCalls[0]).toMatchObject({
      state: {
        type: "vercel",
        sandboxName: "session_session-1",
        snapshotId: "snap-legacy-1",
      },
      options: {
        resume: true,
        createIfMissing: true,
        persistent: true,
      },
    });
    expect(updateCalls[0]).toEqual(
      expect.objectContaining({
        sandboxState: expect.objectContaining({
          type: "vercel",
          sandboxName: "session_session-1",
        }),
        snapshotUrl: null,
        snapshotCreatedAt: null,
        lifecycleVersion: 3,
      }),
    );
    expect(kickCalls).toEqual([
      { sessionId: "session-1", reason: "snapshot-restored" },
    ]);
  });
});
