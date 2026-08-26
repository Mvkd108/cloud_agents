import type { SandboxNetworkUpdate } from "e2b";
import { getNpmRegistryDomains } from "../vercel/network-policy.ts";

/**
 * E2B network policy helpers. E2B sandboxes start with deny-all egress.
 * Trusted operations temporarily replace the egress rules with an exact-domain
 * allowlist (and optional header-based credential injection) and always
 * restore deny-all afterward.
 *
 * GitHub credentials are injected as HTTP header transforms at the network
 * boundary. They are never added to commands, repository config, or persistent
 * sandbox environment variables.
 */

/** Exact GitHub hosts used for clone/setup and short-lived credential brokerage. */
export const E2B_GITHUB_HOSTS = [
  "api.github.com",
  "uploads.github.com",
  "codeload.github.com",
  "github.com",
] as const;

/**
 * Deny-all egress update. `updateNetwork` replaces the current egress rules
 * atomically and clears omitted fields, so this both blocks outbound traffic
 * and removes any previously applied allowlist or header transforms.
 */
export const E2B_DENY_ALL_NETWORK_UPDATE: SandboxNetworkUpdate = {
  allowOut: [],
  denyOut: ["0.0.0.0/0"],
};

/**
 * Setup-time policy that allows only the exact GitHub hosts. Used while
 * cloning a repository into a fresh sandbox when no credential is needed.
 */
export function buildE2BGitHubSetupPolicy(): SandboxNetworkUpdate {
  return { allowOut: [...E2B_GITHUB_HOSTS] };
}

/**
 * Short-lived GitHub credential brokering policy. Only the exact GitHub hosts
 * are reachable, and requests to them get the installation token injected as a
 * header transform. When no token is present the policy is deny-all.
 */
export function buildE2BGitHubCredentialBrokeringPolicy(
  token?: string,
): SandboxNetworkUpdate {
  if (!token) {
    return E2B_DENY_ALL_NETWORK_UPDATE;
  }

  const basicAuthToken = Buffer.from(
    `x-access-token:${token}`,
    "utf-8",
  ).toString("base64");

  return {
    allowOut: ({ rules }) => [...rules.keys()],
    rules: {
      "api.github.com": [
        { transform: { headers: { Authorization: `Bearer ${token}` } } },
      ],
      "uploads.github.com": [
        { transform: { headers: { Authorization: `Bearer ${token}` } } },
      ],
      "codeload.github.com": [
        { transform: { headers: { Authorization: `Bearer ${token}` } } },
      ],
      "github.com": [
        {
          transform: {
            headers: { Authorization: `Basic ${basicAuthToken}` },
          },
        },
      ],
    },
  };
}

/**
 * Narrow registry allowlist for approved dependency installs. Deny-all is
 * restored after the operation.
 */
export function buildE2BNpmRegistryNetworkPolicy(
  domains = getNpmRegistryDomains(),
): SandboxNetworkUpdate {
  return { allowOut: domains };
}
