import "server-only";

import type { SandboxProvider } from "@open-agents/sandbox";

/**
 * Single source of truth for which sandbox providers a deployment may expose.
 *
 * Provider availability is deployment configuration. It is evaluated
 * server-side from the explicit E2B launch flag and required credentials.
 * The session's persisted `sandboxState.type` remains the source of truth
 * for an existing session; this module only decides whether a provider may be
 * selected for new sessions and whether provisioning may proceed.
 */

export type SandboxProviderId = SandboxProvider;

export const SANDBOX_PROVIDER_IDS: readonly SandboxProviderId[] = [
  "vercel",
  "e2b",
] as const;

/** Explicit opt-in flag for the E2B sandbox provider. */
export const E2B_LAUNCH_FLAG = "E2B_SANDBOX_ENABLED" as const;
export const E2B_API_KEY_VAR = "E2B_API_KEY" as const;
export const E2B_CODEX_TEMPLATE_VAR = "E2B_CODEX_TEMPLATE" as const;

export interface SandboxProviderReadiness {
  /** Whether the provider may be selected for new sessions. */
  ready: boolean;
  /** Provider-specific configuration variables that are missing or inactive. */
  missing: string[];
}

export interface SandboxProviderPolicy {
  /** Provider used when a session does not request a specific one. */
  defaultProvider: SandboxProviderId;
  e2b: SandboxProviderReadiness;
}

export type SandboxProviderEnvironment = Record<string, string | undefined>;

function envValue(
  environment: SandboxProviderEnvironment,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

function evaluateE2B(
  environment: SandboxProviderEnvironment,
): SandboxProviderReadiness {
  const flagEnabled =
    envValue(environment, E2B_LAUNCH_FLAG)?.toLowerCase() === "true";
  const hasApiKey = Boolean(envValue(environment, E2B_API_KEY_VAR));

  const missing: string[] = [];
  if (!flagEnabled) {
    missing.push(E2B_LAUNCH_FLAG);
  }
  if (!hasApiKey) {
    missing.push(E2B_API_KEY_VAR);
  }

  return {
    ready: flagEnabled && hasApiKey,
    missing,
  };
}

export function getSandboxProviderPolicy(
  environment: SandboxProviderEnvironment = process.env,
): SandboxProviderPolicy {
  return {
    // Vercel remains the default during controlled rollout.
    defaultProvider: "vercel",
    e2b: evaluateE2B(environment),
  };
}

export function isSandboxProviderEnabled(
  provider: SandboxProviderId,
  environment: SandboxProviderEnvironment = process.env,
): boolean {
  if (provider === "e2b") {
    return getSandboxProviderPolicy(environment).e2b.ready;
  }
  return true;
}

export function getDefaultSandboxProvider(
  environment: SandboxProviderEnvironment = process.env,
): SandboxProviderId {
  return getSandboxProviderPolicy(environment).defaultProvider;
}

export interface SandboxProviderStatus {
  provider: SandboxProviderId;
  enabled: boolean;
}

/**
 * Secret-safe provider diagnostics for operational logs. Never includes
 * credentials, tokens, or environment values.
 */
export function getSandboxProviderStatus(
  environment: SandboxProviderEnvironment = process.env,
): SandboxProviderStatus[] {
  const policy = getSandboxProviderPolicy(environment);

  return [
    { provider: "vercel", enabled: true },
    { provider: "e2b", enabled: policy.e2b.ready },
  ];
}
