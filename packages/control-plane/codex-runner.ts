import { E2BSandbox } from "@open-agents/sandbox/e2b";
import type { ControlPlaneStore } from "./db.ts";
import { parseJsonLines, terminalCodexUsage } from "./events.ts";
import type {
  AgentRunRecord,
  AgentSessionRecord,
  RunJobData,
} from "./types.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildCodexCommand(run: AgentRunRecord): string {
  const modelArg = run.modelId ? ` --model ${shellQuote(run.modelId)}` : "";
  return `codex exec --json --sandbox workspace-write --skip-git-repo-check${modelArg} ${shellQuote(run.prompt)}`;
}

async function ensureSandbox(params: {
  store: ControlPlaneStore;
  session: AgentSessionRecord;
  githubToken?: string;
}): Promise<E2BSandbox> {
  const active = await params.store.getActiveSandbox(params.session.id);
  if (active) {
    return E2BSandbox.connect({
      sandboxId: active.sandboxId,
      repoPath: active.repoPath,
      env: process.env["FIREWORKS_API_KEY"]
        ? { FIREWORKS_API_KEY: process.env["FIREWORKS_API_KEY"] }
        : {},
      timeout: 600_000,
      ports: [3000, 5173, 4321, 8000],
    });
  }

  const branch = params.session.branch ?? undefined;
  const sandbox = await E2BSandbox.create({
    template: process.env["E2B_CODEX_TEMPLATE"] ?? "codex",
    source: {
      url: params.session.repoUrl,
      branch,
      newBranch: `agent/${params.session.id.slice(0, 8)}`,
    },
    githubToken: params.githubToken,
    gitUser: {
      name: "Open Agents Bot",
      email: "open-agents@example.invalid",
    },
    env: process.env["FIREWORKS_API_KEY"]
      ? { FIREWORKS_API_KEY: process.env["FIREWORKS_API_KEY"] }
      : {},
    timeout: 600_000,
    ports: [3000, 5173, 4321, 8000],
  });
  const instance = await params.store.upsertSandboxInstance({
    sessionId: params.session.id,
    sandboxId: sandbox.sandboxId,
    templateId: process.env["E2B_CODEX_TEMPLATE"] ?? "codex",
    repoPath: sandbox.workingDirectory,
    lifecycleState: "active",
  });
  await params.store.updateSessionSandbox({
    sessionId: params.session.id,
    sandboxInstanceId: instance.id,
  });

  return sandbox;
}

export async function processRunJob(
  store: ControlPlaneStore,
  data: RunJobData,
): Promise<void> {
  const run = await store.getRun(data.runId);
  if (!run) {
    throw new Error(`Run not found: ${data.runId}`);
  }
  const session = await store.getSession(run.sessionId);
  if (!session) {
    throw new Error(`Session not found: ${run.sessionId}`);
  }

  await store.updateRun({ runId: run.id, status: "running" });
  await store.appendRunEvent({
    runId: run.id,
    type: "run.started",
    payload: { runId: run.id, sessionId: session.id },
  });

  let stdoutBuffer = "";
  let latestUsage:
    | {
        inputTokens?: number;
        outputTokens?: number;
      }
    | undefined;

  try {
    const sandbox = await ensureSandbox({
      store,
      session,
      githubToken: data.githubToken,
    });
    const command = buildCodexCommand(run);
    const result = await sandbox.runStreamingCommand(command, {
      cwd: sandbox.workingDirectory,
      timeoutMs: 30 * 60 * 1000,
      onStdout: async (chunk) => {
        stdoutBuffer += chunk;
        const parsed = parseJsonLines(stdoutBuffer);
        stdoutBuffer = parsed.remainder;

        for (const event of parsed.events) {
          if (event.thread_id && !run.codexSessionId) {
            await store.updateRun({
              runId: run.id,
              status: "running",
              codexSessionId: event.thread_id,
            });
          }
          latestUsage = terminalCodexUsage(event) ?? latestUsage;
          await store.appendRunEvent({
            runId: run.id,
            type: event.type ?? "codex.event",
            payload: event,
          });
        }
      },
      onStderr: async (chunk) => {
        await store.appendRunEvent({
          runId: run.id,
          type: "codex.stderr",
          payload: { text: chunk },
        });
      },
    });

    if (stdoutBuffer.trim()) {
      const parsed = parseJsonLines(`${stdoutBuffer}\n`);
      for (const event of parsed.events) {
        latestUsage = terminalCodexUsage(event) ?? latestUsage;
        await store.appendRunEvent({
          runId: run.id,
          type: event.type ?? "codex.event",
          payload: event,
        });
      }
    }

    if (!result.success) {
      throw new Error(result.stderr || `Codex exited with ${result.exitCode}`);
    }

    await store.updateRun({
      runId: run.id,
      status: "completed",
      inputTokens: latestUsage?.inputTokens,
      outputTokens: latestUsage?.outputTokens,
    });
    await store.appendRunEvent({
      runId: run.id,
      type: "run.completed",
      payload: { runId: run.id },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.updateRun({ runId: run.id, status: "failed", error: message });
    await store.appendRunEvent({
      runId: run.id,
      type: "run.failed",
      payload: { message },
    });
    throw error;
  }
}
