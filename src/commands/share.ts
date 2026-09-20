import { Command } from "commander";
import { stdout as output } from "node:process";

import { buildSharePlan, writeShareIndex } from "../share.js";
import * as helpers from "./helpers.js";

export function register(program: Command): void {
  program
    .command("share [memoryId]")
    .description("Prepare an explicit Git share plan for one memory or all active memories.")
    .option("--all-active", "Share all active memories in .brain.")
    .option(
      "--include-source-evidence",
      "Include raw provenance source blobs for full RepoBrain verification on another checkout.",
    )
    .action(
      async (
        memoryId: string | undefined,
        options: { allActive?: boolean; includeSourceEvidence?: boolean },
      ) => {
        const projectRoot = await helpers.resolveProjectRoot();
        const plan = await buildSharePlan(projectRoot, {
          ...(options.allActive ? { allActive: true } : {}),
          ...(memoryId ? { memoryId } : {}),
          ...(options.includeSourceEvidence ? { includeSourceEvidence: true } : {}),
        });

        await writeShareIndex(projectRoot, plan);

        output.write(
          `Share plan for ${plan.records.length} memory${plan.records.length === 1 ? "" : "ies"}:\n`,
        );
        for (const entry of plan.records) {
          output.write(
            `- ${entry.relativePath.replace(/\\/g, "/")} | ${entry.memory.type} | ${entry.memory.title}\n`,
          );
        }

        output.write(`\nPrepared portable index: ${plan.sharedIndexPath}\n`);
        output.write(
          `Raw provenance source evidence: ${plan.includeSourceEvidence ? "included" : "excluded"}\n`,
        );

        for (const warning of plan.warnings) {
          output.write(`WARNING: ${warning}\n`);
        }

        output.write("\nSuggested next commands:\n");
        for (const command of plan.addCommands) {
          output.write(`${command}\n`);
        }
        output.write(`git commit -m ${JSON.stringify(plan.commitMessage)}\n`);
      },
    );

  program;
}
