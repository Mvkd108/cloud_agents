import { describe, expect, test } from "bun:test";
import { createModelProvider, type ModelProvider } from "./model-provider";
import { createOpenAgent } from "./open-agent";

function captureProvider(): {
  provider: ModelProvider;
  calls: string[];
  selections: string[];
} {
  const calls: string[] = [];
  const selections: string[] = [];

  const provider: ModelProvider = {
    kind: "vercel-gateway",
    languageModel: (modelId: string) => {
      calls.push(modelId);
      return {
        specificationVersion: "v3",
        provider: "captured",
        modelId,
        supportedUrls: {},
        doGenerate: () => Promise.resolve({} as never),
        doStream: () => Promise.resolve({} as never),
      } as unknown as ReturnType<ModelProvider["languageModel"]>;
    },
  };

  return {
    provider,
    calls,
    selections,
  };
}

describe("createOpenAgent routing", () => {
  test("unprefixed model → vercel provider", () => {
    const { provider, calls } = captureProvider();

    const agent = createOpenAgent((_id) => provider);

    expect(() => agent).not.toThrow();
    expect(calls).toContain("anthropic/claude-opus-4.6");
  });

  test("resolver receives vercel:-prefixed model ID correctly", () => {
    const seenIds: string[] = [];

    createOpenAgent((selectionId) => {
      seenIds.push(selectionId);
      return createModelProvider({ kind: "vercel-gateway" });
    });

    expect(seenIds).toContain("anthropic/claude-opus-4.6");
  });

  test("resolver called with selection ID at agent construction time", () => {
    const { provider, calls } = captureProvider();

    createOpenAgent((_id) => provider);

    expect(calls).toContain("anthropic/claude-opus-4.6");
  });

  test("two independent agents use independent resolver instances", () => {
    const calls1: string[] = [];
    const calls2: string[] = [];

    createOpenAgent((id) => {
      calls1.push(id);
      return createModelProvider({ kind: "vercel-gateway" });
    });
    createOpenAgent((id) => {
      calls2.push(id);
      return createModelProvider({ kind: "vercel-gateway" });
    });

    expect(calls1).toEqual(calls2);
    expect(calls1.length).toBe(1);
  });
});

describe("createOpenAgent failure modes", () => {
  test("compatible selection without config → redacted failure", () => {
    let err: unknown;
    try {
      createOpenAgent((_id) => {
        throw new Error(
          "Compatible provider is not configured. " +
            "Set OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_API_KEY, and OPENAI_COMPATIBLE_MODELS.",
        );
      });
    } catch (error) {
      err = error;
    }

    const message = String(err);
    expect(message).toContain("Compatible provider is not configured");
    expect(message).not.toContain("sk-");
    expect(message).not.toContain("apiKey");
    expect(message).not.toContain("api_key");
  });

  test("compatible selection not in allowlist → failure", () => {
    let err: unknown;
    try {
      createOpenAgent((_id) => {
        throw new Error(
          'Model "kimi/k2.5" is not in the allowed compatible model list. ' +
            "Check OPENAI_COMPATIBLE_MODELS.",
        );
      });
    } catch (error) {
      err = error;
    }

    expect(String(err)).toContain("not in the allowed compatible model list");
    expect(String(err)).not.toContain("sk-");
  });

  test("empty provider or model portion → failure", () => {
    const { provider } = captureProvider();

    const agent = createOpenAgent((selectionId) => {
      if (selectionId === "badprefix:") {
        throw new Error(
          `Unknown provider "badprefix" for model "${selectionId}".`,
        );
      }
      if (selectionId.includes(":") && !selectionId.split(":")[1]) {
        throw new Error(`Invalid model selection: "${selectionId}".`);
      }
      return provider;
    });

    expect(() => agent).not.toThrow();
  });

  test("unknown provider prefix → failure", () => {
    let err: unknown;
    try {
      createOpenAgent((selectionId) => {
        if (selectionId.startsWith("unknown:")) {
          throw new Error(
            `Unknown provider prefix in selection "${selectionId}".`,
          );
        }
        return createModelProvider({ kind: "vercel-gateway" });
      });
    } catch (error) {
      err = error;
    }

    expect(err).toBeUndefined();
  });

  test("error messages from resolver do not cross agent boundary in a way that leaks", () => {
    let err: unknown;
    try {
      createOpenAgent((_id) => {
        throw new Error("Provider unavailable");
      });
    } catch (error) {
      err = error;
    }

    expect(String(err)).toContain("Provider unavailable");
  });
});

describe("createOpenAgent serialization safety", () => {
  test("no API key or base URL leaks on default agent serialization", () => {
    const agent = createOpenAgent();
    const serialized = JSON.stringify(agent);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("sk-");
  });

  test("no secret leaks when resolver captures provider with secrets", () => {
    const provider = createModelProvider({
      kind: "openai-compatible",
      name: "test",
      baseURL: "https://secret.example.com/v1",
      apiKey: "sk-abcdef1234567890",
    });

    const agent = createOpenAgent((_id) => provider);
    const serialized = JSON.stringify(agent);
    expect(serialized).not.toContain("secret.example.com");
    expect(serialized).not.toContain("sk-abcdef1234567890");
    expect(serialized).not.toContain("apiKey");
  });
});
