import { Template, defaultBuildLogger } from "e2b";
import { template } from "./template.ts";

await Template.build(template, "open-agents-codex-fireworks", {
  cpuCount: 4,
  memoryMB: 8192,
  onBuildLogs: defaultBuildLogger(),
});
