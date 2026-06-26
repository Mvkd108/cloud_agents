import type { CodexJsonEvent } from "./types.ts";

export function parseJsonLines(buffer: string): {
  events: CodexJsonEvent[];
  remainder: string;
} {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  const events: CodexJsonEvent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      events.push(JSON.parse(trimmed) as CodexJsonEvent);
    } catch {
      events.push({ type: "codex.raw", text: trimmed });
    }
  }

  return { events, remainder };
}

export function terminalCodexUsage(event: CodexJsonEvent):
  | {
      inputTokens?: number;
      outputTokens?: number;
    }
  | undefined {
  const usage = event.usage;
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
}
