import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getBrainDir } from "./config.js";
import {
  attestMemoryRecord,
  loadStoredMemoryRecords,
  overwriteStoredMemory,
  parseMemory,
  serializeMemory,
  updateIndex,
  verifyMemoryProvenance,
} from "./store.js";
import type { BrainConfig, Importance, StoredMemoryRecord } from "./types.js";

const IMPORTANCE_DOWNGRADE: Record<Exclude<Importance, "low">, Importance> = {
  high: "medium",
  medium: "low",
};

export interface SweepScanResult {
  expiredWorking: ExpiredWorkingCandidate[];
  staleMemories: StaleMemoryCandidate[];
  duplicatePairs: DuplicateTitleCandidate[];
  archiveGoals: ArchiveGoalCandidate[];
}

export interface ExpiredWorkingCandidate {
  record: StoredMemoryRecord;
  expires: string;
}

export interface StaleMemoryCandidate {
  record: StoredMemoryRecord;
  staleDays: number;
  daysSinceUpdated: number;
  nextImportance: Importance;
}

export interface DuplicateTitleCandidate {
  left: StoredMemoryRecord;
  right: StoredMemoryRecord;
  similarity: number;
}

export interface ArchiveGoalCandidate {
  record: StoredMemoryRecord;
  updated: string;
  daysSinceUpdated: number;
}

export interface SweepAutoApplyResult {
  changed: boolean;
  lines: string[];
  scan: SweepScanResult;
}

export async function scanSweepCandidates(
  projectRoot: string,
  config: BrainConfig,
  now: Date = new Date(),
): Promise<SweepScanResult> {
  const today = getTodayDate(now);
  const records = await loadStoredMemoryRecords(projectRoot);
  const expiredPaths = new Set<string>();

  const expiredWorking = records
    .filter((entry) => entry.memory.type === "working" && typeof entry.memory.expires === "string")
    .filter((entry) => entry.memory.expires !== undefined && entry.memory.expires < today)
    .map((entry) => {
      expiredPaths.add(entry.filePath);
      return {
        record: entry,
        expires: entry.memory.expires as string,
      };
    });

  const staleMemories = records
    .filter((entry) => !expiredPaths.has(entry.filePath))
    .filter((entry) => entry.memory.type !== "goal")
    .filter((entry) => entry.memory.importance !== "low")
    .map((entry) => {
      const updated = entry.memory.updated ?? getTodayDate(new Date(entry.memory.date));
      return {
        record: entry,
        updated,
        daysSinceUpdated: diffDays(updated, today),
      };
    })
    .filter((entry) => entry.daysSinceUpdated > config.staleDays)
    .map((entry) => ({
      record: entry.record,
      staleDays: config.staleDays,
      daysSinceUpdated: entry.daysSinceUpdated,
      nextImportance: IMPORTANCE_DOWNGRADE[entry.record.memory.importance as keyof typeof IMPORTANCE_DOWNGRADE],
    }));

  const duplicateSource = records.filter((entry) => !expiredPaths.has(entry.filePath));
  const duplicatePairs: DuplicateTitleCandidate[] = [];
  for (let index = 0; index < duplicateSource.length; index += 1) {
    const left = duplicateSource[index];
    if (!left) {
      continue;
    }

    for (let otherIndex = index + 1; otherIndex < duplicateSource.length; otherIndex += 1) {
      const right = duplicateSource[otherIndex];
      if (!right) {
        continue;
      }

      const similarity = titleSimilarity(left.memory.title, right.memory.title);
      if (similarity > 0.6) {
        duplicatePairs.push({ left, right, similarity });
      }
    }
  }

  const archiveGoals = records
    .filter((entry) => entry.memory.type === "goal")
    .filter((entry) => entry.memory.status === "done")
    .map((entry) => {
      const updated = entry.memory.updated ?? getTodayDate(new Date(entry.memory.date));
      return {
        record: entry,
        updated,
        daysSinceUpdated: diffDays(updated, today),
      };
    })
    .filter((entry) => entry.daysSinceUpdated > 30)
    .map((entry) => ({
      record: entry.record,
      updated: entry.updated,
      daysSinceUpdated: entry.daysSinceUpdated,
    }));

  return {
    expiredWorking,
    staleMemories,
    duplicatePairs,
    archiveGoals,
  };
}

export function renderSweepDryRun(result: SweepScanResult): string {
  const lines: string[] = [];

  for (const entry of result.expiredWorking) {
    lines.push(`[EXPIRED]  ${toDisplayPath(entry.record)}（过期于 ${entry.expires}）`);
  }

  for (const entry of result.staleMemories) {
    lines.push(
      `[STALE]    ${toDisplayPath(entry.record)}（${entry.daysSinceUpdated} 天未更新，importance: ${entry.record.memory.importance} → ${entry.nextImportance}）`,
    );
  }

  for (const entry of result.duplicatePairs) {
    lines.push(
      `[POSSIBLE-DUP] ${toDisplayPath(entry.left, false)} ↔ ${toDisplayPath(entry.right, false)}（相似度 ${formatPercent(entry.similarity)}）`,
    );
  }

  for (const entry of result.archiveGoals) {
    lines.push(`[ARCHIVE]  ${toDisplayPath(entry.record)}（完成于 ${entry.updated}，建议归档）`);
  }

  if (lines.length > 0) {
    lines.push("");
  }

  lines.push(...renderSweepSummary(result));
  return lines.join("\n");
}

export function renderSweepSummary(result: SweepScanResult): string[] {
  return [
    "brain sweep 扫描完成",
    "──────────────────────────────",
    `过期 working 记忆  ${result.expiredWorking.length} 条（待删除）`,
    `陈旧记忆           ${result.staleMemories.length} 条（待降权）`,
    `可疑重复对         ${result.duplicatePairs.length} 对（待确认）`,
    `已完成 goal        ${result.archiveGoals.length} 条（建议归档）`,
    "运行 brain sweep 进行交互式处理，或 brain sweep --auto 自动处理。",
  ];
}

export async function deleteExpiredWorking(candidate: ExpiredWorkingCandidate): Promise<void> {
  await rm(candidate.record.filePath, { force: true });
}

export async function downgradeStaleMemory(candidate: StaleMemoryCandidate, today: string): Promise<void> {
  await overwriteStoredMemory({
    ...candidate.record,
    memory: {
      ...candidate.record.memory,
      importance: candidate.nextImportance,
      updated: today,
    },
  });
}

export async function archiveGoalMemory(projectRoot: string, candidate: ArchiveGoalCandidate): Promise<string> {
  const archiveDir = path.join(getBrainDir(projectRoot), "archive");
  await mkdir(archiveDir, { recursive: true });
  const currentMemory = parseMemory(await readFile(candidate.record.filePath, "utf8"), candidate.record.filePath);
  const provenance = await verifyMemoryProvenance(projectRoot, currentMemory, candidate.record.relativePath);
  if (!provenance.ok) {
    throw new Error(`Cannot archive goal with invalid provenance: ${provenance.reason}.`);
  }

  const parsed = path.parse(candidate.record.filePath);
  let attempt = 0;
  while (attempt < 1000) {
    const nextName = attempt === 0 ? parsed.base : `${parsed.name}-${attempt}${parsed.ext}`;
    const targetPath = path.join(archiveDir, nextName);
    const targetRelativePath = path.relative(projectRoot, targetPath);
    const archivedContent = serializeMemory(attestMemoryRecord(currentMemory, targetRelativePath));

    try {
      await writeFile(targetPath, archivedContent, { encoding: "utf8", flag: "wx" });
      try {
        await rm(candidate.record.filePath);
      } catch (error) {
        await rm(targetPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return targetPath;
    } catch (error) {
      if (isFileAlreadyExistsError(error)) {
        attempt += 1;
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    `Failed to archive memory "${candidate.record.memory.title}" because no unique archive file name was available.`,
  );
}

export async function applySweepAuto(
  projectRoot: string,
  config: BrainConfig,
  now: Date = new Date(),
): Promise<SweepAutoApplyResult> {
  const scan = await scanSweepCandidates(projectRoot, config, now);
  const lines: string[] = [];
  const today = getTodayDate(now);
  let changed = false;

  for (const entry of scan.expiredWorking) {
    await deleteExpiredWorking(entry);
    changed = true;
    lines.push(`[EXPIRED]  已删除 ${toDisplayPath(entry.record)}（过期于 ${entry.expires}）`);
  }

  for (const entry of scan.staleMemories) {
    await downgradeStaleMemory(entry, today);
    changed = true;
    lines.push(
      `[STALE]    已降权 ${toDisplayPath(entry.record)}（${entry.record.memory.importance} → ${entry.nextImportance}）`,
    );
  }

  for (const entry of scan.duplicatePairs) {
    lines.push(
      `[POSSIBLE-DUP] ${toDisplayPath(entry.left, false)} ↔ ${toDisplayPath(entry.right, false)}（相似度 ${formatPercent(entry.similarity)}）`,
    );
  }

  for (const entry of scan.archiveGoals) {
    const archivedPath = await archiveGoalMemory(projectRoot, entry);
    changed = true;
    lines.push(
      `[ARCHIVE]  已归档 ${toDisplayPath(entry.record)} → ${path.relative(projectRoot, archivedPath).replace(/\\/g, "/")}`,
    );
  }

  if (changed) {
    await updateIndex(projectRoot);
  }

  return {
    changed,
    lines,
    scan,
  };
}

export function titleSimilarity(a: string, b: string): number {
  const tokenize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter(Boolean);

  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }

  return intersection / Math.max(left.size, right.size);
}

export function previewMemoryLines(record: StoredMemoryRecord, maxLines = 3): string[] {
  return record.memory.detail.trim().split(/\r?\n/).slice(0, maxLines);
}

export function toDisplayPath(record: StoredMemoryRecord, includeBrainRoot = true): string {
  const normalized = record.relativePath.replace(/\\/g, "/");
  return includeBrainRoot ? normalized : normalized.replace(/^\.brain\//, "");
}

function diffDays(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T00:00:00`);
  const to = new Date(`${toDate}T00:00:00`);
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

function getTodayDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
