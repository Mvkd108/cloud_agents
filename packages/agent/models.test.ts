import { describe, expect, mock, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ProviderOptionsByProvider } from "./models";

const defaultProviderConfigs: Array<Record<string, unknown>> = [];
const defaultProviderModelIds: string[] = [];
const wrapCalls: Array<{ model: unknown; middleware: unknown }> = [];

function mockLanguageModel(id: string): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "mock",
    modelId: id,
    supportedUrls: {},
    doGenerate: () => Promise.resolve({} as never),
    doStream: () => Promise.resolve({} as never),
  } as unknown as LanguageModelV3;
}

mock.module("./model-provider", () => {
  const defaultProvider = {
    kind: "vercel-gateway",
    languageModel: (modelId: string) => {
      defaultProviderModelIds.push(modelId);
      return mockLanguageModel(modelId);
    },
  };

  return {
    createModelProvider: (config: Record<string, unknown>) => {
      defaultProviderConfigs.push(config);
      return defaultProvider;
    },
  };
});

mock.module("@ai-sdk/provider", () => {
  return {};
});

mock.module("ai", () => {
  return {
    createGateway: () => ({ languageModel: () => mockLanguageModel("") }),
    defaultSettingsMiddleware: (_settings: unknown) => ({
      kind: "default-settings-middleware",
    }),
    wrapLanguageModel: ({
      model,
      middleware,
    }: {
      model: unknown;
      middleware: unknown;
    }) => {
      wrapCalls.push({ model, middleware });
      return model;
    },
  };
});

const {
  gateway,
  applyModelMiddleware,
  getProviderOptionsForModel,
  mergeProviderOptions,
  shouldApplyOpenAIReasoningDefaults,
} = await import("./models");

describe("shouldApplyOpenAIReasoningDefaults", () => {
  test("returns true for existing GPT-5 variants", () => {
    expect(shouldApplyOpenAIReasoningDefaults("openai/gpt-5.3")).toBe(true);
    expect(shouldApplyOpenAIReasoningDefaults("openai/gpt-5.4")).toBe(true);
  });

  test("returns true for future GPT-5 variants", () => {
    expect(shouldApplyOpenAIReasoningDefaults("openai/gpt-5.9")).toBe(true);
  });

  test("returns false for non-GPT-5 OpenAI models", () => {
    expect(shouldApplyOpenAIReasoningDefaults("openai/gpt-4o")).toBe(false);
  });
});

describe("getProviderOptionsForModel", () => {
  test("applies adaptive thinking defaults to Anthropic 4.6 models", () => {
    const result = getProviderOptionsForModel("anthropic/claude-sonnet-4.6");

    expect(result).toEqual({
      anthropic: {
        effort: "medium",
        thinking: { type: "adaptive" },
      },
    });
  });

  test("applies adaptive thinking defaults to Anthropic 4.7 models", () => {
    const result = getProviderOptionsForModel("anthropic/claude-opus-4.7");

    expect(result).toEqual({
      anthropic: {
        effort: "medium",
        thinking: { type: "adaptive" },
      },
    });
  });

  test("preserves legacy thinking defaults for older Anthropic models", () => {
    const result = getProviderOptionsForModel("anthropic/claude-opus-4.5");

    expect(result).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 8000,
        },
      },
    });
  });

  test("merges OpenAI defaults with custom variant options", () => {
    const result = getProviderOptionsForModel("openai/gpt-5", {
      openai: {
        reasoningEffort: "medium",
      },
    });

    expect(result).toEqual({
      openai: {
        reasoningSummary: "detailed",
        include: ["reasoning.encrypted_content"],
        reasoningEffort: "medium",
        store: false,
      },
    });
  });

  test("applies low text verbosity defaults to GPT-5.4 snapshots", () => {
    const result = getProviderOptionsForModel("openai/gpt-5.4-2026-03-05");

    expect(result).toEqual({
      openai: {
        reasoningSummary: "detailed",
        include: ["reasoning.encrypted_content"],
        store: false,
        textVerbosity: "low",
      },
    });
  });

  test("preserves store false and encrypted reasoning content for the built-in GPT-5.4 variant", () => {
    const result = getProviderOptionsForModel("openai/gpt-5.4", {
      openai: {
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
      },
    });

    expect(result).toEqual({
      openai: {
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
        store: false,
        textVerbosity: "low",
      },
    });
  });

  test("enforces store false for OpenAI models even when variant overrides it", () => {
    const result = getProviderOptionsForModel("openai/gpt-5", {
      openai: {
        store: true,
      },
    });

    expect(result).toEqual({
      openai: {
        reasoningSummary: "detailed",
        include: ["reasoning.encrypted_content"],
        store: false,
      },
    });
  });

  test("applies store false to non-GPT-5 OpenAI models", () => {
    const result = getProviderOptionsForModel("openai/gpt-4o");

    expect(result).toEqual({
      openai: {
        store: false,
      },
    });
  });
});

describe("mergeProviderOptions", () => {
  test("returns defaults when overrides are undefined", () => {
    const defaults: ProviderOptionsByProvider = {
      openai: {
        reasoningEffort: "high",
      },
    };

    expect(mergeProviderOptions(defaults)).toEqual(defaults);
  });

  test("deep merges nested provider options", () => {
    const defaults: ProviderOptionsByProvider = {
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 8000,
        },
      },
    };

    const overrides: ProviderOptionsByProvider = {
      anthropic: {
        thinking: {
          budgetTokens: 4000,
        },
      },
    };

    expect(mergeProviderOptions(defaults, overrides)).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 4000,
        },
      },
    });
  });

  test("adds provider overrides that do not exist in defaults", () => {
    const defaults: ProviderOptionsByProvider = {
      openai: {
        store: false,
      },
    };

    const overrides: ProviderOptionsByProvider = {
      anthropic: {
        effort: "low",
      },
    };

    expect(mergeProviderOptions(defaults, overrides)).toEqual({
      openai: {
        store: false,
      },
      anthropic: {
        effort: "low",
      },
    });
  });

  test("replaces arrays instead of deep-merging arrays", () => {
    const defaults: ProviderOptionsByProvider = {
      openai: {
        include: ["reasoning.encrypted_content"],
      },
    };

    const overrides: ProviderOptionsByProvider = {
      openai: {
        include: ["reasoning.summary"],
      },
    };

    expect(mergeProviderOptions(defaults, overrides)).toEqual({
      openai: {
        include: ["reasoning.summary"],
      },
    });
  });
});

describe("gateway", () => {
  test("resolves a model through the default vercel provider", () => {
    defaultProviderConfigs.length = 0;
    defaultProviderModelIds.length = 0;

    const model = gateway("deepseek/deepseek-v3.2");

    expect(defaultProviderConfigs).toContainEqual({ kind: "vercel-gateway" });
    expect(defaultProviderModelIds).toEqual(["deepseek/deepseek-v3.2"]);
    expect(model.modelId).toBe("deepseek/deepseek-v3.2");
  });

  test("applies provider-option middleware after model resolution", () => {
    wrapCalls.length = 0;
    defaultProviderModelIds.length = 0;

    const model = gateway("openai/gpt-5");

    expect(defaultProviderModelIds).toEqual(["openai/gpt-5"]);
    expect(wrapCalls).toHaveLength(1);
    const firstWrapCall = wrapCalls[0];
    if (!firstWrapCall) {
      throw new Error("Expected a wrap call");
    }
    expect(firstWrapCall.middleware).toEqual({
      kind: "default-settings-middleware",
    });
    expect(model.modelId).toBe("openai/gpt-5");
  });
});

describe("applyModelMiddleware", () => {
  test("returns the model unchanged when no provider options are generated", () => {
    wrapCalls.length = 0;
    const raw = mockLanguageModel("test/empty");

    const result = applyModelMiddleware(raw, "test/empty");

    expect(wrapCalls).toHaveLength(0);
    expect(result).toBe(raw);
  });

  test("applies middleware when provider options are generated", () => {
    wrapCalls.length = 0;
    const raw = mockLanguageModel("openai/gpt-5");

    const result = applyModelMiddleware(raw, "openai/gpt-5");

    expect(wrapCalls).toHaveLength(1);
    expect(result).toBe(raw);
  });
});
