import { Template } from "e2b";

export const template = Template()
  .fromTemplate("codex")
  .apt(["git", "gh", "jq", "curl"])
  .runCmd("corepack enable")
  .runCmd("npm install -g pnpm@11.5.1")
  .runCmd("mkdir -p /home/user/.codex /home/user/repo")
  .copy("codex-config.toml", "/home/user/.codex/config.toml");
