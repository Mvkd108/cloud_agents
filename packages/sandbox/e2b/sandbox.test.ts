import { describe, expect, test } from "bun:test";
import { buildCodexConfig } from "./sandbox.ts";

describe("buildCodexConfig", () => {
  test("defaults Codex to Fireworks chat-compatible provider", () => {
    const config = buildCodexConfig();

    expect(config).toContain('model_provider = "fireworks"');
    expect(config).toContain('model = "accounts/fireworks/models/kimi-k2p5"');
    expect(config).toContain(
      'base_url = "https://api.fireworks.ai/inference/v1"',
    );
    expect(config).toContain('env_key = "FIREWORKS_API_KEY"');
    expect(config).toContain('wire_api = "chat"');
  });

  test("allows provider overrides for compatibility spikes", () => {
    const config = buildCodexConfig({
      providerId: "proxy",
      baseUrl: "http://localhost:8788/v1",
      envKey: "PROXY_API_KEY",
      model: "custom/model",
      wireApi: "responses",
    });

    expect(config).toContain('model_provider = "proxy"');
    expect(config).toContain('model = "custom/model"');
    expect(config).toContain('base_url = "http://localhost:8788/v1"');
    expect(config).toContain('env_key = "PROXY_API_KEY"');
    expect(config).toContain('wire_api = "responses"');
  });
});
