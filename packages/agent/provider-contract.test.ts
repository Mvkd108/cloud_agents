import { describe, expect, test } from "bun:test";
import {
  generateText,
  simulateReadableStream,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { normalizeModelProviderError } from "./model-provider";

const USAGE = {
  inputTokens: {
    total: 12,
    noCache: 12,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const STOP_FINISH_REASON = { unified: "stop" as const, raw: undefined };
const TOOL_FINISH_REASON = {
  unified: "tool-calls" as const,
  raw: undefined,
};

describe("hosted model provider contract", () => {
  test("streams text and extracts usage", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "hello" },
            { type: "text-delta", id: "text-1", delta: " world" },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: STOP_FINISH_REASON,
              usage: USAGE,
            },
          ],
        }),
      }),
    });

    const result = streamText({ model, prompt: "Say hello" });

    expect(await result.text).toBe("hello world");
    expect(await result.totalUsage).toMatchObject({
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
    });
  });

  test("supports structured arguments and multi-step tool use", async () => {
    const toolInputs: Array<{ path: string }> = [];
    const responses: LanguageModelV3GenerateResult[] = [
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_file",
            input: JSON.stringify({ path: "package.json" }),
          },
        ],
        finishReason: TOOL_FINISH_REASON,
        usage: USAGE,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "Repository inspected." }],
        finishReason: STOP_FINISH_REASON,
        usage: USAGE,
        warnings: [],
      },
    ];
    let responseIndex = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => responses[responseIndex++] ?? responses[1]!,
    });

    const result = await generateText({
      model,
      prompt: "Inspect the repository",
      tools: {
        read_file: tool({
          inputSchema: z.object({ path: z.string() }),
          execute: async (input) => {
            toolInputs.push(input);
            return { content: "{}" };
          },
        }),
      },
      stopWhen: stepCountIs(3),
    });

    expect(toolInputs).toEqual([{ path: "package.json" }]);
    expect(result.steps).toHaveLength(2);
    expect(result.text).toBe("Repository inspected.");
  });

  test("forwards cancellation signals to the provider", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        receivedSignal = options.abortSignal;
        return {
          content: [{ type: "text", text: "done" }],
          finishReason: STOP_FINISH_REASON,
          usage: USAGE,
          warnings: [],
        };
      },
    });

    await generateText({
      model,
      prompt: "Complete",
      abortSignal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  test("normalizes timeout, cancellation, and rate-limit failures", () => {
    const timeout = new Error("upstream timed out");
    timeout.name = "TimeoutError";
    expect(normalizeModelProviderError(timeout)).toEqual({
      code: "timeout",
      message: "Model request timed out",
      retryable: true,
    });

    const aborted = new Error("contains provider internals");
    aborted.name = "AbortError";
    expect(normalizeModelProviderError(aborted)).toEqual({
      code: "aborted",
      message: "Model request was cancelled",
      retryable: false,
    });

    expect(normalizeModelProviderError({ statusCode: 429 })).toEqual({
      code: "rate_limit",
      message: "Model provider rate limit exceeded",
      retryable: true,
      statusCode: 429,
    });
  });
});
