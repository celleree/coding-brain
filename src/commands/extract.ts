import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { stdout as output } from "node:process";
import { loadConfig, renderConfigWarnings } from "../config.js";
import { buildCommitExtractionInput } from "../git-commit.js";
import { evaluateExtractWorthiness } from "../extract-suggestion.js";
import { decodeStdinBuffer } from "../stdin-decode.js";
import { initBrain } from "../store.js";
import type { Memory, MemoryType } from "../types.js";
import * as helpers from "./helpers.js";

export function register(program: Command): void {
  program
    .command("extract")
    .description("Extract long-lived repo knowledge from stdin and save it into .brain.")
    .option("--source <source>", "Memory source label", "session")
    .option("--type <type>", "Force a memory type for extracted entries.", helpers.parseMemoryTypeOption)
    .option("--candidate", "Save extracted memories as candidates for later review.")
    .action(async (options: { source: Memory["source"]; type?: MemoryType; candidate?: boolean }) => {
      const projectRoot = await helpers.resolveProjectRoot();
      await initBrain(projectRoot);

      const config = await loadConfig(projectRoot);
      renderConfigWarnings(config).forEach((warning) => process.stderr.write(`[repobrain] ${warning}\n`));
      const stdinPayload = await helpers.readStdinPayload();
      await helpers.runExtractionWorkflow(projectRoot, config, stdinPayload.text, {
        ...options,
        sourceBytes: stdinPayload.bytes,
      });
    });

  program;

  program
    .command("extract-commit")
    .description("Extract repo knowledge from a richer git commit context for the latest commit or a target revision.")
    .option("--rev <revision>", "Git revision to analyze", "HEAD")
    .option("--candidate", "Save extracted memories as candidates for later review.")
    .action(async (options: { rev?: string; candidate?: boolean }) => {
      const projectRoot = await helpers.resolveProjectRoot();
      await initBrain(projectRoot);

      const config = await loadConfig(projectRoot);
      renderConfigWarnings(config).forEach((warning) => process.stderr.write(`[repobrain] ${warning}\n`));
      const commitContext = await buildCommitExtractionInput(projectRoot, options.rev?.trim() || "HEAD");
      await helpers.runExtractionWorkflow(
        projectRoot,
        config,
        commitContext,
        options.candidate
          ? { source: "git-commit", candidate: true, sourceBytes: Buffer.from(commitContext, "utf8") }
          : { source: "git-commit", sourceBytes: Buffer.from(commitContext, "utf8") },
      );
    });

  program;

  program
    .command("capture")
    .description(
      "Evaluate whether the current session or change is worth extracting, " +
        "and save as candidate memory when recommended. " +
        "Combines suggest-extract detection with the extract pipeline.",
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
    .option("--input <text>", "Inline session summary text (higher priority than --input-file or stdin).")
    .option("--input-file <path>", "Read session summary text from a UTF-8 file (used when --input is omitted).")
    .option("--source <source>", "Memory source label.", "session")
    .option(
      "--type <type>",
      "Force a memory type for extracted entries (overrides suggested_type).",
      helpers.parseMemoryTypeOption,
    )
    .option("--force-candidate", "Save as candidate even when signals are ambiguous (not clearly positive).")
    .option("--json", 'Print the capture result as JSON. Equivalent to "--format json".')
    .option("--format <format>", 'Output format: "markdown" or "json".', "markdown")
    .action(
      async (options: {
        task?: string;
        path: string[];
        rev?: string;
        testSummary?: string;
        input?: string;
        inputFile?: string;
        source: Memory["source"];
        type?: MemoryType;
        forceCandidate?: boolean;
        json?: boolean;
        format?: string;
      }) => {
        const projectRoot = await helpers.resolveProjectRoot();
        await initBrain(projectRoot);

        const task = options.task?.trim() || undefined;
        const inlineInput = options.input?.trim();
        let sessionSummary: string | undefined;
        let sessionSourceBytes: Buffer | undefined;
        if (inlineInput) {
          sessionSummary = inlineInput;
          sessionSourceBytes = Buffer.from(options.input ?? "", "utf8");
        } else if (options.inputFile?.trim()) {
          const inputFilePath = options.inputFile.trim();
          try {
            const fileBytes = await readFile(inputFilePath);
            const fileContent = decodeStdinBuffer(fileBytes);
            const trimmed = fileContent.trim();
            sessionSummary = trimmed || undefined;
            sessionSourceBytes = fileBytes;
          } catch (error: unknown) {
            const reason = error instanceof Error && error.message ? error.message : String(error);
            throw new Error(`Failed to read --input-file "${inputFilePath}": ${reason}`, {
              cause: error,
            });
          }
        } else {
          const stdinPayload = await helpers.readOptionalStdinPayload();
          sessionSummary = stdinPayload?.text.trim() || undefined;
          sessionSourceBytes = stdinPayload?.bytes;
        }
        const changedFiles = helpers.resolveChangedFiles(projectRoot, options.path);
        const commitContext = await helpers.safeLoadCommitContext(projectRoot, options.rev ?? "HEAD");

        const suggestion = evaluateExtractWorthiness({
          task,
          sessionSummary,
          changedFiles,
          commitMessage: commitContext.commitMessage,
          diffStat: commitContext.diffStat,
          testResultSummary: options.testSummary?.trim() || undefined,
          source: commitContext.commitMessage ? "git-commit" : "session",
        });

        const shouldProceed = suggestion.should_extract || (options.forceCandidate && suggestion.confidence < 0.5);

        if (!shouldProceed) {
          const format = helpers.resolveSuggestSkillsOutputFormat(options);
          const captureResult: helpers.CaptureResult = {
            action: "skipped",
            reason: suggestion.summary,
            suggestion,
            saved_paths: [],
          };

          if (format === "json") {
            output.write(`${JSON.stringify(captureResult, null, 2)}\n`);
          } else {
            output.write("[capture] Not recommended for extraction.\n");
            output.write(`Reason: ${suggestion.summary}\n`);
            if (suggestion.evidence.length > 0) {
              output.write("Evidence:\n");
              for (const e of suggestion.evidence) {
                const mark = e.signal === "positive" ? "+" : e.signal === "negative" ? "-" : "~";
                output.write(`  [${mark}${Math.abs(e.weight).toFixed(1)}] ${e.rule}: ${e.detail}\n`);
              }
            }
            if (!options.forceCandidate) {
              output.write('Tip: use "--force-candidate" to save as candidate despite ambiguous signals.\n');
            }
          }
          return;
        }

        const config = await loadConfig(projectRoot);
        renderConfigWarnings(config).forEach((warning) => process.stderr.write(`[repobrain] ${warning}\n`));

        const rawInput = helpers.buildCaptureExtractionInput(
          task,
          sessionSummary,
          commitContext,
          changedFiles,
          options.testSummary,
        );
        const resolvedType = options.type ?? suggestion.suggested_type ?? undefined;

        const savedPaths = await helpers.runExtractionWorkflow(projectRoot, config, rawInput, {
          source: options.source ?? "session",
          ...(resolvedType ? { type: resolvedType } : {}),
          candidate: true,
          sourceBytes: sessionSourceBytes ?? Buffer.from(rawInput, "utf8"),
        });

        const format = helpers.resolveSuggestSkillsOutputFormat(options);
        const captureResult: helpers.CaptureResult = {
          action: savedPaths.length > 0 ? "saved_as_candidate" : "extraction_empty",
          reason: suggestion.summary,
          suggestion,
          saved_paths: savedPaths,
        };

        if (format === "json") {
          output.write(`${JSON.stringify(captureResult, null, 2)}\n`);
        } else if (savedPaths.length === 0) {
          output.write("[capture] Extraction recommended but no memories were produced from the input.\n");
          output.write(`Suggestion: ${suggestion.summary}\n`);
        }
      },
    );

  program;
}
