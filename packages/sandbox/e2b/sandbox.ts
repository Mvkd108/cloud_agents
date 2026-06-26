import { Buffer } from "node:buffer";
import type { Dirent } from "node:fs";
import { Sandbox as E2BSdkSandbox } from "e2b";
import type {
  E2BCodexProviderConfig,
  E2BSandboxConfig,
  E2BSandboxConnectConfig,
} from "./config.ts";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
  SnapshotResult,
} from "../interface.ts";
import type { E2BState } from "./state.ts";

const DEFAULT_TEMPLATE = "codex";
const DEFAULT_REPO_PATH = "/home/user/repo";
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_LENGTH = 50_000;

type E2BSdk = InstanceType<typeof E2BSdkSandbox> & {
  sandboxId?: string;
  id?: string;
  files: {
    read(path: string, opts?: Record<string, unknown>): Promise<unknown>;
    write(path: string, data: unknown): Promise<void>;
    list(
      path: string,
    ): Promise<
      Array<{ name?: string; path?: string; type?: string; size?: number }>
    >;
    getInfo(path: string): Promise<{
      name?: string;
      path?: string;
      type?: string;
      size?: number;
    }>;
    exists(path: string): Promise<boolean>;
    makeDir(path: string): Promise<boolean>;
  };
  commands: {
    run(
      command: string,
      options?: {
        cwd?: string;
        envs?: Record<string, string>;
        timeoutMs?: number;
        background?: boolean;
        onStdout?: (data: string) => void | Promise<void>;
        onStderr?: (data: string) => void | Promise<void>;
        signal?: AbortSignal;
      },
    ): Promise<{
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      pid?: number;
      kill?: () => Promise<void>;
    }>;
  };
  git?: {
    clone(
      repo: string,
      options?: {
        path?: string;
        branch?: string;
        username?: string;
        password?: string;
        depth?: number;
      },
    ): Promise<void>;
    configureUser(
      name: string,
      email: string,
      options?: { scope?: "global" | "local"; path?: string },
    ): Promise<void>;
  };
  getHost(port: number): string;
  kill(): Promise<void>;
  pause(opts?: { keepMemory?: boolean }): Promise<void>;
  createSnapshot(): Promise<{ snapshotId?: string; snapshot_id?: string }>;
};

export interface E2BStreamingCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (data: string) => void | Promise<void>;
  onStderr?: (data: string) => void | Promise<void>;
}

function truncateCommandOutput(output: string): {
  output: string;
  truncated: boolean;
} {
  if (output.length <= MAX_OUTPUT_LENGTH) {
    return { output, truncated: false };
  }

  return {
    output: output.slice(0, MAX_OUTPUT_LENGTH),
    truncated: true,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandEnv(
  baseEnv: Record<string, string> | undefined,
  ports: number[] | undefined,
  domain: (port: number) => string,
): Record<string, string> | undefined {
  const env: Record<string, string> = { ...baseEnv };

  for (const port of ports ?? []) {
    env[`SANDBOX_URL_${port}`] = domain(port);
  }

  return Object.keys(env).length > 0 ? env : undefined;
}

function asBuffer(content: unknown): Buffer {
  if (Buffer.isBuffer(content)) {
    return content;
  }
  if (content instanceof Uint8Array) {
    return Buffer.from(content);
  }
  if (typeof content === "string") {
    return Buffer.from(content, "utf-8");
  }

  throw new Error("Unsupported E2B file payload");
}

function direntFromEntry(
  parentPath: string,
  entry: { name?: string; path?: string; type?: string },
): Dirent {
  const name = entry.name ?? entry.path?.split("/").at(-1) ?? "";
  const type = entry.type;
  const isDir = type === "dir" || type === "directory";
  const isFile = type === "file";

  return {
    name,
    parentPath,
    path: parentPath,
    isDirectory: () => isDir,
    isFile: () => isFile,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as Dirent;
}

export function buildCodexConfig(config: E2BCodexProviderConfig = {}): string {
  const providerId = config.providerId ?? "fireworks";
  const baseUrl = config.baseUrl ?? "https://api.fireworks.ai/inference/v1";
  const envKey = config.envKey ?? "FIREWORKS_API_KEY";
  const model = config.model ?? "accounts/fireworks/models/kimi-k2p5";
  const fallbackModel =
    config.fallbackModel ??
    "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct";
  const wireApi = config.wireApi ?? "chat";

  return `model_provider = "${providerId}"
model = "${model}"
approval_policy = "never"
sandbox_mode = "workspace-write"
model_context_window = 131072

[model_providers.${providerId}]
name = "Fireworks"
base_url = "${baseUrl}"
env_key = "${envKey}"
wire_api = "${wireApi}"

[model_providers.${providerId}.metadata]
fallback_model = "${fallbackModel}"
`;
}

async function writeCodexConfig(
  sdk: E2BSdk,
  codex?: E2BCodexProviderConfig,
): Promise<void> {
  await sdk.commands.run("mkdir -p ~/.codex", { timeoutMs: 30_000 });
  await sdk.files.write(
    "/home/user/.codex/config.toml",
    buildCodexConfig(codex),
  );
}

async function cloneSource(params: {
  sdk: E2BSdk;
  repoPath: string;
  url: string;
  branch?: string;
  token?: string;
}): Promise<void> {
  if (params.sdk.git?.clone) {
    await params.sdk.git.clone(params.url, {
      path: params.repoPath,
      ...(params.branch ? { branch: params.branch } : {}),
      ...(params.token
        ? { username: "x-access-token", password: params.token }
        : {}),
      depth: 1,
    });
    return;
  }

  const cloneArgs = [
    "git",
    "clone",
    "--depth",
    "1",
    ...(params.branch ? ["--branch", shellQuote(params.branch)] : []),
    shellQuote(params.url),
    shellQuote(params.repoPath),
  ];
  const result = await params.sdk.commands.run(cloneArgs.join(" "), {
    timeoutMs: 300_000,
    envs: params.token ? { GITHUB_TOKEN: params.token } : undefined,
  });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to clone repository: ${result.stderr ?? ""}`);
  }
}

async function createSdk(
  template: string,
  options: Record<string, unknown>,
): Promise<E2BSdk> {
  const sdkClass = E2BSdkSandbox as unknown as {
    create: (...args: unknown[]) => Promise<E2BSdk>;
  };

  return sdkClass.create(template, options);
}

async function connectSdk(
  sandboxId: string,
  options: Record<string, unknown>,
): Promise<E2BSdk> {
  const sdkClass = E2BSdkSandbox as unknown as {
    connect: (...args: unknown[]) => Promise<E2BSdk>;
  };

  return sdkClass.connect(sandboxId, options);
}

export class E2BSandbox implements Sandbox {
  readonly type = "cloud" as const;
  readonly sandboxId: string;
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
  readonly currentBranch?: string;
  readonly hooks?: SandboxHooks;
  readonly timeout?: number;
  readonly expiresAt?: number;

  private readonly sdk: E2BSdk;
  private readonly template?: string;
  private readonly snapshotId?: string;
  private readonly ports?: number[];
  private readonly codex?: E2BCodexProviderConfig;

  private constructor(params: {
    sdk: E2BSdk;
    sandboxId: string;
    workingDirectory: string;
    env?: Record<string, string>;
    currentBranch?: string;
    hooks?: SandboxHooks;
    timeout?: number;
    expiresAt?: number;
    template?: string;
    snapshotId?: string;
    ports?: number[];
    codex?: E2BCodexProviderConfig;
  }) {
    this.sdk = params.sdk;
    this.sandboxId = params.sandboxId;
    this.workingDirectory = params.workingDirectory;
    this.env = params.env;
    this.currentBranch = params.currentBranch;
    this.hooks = params.hooks;
    this.timeout = params.timeout;
    this.expiresAt = params.expiresAt;
    this.template = params.template;
    this.snapshotId = params.snapshotId;
    this.ports = params.ports;
    this.codex = params.codex;
  }

  get host(): string | undefined {
    const port = this.ports?.[0] ?? 3000;
    try {
      return this.sdk.getHost(port);
    } catch {
      return undefined;
    }
  }

  get environmentDetails(): string {
    const portLines =
      this.ports
        ?.map((port) => `  - Port ${port}: ${this.domain(port)}`)
        .join("\n") ?? "";
    const previewLines = portLines
      ? `\n- Dev server URLs for locally running servers:\n${portLines}`
      : "";

    return `- This workspace runs in an isolated E2B microVM.
- All bash commands already run in the working directory by default.
- Use workspace-relative paths for read/write/search/edit operations.
- Git is available for local inspection. Do not persist GitHub credentials in this sandbox.
- GitHub writes are brokered by the control plane with short-lived installation tokens.
- Codex is configured to use the Fireworks provider through ~/.codex/config.toml.
- If dependencies are missing, inspect the lockfile and run the project package manager install command before tests.
${previewLines}`;
  }

  static async create(config: E2BSandboxConfig = {}): Promise<E2BSandbox> {
    const template =
      config.snapshotId ??
      config.template ??
      process.env["E2B_CODEX_TEMPLATE"] ??
      DEFAULT_TEMPLATE;
    const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    const repoPath = config.repoPath ?? DEFAULT_REPO_PATH;
    const env = config.env;
    const sdk = await createSdk(template, {
      envs: env,
      timeoutMs: timeout,
      lifecycle: {
        onTimeout: "pause",
        autoResume: false,
      },
    });
    const sandboxId = sdk.sandboxId ?? sdk.id;
    if (!sandboxId) {
      throw new Error("E2B sandbox was created without an id");
    }

    await writeCodexConfig(sdk, config.codex);
    await sdk.commands.run(`mkdir -p ${shellQuote(repoPath)}`, {
      timeoutMs: 30_000,
    });

    const source = config.source;
    if (source) {
      await cloneSource({
        sdk,
        repoPath,
        url: source.url,
        branch: source.branch,
        token: config.githubToken ?? source.token,
      });
    } else {
      await sdk.commands.run("git init", { cwd: repoPath, timeoutMs: 30_000 });
    }

    if (config.gitUser) {
      if (sdk.git?.configureUser) {
        await sdk.git.configureUser(config.gitUser.name, config.gitUser.email, {
          scope: "local",
          path: repoPath,
        });
      } else {
        await sdk.commands.run(
          `git config user.name ${shellQuote(config.gitUser.name)} && git config user.email ${shellQuote(config.gitUser.email)}`,
          { cwd: repoPath, timeoutMs: 30_000 },
        );
      }
    }

    let currentBranch = source?.branch;
    if (source?.newBranch) {
      const result = await sdk.commands.run(
        `git checkout -B ${shellQuote(source.newBranch)}`,
        { cwd: repoPath, timeoutMs: 30_000 },
      );
      if (result.exitCode !== 0) {
        throw new Error(`Failed to checkout branch: ${result.stderr ?? ""}`);
      }
      currentBranch = source.newBranch;
    }

    const sandbox = new E2BSandbox({
      sdk,
      sandboxId,
      workingDirectory: repoPath,
      env,
      currentBranch,
      hooks: config.hooks,
      timeout,
      expiresAt: Date.now() + timeout,
      template,
      snapshotId: config.snapshotId,
      ports: config.ports,
      codex: config.codex,
    });

    if (config.hooks?.afterStart) {
      await config.hooks.afterStart(sandbox);
    }

    return sandbox;
  }

  static async connect(config: E2BSandboxConnectConfig): Promise<E2BSandbox> {
    const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    const sdk = await connectSdk(config.sandboxId, { timeoutMs: timeout });
    await writeCodexConfig(sdk, undefined);

    const sandbox = new E2BSandbox({
      sdk,
      sandboxId: config.sandboxId,
      workingDirectory: config.repoPath ?? DEFAULT_REPO_PATH,
      env: config.env,
      currentBranch: config.currentBranch,
      hooks: config.hooks,
      timeout,
      expiresAt: Date.now() + timeout,
      ports: config.ports,
    });

    if (config.hooks?.afterStart) {
      await config.hooks.afterStart(sandbox);
    }

    return sandbox;
  }

  async readFile(path: string, _encoding: "utf-8"): Promise<string> {
    const content = await this.sdk.files.read(path, { format: "text" });
    return asBuffer(content).toString("utf-8");
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    const content = await this.sdk.files.read(path, { format: "bytes" });
    return asBuffer(content);
  }

  async writeFile(
    path: string,
    content: string,
    _encoding: "utf-8",
  ): Promise<void> {
    const parentDir = path.substring(0, path.lastIndexOf("/"));
    if (parentDir) {
      await this.mkdir(parentDir, { recursive: true });
    }
    await this.sdk.files.write(path, content);
  }

  async stat(path: string): Promise<SandboxStats> {
    const info = await this.sdk.files.getInfo(path);
    const type = String(info.type);
    const isDir = type === "dir" || type === "directory";
    const isFile = type === "file";

    return {
      isDirectory: () => isDir,
      isFile: () => isFile,
      size: info.size ?? 0,
      mtimeMs: 0,
    };
  }

  async access(path: string): Promise<void> {
    const exists = await this.sdk.files.exists(path);
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory, access '${path}'`);
    }
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    await this.sdk.files.makeDir(path);
  }

  async readdir(
    path: string,
    _options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    const entries = await this.sdk.files.list(path);
    return entries.map((entry) => direntFromEntry(path, entry));
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    try {
      const result = await this.sdk.commands.run(command, {
        cwd,
        timeoutMs,
        envs: commandEnv(this.env, this.ports, (port) => this.domain(port)),
        signal: options?.signal,
      });
      const stdout = truncateCommandOutput(result.stdout ?? "");
      const stderr = truncateCommandOutput(result.stderr ?? "");

      return {
        success: result.exitCode === 0,
        exitCode: result.exitCode ?? null,
        stdout: stdout.output,
        stderr: stderr.output,
        truncated: stdout.truncated || stderr.truncated,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }

      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        truncated: false,
      };
    }
  }

  async execDetached(
    command: string,
    cwd: string,
  ): Promise<{ commandId: string }> {
    const result = await this.sdk.commands.run(command, {
      cwd,
      background: true,
      envs: commandEnv(this.env, this.ports, (port) => this.domain(port)),
    });

    return { commandId: String(result.pid ?? Date.now()) };
  }

  async runStreamingCommand(
    command: string,
    options: E2BStreamingCommandOptions = {},
  ): Promise<ExecResult> {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const result = await this.sdk.commands.run(command, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      envs: {
        ...commandEnv(this.env, this.ports, (port) => this.domain(port)),
        ...options.env,
      },
      onStdout: async (data) => {
        stdoutChunks.push(data);
        await options.onStdout?.(data);
      },
      onStderr: async (data) => {
        stderrChunks.push(data);
        await options.onStderr?.(data);
      },
    });
    const stdout = truncateCommandOutput(
      stdoutChunks.join("") || result.stdout || "",
    );
    const stderr = truncateCommandOutput(
      stderrChunks.join("") || result.stderr || "",
    );

    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode ?? null,
      stdout: stdout.output,
      stderr: stderr.output,
      truncated: stdout.truncated || stderr.truncated,
    };
  }

  domain(port: number): string {
    return `https://${this.sdk.getHost(port)}`;
  }

  async stop(): Promise<void> {
    if (this.hooks?.beforeStop) {
      await this.hooks.beforeStop(this);
    }
    await this.sdk.pause({ keepMemory: true });
  }

  async kill(): Promise<void> {
    await this.sdk.kill();
  }

  async extendTimeout(additionalMs: number): Promise<{ expiresAt: number }> {
    return { expiresAt: Date.now() + additionalMs };
  }

  async snapshot(): Promise<SnapshotResult> {
    const snapshot = await this.sdk.createSnapshot();
    const snapshotLike = snapshot as {
      snapshotId?: string;
      snapshot_id?: string;
    };
    const snapshotId = snapshotLike.snapshotId ?? snapshotLike.snapshot_id;
    if (!snapshotId) {
      throw new Error("E2B snapshot did not return a snapshot id");
    }
    return { snapshotId };
  }

  getState(): { type: "e2b" } & E2BState {
    return {
      type: "e2b",
      sandboxId: this.sandboxId,
      template: this.template,
      snapshotId: this.snapshotId,
      repoPath: this.workingDirectory,
      currentBranch: this.currentBranch,
      expiresAt: this.expiresAt,
      ports: this.ports,
      codex: this.codex,
    };
  }
}
