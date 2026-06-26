import { describe, expect, test } from "bun:test";
import { parseJsonLines, terminalCodexUsage } from "./events.ts";

describe("parseJsonLines", () => {
  test("parses complete JSONL events and keeps an incomplete remainder", () => {
    const parsed = parseJsonLines(
      '{"type":"thread.started","thread_id":"thr_1"}\n{"type":"turn.',
    );

    expect(parsed.events).toEqual([
      { type: "thread.started", thread_id: "thr_1" },
    ]);
    expect(parsed.remainder).toBe('{"type":"turn.');
  });

  test("preserves malformed lines as raw events", () => {
    const parsed = parseJsonLines("not json\n");

    expect(parsed.events).toEqual([{ type: "codex.raw", text: "not json" }]);
    expect(parsed.remainder).toBe("");
  });
});

describe("terminalCodexUsage", () => {
  test("normalizes Codex token usage", () => {
    expect(
      terminalCodexUsage({
        type: "turn.completed",
        usage: {
          input_tokens: 12,
          output_tokens: 7,
        },
      }),
    ).toEqual({ inputTokens: 12, outputTokens: 7 });
  });
});
