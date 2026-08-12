import { describe, expect, mock, test } from "bun:test";

const gatewayCalls: Array<Record<string, unknown>> = [];
const compatibleCalls: Array<Record<string, unknown>> = [];
const gatewayModelIds: string[] = [];
const compatibleModelIds: string[] = [];

mock.module("ai", () => {
  return {
    createGateway: (settings: Record<string, unknown>) => {
      gatewayCalls.push(settings);
      return {
        languageModel: (modelId: string) => {
          gatewayModelIds.push(modelId);
          return { provider: "gateway", modelId };
        },
      };
    },
  };
});

mock.module("@ai-sdk/openai-compatible", () => {
  return {
    createOpenAICompatible: (settings: Record<string, unknown>) => {
      compatibleCalls.push(settings);
      return {
        languageModel: (modelId: string) => {
          compatibleModelIds.push(modelId);
          return { provider: "openai-compatible", modelId };
        },
      };
    },
  };
});

const { createModelProvider } = await import("./model-provider");

const DEFAULT_HEADERS = {
  "http-referer": "https://open-agents.dev",
  "x-title": "Open Agents",
};

describe("createModelProvider", () => {
  test("vercel-gateway uses createGateway with default attribution headers", () => {
    gatewayCalls.length = 0;
    compatibleCalls.length = 0;
    gatewayModelIds.length = 0;

    const provider = createModelProvider({ kind: "vercel-gateway" });

    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toEqual({ headers: DEFAULT_HEADERS });
    expect(compatibleCalls).toHaveLength(0);

    const model = provider.languageModel("moonshotai/kimi-k2.5");
    expect(gatewayModelIds).toEqual(["moonshotai/kimi-k2.5"]);
    expect(model).toBeDefined();
  });

  test("openai-compatible uses createOpenAICompatible with config and default headers", () => {
    gatewayCalls.length = 0;
    compatibleCalls.length = 0;
    compatibleModelIds.length = 0;

    const provider = createModelProvider({
      kind: "openai-compatible",
      name: "moonshot",
      baseURL: "https://api.moonshot.local/v1",
      apiKey: "sk-test-secret-key",
    });

    expect(compatibleCalls).toHaveLength(1);
    expect(compatibleCalls[0]).toEqual({
      name: "moonshot",
      baseURL: "https://api.moonshot.local/v1",
      apiKey: "sk-test-secret-key",
      headers: DEFAULT_HEADERS,
    });
    expect(gatewayCalls).toHaveLength(0);

    const model = provider.languageModel("moonshotai/kimi-k2.5");
    expect(compatibleModelIds).toEqual(["moonshotai/kimi-k2.5"]);
    expect(model).toBeDefined();
  });

  test("attribution overrides replace the defaults", () => {
    gatewayCalls.length = 0;

    createModelProvider(
      { kind: "vercel-gateway" },
      { appName: "Test App", appUrl: "https://test.example.com" },
    );

    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toEqual({
      headers: {
        "http-referer": "https://test.example.com",
        "x-title": "Test App",
      },
    });
  });

  test("does not expose apiKey or baseURL on the returned provider", () => {
    const provider = createModelProvider({
      kind: "openai-compatible",
      name: "moonshot",
      baseURL: "https://secret.example.com/v1",
      apiKey: "sk-super-secret-api-key",
    });

    const serialized = JSON.stringify(provider);

    expect(serialized).not.toContain("sk-super-secret-api-key");
    expect(serialized).not.toContain("https://secret.example.com/v1");
  });
});
