import { tool } from "ai";
import { z } from "zod";
import { getSandbox } from "./utils";
import { resolveWorkspacePath } from "./path-security";

const installDependenciesInputSchema = z.object({
  cwd: z
    .string()
    .optional()
    .describe("Workspace-relative directory containing the project lockfile"),
  lockfileMode: z
    .enum(["frozen", "update"])
    .optional()
    .describe(
      "Use frozen for existing lockfiles. Use update only after the user approved dependency changes.",
    ),
});

export const installDependenciesTool = tool({
  needsApproval: true,
  description: `Install JavaScript or TypeScript project dependencies.

This is the only tool that receives temporary package-registry network access.
It detects pnpm, Bun, Yarn, or npm from the lockfile and accepts no arbitrary
shell command. Use lockfileMode "frozen" unless dependency changes were
explicitly requested and approved.`,
  inputSchema: installDependenciesInputSchema,
  execute: async (
    { cwd, lockfileMode = "frozen" },
    { experimental_context, abortSignal },
  ) => {
    const sandbox = await getSandbox(
      experimental_context,
      "install_dependencies",
    );
    if (!sandbox.installDependencies) {
      return {
        success: false,
        error: "Dependency installation is not supported in this sandbox",
      };
    }

    const resolvedCwd = resolveWorkspacePath(
      cwd ?? ".",
      sandbox.workingDirectory,
    );
    if (!resolvedCwd) {
      return {
        success: false,
        error: "Dependency installation must stay inside the workspace",
      };
    }

    try {
      const result = await sandbox.installDependencies(
        resolvedCwd,
        lockfileMode,
        { signal: abortSignal },
      );
      return {
        success: result.success,
        packageManager: result.packageManager,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.truncated && { truncated: true }),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
