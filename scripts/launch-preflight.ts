import { loadEnvFile } from "node:process";
import { evaluateLaunchReadiness } from "../apps/web/lib/deployment/launch-readiness.ts";

function getOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const envFile = getOption("env-file");
if (envFile) {
  loadEnvFile(envFile);
}

const report = evaluateLaunchReadiness(process.env);

for (const item of report.checks) {
  const marker = item.status === "pass" ? "PASS" : "BLOCK";
  console.log(`[${marker}] ${item.label}: ${item.message}`);
}

console.log(
  report.ready
    ? "Launch preflight passed."
    : "Launch preflight found blocking configuration gaps.",
);

if (!report.ready) {
  process.exitCode = 1;
}
