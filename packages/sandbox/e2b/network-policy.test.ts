import { describe, expect, test } from "bun:test";
import {
  buildE2BGitHubCredentialBrokeringPolicy,
  buildE2BGitHubSetupPolicy,
  buildE2BNpmRegistryNetworkPolicy,
  E2B_DENY_ALL_NETWORK_UPDATE,
} from "./network-policy";

describe("E2B sandbox network policies", () => {
  test("deny-all blocks all egress and clears any allowlist", () => {
    expect(E2B_DENY_ALL_NETWORK_UPDATE).toEqual({
      allowOut: [],
      denyOut: ["0.0.0.0/0"],
    });
  });

  test("setup policy allows only the exact GitHub hosts", () => {
    const policy = buildE2BGitHubSetupPolicy();

    expect(policy.allowOut).toEqual([
      "api.github.com",
      "uploads.github.com",
      "codeload.github.com",
      "github.com",
    ]);
    expect(policy.allowOut).not.toContain("*");
    expect(policy.rules).toBeUndefined();
  });

  test("uses deny-all when no GitHub credential is present", () => {
    expect(buildE2BGitHubCredentialBrokeringPolicy()).toEqual(
      E2B_DENY_ALL_NETWORK_UPDATE,
    );
  });

  test("limits GitHub credential brokering to exact domains with header transforms", () => {
    const policy = buildE2BGitHubCredentialBrokeringPolicy("secret-token");

    expect(policy.allowOut).toBeDefined();
    const allowedDomains = [
      "api.github.com",
      "uploads.github.com",
      "codeload.github.com",
      "github.com",
    ];

    const allowList = policy.allowOut as string[];
    if (Array.isArray(allowList)) {
      expect(allowList).toEqual(allowedDomains);
    }

    const rules = policy.rules as Record<string, unknown[]>;
    expect(Object.keys(rules).sort()).toEqual(allowedDomains.sort());
    const rule = rules["api.github.com"]?.[0] as {
      transform: { headers: Record<string, string> };
    };
    expect(rule.transform.headers.Authorization).toBe("Bearer secret-token");
  });

  test("injects basic auth for github.com and bearer for api hosts", () => {
    const policy = buildE2BGitHubCredentialBrokeringPolicy("secret-token");
    const rules = policy.rules as Record<
      string,
      Array<{ transform: { headers: Record<string, string> } }>
    >;

    const basicAuthToken = Buffer.from(
      "x-access-token:secret-token",
      "utf-8",
    ).toString("base64");

    expect(rules["github.com"]?.[0]?.transform.headers.Authorization).toBe(
      `Basic ${basicAuthToken}`,
    );
    expect(
      rules["codeload.github.com"]?.[0]?.transform.headers.Authorization,
    ).toBe("Bearer secret-token");
  });

  test("uses only explicitly configured package registry domains", () => {
    expect(buildE2BNpmRegistryNetworkPolicy(["registry.npmjs.org"])).toEqual({
      allowOut: ["registry.npmjs.org"],
    });
  });
});
