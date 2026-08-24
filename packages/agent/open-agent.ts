import type { SandboxState } from "@open-agents/sandbox";
import { stepCountIs, ToolLoopAgent, type ToolSet } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { z } from "zod";
import { addCacheControl } from "./context-management";
import { createModelProvider, type ModelProvider } from "./model-provider";
import { applyModelMiddleware, type ProviderOptionsByProvider } from "./models";
import { resolveProviderModelId } from "./resolve-provider-model-id";

import type { SkillMetadata } from "./skills/types";
import { buildSystemPrompt } from "./system-prompt";
import {
  askUserQuestionTool,
  bashTool,
  editFileTool,
  globTool,
  grepTool,
  installDependenciesTool,
  readFileTool,
  skillTool,
  taskTool,
  todoWriteTool,
  webFetchTool,
  writeFileTool,
} from "./tools";

export interface AgentModelSelection {
  id: string;
  providerOptionsOverrides?: ProviderOptionsByProvider;
}

export type OpenAgentModelInput = string | AgentModelSelection;

export interface AgentSandboxContext {
  state: SandboxState;
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
}

const callOptionsSchema = z.object({
  sandbox: z.custom<AgentSandboxContext>(),
  model: z.custom<OpenAgentModelInput>().optional(),
  subagentModel: z.custom<OpenAgentModelInput>().optional(),
  customInstructions: z.string().optional(),
  skills: z.custom<SkillMetadata[]>().optional(),
});

export type OpenAgentCallOptions = z.infer<typeof callOptionsSchema>;

export const defaultModelLabel = "anthropic/claude-opus-4.6" as const;

function normalizeAgentModelSelection(
  selection: OpenAgentModelInput | undefined,
  fallbackId: string,
): AgentModelSelection {
  if (!selection) {
    return { id: fallbackId };
  }

  return typeof selection === "string" ? { id: selection } : selection;
}

const tools = {
  todo_write: todoWriteTool,
  read: readFileTool(),
  write: writeFileTool(),
  edit: editFileTool(),
  grep: grepTool(),
  glob: globTool(),
  bash: bashTool(),
  install_dependencies: installDependenciesTool,
  task: taskTool,
  ask_user_question: askUserQuestionTool,
  skill: skillTool,
  web_fetch: webFetchTool,
} satisfies ToolSet;

export type ProviderResolver = (selectionId: string) => ModelProvider;

function buildVercelProvider(): ModelProvider {
  return createModelProvider({ kind: "vercel-gateway" });
}

function resolveModel(
  selectionId: string,
  resolveProvider: ProviderResolver,
  providerOptionsOverrides?: ProviderOptionsByProvider,
): LanguageModelV3 {
  const { providerModelId } = resolveProviderModelId(selectionId);
  const provider = resolveProvider(selectionId);
  let model = provider.languageModel(providerModelId);
  return applyModelMiddleware(model, selectionId, providerOptionsOverrides);
}

export function createOpenAgent(resolveProvider?: ProviderResolver) {
  const resolve = resolveProvider ?? buildVercelProvider;

  return new ToolLoopAgent({
    model: resolveModel(defaultModelLabel, resolve),
    instructions: buildSystemPrompt({}),
    tools,
    stopWhen: stepCountIs(1),
    callOptionsSchema,
    prepareStep: ({ messages, model, steps: _steps }) => {
      return {
        messages: addCacheControl({
          messages,
          model,
        }),
      };
    },
    prepareCall: ({ options, ...settings }) => {
      if (!options) {
        throw new Error("Open Agent requires call options with sandbox.");
      }

      const mainSelection = normalizeAgentModelSelection(
        options.model,
        defaultModelLabel,
      );
      const subagentSelection = options.subagentModel
        ? normalizeAgentModelSelection(options.subagentModel, defaultModelLabel)
        : undefined;

      const callModel = resolveModel(
        mainSelection.id,
        resolve,
        mainSelection.providerOptionsOverrides,
      );

      let subagentModel: LanguageModelV3 | undefined;
      if (subagentSelection) {
        const mainProviderRef = resolveProviderModelId(
          mainSelection.id,
        ).providerRef;
        const subProviderRef = resolveProviderModelId(
          subagentSelection.id,
        ).providerRef;

        if (mainProviderRef !== subProviderRef) {
          throw new Error(
            `Main agent provider "${mainProviderRef}" does not match subagent provider "${subProviderRef}". ` +
              `Main and subagent must use the same provider.`,
          );
        }

        subagentModel = resolveModel(
          subagentSelection.id,
          resolve,
          subagentSelection.providerOptionsOverrides,
        );
      }

      const customInstructions = options.customInstructions;
      const sandbox = options.sandbox;
      const skills = options.skills ?? [];

      const instructions = buildSystemPrompt({
        cwd: sandbox.workingDirectory,
        currentBranch: sandbox.currentBranch,
        customInstructions,
        environmentDetails: sandbox.environmentDetails,
        skills,
        modelId: mainSelection.id,
      });

      return {
        ...settings,
        model: callModel,
        tools: addCacheControl({
          tools: settings.tools ?? tools,
          model: callModel,
        }),
        instructions,
        experimental_context: {
          sandbox,
          skills,
          model: callModel,
          subagentModel,
        },
      };
    },
  });
}

export const defaultModel = resolveModel(
  defaultModelLabel,
  buildVercelProvider,
);
export const openAgent = createOpenAgent();
export type OpenAgent = typeof openAgent;
