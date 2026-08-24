import { runDeploymentSmoke } from "../apps/web/lib/deployment/deployment-smoke.ts";

function getDeploymentUrl(): string | undefined {
  const prefix = "--url=";
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf("--url");
  return (
    (index >= 0 ? process.argv[index + 1] : undefined) ??
    process.env.LAUNCH_BASE_URL?.trim()
  );
}

const deploymentUrl = getDeploymentUrl();
if (!deploymentUrl) {
  throw new Error("Provide --url=https://YOUR_DOMAIN or set LAUNCH_BASE_URL.");
}

const report = await runDeploymentSmoke(deploymentUrl);
for (const item of report.checks) {
  const marker = item.status === "pass" ? "PASS" : "FAIL";
  console.log(`[${marker}] ${item.label}: ${item.message}`);
}

console.log(
  report.passed
    ? `Deployment smoke passed for ${report.baseUrl}.`
    : `Deployment smoke failed for ${report.baseUrl}.`,
);

if (!report.passed) {
  process.exitCode = 1;
}
