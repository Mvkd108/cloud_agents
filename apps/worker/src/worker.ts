import "dotenv/config";

import {
  ControlPlaneStore,
  createRunWorker,
  createSql,
  ensureControlPlaneSchema,
  loadControlPlaneEnv,
  processRunJob,
} from "@open-agents/control-plane";

const env = loadControlPlaneEnv();
const sql = createSql(env.postgresUrl);
await ensureControlPlaneSchema(sql);
const store = new ControlPlaneStore(sql);

const worker = createRunWorker(env.redisUrl, async (data) => {
  await processRunJob(store, data);
});

worker.on("completed", (job) => {
  console.log(`completed run job ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`failed run job ${job?.id}:`, error);
});

console.log("control-plane worker started");
