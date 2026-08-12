import { createGateway, type GatewayModelId, type LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export type ModelProviderKind = "vercel-gateway" | "openai-compatible";

export type ModelProviderConfig =
  | {
      kind: "vercel-gateway";
    }
  | {
      kind: "openai-compatible";
      name: string;
      baseURL: string;
      apiKey: string;
    };

export interface ModelProviderAttribution {
  appName?: string;
  appUrl?: string;
}

export interface ModelProvider {
  readonly kind: ModelProviderKind;
  languageModel(modelId: GatewayModelId): LanguageModel;
}

const DEFAULT_APP_NAME = "Open Agents";
const DEFAULT_APP_URL = "https://open-agents.dev";

export function createModelProvider(
  config: ModelProviderConfig,
  attribution: ModelProviderAttribution = {},
): ModelProvider {
  const appName = attribution.appName ?? DEFAULT_APP_NAME;
  const appUrl = attribution.appUrl ?? DEFAULT_APP_URL;

  const headers = {
    "http-referer": appUrl,
    "x-title": appName,
  };

  if (config.kind === "vercel-gateway") {
    const gateway = createGateway({ headers });

    return {
      kind: config.kind,
      languageModel: modelId => gateway.languageModel(modelId),
    };
  }

  const provider = createOpenAICompatible({
    name: config.name,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    headers,
  });

  return {
    kind: config.kind,
    languageModel: modelId => provider.languageModel(modelId),
  };
}
