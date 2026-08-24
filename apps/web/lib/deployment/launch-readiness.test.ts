import { describe, expect, test } from "bun:test";
import { evaluateLaunchReadiness } from "./launch-readiness";

const validEnvironment = {
  POSTGRES_URL: "postgresql://user:password@db.example/app",
  BETTER_AUTH_SECRET: "a-secure-session-secret-with-32-chars",
  BETTER_AUTH_URL: "https://agents.example.com",
  NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: "vercel-client",
  VERCEL_APP_CLIENT_SECRET: "vercel-secret",
  NEXT_PUBLIC_GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: "private-key",
  NEXT_PUBLIC_GITHUB_APP_SLUG: "agents-example",
  GITHUB_WEBHOOK_SECRET: "webhook-secret",
  REDIS_URL: "rediss://cache.example:6379",
  OPENAI_COMPATIBLE_BASE_URL: "https://models.example/v1",
  OPENAI_COMPATIBLE_API_KEY: "provider-secret",
  OPENAI_COMPATIBLE_MODELS: JSON.stringify([
    {
      id: "open/model",
      name: "Open Model",
      contextWindow: 131_072,
      enabled: true,
      capabilities: { tools: true, vision: false, reasoning: true },
    },
  ]),
};

describe("evaluateLaunchReadiness", () => {
  test("passes a complete launch environment", () => {
    const report = evaluateLaunchReadiness(validEnvironment);

    expect(report.ready).toBe(true);
    expect(report.checks.every((item) => item.status === "pass")).toBe(true);
  });

  test("blocks launch when production rate limiting is unavailable", () => {
    const { REDIS_URL: _redisUrl, ...environment } = validEnvironment;
    const report = evaluateLaunchReadiness(environment);

    expect(report.ready).toBe(false);
    expect(report.checks.find((item) => item.id === "rate-limiting")).toEqual({
      id: "rate-limiting",
      label: "Production rate limiting",
      status: "block",
      message:
        "Set REDIS_URL or KV_URL; production API operations return 503 without one.",
    });
  });

  test("accepts KV_URL as the production rate-limit store", () => {
    const { REDIS_URL: _redisUrl, ...environment } = validEnvironment;
    const report = evaluateLaunchReadiness({
      ...environment,
      KV_URL: "rediss://cache.example:6379",
    });

    expect(report.ready).toBe(true);
  });

  test("blocks incomplete compatible provider configuration", () => {
    const { OPENAI_COMPATIBLE_API_KEY: _apiKey, ...environment } =
      validEnvironment;
    const report = evaluateLaunchReadiness(environment);

    expect(report.ready).toBe(false);
    expect(
      report.checks.find((item) => item.id === "compatible-provider")?.status,
    ).toBe("block");
  });

  test("blocks duplicate compatible model IDs", () => {
    const descriptor = JSON.parse(
      validEnvironment.OPENAI_COMPATIBLE_MODELS,
    ) as unknown[];
    const report = evaluateLaunchReadiness({
      ...validEnvironment,
      OPENAI_COMPATIBLE_MODELS: JSON.stringify([...descriptor, ...descriptor]),
    });

    expect(report.ready).toBe(false);
    expect(
      report.checks.find((item) => item.id === "compatible-provider")?.message,
    ).toBe("OPENAI_COMPATIBLE_MODELS contains duplicate model IDs.");
  });

  test("never includes configured secret values in the report", () => {
    const report = evaluateLaunchReadiness({
      ...validEnvironment,
      GITHUB_APP_ID: "not-an-id",
    });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(validEnvironment.BETTER_AUTH_SECRET);
    expect(serialized).not.toContain(validEnvironment.GITHUB_CLIENT_SECRET);
    expect(serialized).not.toContain(
      validEnvironment.OPENAI_COMPATIBLE_API_KEY,
    );
  });
});
