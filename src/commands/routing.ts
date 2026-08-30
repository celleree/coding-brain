import { Command } from "commander";
import { stdout as output } from "node:process";
import { loadConfig, renderConfigWarnings } from "../config.js";
import { clearRoutingFeedbackReminders } from "../reinforce-pending.js";
import {
  evaluateExtractWorthiness,
  renderExtractSuggestionJson,
  renderExtractSuggestionMarkdown,
} from "../extract-suggestion.js";
import {
  buildSkillShortlist,
  renderSkillShortlist,
  renderSkillShortlistJson,
  resolveSuggestedSkillPaths,
} from "../suggest-skills.js";
import type { PathSource } from "../suggest-skills.js";
import { renderTaskRoutingBundle, renderTaskRoutingBundleJson } from "../task-routing.js";
import {
  applyRoutingFeedback,
  explainRoutingFeedbackForSkill,
  parseRoutingFeedbackStdin,
  renderExplainRoutingFeedbackText,
} from "../routing-feedback.js";
import { initBrain, persistSourceBytes, updateIndex } from "../store.js";
import { buildRoutingInspectorViewModel } from "../tui/adapters/routing.js";
import * as helpers from "./helpers.js";

export function register(program: Command): void {
  program
    .command("suggest-skills")
    .description(
      "Suggest a skill shortlist from the current task, changed paths, and matched memories. " +
        "When --path is omitted, paths are auto-collected from git diff --name-only HEAD. " +
        'Simplest usage: brain suggest-skills --task "fix refund bug"',
    )
    .option("--task <task>", "Task description to match against skill_trigger_tasks.")
    .option(
      "--path <path>",
      "Override changed paths (skips git diff auto-detection). Repeat or pass a comma-separated list.",
      helpers.collectValues,
      [] as string[],
    )
    .option("--json", 'Print the result as JSON. Equivalent to "--format json".')
    .option("--format <format>", 'Output format: "markdown" or "json".', "markdown")
    .option("--no-session", "Skip `.brain/runtime/session-profile.json` for routing.")
    .action(
      async (options: { task?: string; path: string[]; json?: boolean; format?: string; noSession?: boolean }) => {
        const projectRoot = await helpers.resolveProjectRoot();
        const task = options.task?.trim() || (await helpers.readOptionalStdin());
        const resolvedPaths = resolveSuggestedSkillPaths(projectRoot, options.path);
        const paths = resolvedPaths.paths;
        const pathSource: PathSource = resolvedPaths.path_source;

        const result = await buildSkillShortlist(projectRoot, {
          ...(task ? { task } : {}),
          paths,
          path_source: pathSource,
          ...(options.noSession ? { includeSessionProfile: false } : {}),
        });

        const format = helpers.resolveSuggestSkillsOutputFormat(options);
        output.write(format === "json" ? `${renderSkillShortlistJson(result)}\n` : `${renderSkillShortlist(result)}\n`);
      },
    );

  program;

  program
    .command("suggest-extract")
    .description(
      "Evaluate whether the current session or change is worth extracting as durable memory. " +
        "Uses local deterministic rules only.",
    )
    .option("--task <task>", "Current task description.")
    .option(
      "--path <path>",
      "Override changed paths (skips git diff auto-detection). Repeat or pass a comma-separated list.",
      helpers.collectValues,
      [] as string[],
    )
    .option("--rev <revision>", "Git revision for commit context.", "HEAD")
    .option("--test-summary <text>", "Optional test result summary text.")
    .option("--json", 'Print the result as JSON. Equivalent to "--format json".')
    .option("--format <format>", 'Output format: "markdown" or "json".', "markdown")
    .action(
      async (options: {
        task?: string;
        path: string[];
        rev?: string;
        testSummary?: string;
        json?: boolean;
        format?: string;
      }) => {
        const projectRoot = await helpers.resolveProjectRoot();
        const task = options.task?.trim() || undefined;
        const sessionSummary = (await helpers.readOptionalStdin())?.trim() || undefined;
        const changedFiles = helpers.resolveChangedFiles(projectRoot, options.path);
        const commitContext = await helpers.safeLoadCommitContext(projectRoot, options.rev ?? "HEAD");

        const result = evaluateExtractWorthiness({
          task,
          sessionSummary,
          changedFiles,
          commitMessage: commitContext.commitMessage,
          diffStat: commitContext.diffStat,
          testResultSummary: options.testSummary?.trim() || undefined,
          source: commitContext.commitMessage ? "git-commit" : "session",
        });

        const format = helpers.resolveSuggestSkillsOutputFormat(options);
        output.write(
          format === "json"
            ? `${renderExtractSuggestionJson(result)}\n`
            : `${renderExtractSuggestionMarkdown(result)}\n`,
        );
      },
    );

  program;

  program
    .command("route")
    .alias("start")
    .description(
      "Build a session/task routing bundle by combining inject context and suggest-skills output. " +
        'Use "brain route --task \\"fix refund bug\\"" or the alias "brain start".',
    )
    .option("--task <task>", "Task description to route.")
    .option(
      "--path <path>",
      "Override changed paths (skips git diff auto-detection). Repeat or pass a comma-separated list.",
      helpers.collectValues,
      [] as string[],
    )
    .option(
      "--module <module>",
      "Module or subsystem keywords to prioritize during inject. Repeat or pass a comma-separated list.",
      helpers.collectValues,
      [] as string[],
    )
    .option("--json", 'Print the combined bundle as JSON. Equivalent to "--format json".')
    .option("--format <format>", 'Output format: "markdown" or "json".', "markdown")
    .option("--no-session", "Skip `.brain/runtime/session-profile.json` for inject + routing.")
    .action(
      async (options: {
        task?: string;
        path: string[];
        module: string[];
        json?: boolean;
        format?: string;
        noSession?: boolean;
      }) => {
        const projectRoot = await helpers.resolveProjectRoot();
        const config = await loadConfig(projectRoot);
        renderConfigWarnings(config).forEach((warning) => process.stderr.write(`[repobrain] ${warning}\n`));
        if (config.sweepOnInject) {
          await initBrain(projectRoot);
          await helpers.runSweepAuto(projectRoot, config, (line) => process.stderr.write(`${line}\n`), true);
        }

        const task = options.task?.trim() || (await helpers.readOptionalStdin());
        if (!task) {
          throw new Error('Provide a task with "--task" (or stdin) before running "brain route".');
        }

        const resolvedPaths = resolveSuggestedSkillPaths(projectRoot, options.path);
        const routingInspector = await buildRoutingInspectorViewModel(projectRoot, config, {
          task,
          paths: resolvedPaths.paths,
          path_source: resolvedPaths.path_source,
          modules: options.module,
          warnings: resolvedPaths.warnings,
          ...(options.noSession ? { includeSessionProfile: false } : {}),
        });

        const format = helpers.resolveSuggestSkillsOutputFormat(options);
        output.write(
          format === "json"
            ? `${renderTaskRoutingBundleJson(routingInspector.bundle)}\n`
            : `${renderTaskRoutingBundle(routingInspector.bundle)}\n`,
        );
      },
    );

  program;

  program
    .command("routing-feedback")
    .description(
      "Apply routing feedback events from stdin (JSON array or NDJSON). Does not run agents — updates local preference candidates, confidence, logs, and reinforce reminders.",
    )
    .option("--json", "Print structured result as JSON.")
    .option("--explain <skill>", "Show how preferences and routing feedback logs relate to a skill.")
    .option("--ack-reminders", "Clear routing feedback reminders stored alongside pending reinforcement.")
    .action(async (options: { json?: boolean; explain?: string; ackReminders?: boolean }) => {
      const projectRoot = await helpers.resolveProjectRoot();
      await initBrain(projectRoot);

      if (options.ackReminders) {
        await clearRoutingFeedbackReminders(projectRoot);
        const msg = "[brain] Cleared routing feedback reminders in reinforce-pending.\n";
        output.write(
          options.json ? `${JSON.stringify({ ok: true, cleared: "routing_feedback_reminders" }, null, 2)}\n` : msg,
        );
        return;
      }

      if (options.explain?.trim()) {
        const result = await explainRoutingFeedbackForSkill(projectRoot, options.explain.trim());
        const text = renderExplainRoutingFeedbackText(result);
        output.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${text}\n`);
        return;
      }

      const stdinPayload = await helpers.readStdinPayload();
      const events = parseRoutingFeedbackStdin(stdinPayload.text);
      const sourceEpisode = await persistSourceBytes(projectRoot, stdinPayload.bytes);
      const applied = await applyRoutingFeedback(projectRoot, events, { sourceEpisode });
      await updateIndex(projectRoot);

      if (options.json) {
        output.write(`${JSON.stringify(applied, null, 2)}\n`);
        return;
      }

      output.write(`[brain] routing-feedback: processed ${events.length} event(s)\n`);
      for (const a of applied.applied) {
        output.write(`  ✓ [${a.kind}] ${a.detail}\n`);
      }
      for (const s of applied.skipped) {
        output.write(`  · skipped: ${s.reason}\n`);
      }
      for (const p of applied.pending_review) {
        output.write(`  ⚠ review: ${p.reason}${p.skill ? ` (${p.skill})` : ""}\n`);
      }
    });

  program;
}
