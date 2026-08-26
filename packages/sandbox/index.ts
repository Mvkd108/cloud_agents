// interface
export type {
  ExecResult,
  DependencyInstallLockfileMode,
  DependencyInstallResult,
  JavaScriptPackageManager,
  Sandbox,
  SandboxHook,
  SandboxHooks,
  SandboxStats,
  SandboxType,
  SnapshotResult,
} from "./interface.ts";

// shared types
export type { Source, FileEntry, SandboxStatus } from "./types.ts";

// factory
export {
  connectSandbox,
  resolveSandboxProvider,
  type SandboxProvider,
  type SandboxState,
  type ConnectOptions,
  type SandboxConnectConfig,
} from "./factory.ts";

// git helpers
export {
  hasUncommittedChanges,
  stageAll,
  getCurrentBranch,
  getHeadSha,
  getStagedDiff,
  getChangedFiles,
  detectBinaryFiles,
  readFileContents,
  getFileModes,
  syncToRemote,
  syncToRemotePreservingChanges,
  execGitHubBrokered,
  type FileChange,
  type FileChangeStatus,
  type FileWithContent,
} from "./git.ts";

// vercel
export {
  connectVercelSandbox,
  VercelSandbox,
  type VercelSandboxConfig,
  type VercelSandboxConnectConfig,
  type VercelState,
} from "./vercel/index.ts";

// e2b
export {
  connectE2B,
  E2BSandbox,
  type E2BCodexProviderConfig,
  type E2BSandboxConfig,
  type E2BSandboxConnectConfig,
  type E2BState,
  type E2BStreamingCommandOptions,
} from "./e2b/index.ts";

// e2b network policy
export {
  buildE2BGitHubCredentialBrokeringPolicy,
  buildE2BGitHubSetupPolicy,
  buildE2BNpmRegistryNetworkPolicy,
  E2B_DENY_ALL_NETWORK_UPDATE,
  E2B_GITHUB_HOSTS,
} from "./e2b/network-policy.ts";
