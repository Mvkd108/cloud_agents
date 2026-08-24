import { describe, expect, test } from "bun:test";
import { resolveProviderModelId } from "./resolve-provider-model-id";

describe("resolveProviderModelId", () => {
  test("parses a vercel-prefixed gateway model ID", () => {
    expect(resolveProviderModelId("vercel:deepseek/deepseek-v3.2")).toEqual({
      providerRef: "vercel",
      providerModelId: "deepseek/deepseek-v3.2",
    });
  });

  test("parses a compatible-prefixed model ID", () => {
    expect(resolveProviderModelId("compatible:kimi/k2.5")).toEqual({
      providerRef: "compatible",
      providerModelId: "kimi/k2.5",
    });
  });

  test("defaults to vercel provider when no prefix is present", () => {
    expect(resolveProviderModelId("anthropic/claude-opus-4.6")).toEqual({
      providerRef: "vercel",
      providerModelId: "anthropic/claude-opus-4.6",
    });
  });

  test("handles model IDs with multiple colons", () => {
    expect(
      resolveProviderModelId("compatible:provider/sub:model:name"),
    ).toEqual({
      providerRef: "compatible",
      providerModelId: "provider/sub:model:name",
    });
  });

  test("two providers with the same model ID produce different results", () => {
    const vercel = resolveProviderModelId("vercel:shared-model");
    const compatible = resolveProviderModelId("compatible:shared-model");

    expect(vercel).toEqual({
      providerRef: "vercel",
      providerModelId: "shared-model",
    });
    expect(compatible).toEqual({
      providerRef: "compatible",
      providerModelId: "shared-model",
    });
  });

  test("producer model ID is stable after round-trip parsing", () => {
    const selectionId = "compatible:moonshotai/kimi-k2.5";
    const resolved = resolveProviderModelId(selectionId);
    const reconstructed = `${resolved.providerRef}:${resolved.providerModelId}`;
    expect(reconstructed).toBe(selectionId);
  });
});
