import "dotenv/config";

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  ControlPlaneStore,
  createRunInputSchema,
  createRunQueue,
  createSql,
  enqueueRun,
  ensureControlPlaneSchema,
  getSessionDiff,
  loadControlPlaneEnv,
  pushAndCreatePr,
} from "@open-agents/control-plane";

const env = loadControlPlaneEnv();
const sql = createSql(env.postgresUrl);
await ensureControlPlaneSchema(sql);
const store = new ControlPlaneStore(sql);
const queue = createRunQueue(env.redisUrl);

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function routePath(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://localhost");
}

async function handleCreateRun(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const input = createRunInputSchema.parse(await readJson(request));
  const session = await store.createOrGetSession({
    id: input.sessionId,
    userId: input.userId,
    repoUrl: input.repo,
    branch: input.branch,
    selectedModel: input.modelId ?? env.defaultModel,
  });
  const run = await store.createRun({
    sessionId: session.id,
    prompt: input.prompt,
    modelId: input.modelId ?? env.defaultModel,
  });
  await store.appendRunEvent({
    runId: run.id,
    type: "run.queued",
    payload: { runId: run.id, sessionId: session.id },
  });
  await enqueueRun(queue, {
    runId: run.id,
    githubToken: input.githubToken,
  });

  sendJson(response, 202, { session, run });
}

async function handleRunEvents(
  runId: string,
  response: ServerResponse,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });

  let sequence = 0;
  let closed = false;
  response.on("close", () => {
    closed = true;
  });

  while (!closed) {
    const [events, run] = await Promise.all([
      store.listRunEventsAfter(runId, sequence),
      store.getRun(runId),
    ]);

    for (const event of events) {
      sequence = event.sequence;
      response.write(`id: ${event.sequence}\n`);
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    if (
      run &&
      (run.status === "completed" ||
        run.status === "failed" ||
        run.status === "cancelled")
    ) {
      response.write(`event: run.status\n`);
      response.write(`data: ${JSON.stringify({ status: run.status })}\n\n`);
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  response.end();
}

async function handleCancelRun(
  runId: string,
  response: ServerResponse,
): Promise<void> {
  await store.updateRun({
    runId,
    status: "cancelled",
    error: "Cancelled by user",
  });
  await store.appendRunEvent({
    runId,
    type: "run.cancelled",
    payload: { runId },
  });
  sendJson(response, 202, { ok: true });
}

async function handleSessionDiff(
  sessionId: string,
  response: ServerResponse,
): Promise<void> {
  const diff = await getSessionDiff(store, sessionId);
  sendJson(response, 200, { diff });
}

async function handleCreatePr(
  sessionId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = (await readJson(request)) as {
    githubToken?: string;
    title?: string;
    body?: string;
  };
  if (!body.githubToken) {
    sendJson(response, 400, { error: "githubToken is required" });
    return;
  }

  const pr = await pushAndCreatePr({
    store,
    sessionId,
    githubToken: body.githubToken,
    title: body.title,
    body: body.body,
  });
  sendJson(response, 201, pr);
}

async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    if (request.method === "OPTIONS") {
      sendJson(response, 204, {});
      return;
    }

    const url = routePath(request);
    const path = url.pathname;

    if (request.method === "GET" && path === "/healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && path === "/runs") {
      await handleCreateRun(request, response);
      return;
    }

    const runEventsMatch = path.match(/^\/runs\/([^/]+)\/events$/);
    if (request.method === "GET" && runEventsMatch?.[1]) {
      await handleRunEvents(runEventsMatch[1], response);
      return;
    }

    const runCancelMatch = path.match(/^\/runs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && runCancelMatch?.[1]) {
      await handleCancelRun(runCancelMatch[1], response);
      return;
    }

    const sessionDiffMatch = path.match(/^\/sessions\/([^/]+)\/diff$/);
    if (request.method === "GET" && sessionDiffMatch?.[1]) {
      await handleSessionDiff(sessionDiffMatch[1], response);
      return;
    }

    const sessionPrMatch = path.match(/^\/sessions\/([^/]+)\/pr$/);
    if (request.method === "POST" && sessionPrMatch?.[1]) {
      await handleCreatePr(sessionPrMatch[1], request, response);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { error: message });
  }
}

const server = createServer((request, response) => {
  void handler(request, response);
});

server.listen(env.apiPort, () => {
  console.log(`control-plane API listening on :${env.apiPort}`);
});
