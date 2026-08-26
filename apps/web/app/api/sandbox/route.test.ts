import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  DEFAULT_SANDBOX_TIMEOUT_MS,
  DEFAULT_SANDBOX_VCPUS,
} from "@/lib/sandbox/config";

mock.module("server-only", () => ({}));

mock.module("botid/server", () => ({
  checkBotId: async () => ({ isBot: false }),
}));

interface TestSessionRecord {
  id: string;
  userId: string;
  lifecycleVersion: number;
  sandboxState: { type: "vercel" } | { type: "e2b" };
  vercelProjectId: string | null;
  vercelProjectName: string | null;
  vercelTeamId: string | null;
  globalSkillRefs: Array<{ source: string; skillName: string }>;
}

interface TestVercelAuthInfo {
  token: string;
  expiresAt: number;
  externalId: string;
}

interface KickCall {
  sessionId: string;
  reason: string;
}

interface ConnectConfig {
  state:
    | {
        type: "vercel";
        sandboxName?: string;
        source?: {
          repo?: string;
          branch?: string;
          newBranch?: string;
        };
      }
    | {
        type: "e2b";
        source?: {
          repo?: string;
          branch?: string;
          newBranch?: string;
        };
      };
  options?: {
    githubToken?: string;
    gitUser?: {
      email?: string;
    };
    persistent?: boolean;
    resume?: boolean;
    createIfMissing?: boolean;
    timeout?: number;
    vcpus?: number;
  };
}

const kickCalls: KickCall[] = [];
const updateCalls: Array<{
  sessionId: string;
  patch: Record<string, unknown>;
}> = [];
const connectConfigs: ConnectConfig[] = [];
const writeFileCalls: Array<{ path: string; content: string }> = [];
const dotenvSyncCalls: Array<Record<string, unknown>> = [];

let sessionRecord: TestSessionRecord;
let currentVercelAuthInfo: TestVercelAuthInfo | null;
let currentDotenvContent: string;
let currentDotenvError: Error | null;

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => ({
    user: {
      id: "user-1",
      username: "nico",
      name: "Nico",
      email: "nico@example.com",
    },
  }),
}));

mock.module("@/lib/github/users", () => ({
  getGitHubUserProfile: async () => ({
    externalUserId: "12345",
    username: "nico-gh",
  }),
}));

mock.module("@/lib/github/urls", () => ({
  parseGitHubHttpsUrl: (repoUrl: string) => {
    let parsed: URL;
    try {
      parsed = new URL(repoUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
      return null;
    }
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+?)(\.git)?$/);
    if (!match?.[1] || !match[2]) {
      return null;
    }
    return { owner: match[1], repo: match[2] };
  },
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
  revokeInstallationToken: async () => {},
}));

mock.module("@/lib/vercel/token", () => ({
  getUserVercelAuthInfo: async () => currentVercelAuthInfo,
  getUserVercelToken: async () => currentVercelAuthInfo?.token ?? null,
}));

mock.module("@/lib/vercel/projects", () => ({
  buildDevelopmentDotenvFromVercelProject: async (
    input: Record<string, unknown>,
  ) => {
    dotenvSyncCalls.push(input);
    if (currentDotenvError) {
      throw currentDotenvError;
    }
    return currentDotenvContent;
  },
}));

mock.module("@/lib/db/sessions", () => ({
  getChatsBySessionId: async () => [],
  getSessionById: async () => sessionRecord,
  updateSession: async (sessionId: string, patch: Record<string, unknown>) => {
    updateCalls.push({ sessionId, patch });
    return {
      ...sessionRecord,
      ...patch,
    };
  },
  updateSessionIfNotArchived: async (
    sessionId: string,
    patch: Record<string, unknown>,
  ) => {
    updateCalls.push({ sessionId, patch });
    return {
      ...sessionRecord,
      ...patch,
    };
  },
}));

mock.module("@/lib/sandbox/lifecycle-kick", () => ({
  kickSandboxLifecycleWorkflow: (input: KickCall) => {
    kickCalls.push(input);
  },
}));

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: async (config: ConnectConfig) => {
    connectConfigs.push(config);

    return {
      currentBranch: "main",
      workingDirectory: "/vercel/sandbox",
      getState: () =>
        config.state.type === "e2b"
          ? {
              type: "e2b" as const,
              sandboxId: "e2b-sandbox-1",
              repoPath: "/home/user/repo",
              currentBranch: "main",
              expiresAt: Date.now() + 120_000,
            }
          : {
              type: "vercel" as const,
              sandboxName: config.state.sandboxName ?? "session_session-1",
              expiresAt: Date.now() + 120_000,
            },
      exec: async () => {
        return {
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          truncated: false,
        };
      },
      writeFile: async (path: string, content: string) => {
        writeFileCalls.push({ path, content });
      },
      stop: async () => {},
    };
  },
}));

const routeModulePromise = import("./route");

describe("/api/sandbox lifecycle kicks", () => {
  beforeEach(() => {
    delete process.env.E2B_SANDBOX_ENABLED;
    delete process.env.E2B_API_KEY;
    kickCalls.length = 0;
    updateCalls.length = 0;
    connectConfigs.length = 0;
    writeFileCalls.length = 0;
    dotenvSyncCalls.length = 0;
    currentVercelAuthInfo = {
      token: "vercel-token",
      expiresAt: 1_700_000_000,
      externalId: "user_ext_1",
    };
    currentDotenvContent = 'API_KEY="secret"\n';
    currentDotenvError = null;
    sessionRecord = {
      id: "session-1",
      userId: "user-1",
      lifecycleVersion: 3,
      sandboxState: { type: "vercel" },
      vercelProjectId: "project-1",
      vercelProjectName: "open-agents-web",
      vercelTeamId: "team-1",
      globalSkillRefs: [],
    };
  });

  test("uses session_<sessionId> as the persistent sandbox name", async () => {
    const { POST } = await routeModulePromise;

    currentDotenvContent = "";
    sessionRecord.vercelProjectId = null;
    sessionRecord.vercelProjectName = null;
    sessionRecord.vercelTeamId = null;

    const request = new Request("http://localhost/api/sandbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        sandboxType: "vercel",
      }),
    });

    const response = await POST(request);

    expect(response.ok).toBe(true);
    expect(kickCalls).toEqual([
      {
        sessionId: "session-1",
        reason: "sandbox-created",
      },
    ]);
    expect(connectConfigs[0]).toMatchObject({
      state: {
        type: "vercel",
        sandboxName: "session_session-1",
      },
      options: {
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        vcpus: DEFAULT_SANDBOX_VCPUS,
        persistent: true,
        resume: true,
        createIfMissing: true,
      },
    });
    expect(dotenvSyncCalls).toHaveLength(0);
  });

  test("repo sandboxes use a setup-only installation token instead of embedding it", async () => {
    const { POST } = await routeModulePromise;

    sessionRecord.vercelProjectId = null;
    sessionRecord.vercelProjectName = null;
    sessionRecord.vercelTeamId = null;

    const response = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          repoUrl: "https://github.com/acme/private-repo",
          branch: "main",
          sandboxType: "vercel",
        }),
      }),
    );

    expect(response.ok).toBe(true);
    expect(connectConfigs[0]).toMatchObject({
      state: {
        type: "vercel",
        sandboxName: "session_session-1",
        source: {
          repo: "https://github.com/acme/private-repo",
          branch: "main",
        },
      },
      options: {
        githubToken: "installation-token-mock",
      },
    });
    expect(connectConfigs[0]?.state.source).not.toHaveProperty("token");
  });

  test("rejects repo URLs that only contain github.com in the path", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          repoUrl: "https://attacker.example/github.com/acme/private-repo",
          branch: "main",
          sandboxType: "vercel",
        }),
      }),
    );

    const payload = (await response.json()) as { error: string };
    expect(response.status).toBe(400);
    expect(payload.error).toBe("Invalid GitHub repository URL");
    expect(connectConfigs).toHaveLength(0);
  });

  test("new vercel sandbox does not sync linked Development env vars while code is commented out", async () => {
    const { POST } = await routeModulePromise;

    const request = new Request("http://localhost/api/sandbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        sandboxType: "vercel",
      }),
    });

    const response = await POST(request);

    expect(response.ok).toBe(true);
    expect(kickCalls).toEqual([
      {
        sessionId: "session-1",
        reason: "sandbox-created",
      },
    ]);
    expect(updateCalls.length).toBeGreaterThan(0);
    expect(connectConfigs[0]?.options?.gitUser?.email).toBe(
      "12345+nico-gh@users.noreply.github.com",
    );
    expect(dotenvSyncCalls).toHaveLength(0);
    expect(writeFileCalls).toEqual([]);

    const payload = (await response.json()) as {
      timeout: number;
      mode: string;
    };
    expect(payload.timeout).toBe(DEFAULT_SANDBOX_TIMEOUT_MS);
    expect(payload.mode).toBe("vercel");
  });

  test("commented-out env sync does not run during sandbox creation", async () => {
    const { POST } = await routeModulePromise;

    currentDotenvError = new Error("boom");

    const response = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          sandboxType: "vercel",
        }),
      }),
    );

    expect(response.ok).toBe(true);
    expect(kickCalls).toEqual([
      {
        sessionId: "session-1",
        reason: "sandbox-created",
      },
    ]);
    expect(dotenvSyncCalls).toHaveLength(0);
    expect(writeFileCalls).toEqual([]);
  });

  test("new sandboxes do not download global skills", async () => {
    const { POST } = await routeModulePromise;

    sessionRecord.globalSkillRefs = [
      { source: "vercel/ai", skillName: "ai-sdk" },
    ];

    const response = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          sandboxType: "vercel",
        }),
      }),
    );

    expect(response.ok).toBe(true);
  });

  test("rejects unsupported sandbox types", async () => {
    const { POST } = await routeModulePromise;

    const request = new Request("http://localhost/api/sandbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        sandboxType: "invalid",
      }),
    });

    const response = await POST(request);
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Invalid sandbox type");
    expect(connectConfigs).toHaveLength(0);
    expect(kickCalls).toHaveLength(0);
  });

  test("rejects E2B when the deployment does not enable it", async () => {
    const { POST } = await routeModulePromise;

    sessionRecord.sandboxState = { type: "e2b" };

    const response = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          sandboxType: "e2b",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "The E2B sandbox provider is not enabled on this deployment",
    });
    expect(connectConfigs).toHaveLength(0);
    expect(kickCalls).toHaveLength(0);
  });

  test("provisions an E2B sandbox when the deployment enables it", async () => {
    const originalFlag = process.env.E2B_SANDBOX_ENABLED;
    const originalKey = process.env.E2B_API_KEY;
    process.env.E2B_SANDBOX_ENABLED = "true";
    process.env.E2B_API_KEY = "e2b-test-key";

    try {
      const { POST } = await routeModulePromise;

      sessionRecord.sandboxState = { type: "e2b" };
      sessionRecord.vercelProjectId = null;
      sessionRecord.vercelProjectName = null;
      sessionRecord.vercelTeamId = null;

      const response = await POST(
        new Request("http://localhost/api/sandbox", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: "session-1",
            sandboxType: "e2b",
          }),
        }),
      );

      expect(response.ok).toBe(true);
      expect(connectConfigs[0]?.state).toMatchObject({ type: "e2b" });
      expect(connectConfigs[0]?.state).not.toHaveProperty("sandboxName");
      expect(connectConfigs[0]?.options).toMatchObject({
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
      });
      expect(connectConfigs[0]?.options).not.toHaveProperty("persistent");
      expect(connectConfigs[0]?.options).not.toHaveProperty("resume");
      expect(connectConfigs[0]?.options).not.toHaveProperty("createIfMissing");
      expect(connectConfigs[0]?.options).not.toHaveProperty("vcpus");
      expect(connectConfigs[0]?.options).not.toHaveProperty("baseSnapshotId");

      const payload = (await response.json()) as { mode: string };
      expect(payload.mode).toBe("e2b");
    } finally {
      if (originalFlag === undefined) {
        delete process.env.E2B_SANDBOX_ENABLED;
      } else {
        process.env.E2B_SANDBOX_ENABLED = originalFlag;
      }
      if (originalKey === undefined) {
        delete process.env.E2B_API_KEY;
      } else {
        process.env.E2B_API_KEY = originalKey;
      }
    }
  });

  test("rejects requesting a different provider than the persisted session type", async () => {
    const { POST } = await routeModulePromise;

    sessionRecord.sandboxState = { type: "e2b" };

    const response = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          sandboxType: "vercel",
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This session uses a different sandbox type",
    });
    expect(connectConfigs).toHaveLength(0);
  });
});
