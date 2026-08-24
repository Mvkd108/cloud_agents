import type { NetworkPolicy } from "@vercel/sandbox";

const DEFAULT_NPM_REGISTRY_DOMAINS = ["registry.npmjs.org"];
const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export const DENY_ALL_NETWORK_POLICY: NetworkPolicy = "deny-all";

export function buildGitHubCredentialBrokeringPolicy(
  token?: string,
): NetworkPolicy {
  if (!token) {
    return DENY_ALL_NETWORK_POLICY;
  }

  const basicAuthToken = Buffer.from(
    `x-access-token:${token}`,
    "utf-8",
  ).toString("base64");

  return {
    allow: {
      "api.github.com": [
        {
          transform: [{ headers: { Authorization: `Bearer ${token}` } }],
        },
      ],
      "uploads.github.com": [
        {
          transform: [{ headers: { Authorization: `Bearer ${token}` } }],
        },
      ],
      "codeload.github.com": [
        {
          transform: [{ headers: { Authorization: `Bearer ${token}` } }],
        },
      ],
      "github.com": [
        {
          transform: [
            { headers: { Authorization: `Basic ${basicAuthToken}` } },
          ],
        },
      ],
    },
  };
}

export function getNpmRegistryDomains(
  configuredDomains = process.env.SANDBOX_NPM_REGISTRY_DOMAINS,
): string[] {
  const candidates = configuredDomains
    ? configuredDomains.split(",")
    : DEFAULT_NPM_REGISTRY_DOMAINS;
  const domains = Array.from(
    new Set(
      candidates.map((value) => value.trim().toLowerCase()).filter(Boolean),
    ),
  );

  if (domains.length === 0) {
    throw new Error("At least one npm registry domain must be configured");
  }

  for (const domain of domains) {
    if (domain === "*" || !DOMAIN_PATTERN.test(domain)) {
      throw new Error(`Invalid npm registry domain: ${domain}`);
    }
  }

  return domains;
}

export function buildNpmRegistryNetworkPolicy(
  domains = getNpmRegistryDomains(),
): NetworkPolicy {
  return { allow: domains };
}
