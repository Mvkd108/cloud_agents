import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

interface TestSessionRecord {
  id: string;
  userId: string;
  status: "running" | "archived";
  sandboxState:
    | { type: "vercel" }
    | { type: "vercel"; sandboxName: string; expiresAt: number }
    | { type: "e2b" }
    | { type: "e2b"; sandboxId: string; expiresAt: number }
    | null;
  cloneUrl: string | null;
  repoOwner: string | null;
  repoName: string | null;
  branch: string | null;
  prNumber: number | null;
  isNewBranch: boolean;
  lifecycleVersion: number;
}

let sessionRecord: TestSessionRecord;
const connectConfigs: Array<{ state: unknown; options: unknown }> = [];
const updateCalls: Array<Record<string, unknown>> = [];
const kickCalls: Array<{ sessionId: string; reason: string }> = [];
const revokeCalls: string[] = [];

mock.module("@/lib/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: "user-1",
              username: "nico",
              name: "Nico",
              email: "nico@example.com",
            },
          ],
        }),
      }),
    }),
  },
}));

mock.module("@/lib/db/schema", () => ({
  users: {},
}));

mock.module("@/lib/github/users", () => ({
  getGitHubUserProfile: async () => ({
    externalUserId: "12345",
    username: "nico-gh",
  }),
}));

mock.module("@/lib/github/access", () => ({
  verifyRepoAccess: async () => ({
    ok: true,
    installationId: 999,
    repositoryId: 123,
    defaultBranch: "main",
  }),
  getRepoAccessErrorMessage: () => "Access denied",
}));

mock.module("@/lib/github/app", () => ({
  mintInstallationToken: async () => ({
    token: "installation-token-mock",
    expiresAt: null,
    installationId: 999,
    repositoryIds: [123],
    permissions: { contents: "read" },
  }),
  revokeInstallationToken: async (token: string) => {
    revokeCalls.push(token);
  },
}));

mock.module("@/lib/db/sessions", () => ({
  getChatsBySessionId: async () => [],
  getSessionById: async () => sessionRecord,
  updateSession: async (_sessionId: string, patch: Record<string, unknown>) => {
    updateCalls.push(patch);
    return { ...sessionRecord, ...patch };
  },
  updateSessionIfNotArchived: async (
    _sessionId: string,
    patch: Record<string, unknown>,
  ) => {
    updateCalls.push(patch);
    return { ...sessionRecord, ...patch };
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
  connectSandbox: async (config: unknown) => {
    const connectConfig = config as {
      state: { type: string; repoPath?: string };
      options?: unknown;
    };
    connectConfigs.push({
      state: connectConfig.state,
      options: connectConfig.options,
    });
    return {
      currentBranch: "main",
      workingDirectory: connectConfig.state.repoPath ?? "/vercel/sandbox",
      environmentDetails: "env details",
      getState: () =>
        connectConfig.state.type === "e2b"
          ? {
              type: "e2b",
              sandboxId: "e2b-sandbox-1",
              repoPath: "/home/user/repo",
              currentBranch: "main",
              expiresAt: Date.now() + 120_000,
            }
          : {
              type: "vercel",
              sandboxName: "session_session-1",
              expiresAt: Date.now() + 120_000,
            },
      stop: async () => {},
    };
  },
}));

const { provisionSessionSandbox } = await import("./provisioning");

function makeSessionRecord(
  overrides: Partial<TestSessionRecord> = {},
): TestSessionRecord {
  return {
    id: "session-1",
    userId: "user-1",
    status: "running",
    sandboxState: { type: "vercel" },
    cloneUrl: null,
    repoOwner: null,
    repoName: null,
    branch: null,
    prNumber: null,
    isNewBranch: false,
    lifecycleVersion: 2,
    ...overrides,
  };
}

beforeEach(() => {
  sessionRecord = makeSessionRecord();
  connectConfigs.length = 0;
  updateCalls.length = 0;
  kickCalls.length = 0;
  revokeCalls.length = 0;
  delete process.env.E2B_SANDBOX_ENABLED;
  delete process.env.E2B_API_KEY;
});

describe("provisionSessionSandbox", () => {
  test("keeps Vercel named persistent-sandbox provisioning", async () => {
    sessionRecord = makeSessionRecord({
      sandboxState: { type: "vercel" },
      cloneUrl: "https://github.com/acme/repo",
      repoOwner: "acme",
      repoName: "repo",
    });

    const result = await provisionSessionSandbox({ sessionId: "session-1" });

    expect(connectConfigs[0]?.state).toMatchObject({
      type: "vercel",
      sandboxName: "session_session-1",
      source: { repo: "https://github.com/acme/repo", branch: "main" },
    });
    expect(connectConfigs[0]?.options).toMatchObject({
      persistent: true,
      resume: true,
      createIfMissing: true,
    });
    expect(result.sandboxState).toMatchObject({ type: "vercel" });
  });

  test("rejects E2B provisioning when the deployment does not enable E2B", async () => {
    sessionRecord = makeSessionRecord({ sandboxState: { type: "e2b" } });

    await expect(
      provisionSessionSandbox({ sessionId: "session-1" }),
    ).rejects.toThrow(
      "The E2B sandbox provider is not enabled on this deployment",
    );
    expect(connectConfigs).toHaveLength(0);
    expect(kickCalls).toHaveLength(0);
  });

  test("provisions an E2B sandbox without Vercel-only options", async () => {
    process.env.E2B_SANDBOX_ENABLED = "true";
    process.env.E2B_API_KEY = "e2b-test-key";

    sessionRecord = makeSessionRecord({
      sandboxState: { type: "e2b" },
      cloneUrl: "https://github.com/acme/repo",
      repoOwner: "acme",
      repoName: "repo",
    });

    const result = await provisionSessionSandbox({ sessionId: "session-1" });

    expect(connectConfigs[0]?.state).toMatchObject({
      type: "e2b",
      source: { repo: "https://github.com/acme/repo", branch: "main" },
    });
    expect(connectConfigs[0]?.state).not.toHaveProperty("sandboxName");
    expect(connectConfigs[0]?.options).not.toHaveProperty("persistent");
    expect(connectConfigs[0]?.options).not.toHaveProperty("resume");
    expect(connectConfigs[0]?.options).not.toHaveProperty("createIfMissing");
    expect(connectConfigs[0]?.options).not.toHaveProperty("vcpus");
    expect(connectConfigs[0]?.options).not.toHaveProperty("baseSnapshotId");
    expect(connectConfigs[0]?.options).toMatchObject({
      githubToken: "installation-token-mock",
    });
    expect(result.sandboxState).toMatchObject({
      type: "e2b",
      sandboxId: "e2b-sandbox-1",
    });
    expect(revokeCalls).toEqual(["installation-token-mock"]);
    expect(kickCalls).toEqual([
      { sessionId: "session-1", reason: "sandbox-created" },
    ]);
  });

  test("reconnects a previously active E2B session state", async () => {
    process.env.E2B_SANDBOX_ENABLED = "true";
    process.env.E2B_API_KEY = "e2b-test-key";

    sessionRecord = makeSessionRecord({
      sandboxState: {
        type: "e2b",
        sandboxId: "e2b-sandbox-1",
        expiresAt: Date.now() + 60_000,
      },
      cloneUrl: null,
    });

    const result = await provisionSessionSandbox({ sessionId: "session-1" });

    expect(connectConfigs[0]?.state).toMatchObject({
      type: "e2b",
      sandboxId: "e2b-sandbox-1",
    });
    expect(result.didSetupWorkspace).toBe(false);
    expect(result.sandboxState).toMatchObject({
      type: "e2b",
      sandboxId: "e2b-sandbox-1",
    });
  });
});
