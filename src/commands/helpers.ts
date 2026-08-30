import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { findProjectRoot, getWorkflowPreset, loadConfig, writeConfig } from "../config.js";
import { decodeStdinBuffer } from "../stdin-decode.js";
import { extractMemories } from "../extract.js";
import { buildCommitExtractionInput } from "../git-commit.js";
import { loadPendingReinforcementState } from "../reinforce-pending.js";
import { isSafeForAutoApproval, looksTemporary, reviewCandidateMemories, reviewCandidateMemory } from "../reviewer.js";
import type { ExtractSuggestionResult } from "../extract-suggestion.js";
import { collectGitDiffPaths } from "../suggest-skills.js";
import { detectSystemLanguage } from "../i18n.js";
import {
  applySweepAuto,
  archiveGoalMemory,
  deleteExpiredWorking,
  downgradeStaleMemory,
  previewMemoryLines,
  scanSweepCandidates,
  toDisplayPath,
} from "../sweep.js";
import { getMemoryStatus, loadStoredMemoryRecords, saveMemory, updateIndex } from "../store.js";
import type { FailureEvent } from "../failure-detector.js";
import type {
  BrainConfig,
  CandidateMemoryReviewResult,
  Memory,
  MemoryActivityEntry,
  StoredMemoryRecord,
  MemoryType,
  WorkflowMode,
} from "../types.js";
import { MEMORY_TYPES } from "../types.js";

export async function runExtractionWorkflow(
  projectRoot: string,
  config: BrainConfig,
  rawInput: string,
  options: {
    source: Memory["source"];
    type?: MemoryType;
    candidate?: boolean;
    sourceBytes?: Uint8Array;
  },
): Promise<string[]> {
  const memories = (await extractMemories(rawInput, config, projectRoot)).map((memory) =>
    applyExtractedMemoryDefaults(memory, options.type),
  );
  const existingRecords = await loadStoredMemoryRecords(projectRoot);
  const reviewedCandidates = reviewCandidateMemories(memories, existingRecords);
  const savedPaths: string[] = [];
  const deferredCandidates: string[] = [];
  const rejectedCandidates: string[] = [];

  for (const entry of reviewedCandidates) {
    const { memory, review } = entry;
    const toSave: Memory = {
      ...memory,
      ...(options.source ? { source: options.source } : {}),
    };

    if (review.decision === "reject") {
      rejectedCandidates.push(memory.title);
      continue;
    }

    const resolvedStatus = options.candidate || review.decision !== "accept" ? ("candidate" as const) : undefined;
    const savedPath = await saveMemory(
      resolvedStatus
        ? {
            ...toSave,
            status: resolvedStatus,
          }
        : toSave,
      projectRoot,
      { sourceBytes: options.sourceBytes ?? Buffer.from(rawInput, "utf8") },
    );
    savedPaths.push(savedPath);

    if (review.decision !== "accept") {
      deferredCandidates.push(memory.title);
    }
  }

  await updateIndex(projectRoot);
  output.write(
    `Reviewed ${reviewedCandidates.length} extracted memor${reviewedCandidates.length === 1 ? "y" : "ies"}.\n`,
  );
  for (const entry of reviewedCandidates) {
    output.write(
      `- ${entry.review.decision} | targets=${entry.review.target_memory_ids.join(", ") || "-"} | reason=${entry.review.reason} | ${entry.memory.title}\n`,
    );
  }

  output.write(
    `Saved ${savedPaths.length} memor${savedPaths.length === 1 ? "y" : "ies"}${options.candidate ? " as candidates" : ""}.\n`,
  );
  for (const savedPath of savedPaths) {
    output.write(`- ${savedPath}\n`);
  }

  if (deferredCandidates.length > 0) {
    output.write(
      `${deferredCandidates.length} memor${deferredCandidates.length === 1 ? "y" : "ies"} were kept as candidates because the review decision requires confirmation.\n`,
    );
  }

  if (rejectedCandidates.length > 0) {
    output.write(
      `${rejectedCandidates.length} memor${rejectedCandidates.length === 1 ? "y" : "ies"} were rejected and not written.\n`,
    );
  }

  return savedPaths;
}

export interface RawTextPayload {
  bytes: Buffer;
  text: string;
}

export async function readStdinPayload(): Promise<RawTextPayload> {
  const chunks: Buffer[] = [];

  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const bytes = Buffer.concat(chunks);
  return { bytes, text: decodeStdinBuffer(bytes) };
}

export async function readStdin(): Promise<string> {
  return (await readStdinPayload()).text;
}

export async function runSweepAuto(
  projectRoot: string,
  config: BrainConfig,
  writeLine: (line: string) => void,
  quietWhenNoActions = false,
): Promise<void> {
  const result = await applySweepAuto(projectRoot, config);
  result.lines.forEach((line) => writeLine(line));

  if (!quietWhenNoActions || result.changed || result.scan.duplicatePairs.length > 0) {
    writeLine("brain sweep 扫描完成");
    writeLine(`过期 working 记忆: ${result.scan.expiredWorking.length}`);
    writeLine(`陈旧记忆: ${result.scan.staleMemories.length}`);
    writeLine(`可疑重复对: ${result.scan.duplicatePairs.length}`);
    writeLine(`已完成 goal: ${result.scan.archiveGoals.length}`);
  }
}

export async function runSweepInteractive(projectRoot: string, config: BrainConfig): Promise<void> {
  const terminal = await createPromptTerminal();
  if (!terminal) {
    throw new Error('Interactive sweep requires a TTY. Re-run with "--auto" or "--dry-run".');
  }

  const rl = createInterface({
    input: terminal.input,
    output: terminal.output,
  });

  let changed = false;
  const deletedPaths = new Set<string>();

  try {
    const result = await scanSweepCandidates(projectRoot, config);
    const today = getTodayDate();

    for (const entry of result.expiredWorking) {
      const answer = (await rl.question(`? 删除已过期的 working 记忆 "${entry.record.memory.title}"？[Y/n] `))
        .trim()
        .toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") {
        await deleteExpiredWorking(entry);
        changed = true;
        output.write(`[EXPIRED]  已删除 ${toDisplayPath(entry.record)}\n`);
      }
    }

    for (const entry of result.staleMemories) {
      const answer = (
        await rl.question(
          `? 降权 ${entry.daysSinceUpdated} 天未更新的记忆 "${entry.record.memory.title}"（${entry.record.memory.importance} → ${entry.nextImportance}）？[Y/n] `,
        )
      )
        .trim()
        .toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") {
        await downgradeStaleMemory(entry, today);
        changed = true;
        output.write(`[STALE]    已降权 ${toDisplayPath(entry.record)}\n`);
      }
    }

    for (const entry of result.duplicatePairs) {
      if (deletedPaths.has(entry.left.filePath) || deletedPaths.has(entry.right.filePath)) {
        continue;
      }

      output.write("? 发现可能重复的记忆：\n");
      output.write(`[1] ${toDisplayPath(entry.left, false)}: "${entry.left.memory.title}"\n`);
      for (const line of previewMemoryLines(entry.left)) {
        output.write(`    ${line}\n`);
      }
      output.write(`[2] ${toDisplayPath(entry.right, false)}: "${entry.right.memory.title}"\n`);
      for (const line of previewMemoryLines(entry.right)) {
        output.write(`    ${line}\n`);
      }

      const answer = (await rl.question("操作: (1) 保留两者  (2) 删除 [1]  (3) 删除 [2]  (4) 跳过 "))
        .trim()
        .toLowerCase();

      if (answer === "2") {
        await rm(entry.left.filePath, { force: true });
        deletedPaths.add(entry.left.filePath);
        changed = true;
        output.write(`[POSSIBLE-DUP] 已删除 ${toDisplayPath(entry.left)}\n`);
      } else if (answer === "3") {
        await rm(entry.right.filePath, { force: true });
        deletedPaths.add(entry.right.filePath);
        changed = true;
        output.write(`[POSSIBLE-DUP] 已删除 ${toDisplayPath(entry.right)}\n`);
      }
    }

    for (const entry of result.archiveGoals) {
      if (deletedPaths.has(entry.record.filePath)) {
        continue;
      }

      const answer = (
        await rl.question(`? 将已完成 30+ 天的目标 "${entry.record.memory.title}" 归档到 .brain/archive/？[Y/n] `)
      )
        .trim()
        .toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") {
        const archivedPath = await archiveGoalMemory(projectRoot, entry);
        changed = true;
        output.write(
          `[ARCHIVE]  已归档 ${toDisplayPath(entry.record)} → ${path.relative(projectRoot, archivedPath).replace(/\\/g, "/")}\n`,
        );
      }
    }

    if (changed) {
      await updateIndex(projectRoot);
    }
  } finally {
    rl.close();
    terminal.close();
  }
}

export async function promptSteeringRulesChoice(): Promise<"claude" | "codex" | "cursor" | "all" | "both" | "skip"> {
  const rl = createInterface({
    input,
    output,
  });

  try {
    output.write("? 你使用哪个 AI 编码工具？（用于生成 steering rules）\n");
    output.write("1. Claude Code（生成 .claude/rules/brain-session.md）\n");
    output.write("2. Codex（补充 .codex/brain-session.md）\n");
    output.write("3. Cursor（生成 .cursor/rules/brain-session.mdc）\n");
    output.write("4. 全部\n");
    output.write("5. 跳过\n");

    while (true) {
      const answer = (await rl.question("选择 [5]: ")).trim().toLowerCase();
      if (!answer || answer === "5" || answer === "skip") {
        return "skip";
      }
      if (answer === "1" || answer === "claude" || answer === "claude code") {
        return "claude";
      }
      if (answer === "2" || answer === "codex") {
        return "codex";
      }
      if (answer === "3" || answer === "cursor") {
        return "cursor";
      }
      if (answer === "4" || answer === "all" || answer === "both" || answer === "全部") {
        return "all";
      }

      output.write('请输入 1-5，或输入 "claude" / "codex" / "cursor" / "all" / "skip"。\n');
    }
  } finally {
    rl.close();
  }
}

export interface WorkflowSnapshot {
  workflow: ReturnType<typeof getWorkflowPreset>;
  candidateCount: number;
  safeCandidateCount: number;
  pendingReinforceCount: number;
  cleanupCount: number;
  reminders: string[];
  nextSteps: string[];
}

export async function applyWorkflowPresetConfig(projectRoot: string, workflowMode: WorkflowMode): Promise<void> {
  const currentConfig = await loadConfig(projectRoot);
  const preset = getWorkflowPreset(workflowMode);
  const detectedLanguage = detectSystemLanguage();
  await writeConfig(projectRoot, {
    ...currentConfig,
    workflowMode,
    triggerMode: preset.triggerMode,
    captureMode: preset.captureMode,
    extractMode: preset.extractMode,
    language: detectedLanguage,
    sweepOnInject: preset.sweepOnInject,
    autoApproveSafeCandidates: preset.autoApproveSafeCandidates,
  });
}

export function resolveSteeringRulesChoice(
  value: string | undefined,
  skip: boolean | undefined,
): "claude" | "codex" | "cursor" | "all" | "both" | "skip" {
  if (skip) {
    return "skip";
  }

  if (!value) {
    return "all";
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "claude" ||
    normalized === "codex" ||
    normalized === "cursor" ||
    normalized === "all" ||
    normalized === "both" ||
    normalized === "skip"
  ) {
    return normalized;
  }

  throw new Error(
    'Use "--steering-rules claude", "--steering-rules codex", "--steering-rules cursor", "--steering-rules all", or "--skip-steering-rules".',
  );
}

export function renderWorkflowSummaryLines(workflowMode: WorkflowMode): string[] {
  const preset = getWorkflowPreset(workflowMode);
  return [
    `Workflow: ${preset.label} (${preset.mode})`,
    `Trigger: ${preset.triggerMode === "detect" ? "auto-detect (hooks/capture)" : "manual (CLI only)"}`,
    `Capture: ${preset.captureMode === "candidate" ? "candidate-first (all new memories start as candidate)" : "direct (write active immediately)"}`,
    `Auto-approve safe candidates: ${preset.autoApproveSafeCandidates ? "yes" : "no"}`,
    `Sweep on inject: ${preset.sweepOnInject ? "yes" : "no"}`,
    `Fit: ${preset.audience}`,
    `Risk: ${preset.risk}`,
  ];
}

export function renderSetupNextSteps(workflowMode: WorkflowMode): string[] {
  const preset = getWorkflowPreset(workflowMode);
  const steps = [
    'Start the first conversation in each session with "brain start"; if a fresh conversation opens later in the same session, let "brain conversation-start" decide whether to refresh or skip.',
    'End sessions by extracting candidates with "brain extract" or let the hook queue them for review.',
    'Use "brain review" and "brain approve --safe" as the normal daily promotion loop.',
  ];

  if (preset.triggerMode === "manual") {
    steps[1] = 'End sessions with "brain extract" or "brain extract-commit" because triggerMode is manual.';
  }

  if (preset.autoApproveSafeCandidates) {
    steps.push('Check "brain status" regularly because safe auto-approve is enabled for clear low-risk candidates.');
  }

  return steps;
}

export function formatSteeringRulesStatus(status: {
  claudeConfigured: boolean;
  codexConfigured: boolean;
  cursorConfigured: boolean;
}): string {
  const configured: string[] = [];
  if (status.claudeConfigured) {
    configured.push("claude");
  }
  if (status.codexConfigured) {
    configured.push("codex");
  }
  if (status.cursorConfigured) {
    configured.push("cursor");
  }

  return configured.length > 0 ? configured.join(", ") : 'missing (run "brain init --steering-rules all")';
}

export async function buildWorkflowSnapshot(
  projectRoot: string,
  config: BrainConfig,
  memories: Memory[],
): Promise<WorkflowSnapshot> {
  const records = await loadStoredMemoryRecords(projectRoot);
  const candidateRecords = getCandidateRecords(records);
  const safeCandidateCount = candidateRecords.filter((entry) =>
    isSafeCandidateReview(
      reviewCandidateMemory(
        entry.memory,
        records.filter((record) => record.filePath !== entry.filePath),
      ),
    ),
  ).length;
  const pendingReinforcement = await loadPendingReinforcementState(projectRoot);
  const sweepResult = await scanSweepCandidates(projectRoot, config).catch(() => null);
  const cleanupCount = sweepResult
    ? sweepResult.expiredWorking.length +
      sweepResult.staleMemories.length +
      sweepResult.archiveGoals.length +
      sweepResult.duplicatePairs.length
    : buildScoreCandidates(records).length;
  const reminders: string[] = [];
  const nextSteps: string[] = [];
  const workflow = getWorkflowPreset(config.workflowMode);

  if (candidateRecords.length > 0) {
    reminders.push(
      `You have ${candidateRecords.length} candidate memor${candidateRecords.length === 1 ? "y" : "ies"} waiting for review.`,
    );
    nextSteps.push(
      safeCandidateCount > 0
        ? `run "brain review" and then "brain approve --safe" for ${safeCandidateCount} low-risk candidate memor${safeCandidateCount === 1 ? "y" : "ies"}`
        : 'run "brain review" to inspect the pending candidate queue before approving anything',
    );
  }

  if (pendingReinforcement.events.length > 0) {
    reminders.push(
      `You have ${pendingReinforcement.events.length} reinforcement suggestion${pendingReinforcement.events.length === 1 ? "" : "s"} waiting to be applied.`,
    );
    nextSteps.push(
      `run "brain reinforce --pending" to apply ${pendingReinforcement.events.length} queued reinforcement suggestion${pendingReinforcement.events.length === 1 ? "" : "s"}`,
    );
  }

  if (cleanupCount > 0) {
    reminders.push(
      `You have ${cleanupCount} stale, expired, duplicate, or archive-ready memor${cleanupCount === 1 ? "y" : "ies"} to clean up.`,
    );
    nextSteps.push('run "brain score" or "brain sweep --dry-run" to inspect cleanup candidates');
  }

  if (memories.length === 0) {
    nextSteps.push('capture your first durable lesson with "brain extract" after the next meaningful task');
  }

  if (nextSteps.length === 0) {
    nextSteps.push(
      'run "brain start" for the first conversation in the next coding session, or "brain conversation-start" when a later fresh conversation needs a smart refresh decision',
    );
  }

  return {
    workflow,
    candidateCount: candidateRecords.length,
    safeCandidateCount,
    pendingReinforceCount: pendingReinforcement.events.length,
    cleanupCount,
    reminders,
    nextSteps,
  };
}

export async function readOptionalStdin(): Promise<string | undefined> {
  return (await readOptionalStdinPayload())?.text.trim() || undefined;
}

export async function readOptionalStdinPayload(): Promise<RawTextPayload | undefined> {
  if (input.isTTY) {
    return undefined;
  }

  const STDIN_TIMEOUT_MS = 200;
  return new Promise<RawTextPayload | undefined>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        input.removeAllListeners("data");
        input.removeAllListeners("end");
        input.removeAllListeners("error");
        input.pause();
        input.destroy();
        const bytes = Buffer.concat(chunks);
        resolve(chunks.length > 0 ? { bytes, text: decodeStdinBuffer(bytes) } : undefined);
      }
    }, STDIN_TIMEOUT_MS);

    input.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    input.on("end", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const bytes = Buffer.concat(chunks);
        resolve(chunks.length > 0 ? { bytes, text: decodeStdinBuffer(bytes) } : undefined);
      }
    });

    input.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      }
    });

    input.resume();
  });
}

export async function resolveProjectRoot(): Promise<string> {
  return (await findProjectRoot(process.cwd())) ?? process.cwd();
}

export function collectValues(value: string, previous: string[]): string[] {
  return [
    ...previous,
    ...value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  ];
}

export function resolveSuggestSkillsOutputFormat(options: { json?: boolean; format?: string }): "markdown" | "json" {
  const format = options.format?.trim().toLowerCase() || "markdown";
  if (format !== "markdown" && format !== "json") {
    throw new Error('Use "--format markdown" or "--format json".');
  }

  if (options.json && format !== "json" && options.format) {
    throw new Error('Use either "--json" or "--format json", not both with different values.');
  }

  return options.json ? "json" : format;
}

export function parseMemoryTypeOption(value: string): MemoryType {
  const normalized = value.trim().toLowerCase();
  if (MEMORY_TYPES.includes(normalized as MemoryType)) {
    return normalized as MemoryType;
  }

  throw new Error(`Unsupported memory type "${value}". Expected one of: ${MEMORY_TYPES.join(", ")}.`);
}

export function applyExtractedMemoryDefaults(memory: Memory, forcedType?: MemoryType): Memory {
  const type = forcedType ?? memory.type;
  const today = getTodayDate();
  const nextMemory: Memory = {
    ...memory,
    type,
    created: memory.created ?? today,
    updated: today,
  };

  if (type === "working" && !nextMemory.expires) {
    nextMemory.expires = addDays(today, 7);
  }

  if (type === "goal" && !nextMemory.status) {
    nextMemory.status = "active";
  }

  return nextMemory;
}

export function getTodayDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(dateOnly: string, days: number): string {
  const base = new Date(`${dateOnly}T00:00:00`);
  base.setDate(base.getDate() + days);
  return getTodayDate(base);
}

export function formatCountMap(map: Map<string, number>): string {
  return Array.from(map.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

export function formatMemoryListLine(memory: Memory): string {
  const tags = memory.tags.length > 0 ? ` [${memory.tags.join(", ")}]` : "";
  const status = getMemoryStatus(memory);
  return `${memory.date} | ${memory.type} | ${memory.importance} | ${status} | ${memory.title}${tags}`;
}

export function renderGoalList(memories: Memory[]): string {
  const grouped = new Map<string, Memory[]>();

  for (const memory of memories) {
    const status = getMemoryStatus(memory);
    const bucket = grouped.get(status) ?? [];
    bucket.push(memory);
    grouped.set(status, bucket);
  }

  return Array.from(grouped.entries())
    .sort(([leftStatus], [rightStatus]) => compareGoalStatus(leftStatus, rightStatus))
    .map(([status, entries]) => {
      const lines = entries.map((memory) => `- ${formatMemoryListLine(memory)}`);
      return [`[${status}]`, ...lines].join("\n");
    })
    .join("\n");
}

export function compareGoalStatus(left: string, right: string): number {
  const order = ["active", "done", "stale", "candidate", "superseded"];
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);

  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) {
      return 1;
    }

    if (rightIndex === -1) {
      return -1;
    }

    return leftIndex - rightIndex;
  }

  return left.localeCompare(right);
}

export function formatMemoryList(memories: Array<Memory | MemoryActivityEntry>): string {
  if (memories.length === 0) {
    return "- None.";
  }

  return memories
    .map((memory) => {
      const status = "status" in memory && typeof memory.status === "string" ? ` | ${memory.status}` : "";
      return `- ${memory.type} | ${memory.importance}${status} | ${memory.title} (${memory.date})`;
    })
    .join("\n");
}

export function resolveStoredMemoryByFile(records: StoredMemoryRecord[], rawQuery: string): StoredMemoryRecord {
  const query = rawQuery.trim();
  if (!query) {
    throw new Error('Provide a memory file path like "decisions/use-tsup.md".');
  }

  const matches = records.filter((entry) => matchesStoredMemoryFile(entry, query));
  const firstMatch = matches[0];
  if (matches.length === 1 && firstMatch) {
    return firstMatch;
  }

  if (matches.length > 1) {
    throw new Error(
      [
        `Multiple memory files matched "${rawQuery}".`,
        "Use a more specific path under .brain/:",
        ...matches.map((entry) => `- ${toBrainRelativePath(entry.relativePath)}`),
      ].join("\n"),
    );
  }

  throw new Error(`Memory file "${rawQuery}" was not found. Run "brain list" to inspect available memories.`);
}

export function matchesStoredMemoryFile(entry: StoredMemoryRecord, rawQuery: string): boolean {
  const query = normalizeMemoryPathQuery(rawQuery);
  const brainRelativePath = normalizeMemoryPathQuery(toBrainRelativePath(entry.relativePath));
  const undatedRelativePath = normalizeMemoryPathQuery(toUndatedBrainRelativePath(entry.relativePath));
  const fileName = normalizeMemoryPathQuery(path.basename(entry.relativePath));
  const fileStem = normalizeMemoryPathQuery(path.basename(entry.relativePath, path.extname(entry.relativePath)));

  return brainRelativePath === query || undatedRelativePath === query || fileName === query || fileStem === query;
}

export function normalizeMemoryPathQuery(value: string): string {
  return value
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\.brain\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}

export function toBrainRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.brain\//, "");
}

export function toUndatedBrainRelativePath(relativePath: string): string {
  const normalized = toBrainRelativePath(relativePath);
  const directory = path.posix.dirname(normalized);
  const fileName = path.posix.basename(normalized);
  const undecorated = fileName.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-\d{9}(?:-\d+)?\.md$/, ".md");

  return directory === "." ? undecorated : `${directory}/${undecorated}`;
}

export function describeSupersedeState(
  newRecord: StoredMemoryRecord,
  oldRecord: StoredMemoryRecord,
  desiredNewPath: string,
  desiredOldPath: string,
): {
  alreadyLinked: boolean;
  hasExistingRelationship: boolean;
  details: string[];
} {
  const details: string[] = [];
  const currentNewSupersedes = newRecord.memory.supersedes;
  const currentOldSupersededBy = oldRecord.memory.superseded_by;

  if (currentNewSupersedes && currentNewSupersedes !== desiredOldPath) {
    details.push(`新记忆当前 supersedes: ${currentNewSupersedes}`);
  }

  if (currentOldSupersededBy && currentOldSupersededBy !== desiredNewPath) {
    details.push(`旧记忆当前 superseded_by: ${currentOldSupersededBy}`);
  }

  return {
    alreadyLinked:
      currentNewSupersedes === desiredOldPath &&
      currentOldSupersededBy === desiredNewPath &&
      oldRecord.memory.stale === true,
    hasExistingRelationship: details.length > 0,
    details,
  };
}

export function renderMemoryLineage(records: StoredMemoryRecord[], rawQuery?: string): string {
  const lineageNodes = new Map<string, StoredMemoryRecord>();
  const supersedesByNode = new Map<string, string | null>();
  const supersededByNode = new Map<string, string[]>();

  for (const record of records) {
    const pathKey = toBrainRelativePath(record.relativePath);
    const hasLineage = Boolean(record.memory.supersedes || record.memory.superseded_by);
    if (!hasLineage) {
      continue;
    }

    lineageNodes.set(pathKey, record);
    supersedesByNode.set(pathKey, record.memory.supersedes ?? null);
    supersededByNode.set(pathKey, []);
  }

  const matchedRecord = rawQuery ? resolveStoredMemoryByFile(records, rawQuery) : null;
  if (lineageNodes.size === 0) {
    if (matchedRecord) {
      return `Memory "${toBrainRelativePath(matchedRecord.relativePath)}" has no lineage relationships.`;
    }

    return "No memory lineage found.";
  }

  for (const [pathKey, record] of lineageNodes.entries()) {
    const supersedes = record.memory.supersedes;
    if (!supersedes) {
      continue;
    }

    const target = lineageNodes.get(supersedes);
    if (!target) {
      throw new Error(
        `Memory lineage reference "${supersedes}" from "${pathKey}" does not exist. Run "brain list" to inspect available memories.`,
      );
    }

    const incoming = supersededByNode.get(supersedes);
    if (incoming) {
      incoming.push(pathKey);
    }
  }

  detectLineageCycles(lineageNodes, supersedesByNode);

  const roots = Array.from(lineageNodes.keys())
    .filter((pathKey) => (supersededByNode.get(pathKey) ?? []).length === 0)
    .sort((left, right) => compareLineageRecords(lineageNodes.get(left), lineageNodes.get(right)));

  const selectedRoots = matchedRecord
    ? filterLineageRootsByQuery(roots, lineageNodes, toBrainRelativePath(matchedRecord.relativePath))
    : roots;

  if (selectedRoots.length === 0) {
    if (matchedRecord) {
      const matchedPath = toBrainRelativePath(matchedRecord.relativePath);
      if (!lineageNodes.has(matchedPath)) {
        return `Memory "${matchedPath}" has no lineage relationships.`;
      }
    }

    return "No memory lineage found.";
  }

  return selectedRoots
    .map((rootPath) => renderLineageNode(rootPath, lineageNodes, supersedesByNode, "", true))
    .join("\n\n");
}

export function filterLineageRootsByQuery(
  roots: string[],
  lineageNodes: Map<string, StoredMemoryRecord>,
  matchedPath: string,
): string[] {
  return roots.filter((rootPath) => lineageContains(rootPath, matchedPath, supersedesByNodeFromRecords(lineageNodes)));
}

export function supersedesByNodeFromRecords(lineageNodes: Map<string, StoredMemoryRecord>): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const [pathKey, record] of lineageNodes.entries()) {
    result.set(pathKey, record.memory.supersedes ?? null);
  }
  return result;
}

export function lineageContains(
  currentPath: string,
  targetPath: string,
  supersedesByNode: Map<string, string | null>,
): boolean {
  let cursor: string | null = currentPath;

  while (cursor) {
    if (cursor === targetPath) {
      return true;
    }

    cursor = supersedesByNode.get(cursor) ?? null;
  }

  return false;
}

export function detectLineageCycles(
  lineageNodes: Map<string, StoredMemoryRecord>,
  supersedesByNode: Map<string, string | null>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (pathKey: string): void => {
    if (visited.has(pathKey)) {
      return;
    }

    if (visiting.has(pathKey)) {
      throw new Error(`Memory lineage contains a cycle involving "${pathKey}".`);
    }

    visiting.add(pathKey);
    const next = supersedesByNode.get(pathKey) ?? null;
    if (next && lineageNodes.has(next)) {
      visit(next);
    }
    visiting.delete(pathKey);
    visited.add(pathKey);
  };

  for (const pathKey of lineageNodes.keys()) {
    visit(pathKey);
  }
}

export function renderLineageNode(
  pathKey: string,
  lineageNodes: Map<string, StoredMemoryRecord>,
  supersedesByNode: Map<string, string | null>,
  prefix: string,
  isRoot: boolean,
): string {
  const record = lineageNodes.get(pathKey);
  if (!record) {
    throw new Error(`Missing lineage node "${pathKey}".`);
  }

  const currentLine = `${prefix}${isRoot ? "" : "└── supersedes: "}${formatLineageRecord(record)}`;
  const parentPath = supersedesByNode.get(pathKey) ?? null;

  if (!parentPath) {
    return currentLine;
  }

  return `${currentLine}\n${renderLineageNode(parentPath, lineageNodes, supersedesByNode, `${prefix}${isRoot ? "" : "    "}`, false)}`;
}

export function formatLineageRecord(record: StoredMemoryRecord): string {
  const version = record.memory.version ?? 1;
  const status = record.memory.stale || record.memory.superseded_by ? "✗ 已过期" : "✓ 有效";
  return `[${record.memory.type}] ${toUndatedBrainRelativePath(record.relativePath)}  v${version} · score:${record.memory.score} · ${status}`;
}

export function compareLineageRecords(
  left: StoredMemoryRecord | undefined,
  right: StoredMemoryRecord | undefined,
): number {
  if (!left && !right) {
    return 0;
  }

  if (!left) {
    return 1;
  }

  if (!right) {
    return -1;
  }

  return right.memory.date.localeCompare(left.memory.date);
}

export function getCandidateRecords(records: StoredMemoryRecord[]): StoredMemoryRecord[] {
  return records.filter((entry) => getMemoryStatus(entry.memory) === "candidate");
}

export interface SafeCandidateRecord {
  record: StoredMemoryRecord;
  review: CandidateMemoryReviewResult;
}

export function resolveCandidateRecords(
  records: StoredMemoryRecord[],
  rawQuery: string | undefined,
  all: boolean | undefined,
): StoredMemoryRecord[] {
  const candidates = getCandidateRecords(records);
  if (candidates.length === 0) {
    throw new Error("No candidate memories found.");
  }

  if (all) {
    return candidates;
  }

  const query = rawQuery?.trim();
  if (!query) {
    throw new Error('Provide a candidate id or use "--all".');
  }

  const matches = candidates.filter((entry) => matchesStoredMemory(entry, query));
  if (matches.length === 0) {
    throw new Error(`No candidate memory matched "${query}".`);
  }

  if (matches.length > 1) {
    const suggestions = matches.map((entry) => `- ${getStoredMemoryId(entry)} (${entry.memory.title})`);
    throw new Error(
      [`Multiple candidate memories matched "${query}". Use a more specific id:`, ...suggestions].join("\n"),
    );
  }

  return matches;
}

export function resolveSafeCandidateRecords(
  records: StoredMemoryRecord[],
  rawQuery: string | undefined,
  all: boolean | undefined,
): {
  matches: StoredMemoryRecord[];
  skipped: SafeCandidateRecord[];
} {
  const candidates = getCandidateRecords(records);
  if (candidates.length === 0) {
    throw new Error("No candidate memories found.");
  }

  const evaluations = candidates.map((record) => ({
    record,
    review: reviewCandidateMemory(
      record.memory,
      records.filter((entry) => entry.filePath !== record.filePath),
    ),
  }));
  const safeMatches = evaluations.filter((entry) => isSafeCandidateReview(entry.review));
  const skipped = evaluations.filter((entry) => !isSafeCandidateReview(entry.review));

  if (all || !rawQuery?.trim()) {
    return {
      matches: safeMatches.map((entry) => entry.record),
      skipped,
    };
  }

  const query = rawQuery.trim();
  const target = evaluations.filter(({ record }) => matchesStoredMemory(record, query));
  if (target.length === 0) {
    throw new Error(`No candidate memory matched "${query}".`);
  }

  if (target.length > 1) {
    const suggestions = target.map(({ record }) => `- ${getStoredMemoryId(record)} (${record.memory.title})`);
    throw new Error(
      [`Multiple candidate memories matched "${query}". Use a more specific id:`, ...suggestions].join("\n"),
    );
  }

  const [selected] = target;
  if (!selected) {
    throw new Error(`No candidate memory matched "${query}".`);
  }

  if (!isSafeCandidateReview(selected.review)) {
    throw new Error(
      `Candidate "${getStoredMemoryId(selected.record)}" still requires manual review (${selected.review.decision}: ${selected.review.reason}).`,
    );
  }

  return {
    matches: [selected.record],
    skipped: evaluations.filter(
      (entry) => entry.record.filePath !== selected.record.filePath && !isSafeCandidateReview(entry.review),
    ),
  };
}

export function isSafeCandidateReview(review: CandidateMemoryReviewResult): boolean {
  return review.decision === "accept" && review.reason === "novel_memory";
}

export interface PromoteCandidatesResult {
  promoted: Array<{ record: StoredMemoryRecord; review: CandidateMemoryReviewResult }>;
  kept: Array<{ record: StoredMemoryRecord; review: CandidateMemoryReviewResult; reason: string }>;
}

export function evaluateAutoApprovalCandidates(records: StoredMemoryRecord[]): PromoteCandidatesResult {
  const candidates = getCandidateRecords(records);
  const promoted: PromoteCandidatesResult["promoted"] = [];
  const kept: PromoteCandidatesResult["kept"] = [];

  for (const record of candidates) {
    const review = reviewCandidateMemory(
      record.memory,
      records.filter((entry) => entry.filePath !== record.filePath),
    );

    if (isSafeForAutoApproval(record.memory, review)) {
      promoted.push({ record, review });
    } else {
      const reason =
        record.memory.type === "working"
          ? "working memory excluded from auto-approval"
          : looksTemporary(record.memory)
            ? "temporary content excluded from auto-approval"
            : `review: ${review.decision} / ${review.reason}`;
      kept.push({ record, review, reason });
    }
  }

  return { promoted, kept };
}

export function matchesStoredMemory(entry: StoredMemoryRecord, rawQuery: string): boolean {
  const query = normalizeIdentifier(rawQuery);
  const relativePath = normalizeIdentifier(entry.relativePath);
  const fileName = normalizeIdentifier(path.basename(entry.filePath, path.extname(entry.filePath)));
  const candidateId = normalizeIdentifier(getStoredMemoryId(entry));
  const title = normalizeIdentifier(entry.memory.title);

  return relativePath.includes(query) || fileName === query || candidateId === query || title.includes(query);
}

export function getStoredMemoryId(entry: StoredMemoryRecord): string {
  return path.basename(entry.filePath, path.extname(entry.filePath));
}

export function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-");
}

export type ScoreAction = "s" | "d" | "k" | "q";

export interface ScoreCandidate {
  record: StoredMemoryRecord;
  triggers: string[];
}

export interface ScoreCandidateJson {
  file: string;
  type: Memory["type"];
  score: number;
  hit_count: number;
  last_used: string | null;
  triggers: string[];
}

export function renderFailureEventLine(index: number, event: FailureEvent): string {
  const details = [`${index}. [${event.kind}] ${event.description}`, `action=${event.suggestedAction}`];

  if (event.relatedMemoryFile) {
    details.push(`file=${event.relatedMemoryFile}`);
  }

  return `- ${details.join(" | ")}`;
}

export function buildScoreCandidates(records: StoredMemoryRecord[], now: Date = new Date()): ScoreCandidate[] {
  return records
    .map((record) => ({
      record,
      triggers: getScoreTriggers(record.memory, now),
    }))
    .filter((entry) => entry.triggers.length > 0)
    .sort(compareScoreCandidates);
}

export function getScoreTriggers(memory: Memory, now: Date): string[] {
  const triggers: string[] = [];
  const nowTime = now.getTime();

  if (memory.last_used) {
    const lastUsedTime = Date.parse(memory.last_used);
    if (!Number.isNaN(lastUsedTime)) {
      const ageInDays = (nowTime - lastUsedTime) / (1000 * 60 * 60 * 24);
      if (ageInDays > 180) {
        triggers.push("A:last_used>180d");
      }
    }
  }

  if (memory.score < 30) {
    triggers.push("B:score<30");
  }

  if (memory.hit_count > 5 && memory.score < 50) {
    triggers.push("C:high-hit-low-score");
  }

  return triggers;
}

export function renderScoreTable(candidates: ScoreCandidate[]): string {
  const headers = ["File", "Type", "Score", "Hit Count", "Last Used", "Trigger"];
  const rows = candidates.map((candidate) => [
    path.basename(candidate.record.filePath),
    candidate.record.memory.type,
    String(candidate.record.memory.score),
    String(candidate.record.memory.hit_count),
    candidate.record.memory.last_used ?? "-",
    candidate.triggers.join(", "),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => truncateTableValue(row[index] ?? "").length)),
  );

  return [
    formatTableRow(headers, widths),
    formatTableRow(
      widths.map((width) => "-".repeat(width)),
      widths,
    ),
    ...rows.map((row) => formatTableRow(row, widths)),
  ].join("\n");
}

export function compareScoreCandidates(left: ScoreCandidate, right: ScoreCandidate): number {
  const severityDiff = getScoreSeverity(right) - getScoreSeverity(left);
  if (severityDiff !== 0) {
    return severityDiff;
  }

  const scoreDiff = left.record.memory.score - right.record.memory.score;
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  const leftLastUsed = Date.parse(left.record.memory.last_used ?? "");
  const rightLastUsed = Date.parse(right.record.memory.last_used ?? "");
  const leftHasLastUsed = !Number.isNaN(leftLastUsed);
  const rightHasLastUsed = !Number.isNaN(rightLastUsed);

  if (leftHasLastUsed && rightHasLastUsed && leftLastUsed !== rightLastUsed) {
    return leftLastUsed - rightLastUsed;
  }

  if (leftHasLastUsed !== rightHasLastUsed) {
    return leftHasLastUsed ? -1 : 1;
  }

  return left.record.relativePath.localeCompare(right.record.relativePath);
}

export function getScoreSeverity(candidate: ScoreCandidate): number {
  const weights = candidate.triggers.map((trigger) => {
    if (trigger.startsWith("C:")) {
      return 3;
    }

    if (trigger.startsWith("B:")) {
      return 2;
    }

    if (trigger.startsWith("A:")) {
      return 1;
    }

    return 0;
  });

  return weights.length > 0 ? Math.max(...weights) : 0;
}

export function formatTableRow(values: string[], widths: number[]): string {
  return values.map((value, index) => truncateTableValue(value).padEnd(widths[index] ?? value.length)).join(" | ");
}

export function truncateTableValue(value: string, maxLength: number = 40): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

export function toScoreCandidateJson(candidate: ScoreCandidate): ScoreCandidateJson {
  return {
    file: path.basename(candidate.record.filePath),
    type: candidate.record.memory.type,
    score: candidate.record.memory.score,
    hit_count: candidate.record.memory.hit_count,
    last_used: candidate.record.memory.last_used,
    triggers: candidate.triggers,
  };
}

export async function promptScoreAction(
  rl: ReturnType<typeof createInterface>,
  fileName: string,
): Promise<ScoreAction> {
  while (true) {
    const answer = (await rl.question(`Action for ${fileName} [s/d/k/q]: `)).trim().toLowerCase();
    if (answer === "s" || answer === "d" || answer === "k" || answer === "q") {
      return answer;
    }

    output.write('Choose one of "s", "d", "k", or "q".\n');
  }
}

export async function createScoreActionPrompter(): Promise<{
  (fileName: string): Promise<ScoreAction>;
  close(): Promise<void>;
}> {
  if (!input.isTTY) {
    const queuedAnswers = (await readStdin())
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean);
    let index = 0;

    const prompter = async (_fileName: string): Promise<ScoreAction> => {
      while (index < queuedAnswers.length) {
        const answer = queuedAnswers[index];
        index += 1;
        if (answer === "s" || answer === "d" || answer === "k" || answer === "q") {
          return answer;
        }
      }

      return "q";
    };

    prompter.close = async () => undefined;
    return prompter;
  }

  const rl = createInterface({
    input,
    output,
  });
  const prompter = (fileName: string) => promptScoreAction(rl, fileName);
  prompter.close = async () => {
    rl.close();
  };
  return prompter;
}

export async function confirmReinforcement(): Promise<boolean> {
  const terminal = await createPromptTerminal();
  if (!terminal) {
    throw new Error('Interactive confirmation requires a TTY. Re-run with "--yes" to skip prompts.');
  }

  const rl = createInterface({
    input: terminal.input,
    output: terminal.output,
  });

  try {
    const answer = (await rl.question("Apply these reinforcement actions? [y/N]: ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
    terminal.close();
  }
}

export async function confirmSupersedeOverwrite(): Promise<boolean> {
  const terminal = await createPromptTerminal();
  if (!terminal) {
    throw new Error(
      'Existing supersede links require confirmation. Re-run with "--yes" to overwrite without prompting.',
    );
  }

  const rl = createInterface({
    input: terminal.input,
    output: terminal.output,
  });

  try {
    const answer = (await rl.question("Overwrite the current supersede relationship? [y/N]: ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
    terminal.close();
  }
}

export async function createPromptTerminal(): Promise<{
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  close(): void;
} | null> {
  if (input.isTTY) {
    return {
      input,
      output,
      close() {
        return;
      },
    };
  }

  const inputPath = process.platform === "win32" ? "CONIN$" : "/dev/tty";
  const outputPath = process.platform === "win32" ? "CONOUT$" : "/dev/tty";

  try {
    const ttyInput = createReadStream(inputPath);
    const ttyOutput = createWriteStream(outputPath);
    return {
      input: ttyInput,
      output: ttyOutput,
      close() {
        ttyInput.destroy();
        ttyOutput.end();
      },
    };
  } catch {
    return null;
  }
}

export function resolveChangedFiles(projectRoot: string, explicitPaths: string[]): string[] {
  const normalizedExplicit = explicitPaths
    .flatMap((p) =>
      p
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .map((p) => p.replace(/\\/g, "/"));

  if (normalizedExplicit.length > 0) {
    return normalizedExplicit;
  }

  return collectGitDiffPaths(projectRoot);
}

export async function safeLoadCommitContext(
  projectRoot: string,
  revision: string,
): Promise<{ commitMessage?: string; diffStat?: string }> {
  try {
    const raw = await buildCommitExtractionInput(projectRoot, revision);
    const commitMessageMatch = raw.match(/Subject:\s*(.+)/);
    const bodyMatch = raw.match(/Body:\n([\s\S]*?)(?=\n## |$)/);
    const commitMessage = [commitMessageMatch?.[1]?.trim() ?? "", bodyMatch?.[1]?.trim() ?? ""]
      .filter(Boolean)
      .join("\n");
    const diffStatMatch = raw.match(/## Diff stat\n([\s\S]*?)$/);
    const diffStat = diffStatMatch?.[1]?.trim() ?? undefined;
    return {
      ...(commitMessage ? { commitMessage } : {}),
      ...(diffStat ? { diffStat } : {}),
    };
  } catch {
    return {};
  }
}

export interface CaptureResult {
  action: "skipped" | "saved_as_candidate" | "extraction_empty";
  reason: string;
  suggestion: ExtractSuggestionResult;
  saved_paths: string[];
}

export function buildCaptureExtractionInput(
  task: string | undefined,
  sessionSummary: string | undefined,
  commitContext: { commitMessage?: string; diffStat?: string },
  changedFiles: string[],
  testSummary: string | undefined,
): string {
  const sections: string[] = [];

  if (task) {
    sections.push(`Task: ${task}`);
  }

  if (sessionSummary) {
    sections.push(`Session summary:\n${sessionSummary}`);
  }

  if (commitContext.commitMessage) {
    sections.push(`Commit message:\n${commitContext.commitMessage}`);
  }

  if (changedFiles.length > 0) {
    sections.push(`Changed files:\n${changedFiles.join("\n")}`);
  }

  if (commitContext.diffStat) {
    sections.push(`Diff stat:\n${commitContext.diffStat}`);
  }

  if (testSummary) {
    sections.push(`Test results:\n${testSummary}`);
  }

  return sections.join("\n\n");
}
