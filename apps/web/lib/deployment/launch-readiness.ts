import { z } from "zod";
import { compatibleModelDescriptorSchema } from "../provider-descriptor.ts";

export type LaunchCheckStatus = "pass" | "block";

export interface LaunchCheck {
  id: string;
  label: string;
  status: LaunchCheckStatus;
  message: string;
}

export interface LaunchReadinessReport {
  ready: boolean;
  checks: LaunchCheck[];
}

type LaunchEnvironment = Record<string, string | undefined>;

const AUTH_ENVIRONMENT = [
  "NEXT_PUBLIC_VERCEL_APP_CLIENT_ID",
  "VERCEL_APP_CLIENT_SECRET",
] as const;

const GITHUB_ENVIRONMENT = [
  "NEXT_PUBLIC_GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "NEXT_PUBLIC_GITHUB_APP_SLUG",
  "GITHUB_WEBHOOK_SECRET",
] as const;

function environmentValue(
  environment: LaunchEnvironment,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

function check(
  id: string,
  label: string,
  passed: boolean,
  successMessage: string,
  failureMessage: string,
): LaunchCheck {
  return {
    id,
    label,
    status: passed ? "pass" : "block",
    message: passed ? successMessage : failureMessage,
  };
}

function hasExpectedUrlProtocol(
  value: string | undefined,
  protocols: string[],
): boolean {
  if (!value) {
    return false;
  }

  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function evaluateCore(environment: LaunchEnvironment): LaunchCheck {
  const databaseUrl = environmentValue(environment, "POSTGRES_URL");
  const authSecret = environmentValue(environment, "BETTER_AUTH_SECRET");
  const validDatabase = hasExpectedUrlProtocol(databaseUrl, [
    "postgres:",
    "postgresql:",
  ]);
  const validSecret = Boolean(authSecret && authSecret.length >= 32);

  return check(
    "core",
    "Database and session security",
    validDatabase && validSecret,
    "Postgres and a sufficiently long Better Auth secret are configured.",
    "Set a valid POSTGRES_URL and a BETTER_AUTH_SECRET of at least 32 characters.",
  );
}

function evaluateCanonicalOrigin(environment: LaunchEnvironment): LaunchCheck {
  const authUrl = environmentValue(environment, "BETTER_AUTH_URL");
  const productionHost =
    environmentValue(
      environment,
      "NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL",
    ) ?? environmentValue(environment, "VERCEL_PROJECT_PRODUCTION_URL");
  const canonicalUrl =
    authUrl ??
    (productionHost
      ? `https://${productionHost.replace(/^https?:\/\//, "")}`
      : undefined);
  const validOrigin = hasExpectedUrlProtocol(canonicalUrl, ["https:"]);

  return check(
    "canonical-origin",
    "Canonical production origin",
    validOrigin,
    "A stable HTTPS production origin is configured for auth and callbacks.",
    "Set BETTER_AUTH_URL or a Vercel production URL variable to the stable HTTPS origin.",
  );
}

function evaluateEnvironmentGroup(
  environment: LaunchEnvironment,
  options: {
    id: string;
    label: string;
    names: readonly string[];
    successMessage: string;
    failureMessage: string;
  },
): LaunchCheck {
  const complete = options.names.every((name) =>
    Boolean(environmentValue(environment, name)),
  );

  return check(
    options.id,
    options.label,
    complete,
    options.successMessage,
    options.failureMessage,
  );
}

function evaluateGitHub(environment: LaunchEnvironment): LaunchCheck {
  const baseCheck = evaluateEnvironmentGroup(environment, {
    id: "github",
    label: "GitHub App",
    names: GITHUB_ENVIRONMENT,
    successMessage:
      "GitHub OAuth, installation access, and webhooks are configured.",
    failureMessage:
      "Set all GitHub App OAuth, app identity, private key, slug, and webhook secret variables.",
  });

  const appId = environmentValue(environment, "GITHUB_APP_ID");
  const parsedAppId = appId ? Number.parseInt(appId, 10) : Number.NaN;
  if (
    baseCheck.status === "pass" &&
    (!Number.isFinite(parsedAppId) || parsedAppId <= 0)
  ) {
    return {
      ...baseCheck,
      status: "block",
      message: "GITHUB_APP_ID must be a positive integer.",
    };
  }

  return baseCheck;
}

function evaluateRateLimiting(environment: LaunchEnvironment): LaunchCheck {
  const configured = Boolean(
    environmentValue(environment, "REDIS_URL") ??
    environmentValue(environment, "KV_URL"),
  );

  return check(
    "rate-limiting",
    "Production rate limiting",
    configured,
    "Redis/KV is configured for fail-closed production rate limiting.",
    "Set REDIS_URL or KV_URL; production API operations return 503 without one.",
  );
}

function evaluateE2BSandbox(environment: LaunchEnvironment): LaunchCheck {
  const flagEnabled =
    environmentValue(environment, "E2B_SANDBOX_ENABLED")?.toLowerCase() ===
    "true";
  const apiKey = environmentValue(environment, "E2B_API_KEY");

  if (!flagEnabled) {
    return check(
      "e2b-sandbox",
      "E2B sandbox provider",
      true,
      "E2B sandboxes are disabled; Vercel Sandbox remains the default.",
      "Set E2B_SANDBOX_ENABLED=true and E2B_API_KEY to enable E2B sandboxes.",
    );
  }

  return check(
    "e2b-sandbox",
    "E2B sandbox provider",
    Boolean(apiKey),
    "E2B sandboxes are enabled and configured.",
    "E2B_SANDBOX_ENABLED=true requires E2B_API_KEY.",
  );
}

function evaluateCompatibleProvider(
  environment: LaunchEnvironment,
): LaunchCheck {
  const baseUrl = environmentValue(environment, "OPENAI_COMPATIBLE_BASE_URL");
  const apiKey = environmentValue(environment, "OPENAI_COMPATIBLE_API_KEY");
  const rawModels = environmentValue(environment, "OPENAI_COMPATIBLE_MODELS");

  if (!(baseUrl && apiKey && rawModels)) {
    return {
      id: "compatible-provider",
      label: "Hosted open-weight model",
      status: "block",
      message:
        "Set all OPENAI_COMPATIBLE_* variables and configure at least one qualified tool-capable model.",
    };
  }

  if (!hasExpectedUrlProtocol(baseUrl, ["https:"])) {
    return {
      id: "compatible-provider",
      label: "Hosted open-weight model",
      status: "block",
      message: "OPENAI_COMPATIBLE_BASE_URL must be a valid HTTPS URL.",
    };
  }

  let parsedModels: unknown;
  try {
    parsedModels = JSON.parse(rawModels);
  } catch {
    return {
      id: "compatible-provider",
      label: "Hosted open-weight model",
      status: "block",
      message: "OPENAI_COMPATIBLE_MODELS must be valid JSON.",
    };
  }

  const result = z
    .array(compatibleModelDescriptorSchema)
    .safeParse(parsedModels);
  if (!result.success || result.data.length === 0) {
    return {
      id: "compatible-provider",
      label: "Hosted open-weight model",
      status: "block",
      message: "OPENAI_COMPATIBLE_MODELS must contain valid model descriptors.",
    };
  }

  const uniqueModelIds = new Set(result.data.map((model) => model.id));
  if (uniqueModelIds.size !== result.data.length) {
    return {
      id: "compatible-provider",
      label: "Hosted open-weight model",
      status: "block",
      message: "OPENAI_COMPATIBLE_MODELS contains duplicate model IDs.",
    };
  }

  const hasEnabledToolModel = result.data.some(
    (model) => model.enabled && model.capabilities.tools,
  );

  return check(
    "compatible-provider",
    "Hosted open-weight model",
    hasEnabledToolModel,
    "At least one enabled, tool-capable compatible model is configured.",
    "Enable at least one qualified compatible model with tools capability.",
  );
}

export function evaluateLaunchReadiness(
  environment: LaunchEnvironment,
): LaunchReadinessReport {
  const checks = [
    evaluateCore(environment),
    evaluateCanonicalOrigin(environment),
    evaluateEnvironmentGroup(environment, {
      id: "vercel-auth",
      label: "Vercel sign-in",
      names: AUTH_ENVIRONMENT,
      successMessage: "Vercel OAuth sign-in is configured.",
      failureMessage: "Set both Vercel OAuth client environment variables.",
    }),
    evaluateGitHub(environment),
    evaluateRateLimiting(environment),
    evaluateE2BSandbox(environment),
    evaluateCompatibleProvider(environment),
  ];

  return {
    ready: checks.every((item) => item.status === "pass"),
    checks,
  };
}
