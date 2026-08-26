import type { ConnectOptions } from "../factory.ts";
import { E2BSandbox } from "./sandbox.ts";
import type { E2BState } from "./state.ts";

export async function connectE2B(
  state: { type: "e2b" } & E2BState,
  options: ConnectOptions = {},
): Promise<E2BSandbox> {
  if (state.sandboxId) {
    return E2BSandbox.connect({
      sandboxId: state.sandboxId,
      env: options.env,
      timeout: options.timeout,
      ports: state.ports ?? options.ports,
      repoPath: state.repoPath,
      currentBranch: state.currentBranch,
      hooks: options.hooks,
    });
  }

  return E2BSandbox.create({
    template: state.template,
    snapshotId: state.snapshotId ?? options.baseSnapshotId,
    source: state.source
      ? {
          url: state.source.repo,
          branch: state.source.branch,
          newBranch: state.source.newBranch,
        }
      : undefined,
    gitUser: options.gitUser,
    env: options.env,
    githubToken: options.githubToken,
    timeout: options.timeout,
    ports: state.ports ?? options.ports,
    repoPath: state.repoPath,
    codex: state.codex,
    hooks: options.hooks,
  });
}
