export const DEPLOY_TEMPLATE_REPOSITORY_URL =
  "https://github.com/Mvkd108/cloud_agents";

export const DEPLOY_ENV_VARS = [
  "POSTGRES_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "NEXT_PUBLIC_VERCEL_APP_CLIENT_ID",
  "VERCEL_APP_CLIENT_SECRET",
  "NEXT_PUBLIC_GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "NEXT_PUBLIC_GITHUB_APP_SLUG",
  "GITHUB_WEBHOOK_SECRET",
] as const;

const DEPLOY_PRODUCTS = [
  {
    type: "integration",
    protocol: "storage",
    productSlug: "neon",
    integrationSlug: "neon",
  },
  {
    type: "integration",
    protocol: "storage",
    productSlug: "upstash-kv",
    integrationSlug: "upstash",
  },
] as const;

export function buildDeployTemplateUrl(): string {
  const params = new URLSearchParams([
    ["project-name", "cloud-agents"],
    ["repository-name", "cloud-agents"],
    ["repository-url", DEPLOY_TEMPLATE_REPOSITORY_URL],
    ["demo-title", "Open Agents"],
    [
      "demo-description",
      "Open-source background coding agent with durable workflows and isolated sandboxes.",
    ],
    ["env", DEPLOY_ENV_VARS.join(",")],
    [
      "envDescription",
      "Neon provides Postgres and Upstash provides production rate limiting. Generate BETTER_AUTH_SECRET, then add the stable origin, Vercel OAuth, and GitHub App credentials.",
    ],
    ["products", encodeURIComponent(JSON.stringify(DEPLOY_PRODUCTS))],
    ["skippable-integrations", "1"],
  ]);

  return `https://vercel.com/new/clone?${params.toString()}`;
}
