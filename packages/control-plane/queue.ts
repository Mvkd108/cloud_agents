import { Queue, Worker, type JobsOptions } from "bullmq";
import type { RunJobData } from "./types.ts";

export const RUN_QUEUE_NAME = "agent-runs";

export function createRedisConnection(redisUrl: string) {
  return {
    url: redisUrl,
    maxRetriesPerRequest: null,
  };
}

export function createRunQueue(redisUrl: string) {
  return new Queue<RunJobData, void, "run-codex">(RUN_QUEUE_NAME, {
    connection: createRedisConnection(redisUrl),
  });
}

export async function enqueueRun(
  queue: Queue<RunJobData, void, "run-codex">,
  data: RunJobData,
  options: JobsOptions = {},
): Promise<void> {
  await queue.add("run-codex", data, {
    attempts: 1,
    removeOnComplete: 1000,
    removeOnFail: 1000,
    ...options,
  });
}

export function createRunWorker(
  redisUrl: string,
  processor: (data: RunJobData) => Promise<void>,
): Worker<RunJobData, void, "run-codex"> {
  return new Worker<RunJobData, void, "run-codex">(
    RUN_QUEUE_NAME,
    async (job) => processor(job.data),
    {
      connection: createRedisConnection(redisUrl),
      concurrency: Number.parseInt(
        process.env["WORKER_CONCURRENCY"] ?? "2",
        10,
      ),
    },
  );
}
