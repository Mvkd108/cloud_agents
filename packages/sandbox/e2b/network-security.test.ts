import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  buildE2BGitHubCredentialBrokeringPolicy,
  buildE2BGitHubSetupPolicy,
  E2B_DENY_ALL_NETWORK_UPDATE,
} from "./network-policy";

type MockRunCommandResult = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  pid?: number;
};

type MockRunCommandParams = {
  command?: string;
  cwd?: string;
  background?: boolean;
  envs?: Record<string, string>;
  timeoutMs?: number;
};

const updateNetworkCalls: unknown[] = [];
const setTimeoutCalls: number[] = [];
const runCommandCalls: MockRunCommandParams[] = [];
const commandResults = new Map<string, MockRunCommandResult>();
const existingFiles = new Set<string>();
let failRunCommand: Error | null = null;
let runCommandHook:
  | ((command: string, params?: MockRunCommandParams) => Promise<void>)
  | undefined;

function createMockSdk() {
  return {
    sandboxId: "sbx-1",
    getHost: (port: number) => `host-${port}.e2b.app`,
    updateNetwork: async (policy: unknown) => {
      updateNetworkCalls.push(policy);
    },
    setTimeout: async (timeoutMs: number) => {
      setTimeoutCalls.push(timeoutMs);
    },
    isRunning: async () => true,
    kill: async () => true,
    pause: async () => true,
    createSnapshot: async () => ({ snapshotId: "snap-1" }),
    files: {
      read: async () => "file",
      write: async () => undefined,
      list: async () => [],
      getInfo: async (path: string) => ({ path, type: "file", size: 3 }),
      exists: async (path: string) => existingFiles.has(path),
      makeDir: async () => true,
    },
    commands: {
      run: async (command: string, params?: MockRunCommandParams) => {
        runCommandCalls.push({ ...params, command });
        await runCommandHook?.(command, params);
        if (failRunCommand) {
          throw failRunCommand;
        }
        return (
          commandResults.get(command) ?? { exitCode: 0, stdout: "", stderr: "" }
        );
      },
    },
    git: {
      clone: async () => undefined,
      configureUser: async () => undefined,
    },
  };
}

const createCalls: Array<{
  template: unknown;
  options: Record<string, unknown>;
}> = [];
const connectCalls: Array<{
  sandboxId: string;
  options: Record<string, unknown>;
}> = [];

mock.module("e2b", () => ({
  Sandbox: {
    create: async (template: unknown, options: Record<string, unknown>) => {
      createCalls.push({ template, options });
      return createMockSdk();
    },
    connect: async (sandboxId: string, options: Record<string, unknown>) => {
      connectCalls.push({ sandboxId, options });
      return createMockSdk();
    },
  },
}));

let sandboxModule: typeof import("./sandbox");

beforeAll(async () => {
  sandboxModule = await import("./sandbox");
});

beforeEach(() => {
  updateNetworkCalls.length = 0;
  setTimeoutCalls.length = 0;
  runCommandCalls.length = 0;
  createCalls.length = 0;
  connectCalls.length = 0;
  commandResults.clear();
  existingFiles.clear();
  failRunCommand = null;
  runCommandHook = undefined;
});

describe("E2BSandbox create network posture", () => {
  test("creates with a GitHub-domain setup policy and restores deny-all", async () => {
    await sandboxModule.E2BSandbox.create({
      source: { url: "https://github.com/open-agents/example", branch: "main" },
    });

    expect(createCalls[0]?.options.network).toEqual(
      buildE2BGitHubSetupPolicy(),
    );
    expect(updateNetworkCalls.at(-1)).toEqual(E2B_DENY_ALL_NETWORK_UPDATE);
  });

  test("creates with the brokered policy when a setup token is provided and restores deny-all", async () => {
    await sandboxModule.E2BSandbox.create({
      githubToken: "github-user-token",
      source: { url: "https://github.com/open-agents/example", branch: "main" },
    });

    const applied = createCalls[0]?.options.network as {
      allowOut: unknown;
      rules: Record<string, unknown>;
    };
    expect(typeof applied.allowOut).toBe("function");
    expect(applied.rules).toEqual(
      (
        buildE2BGitHubCredentialBrokeringPolicy("github-user-token") as {
          rules: Record<string, unknown>;
        }
      ).rules,
    );
    expect(updateNetworkCalls.at(-1)).toEqual(E2B_DENY_ALL_NETWORK_UPDATE);
    // The token must never reach git commands or environment variables.
    expect(JSON.stringify(runCommandCalls)).not.toContain("github-user-token");
  });

  test("applies deny-all on reconnect before any agent command runs", async () => {
    await sandboxModule.E2BSandbox.connect({ sandboxId: "sbx-1" });

    expect(connectCalls[0]?.sandboxId).toBe("sbx-1");
    expect(updateNetworkCalls).toEqual([E2B_DENY_ALL_NETWORK_UPDATE]);
  });
});

describe("E2BSandbox network isolation", () => {
  test("temporarily allows the npm registry and restores deny-all after install", async () => {
    existingFiles.add("/home/user/repo/pnpm-lock.yaml");

    const sandbox = await sandboxModule.E2BSandbox.connect({
      sandboxId: "sbx-1",
      repoPath: "/home/user/repo",
    });
    const result = await sandbox.installDependencies(
      "/home/user/repo",
      "frozen",
    );

    expect(result).toMatchObject({ success: true, packageManager: "pnpm" });
    expect(updateNetworkCalls).toEqual([
      E2B_DENY_ALL_NETWORK_UPDATE,
      { allowOut: ["registry.npmjs.org"] },
      E2B_DENY_ALL_NETWORK_UPDATE,
    ]);
    expect(
      runCommandCalls.some((call) =>
        String(call.command).includes("pnpm install --frozen-lockfile"),
      ),
    ).toBe(true);
  });

  test("restores deny-all when dependency installation is cancelled", async () => {
    existingFiles.add("/home/user/repo/pnpm-lock.yaml");
    failRunCommand = new Error("cancelled");
    failRunCommand.name = "AbortError";

    const sandbox = await sandboxModule.E2BSandbox.connect({
      sandboxId: "sbx-1",
      repoPath: "/home/user/repo",
    });

    await expect(
      sandbox.installDependencies("/home/user/repo", "frozen"),
    ).rejects.toThrow("cancelled");
    expect(updateNetworkCalls.at(-1)).toEqual(E2B_DENY_ALL_NETWORK_UPDATE);
  });

  test("restores deny-all when dependency installation fails", async () => {
    const sandbox = await sandboxModule.E2BSandbox.connect({
      sandboxId: "sbx-1",
      repoPath: "/home/user/repo",
    });

    await expect(
      sandbox.installDependencies("/home/user/repo", "frozen"),
    ).rejects.toThrow("No supported JavaScript lockfile found");
    expect(updateNetworkCalls.at(-1)).toEqual(E2B_DENY_ALL_NETWORK_UPDATE);
  });

  test("rejects installs that escape the workspace directory", async () => {
    const sandbox = await sandboxModule.E2BSandbox.connect({
      sandboxId: "sbx-1",
      repoPath: "/home/user/repo",
    });

    await expect(sandbox.installDependencies("/etc", "frozen")).rejects.toThrow(
      "must stay inside the workspace",
    );
  });

  test("brokers a token only through policy transforms and restores deny-all", async () => {
    const token = "github-secret-token";
    const sandbox = await sandboxModule.E2BSandbox.connect({
      sandboxId: "sbx-1",
      repoPath: "/home/user/repo",
    });

    const result = await sandbox.execGitHubBrokered(
      "git fetch origin main",
      "/home/user/repo",
      30_000,
      token,
    );

    expect(result.success).toBe(true);
    expect(JSON.stringify(runCommandCalls)).not.toContain(token);
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
    expect(updateNetworkCalls.at(-1)).toEqual(E2B_DENY_ALL_NETWORK_UPDATE);
    const brokered = updateNetworkCalls[1] as {
      allowOut: unknown;
      rules: Record<string, unknown>;
    };
    expect(typeof brokered.allowOut).toBe("function");
    expect(brokered.rules).toEqual(
      (
        buildE2BGitHubCredentialBrokeringPolicy(token) as {
          rules: Record<string, unknown>;
        }
      ).rules,
    );
  });

  test("disables network operations after starting a detached command", async () => {
    const sandbox = await sandboxModule.E2BSandbox.connect({
      sandboxId: "sbx-1",
      repoPath: "/home/user/repo",
    });

    await sandbox.execDetached("bun run dev", "/home/user/repo");

    await expect(
      sandbox.installDependencies("/home/user/repo", "frozen"),
    ).rejects.toThrow(
      "Network-enabled operations are unavailable after starting a detached command",
    );
  });

  test("does not open network access while a general command is running", async () => {
    let releaseCommand = () => {};
    const commandStarted = new Promise<void>((resolve) => {
      runCommandHook = async (command) => {
        if (command !== "sleep 30") return;
        resolve();
        await new Promise<void>((resolve) => {
          releaseCommand = () => resolve();
        });
      };
    });
    const sandbox = await sandboxModule.E2BSandbox.connect({
      sandboxId: "sbx-1",
      repoPath: "/home/user/repo",
    });

    const command = sandbox.exec("sleep 30", "/home/user/repo", 30_000);
    await commandStarted;

    await expect(
      sandbox.installDependencies("/home/user/repo", "frozen"),
    ).rejects.toThrow(
      "Network-enabled operations are unavailable while a general command is running",
    );
    expect(updateNetworkCalls).toEqual([E2B_DENY_ALL_NETWORK_UPDATE]);

    releaseCommand();
    expect((await command).success).toBe(true);
  });
});

describe("E2BSandbox timeout extension", () => {
  test("extends the sandbox timeout through the SDK timeout API", async () => {
    const sandbox = await sandboxModule.E2BSandbox.connect({
      sandboxId: "sbx-1",
      repoPath: "/home/user/repo",
      timeout: 60_000,
    });

    const before = sandbox.expiresAt ?? 0;
    const result = await sandbox.extendTimeout(120_000);

    expect(setTimeoutCalls.length).toBe(1);
    expect(setTimeoutCalls[0]).toBeGreaterThanOrEqual(120_000);
    expect(result.expiresAt).toBeGreaterThan(before + 110_000);
    expect(sandbox.expiresAt).toBe(result.expiresAt);
  });
});
