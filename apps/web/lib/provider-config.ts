import "server-only";

import { z } from "zod";
import {
  compatibleModelDescriptorSchema,
  type CompatibleModelDescriptor,
} from "./provider-descriptor";

export type { CompatibleModelDescriptor } from "./provider-descriptor";

export interface DeploymentProviderConfig {
  name: string;
  baseURL: string;
  apiKey: string;
  models: CompatibleModelDescriptor[];
}

const MISSING_VARS_MESSAGE =
  "OPENAI_COMPATIBLE_* environment is incomplete. " +
  "All three variables (OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_API_KEY, " +
  "OPENAI_COMPATIBLE_MODELS) must be set or all must be unset. " +
  "Compatible provider is disabled.";

export function getDeploymentProviderConfig():
  | DeploymentProviderConfig
  | undefined {
  const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL?.trim();
  const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY?.trim();
  const rawModels = process.env.OPENAI_COMPATIBLE_MODELS?.trim();

  const configuredCount =
    (baseURL ? 1 : 0) + (apiKey ? 1 : 0) + (rawModels ? 1 : 0);

  if (configuredCount === 0) {
    return undefined;
  }

  if (configuredCount !== 3) {
    console.error(MISSING_VARS_MESSAGE);
    return undefined;
  }

  if (!baseURL || !apiKey || !rawModels) {
    return undefined;
  }

  let parsedModels: unknown;
  try {
    parsedModels = JSON.parse(rawModels);
  } catch {
    console.error(
      "OPENAI_COMPATIBLE_MODELS is not valid JSON. Compatible provider is disabled.",
    );
    return undefined;
  }

  const result = z
    .array(compatibleModelDescriptorSchema)
    .safeParse(parsedModels);
  if (!result.success) {
    console.error(
      "OPENAI_COMPATIBLE_MODELS validation failed. Compatible provider is disabled:",
      result.error.issues,
    );
    return undefined;
  }

  return {
    name: "compatible",
    baseURL,
    apiKey,
    models: result.data,
  };
}
