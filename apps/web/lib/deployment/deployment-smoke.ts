export type DeploymentSmokeStatus = "pass" | "fail";

export interface DeploymentSmokeCheck {
  id: string;
  label: string;
  status: DeploymentSmokeStatus;
  message: string;
}

export interface DeploymentSmokeReport {
  passed: boolean;
  baseUrl: string;
  checks: DeploymentSmokeCheck[];
}

export type DeploymentFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Deployment URL must use HTTP or HTTPS");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runCheck(
  id: string,
  label: string,
  operation: () => Promise<{ passed: boolean; message: string }>,
): Promise<DeploymentSmokeCheck> {
  try {
    const result = await operation();
    return {
      id,
      label,
      status: result.passed ? "pass" : "fail",
      message: result.message,
    };
  } catch {
    return {
      id,
      label,
      status: "fail",
      message: "The request failed before a valid response was received.",
    };
  }
}

export async function runDeploymentSmoke(
  deploymentUrl: string,
  fetcher: DeploymentFetch = fetch,
): Promise<DeploymentSmokeReport> {
  const baseUrl = normalizeBaseUrl(deploymentUrl);
  const checks = await Promise.all([
    runCheck("home", "Application shell", async () => {
      const response = await fetcher(`${baseUrl}/`, {
        headers: { Accept: "text/html" },
      });
      const contentType = response.headers.get("content-type") ?? "";
      const passed = response.ok && contentType.includes("text/html");
      return {
        passed,
        message: passed
          ? "The application shell is reachable over HTTP."
          : "The application shell did not return a successful HTML response.",
      };
    }),
    runCheck("auth-info", "Authentication API", async () => {
      const response = await fetcher(`${baseUrl}/api/auth/info`, {
        headers: { Accept: "application/json" },
      });
      const body: unknown = await response.json().catch(() => null);
      const passed = response.status === 200 && isRecord(body);
      return {
        passed,
        message: passed
          ? "The public authentication status API returned a valid response."
          : "The authentication status API did not return the expected response.",
      };
    }),
    runCheck("model-catalog", "Model catalog", async () => {
      const response = await fetcher(`${baseUrl}/api/models`, {
        headers: { Accept: "application/json" },
      });
      const body: unknown = await response.json().catch(() => null);
      const passed =
        response.status === 200 &&
        isRecord(body) &&
        Array.isArray(body.models) &&
        body.models.length > 0;
      return {
        passed,
        message: passed
          ? "The deployment exposes a non-empty model catalog."
          : "The deployment did not expose a usable model catalog.",
      };
    }),
    runCheck("auth-boundary", "Session authorization boundary", async () => {
      const response = await fetcher(`${baseUrl}/api/sessions`, {
        headers: { Accept: "application/json" },
      });
      const passed = response.status === 401;
      return {
        passed,
        message: passed
          ? "Anonymous session access is rejected."
          : "The session API did not enforce the expected anonymous boundary.",
      };
    }),
    runCheck("github-webhook", "GitHub webhook boundary", async () => {
      const response = await fetcher(`${baseUrl}/api/github/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const passed = response.status === 400;
      return {
        passed,
        message: passed
          ? "The configured webhook route rejects unsigned requests."
          : "The webhook route is unavailable or its secret is not configured.",
      };
    }),
  ]);

  return {
    passed: checks.every((item) => item.status === "pass"),
    baseUrl,
    checks,
  };
}
