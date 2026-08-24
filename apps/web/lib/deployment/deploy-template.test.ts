import { describe, expect, test } from "bun:test";
import {
  buildDeployTemplateUrl,
  DEPLOY_ENV_VARS,
  DEPLOY_TEMPLATE_REPOSITORY_URL,
} from "./deploy-template";

describe("buildDeployTemplateUrl", () => {
  test("deploys the canonical repository", () => {
    const url = new URL(buildDeployTemplateUrl());

    expect(url.origin).toBe("https://vercel.com");
    expect(url.searchParams.get("repository-url")).toBe(
      DEPLOY_TEMPLATE_REPOSITORY_URL,
    );
    expect(url.searchParams.get("project-name")).toBe("cloud-agents");
  });

  test("requests only environment variables used by the supported deployment", () => {
    const url = new URL(buildDeployTemplateUrl());

    expect(url.searchParams.get("env")?.split(",")).toEqual([
      ...DEPLOY_ENV_VARS,
    ]);
    expect(DEPLOY_ENV_VARS).toContain("BETTER_AUTH_URL");
    expect(DEPLOY_ENV_VARS).not.toContain("ENCRYPTION_KEY");
  });
});
