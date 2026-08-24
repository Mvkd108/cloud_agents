import { createGateway } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV3 } from "@ai-sdk/provider";

export type ModelProviderKind = "vercel-gateway" | "openai-compatible";

export interface ModelProviderConfigVercel {
  kind: "vercel-gateway";
}

export interface ModelProviderConfigCompatible {
  kind: "openai-compatible";
  name: string;
  baseURL: string;
  apiKey: string;
}

export type ModelProviderConfig =
  | ModelProviderConfigVercel
  | ModelProviderConfigCompatible;

export interface ModelProviderAttribution {
  appName?: string;
  appUrl?: string;
}

export interface ModelProvider {
  readonly kind: ModelProviderKind;
  languageModel(modelId: string): LanguageModelV3;
}

export type NormalizedModelProviderErrorCode =
  | "aborted"
  | "provider_error"
  | "rate_limit"
  | "timeout";

export interface NormalizedModelProviderError {
  code: NormalizedModelProviderErrorCode;
  message: string;
  retryable: boolean;
  statusCode?: number;
}

const DEFAULT_APP_NAME = "Open Agents";
const DEFAULT_APP_URL = "https://open-agents.dev";

function getErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as { status?: unknown; statusCode?: unknown };
  if (typeof candidate.statusCode === "number") {
    return candidate.statusCode;
  }
  return typeof candidate.status === "number" ? candidate.status : undefined;
}

export function normalizeModelProviderError(
  error: unknown,
): NormalizedModelProviderError {
  const statusCode = getErrorStatusCode(error);
  const name = error instanceof Error ? error.name : "";
  const rawCode =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (name === "AbortError") {
    return {
      code: "aborted",
      message: "Model request was cancelled",
      retryable: false,
      ...(statusCode !== undefined && { statusCode }),
    };
  }

  if (
    name === "TimeoutError" ||
    rawCode === "ETIMEDOUT" ||
    rawCode === "UND_ERR_CONNECT_TIMEOUT" ||
    message.includes("timed out") ||
    message.includes("timeout")
  ) {
    return {
      code: "timeout",
      message: "Model request timed out",
      retryable: true,
      ...(statusCode !== undefined && { statusCode }),
    };
  }

  if (statusCode === 429) {
    return {
      code: "rate_limit",
      message: "Model provider rate limit exceeded",
      retryable: true,
      statusCode,
    };
  }

  return {
    code: "provider_error",
    message: "Model provider request failed",
    retryable: statusCode === undefined || statusCode >= 500,
    ...(statusCode !== undefined && { statusCode }),
  };
}

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
      languageModel: (modelId) => gateway.languageModel(modelId),
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
    languageModel: (modelId) => provider.languageModel(modelId),
  };
}
