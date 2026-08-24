import { describe, expect, test } from "bun:test";
import { type DeploymentFetch, runDeploymentSmoke } from "./deployment-smoke";

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("runDeploymentSmoke", () => {
  test("passes the read-only public deployment contract", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    const fetcher: DeploymentFetch = async (input, init) => {
      const url = new URL(input);
      requests.push({ path: url.pathname, method: init?.method ?? "GET" });

      if (url.pathname === "/") {
        return new Response("<html></html>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/api/auth/info") {
        return jsonResponse({});
      }
      if (url.pathname === "/api/models") {
        return jsonResponse({ models: [{ id: "open/model" }] });
      }
      if (url.pathname === "/api/sessions") {
        return jsonResponse({ error: "Not authenticated" }, 401);
      }
      if (url.pathname === "/api/github/webhook") {
        return jsonResponse({ error: "Missing webhook headers" }, 400);
      }
      return jsonResponse({ error: "Not found" }, 404);
    };

    const report = await runDeploymentSmoke(
      "https://agents.example.com/some/path?ignored=true",
      fetcher,
    );

    expect(report.passed).toBe(true);
    expect(report.baseUrl).toBe("https://agents.example.com");
    expect(requests).toEqual([
      { path: "/", method: "GET" },
      { path: "/api/auth/info", method: "GET" },
      { path: "/api/models", method: "GET" },
      { path: "/api/sessions", method: "GET" },
      { path: "/api/github/webhook", method: "POST" },
    ]);
  });

  test("reports failures without exposing response bodies", async () => {
    const secretBody = "provider-secret-value";
    const fetcher: DeploymentFetch = async (input) => {
      const url = new URL(input);
      if (url.pathname === "/api/models") {
        return jsonResponse({ error: secretBody }, 500);
      }
      throw new Error(secretBody);
    };

    const report = await runDeploymentSmoke(
      "https://agents.example.com",
      fetcher,
    );

    expect(report.passed).toBe(false);
    expect(JSON.stringify(report)).not.toContain(secretBody);
  });

  test("rejects non-HTTP deployment URLs", () => {
    expect(runDeploymentSmoke("file:///tmp/deployment")).rejects.toThrow(
      "Deployment URL must use HTTP or HTTPS",
    );
  });
});
