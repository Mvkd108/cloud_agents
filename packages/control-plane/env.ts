export interface ControlPlaneEnv {
  postgresUrl: string;
  redisUrl: string;
  fireworksApiKey?: string;
  e2bApiKey?: string;
  e2bTemplate?: string;
  defaultModel?: string;
  apiPort: number;
}

export function loadControlPlaneEnv(
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneEnv {
  const postgresUrl = env["POSTGRES_URL"];
  const redisUrl = env["REDIS_URL"];

  if (!postgresUrl) {
    throw new Error("POSTGRES_URL is required");
  }
  if (!redisUrl) {
    throw new Error("REDIS_URL is required");
  }

  return {
    postgresUrl,
    redisUrl,
    fireworksApiKey: env["FIREWORKS_API_KEY"],
    e2bApiKey: env["E2B_API_KEY"],
    e2bTemplate: env["E2B_CODEX_TEMPLATE"],
    defaultModel:
      env["CODEX_DEFAULT_MODEL"] ?? "accounts/fireworks/models/kimi-k2p5",
    apiPort: Number.parseInt(env["PORT"] ?? "8787", 10),
  };
}
