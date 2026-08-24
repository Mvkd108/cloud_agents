import { afterEach, describe, expect, mock, test } from "bun:test";
import type { CompatibleModelDescriptor } from "./provider-config";

mock.module("server-only", () => ({}));

const { getDeploymentProviderConfig } = await import("./provider-config");

const BASE_URL_KEY = "OPENAI_COMPATIBLE_BASE_URL";
const API_KEY_KEY = "OPENAI_COMPATIBLE_API_KEY";
const MODELS_KEY = "OPENAI_COMPATIBLE_MODELS";
const TOOL_CAPABILITIES = {
  tools: true,
  vision: false,
  reasoning: true,
};

function enabledModel(
  input: Pick<CompatibleModelDescriptor, "id" | "name"> &
    Partial<Pick<CompatibleModelDescriptor, "contextWindow" | "description">>,
): CompatibleModelDescriptor {
  return {
    contextWindow: 128_000,
    ...input,
    enabled: true,
    capabilities: TOOL_CAPABILITIES,
  };
}

afterEach(() => {
  delete process.env[BASE_URL_KEY];
  delete process.env[API_KEY_KEY];
  delete process.env[MODELS_KEY];
});

describe("getDeploymentProviderConfig", () => {
  test("returns undefined when no env vars are set", () => {
    expect(getDeploymentProviderConfig()).toBeUndefined();
  });

  test("returns undefined when only base URL is set", () => {
    process.env[BASE_URL_KEY] = "https://api.example.com/v1";
    expect(getDeploymentProviderConfig()).toBeUndefined();
  });

  test("returns undefined when models env var is missing", () => {
    process.env[BASE_URL_KEY] = "https://api.example.com/v1";
    process.env[API_KEY_KEY] = "sk-test";
    expect(getDeploymentProviderConfig()).toBeUndefined();
  });

  test("returns undefined for malformed JSON in models env var", () => {
    process.env[BASE_URL_KEY] = "https://api.example.com/v1";
    process.env[API_KEY_KEY] = "sk-test";
    process.env[MODELS_KEY] = "{invalid";
    expect(getDeploymentProviderConfig()).toBeUndefined();
  });

  test("returns undefined when models fail schema validation", () => {
    process.env[BASE_URL_KEY] = "https://api.example.com/v1";
    process.env[API_KEY_KEY] = "sk-test";
    process.env[MODELS_KEY] = JSON.stringify([{ name: "Missing ID" }]);
    expect(getDeploymentProviderConfig()).toBeUndefined();
  });

  test("returns valid config with single model", () => {
    process.env[BASE_URL_KEY] = "https://api.moonshot.local/v1";
    process.env[API_KEY_KEY] = "sk-test";
    process.env[MODELS_KEY] = JSON.stringify([
      enabledModel({ id: "moonshotai/kimi-k2.5", name: "Kimi K2.5" }),
    ]);

    const config = getDeploymentProviderConfig();
    expect(config).toEqual({
      name: "compatible",
      baseURL: "https://api.moonshot.local/v1",
      apiKey: "sk-test",
      models: [enabledModel({ id: "moonshotai/kimi-k2.5", name: "Kimi K2.5" })],
    });
  });

  test("returns valid config with multiple models and context windows", () => {
    process.env[BASE_URL_KEY] = "https://api.deepseek.local/v1";
    process.env[API_KEY_KEY] = "sk-test-deepseek";
    process.env[MODELS_KEY] = JSON.stringify([
      enabledModel({
        id: "deepseek/deepseek-v3.2",
        name: "DeepSeek V3.2",
        contextWindow: 131072,
        description: "DeepSeek flagship model",
      }),
      enabledModel({
        id: "deepseek/deepseek-r1-0528",
        name: "DeepSeek R1",
        contextWindow: 131072,
      }),
    ]);

    const config = getDeploymentProviderConfig();
    expect(config).toEqual({
      name: "compatible",
      baseURL: "https://api.deepseek.local/v1",
      apiKey: "sk-test-deepseek",
      models: [
        enabledModel({
          id: "deepseek/deepseek-v3.2",
          name: "DeepSeek V3.2",
          contextWindow: 131072,
          description: "DeepSeek flagship model",
        }),
        enabledModel({
          id: "deepseek/deepseek-r1-0528",
          name: "DeepSeek R1",
          contextWindow: 131072,
        }),
      ],
    });
  });

  test("trims whitespace from env var values", () => {
    process.env[BASE_URL_KEY] = "  https://api.example.com/v1  ";
    process.env[API_KEY_KEY] = "  sk-test  ";
    process.env[MODELS_KEY] = `  ${JSON.stringify([
      enabledModel({ id: "test/model", name: "Test" }),
    ])}  `;

    const config = getDeploymentProviderConfig();
    expect(config).toEqual({
      name: "compatible",
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      models: [enabledModel({ id: "test/model", name: "Test" })],
    });
  });

  test("requires model ID to be non-empty", () => {
    process.env[BASE_URL_KEY] = "https://api.example.com/v1";
    process.env[API_KEY_KEY] = "sk-test";
    process.env[MODELS_KEY] = JSON.stringify([{ id: "", name: "Empty ID" }]);
    expect(getDeploymentProviderConfig()).toBeUndefined();
  });

  test("requires model name to be non-empty", () => {
    process.env[BASE_URL_KEY] = "https://api.example.com/v1";
    process.env[API_KEY_KEY] = "sk-test";
    process.env[MODELS_KEY] = JSON.stringify([{ id: "test/model", name: "" }]);
    expect(getDeploymentProviderConfig()).toBeUndefined();
  });

  test("requires explicit capability and context metadata", () => {
    process.env[BASE_URL_KEY] = "https://api.example.com/v1";
    process.env[API_KEY_KEY] = "sk-test";
    process.env[MODELS_KEY] = JSON.stringify([
      { id: "test/model", name: "Test", enabled: true },
    ]);

    expect(getDeploymentProviderConfig()).toBeUndefined();
  });

  test("emits console.error for partial configuration (fail-closed)", () => {
    const errorCalls: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorCalls.push(args);
    };

    try {
      process.env[BASE_URL_KEY] = "https://api.example.com/v1";
      process.env[API_KEY_KEY] = "sk-test";

      const result = getDeploymentProviderConfig();
      expect(result).toBeUndefined();
      expect(errorCalls.length).toBeGreaterThan(0);
      expect(errorCalls[0]?.[0]).toContain("incomplete");
    } finally {
      console.error = originalError;
    }
  });

  test("distinguishes not-configured from configured-but-invalid", () => {
    const errorCalls: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorCalls.push(args);
    };

    try {
      const notConfigured = getDeploymentProviderConfig();
      expect(notConfigured).toBeUndefined();
      const notConfiguredErrorCount = errorCalls.length;

      errorCalls.length = 0;

      process.env[BASE_URL_KEY] = "https://api.example.com/v1";
      process.env[API_KEY_KEY] = "sk-test";
      process.env[MODELS_KEY] = "[invalid";

      const invalid = getDeploymentProviderConfig();
      expect(invalid).toBeUndefined();
      expect(errorCalls.length).toBeGreaterThan(notConfiguredErrorCount);
    } finally {
      console.error = originalError;
    }
  });

  test("partial config: two of three vars set emits error", () => {
    const errorCalls: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorCalls.push(args);
    };

    try {
      process.env[BASE_URL_KEY] = "https://api.example.com/v1";
      process.env[MODELS_KEY] = '[{"id":"x","name":"X"}]';

      const result = getDeploymentProviderConfig();
      expect(result).toBeUndefined();
      expect(errorCalls.length).toBeGreaterThan(0);
    } finally {
      console.error = originalError;
    }
  });
});
