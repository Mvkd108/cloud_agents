import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { createModelProvider } from "../model-provider";

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const baseURL = requireEnvironment("OPENAI_COMPATIBLE_BASE_URL");
const apiKey = requireEnvironment("OPENAI_COMPATIBLE_API_KEY");
const modelId = requireEnvironment("OPENAI_COMPATIBLE_CONTRACT_MODEL_ID");
const provider = createModelProvider({
  kind: "openai-compatible",
  name: "compatible-contract",
  baseURL,
  apiKey,
});

const files = new Map<string, string>([
  [
    "src/math.ts",
    "export function add(a: number, b: number) {\n  return a - b;\n}\n",
  ],
  [
    "src/math.test.ts",
    'import { add } from "./math";\nif (add(2, 3) !== 5) throw new Error("failed");\n',
  ],
]);
let wroteFile = false;
let passedTests = false;

const result = streamText({
  model: provider.languageModel(modelId),
  prompt: `Fix the bug in this tiny TypeScript repository. You must inspect the
relevant files, write the correction, and run the tests. Do not merely describe
the change; use the tools until the tests pass.`,
  abortSignal: AbortSignal.timeout(120_000),
  stopWhen: stepCountIs(10),
  tools: {
    read_file: tool({
      description: "Read a file from the qualification repository",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => ({
        path,
        content: files.get(path) ?? null,
      }),
    }),
    write_file: tool({
      description: "Replace a file in the qualification repository",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        if (path !== "src/math.ts") {
          return { success: false, error: "Only src/math.ts may be edited" };
        }
        files.set(path, content);
        wroteFile = true;
        return { success: true };
      },
    }),
    run_tests: tool({
      description: "Run the qualification repository tests",
      inputSchema: z.object({}),
      execute: async () => {
        const implementation = files.get("src/math.ts") ?? "";
        passedTests = /return\s+a\s*\+\s*b/.test(implementation);
        return {
          success: passedTests,
          output: passedTests ? "1 test passed" : "1 test failed",
        };
      },
    }),
  },
});

await result.consumeStream();
const usage = await result.totalUsage;
const steps = await result.steps;

if (!wroteFile || !passedTests) {
  throw new Error(
    "Provider failed the repository-editing contract: it must edit the file and pass tests",
  );
}

console.log(
  JSON.stringify({
    ok: true,
    modelId,
    steps: steps.length,
    usage,
  }),
);
