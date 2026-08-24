import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
mock.module("./models-with-context", () => ({
  fetchAvailableLanguageModelsWithContext: async () => [
    { id: "openai/gpt-test", name: "GPT Test", modelType: "language" },
  ],
}));

const originalEnvironment = {
  baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL,
  apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
  models: process.env.OPENAI_COMPATIBLE_MODELS,
};

const { fetchProviderAwareModels } = await import("./provider-catalog");

afterEach(() => {
  if (originalEnvironment.baseURL === undefined) {
    delete process.env.OPENAI_COMPATIBLE_BASE_URL;
  } else {
    process.env.OPENAI_COMPATIBLE_BASE_URL = originalEnvironment.baseURL;
  }
  if (originalEnvironment.apiKey === undefined) {
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
  } else {
    process.env.OPENAI_COMPATIBLE_API_KEY = originalEnvironment.apiKey;
  }
  if (originalEnvironment.models === undefined) {
    delete process.env.OPENAI_COMPATIBLE_MODELS;
  } else {
    process.env.OPENAI_COMPATIBLE_MODELS = originalEnvironment.models;
  }
});

describe("fetchProviderAwareModels", () => {
  test("shows only enabled compatible models that support tools", async () => {
    process.env.OPENAI_COMPATIBLE_BASE_URL = "https://models.example/v1";
    process.env.OPENAI_COMPATIBLE_API_KEY = "test-key";
    process.env.OPENAI_COMPATIBLE_MODELS = JSON.stringify([
      {
        id: "open/model-ready",
        name: "Ready Model",
        contextWindow: 131_072,
        enabled: true,
        capabilities: { tools: true, vision: false, reasoning: true },
      },
      {
        id: "open/model-disabled",
        name: "Disabled Model",
        contextWindow: 131_072,
        enabled: false,
        capabilities: { tools: true, vision: false, reasoning: false },
      },
      {
        id: "open/model-no-tools",
        name: "No Tools",
        contextWindow: 131_072,
        enabled: true,
        capabilities: { tools: false, vision: true, reasoning: false },
      },
    ]);

    const models = await fetchProviderAwareModels();

    expect(models.map((model) => model.id)).toEqual([
      "openai/gpt-test",
      "compatible:open/model-ready",
    ]);
    expect(models[1]?.capabilities).toEqual({
      tools: true,
      vision: false,
      reasoning: true,
    });
  });
});
