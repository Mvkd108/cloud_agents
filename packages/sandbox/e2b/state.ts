import type { Source } from "../types.ts";
import type { E2BCodexProviderConfig } from "./config.ts";

export interface E2BState {
  source?: Source;
  sandboxId?: string;
  template?: string;
  snapshotId?: string;
  repoPath?: string;
  currentBranch?: string;
  expiresAt?: number;
  ports?: number[];
  codex?: E2BCodexProviderConfig;
}
