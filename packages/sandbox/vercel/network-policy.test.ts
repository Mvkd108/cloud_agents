import { describe, expect, test } from "bun:test";
import {
  buildGitHubCredentialBrokeringPolicy,
  buildNpmRegistryNetworkPolicy,
  getNpmRegistryDomains,
} from "./network-policy";

describe("sandbox network policies", () => {
  test("uses deny-all when no GitHub credential is present", () => {
    expect(buildGitHubCredentialBrokeringPolicy()).toBe("deny-all");
  });

  test("limits GitHub credential brokering to exact GitHub domains", () => {
    const policy = buildGitHubCredentialBrokeringPolicy("secret-token");

    expect(policy).not.toBe("deny-all");
    if (
      typeof policy === "string" ||
      !policy.allow ||
      Array.isArray(policy.allow)
    ) {
      throw new Error("Expected an allowlist policy");
    }

    const allowedDomains = Object.keys(policy.allow);
    expect(allowedDomains).toEqual([
      "api.github.com",
      "uploads.github.com",
      "codeload.github.com",
      "github.com",
    ]);
    expect(allowedDomains).not.toContain("*");
  });

  test("uses only explicitly configured package registry domains", () => {
    expect(getNpmRegistryDomains()).toEqual(["registry.npmjs.org"]);
    expect(
      getNpmRegistryDomains("registry.npmjs.org,packages.example.com"),
    ).toEqual(["registry.npmjs.org", "packages.example.com"]);
    expect(buildNpmRegistryNetworkPolicy(["registry.npmjs.org"])).toEqual({
      allow: ["registry.npmjs.org"],
    });
  });

  test("rejects wildcard and malformed package registry domains", () => {
    expect(() => getNpmRegistryDomains("*")).toThrow(
      "Invalid npm registry domain",
    );
    expect(() => getNpmRegistryDomains("*.example.com")).toThrow(
      "Invalid npm registry domain",
    );
    expect(() => getNpmRegistryDomains("https://registry.npmjs.org")).toThrow(
      "Invalid npm registry domain",
    );
  });
});
