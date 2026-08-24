import "server-only";

import { fetchAvailableLanguageModelsWithContext as fetchBaseModels } from "./models-with-context";
import {
  getDeploymentProviderConfig,
  type CompatibleModelDescriptor,
} from "./provider-config";
import type { AvailableModel } from "./models";

function toCompatibleSelectionId(modelId: string): string {
  return `compatible:${modelId}`;
}

function buildCompatibleModels(
  descriptors: CompatibleModelDescriptor[],
): AvailableModel[] {
  const seen = new Set<string>();
  const models: AvailableModel[] = [];

  for (const descriptor of descriptors) {
    if (!descriptor.enabled || !descriptor.capabilities.tools) {
      continue;
    }

    const id = toCompatibleSelectionId(descriptor.id);
    if (seen.has(id)) {
      console.error(
        `Duplicate compatible model descriptor: "${descriptor.id}". Skipping.`,
      );
      continue;
    }
    seen.add(id);

    models.push({
      id,
      name: descriptor.name,
      description: descriptor.description ?? null,
      modelType: "language",
      context_window: descriptor.contextWindow,
      capabilities: descriptor.capabilities,
    });
  }

  return models;
}

/**
 * Fetches all available models with provider-aware IDs.
 * Vercel gateway model IDs are returned unchanged (default "vercel" provider).
 * Compatible models are prefixed with "compatible:".
 * Duplicate compatible descriptors are logged and skipped.
 */
export async function fetchProviderAwareModels(): Promise<AvailableModel[]> {
  const vercelModels = await fetchBaseModels();

  const config = getDeploymentProviderConfig();
  if (!config || config.models.length === 0) {
    return vercelModels;
  }

  const compatibleModels = buildCompatibleModels(config.models);

  return [...vercelModels, ...compatibleModels];
}
