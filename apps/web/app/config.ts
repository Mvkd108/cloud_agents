import {
  createModelProvider,
  createOpenAgent,
  resolveProviderModelId,
  type ModelProvider,
} from "@open-agents/agent";
import { getDeploymentProviderConfig } from "@/lib/provider-config";

const ATTRIBUTION = {
  appName: "Open Agents",
  appUrl: "https://open-agents.dev",
} as const;

function resolveAgentProvider(selectionId: string): ModelProvider {
  const { providerRef, providerModelId } = resolveProviderModelId(selectionId);

  if (providerRef === "compatible") {
    const config = getDeploymentProviderConfig();

    if (!config) {
      throw new Error(
        "Compatible provider is not configured. " +
          "Set OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_API_KEY, and OPENAI_COMPATIBLE_MODELS.",
      );
    }

    const allowed = config.models.some(
      (model) =>
        model.id === providerModelId &&
        model.enabled &&
        model.capabilities.tools,
    );
    if (!allowed) {
      throw new Error(
        `Model "${providerModelId}" is not in the allowed compatible model list. ` +
          "Check OPENAI_COMPATIBLE_MODELS.",
      );
    }

    return createModelProvider(
      {
        kind: "openai-compatible",
        name: config.name,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
      },
      ATTRIBUTION,
    );
  }

  return createModelProvider({ kind: "vercel-gateway" }, ATTRIBUTION);
}

export const webAgent = createOpenAgent(resolveAgentProvider);
