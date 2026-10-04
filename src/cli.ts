#!/usr/bin/env node

import { Command } from "commander";
import { BrainInternalError, BrainUserError } from "./errors.js";

import { register as registerInitSetup } from "./commands/init-setup.js";
import { register as registerImport } from "./commands/import.js";
import { register as registerExtract } from "./commands/extract.js";
import { register as registerInject } from "./commands/inject.js";
import { register as registerConversationStart } from "./commands/conversation-start.js";
import { register as registerReviewApprove } from "./commands/review-approve.js";
import { register as registerListStats } from "./commands/list-stats.js";
import { register as registerDiff } from "./commands/diff.js";
import { register as registerGoal } from "./commands/goal.js";
import { register as registerSweepScore } from "./commands/sweep-score.js";
import { register as registerPreference } from "./commands/preference.js";
import { register as registerSession } from "./commands/session.js";
import { register as registerRouting } from "./commands/routing.js";
import { register as registerMemoryOps } from "./commands/memory-ops.js";
import { register as registerSearch } from "./commands/search.js";
import { register as registerShare } from "./commands/share.js";
import { register as registerMcp } from "./commands/mcp.js";
import { register as registerTui } from "./commands/tui.js";
import { register as registerOrchestratorStatus } from "./commands/orchestrator-status.js";

const program = new Command();

program.name("brain").description("Repo-native project knowledge memory for coding agents.").version("0.1.0");
program.option("--debug", "Print stack traces for CLI errors.");
program.exitOverride();

registerInitSetup(program);
registerImport(program);
registerExtract(program);
registerInject(program);
registerConversationStart(program);
registerReviewApprove(program);
registerListStats(program);
registerDiff(program);
registerGoal(program);
registerSweepScore(program);
registerPreference(program);
registerSession(program);
registerRouting(program);
registerMemoryOps(program);
registerSearch(program);
registerShare(program);
registerMcp(program);
registerTui(program);
registerOrchestratorStatus(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const debugEnabled = program.opts<{ debug?: boolean }>().debug || process.env.REPOBRAIN_DEBUG === "1";
  const commanderError = error as { code?: string; exitCode?: number; message?: string } | null;
  if (commanderError?.code === "commander.helpDisplayed" || commanderError?.code === "commander.version") {
    process.exitCode = 0;
    return;
  }

  if (error instanceof BrainUserError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (typeof commanderError?.exitCode === "number" && commanderError.exitCode !== 0) {
    process.stderr.write(`${commanderError.message ?? "CLI argument error."}\n`);
    process.exitCode = 1;
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof BrainInternalError && !debugEnabled) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${message}\n`);
  if (debugEnabled && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
