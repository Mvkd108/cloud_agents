import { z } from "zod";

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const sessionStatusSchema = z.enum([
  "active",
  "paused",
  "archived",
  "failed",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const createRunInputSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().optional(),
  repo: z.string().url(),
  branch: z.string().optional(),
  prompt: z.string().min(1),
  modelId: z.string().optional(),
  githubToken: z.string().optional(),
});
export type CreateRunInput = z.infer<typeof createRunInputSchema>;

export interface AgentSessionRecord {
  id: string;
  userId: string;
  repoUrl: string;
  repoOwner: string | null;
  repoName: string | null;
  branch: string | null;
  selectedModel: string | null;
  activeSandboxId: string | null;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface SandboxInstanceRecord {
  id: string;
  sessionId: string;
  provider: "e2b";
  sandboxId: string;
  templateId: string | null;
  snapshotId: string | null;
  repoPath: string;
  lifecycleState: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentRunRecord {
  id: string;
  sessionId: string;
  prompt: string;
  status: RunStatus;
  modelId: string | null;
  codexSessionId: string | null;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface RunEventRecord {
  id: number;
  runId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}

export interface RunJobData {
  runId: string;
  githubToken?: string;
}

export type CodexJsonEvent = {
  type?: string;
  thread_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
};
