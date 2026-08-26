import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const {
  E2B_API_KEY_VAR,
  E2B_LAUNCH_FLAG,
  getDefaultSandboxProvider,
  getSandboxProviderPolicy,
  getSandboxProviderStatus,
  isSandboxProviderEnabled,
} = await import("./provider-policy");

type Env = Record<string, string>;

function e2bEnv(overrides: Env = {}): Env {
  return {
    [E2B_LAUNCH_FLAG]: "true",
    [E2B_API_KEY_VAR]: "e2b-secret-key",
    ...overrides,
  };
}

describe("sandbox provider policy", () => {
  test("keeps Vercel as the default provider and always ready", () => {
    const policy = getSandboxProviderPolicy({});

    expect(policy.defaultProvider).toBe("vercel");
    expect(isSandboxProviderEnabled("vercel", {})).toBe(true);
  });

  test("reports E2B disabled when the launch flag is not set", () => {
    const policy = getSandboxProviderPolicy({
      [E2B_API_KEY_VAR]: "e2b-secret-key",
    });

    expect(policy.e2b.ready).toBe(false);
    expect(policy.e2b.missing).toEqual([E2B_LAUNCH_FLAG]);
    expect(
      isSandboxProviderEnabled("e2b", { [E2B_API_KEY_VAR]: "e2b-secret-key" }),
    ).toBe(false);
  });

  test("reports E2B disabled when the launch flag is explicitly off", () => {
    const policy = getSandboxProviderPolicy(
      e2bEnv({ [E2B_LAUNCH_FLAG]: "false" }),
    );

    expect(policy.e2b.ready).toBe(false);
    expect(policy.e2b.missing).toEqual([E2B_LAUNCH_FLAG]);
  });

  test("reports E2B disabled when the API key is missing", () => {
    const policy = getSandboxProviderPolicy({ [E2B_LAUNCH_FLAG]: "true" });

    expect(policy.e2b.ready).toBe(false);
    expect(policy.e2b.missing).toEqual([E2B_API_KEY_VAR]);
  });

  test("reports E2B enabled when the flag and API key are present", () => {
    const policy = getSandboxProviderPolicy(e2bEnv());

    expect(policy.e2b.ready).toBe(true);
    expect(policy.e2b.missing).toEqual([]);
    expect(isSandboxProviderEnabled("e2b", e2bEnv())).toBe(true);
    expect(getDefaultSandboxProvider(e2bEnv())).toBe("vercel");
  });

  test("does not leak credentials or environment values in diagnostics", () => {
    const statuses = getSandboxProviderStatus(e2bEnv());

    expect(statuses).toEqual([
      { provider: "vercel", enabled: true },
      { provider: "e2b", enabled: true },
    ]);

    const serialized = JSON.stringify(statuses);
    expect(serialized).not.toContain("e2b-secret-key");
  });
});
