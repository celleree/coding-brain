import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { stdout as output } from "node:process";

import { BrainUserError } from "../errors.js";
import { decodeStdinBuffer } from "../stdin-decode.js";
import { parseRuleFileToMemories } from "../import.js";
import { reviewCandidateMemory } from "../reviewer.js";
import { initBrain, loadStoredMemoryRecords, saveMemory, updateIndex } from "../store.js";
import type { Memory, MemoryType } from "../types.js";
import * as helpers from "./helpers.js";

type ImportOutputFormat = "text" | "json";

interface ImportPlanEntry {
  file: string;
  title: string;
  type: Memory["type"];
  status: "write" | "skip";
  reason?: string;
  review_decision?: string;
  saved_path?: string;
}

interface ImportCommandSummary {
  parsed: number;
  written: number;
  skipped: number;
  dry_run: boolean;
  files: string[];
  entries: ImportPlanEntry[];
}

export function register(program: Command): void {
  program
    .command("import <files...>")
    .description("Import rule-oriented Markdown files into candidate memories for later review.")
    .option("--type <type>", "Force a memory type for every imported memory.", helpers.parseMemoryTypeOption)
    .option("--dry-run", "Preview parsed memories without writing any files.")
    .option("--format <format>", 'Output format: "text" or "json".', "text")
    .action(async (files: string[], options: { type?: MemoryType; dryRun?: boolean; format?: string }) => {
      const projectRoot = await helpers.resolveProjectRoot();
      await initBrain(projectRoot);

      const format = resolveImportOutputFormat(options.format);
      const summary = await importRuleFiles(projectRoot, files, options.type, options.dryRun === true);

      if (!options.dryRun) {
        await updateIndex(projectRoot);
      }

      if (format === "json") {
        output.write(`${JSON.stringify(summary, null, 2)}\n`);
        return;
      }

      renderTextSummary(summary);
    });
}

async function importRuleFiles(
  projectRoot: string,
  files: string[],
  forcedType: MemoryType | undefined,
  dryRun: boolean,
): Promise<ImportCommandSummary> {
  let existingRecords = await loadStoredMemoryRecords(projectRoot);
  const entries: ImportPlanEntry[] = [];
  let parsed = 0;
  let written = 0;

  for (const file of files) {
    const source = await readRuleFile(file);
    const parsedMemories = parseRuleFileToMemories(
      source.text,
      file,
      forcedType ? { defaultType: forcedType } : undefined,
    ).map((memory) => applyForcedType(memory, forcedType));

    parsed += parsedMemories.length;

    for (const memory of parsedMemories) {
      const review = reviewCandidateMemory(memory, existingRecords);
      if (review.reason === "duplicate_memory") {
        entries.push({
          file,
          title: memory.title,
          type: memory.type,
          status: "skip",
          reason: "duplicate",
          review_decision: review.decision,
        });
        continue;
      }

      if (dryRun) {
        written += 1;
        entries.push({
          file,
          title: memory.title,
          type: memory.type,
          status: "write",
          review_decision: review.decision,
        });
        continue;
      }

      const savedPath = await saveMemory({ ...memory, status: "candidate" }, projectRoot, {
        sourceBytes: source.bytes,
      });
      written += 1;
      existingRecords = await loadStoredMemoryRecords(projectRoot);
      entries.push({
        file,
        title: memory.title,
        type: memory.type,
        status: "write",
        review_decision: review.decision,
        saved_path: savedPath,
      });
    }
  }

  return {
    parsed,
    written,
    skipped: parsed - written,
    dry_run: dryRun,
    files,
    entries,
  };
}

async function readRuleFile(filePath: string): Promise<{ bytes: Buffer; text: string }> {
  try {
    const bytes = await readFile(filePath);
    return { bytes, text: decodeStdinBuffer(bytes) };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BrainUserError(`Failed to read import file "${filePath}": ${message}`);
  }
}

function applyForcedType(memory: Memory, forcedType: MemoryType | undefined): Memory {
  if (!forcedType) {
    return memory;
  }
  return {
    ...memory,
    type: forcedType,
    tags: [forcedType, ...memory.tags.filter((tag) => tag !== memory.type && tag !== forcedType)],
  };
}

function resolveImportOutputFormat(value: string | undefined): ImportOutputFormat {
  const normalized = value?.trim().toLowerCase() || "text";
  if (normalized === "text" || normalized === "json") {
    return normalized;
  }
  throw new BrainUserError(`Unsupported import format "${value}". Use "text" or "json".`);
}

function renderTextSummary(summary: ImportCommandSummary): void {
  for (const entry of summary.entries) {
    if (entry.status === "skip") {
      output.write(`- skipped | ${entry.type} | ${entry.title} | ${entry.reason ?? "skipped"}\n`);
      continue;
    }

    const mode = summary.dry_run ? "preview" : "candidate";
    output.write(`- ${mode} | ${entry.type} | ${entry.title}\n`);
  }

  const verb = summary.dry_run ? "Would write" : "Wrote";
  output.write(
    `[import] Parsed ${summary.parsed} memor${summary.parsed === 1 ? "y" : "ies"}; ${verb.toLowerCase()} ${summary.written} candidate${summary.written === 1 ? "" : "s"}; skipped ${summary.skipped}.\n`,
  );
}
