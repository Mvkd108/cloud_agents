import type { SandboxHooks } from "../interface.ts";

export interface E2BCodexProviderConfig {
  providerId?: string;
  baseUrl?: string;
  envKey?: string;
  model?: string;
  fallbackModel?: string;
  wireApi?: "chat" | "responses";
}

export interface E2BSandboxConfig {
  sandboxId?: string;
  template?: string;
  source?: {
    url: string;
    branch?: string;
    token?: string;
    newBranch?: string;
  };
  gitUser?: {
    name: string;
    email: string;
  };
  env?: Record<string, string>;
  githubToken?: string;
  timeout?: number;
  ports?: number[];
  snapshotId?: string;
  repoPath?: string;
  codex?: E2BCodexProviderConfig;
  hooks?: SandboxHooks;
}

export interface E2BSandboxConnectConfig {
  sandboxId: string;
  env?: Record<string, string>;
  timeout?: number;
  ports?: number[];
  repoPath?: string;
  currentBranch?: string;
  hooks?: SandboxHooks;
}
