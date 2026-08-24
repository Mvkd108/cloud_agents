const PROVIDER_REF_SEPARATOR = ":";

export interface ProviderModelId {
  providerRef: string;
  providerModelId: string;
}

export function resolveProviderModelId(selectionId: string): ProviderModelId {
  const colonIdx = selectionId.indexOf(PROVIDER_REF_SEPARATOR);
  if (colonIdx === -1) {
    return { providerRef: "vercel", providerModelId: selectionId };
  }

  return {
    providerRef: selectionId.slice(0, colonIdx),
    providerModelId: selectionId.slice(colonIdx + 1),
  };
}
