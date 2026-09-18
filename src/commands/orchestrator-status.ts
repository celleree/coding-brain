import { Command } from "commander";
import { stdout as output } from "node:process";

import {
  buildOrchestratorStatus,
  renderOrchestratorStatus,
  renderOrchestratorStatusJson,
} from "../orchestrator-status.js";
import * as helpers from "./helpers.js";

export function register(program: Command): void {
  program
    .command("orchestrator-status")
    .description("Show read-only health and rotation status for the active orchestrator epoch.")
    .option("--json", 'Print the result as JSON. Equivalent to "--format json".')
    .option("--format <format>", 'Output format: "markdown" or "json".')
    .action(async (options: { json?: boolean; format?: string }) => {
      const projectRoot = await helpers.resolveProjectRoot();
      const status = await buildOrchestratorStatus(projectRoot);
      const format = helpers.resolveSuggestSkillsOutputFormat(options);
      output.write(`${format === "json" ? renderOrchestratorStatusJson(status) : renderOrchestratorStatus(status)}\n`);
    });
}
