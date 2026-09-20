import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { sourceBlobRelativePath } from "./store/source-store.js";
import type { StoredMemoryRecord } from "./types.js";
import { getMemoryStatus, loadStoredMemoryRecords, verifyMemoryProvenance } from "./store.js";

export const SHARED_MEMORY_INDEX_PATH = path.join(".brain", "shared", "index.md");

export interface SharePlan {
  records: StoredMemoryRecord[];
  sourcePaths: string[];
  sharedIndexPath: string;
  sharedIndexContent: string;
  includeSourceEvidence: boolean;
  warnings: string[];
  commitMessage: string;
  addCommands: string[];
}

export async function buildSharePlan(
  projectRoot: string,
  options: {
    allActive?: boolean;
    memoryId?: string;
    includeSourceEvidence?: boolean;
  },
): Promise<SharePlan> {
  const records = await loadStoredMemoryRecords(projectRoot);
  const activeRecords = records.filter((entry) => getMemoryStatus(entry.memory) === "active");

  if (options.allActive) {
    if (activeRecords.length === 0) {
      throw new Error("No active memories found.");
    }

    await assertShareableMemoryRecords(projectRoot, activeRecords);
    return createSharePlan(activeRecords, Boolean(options.includeSourceEvidence));
  }

  const memoryId = options.memoryId?.trim();
  if (!memoryId) {
    throw new Error('Provide a memory id or use "--all-active".');
  }

  const matches = matchStoredMemories(activeRecords, memoryId);
  if (matches.length === 0) {
    throw new Error(`No active memory matched "${memoryId}".`);
  }

  if (matches.length > 1) {
    const suggestions = matches.map((entry) => `- ${getCandidateId(entry)} (${entry.memory.title})`);
    throw new Error([`Multiple memories matched "${memoryId}". Use a more specific id:`, ...suggestions].join("\n"));
  }

  await assertShareableMemoryRecords(projectRoot, matches);
  return createSharePlan(matches, Boolean(options.includeSourceEvidence));
}

export async function writeShareIndex(projectRoot: string, plan: SharePlan): Promise<void> {
  const indexPath = path.join(projectRoot, plan.sharedIndexPath);
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, plan.sharedIndexContent, "utf8");
}

async function assertShareableMemoryRecords(projectRoot: string, records: StoredMemoryRecord[]): Promise<void> {
  for (const entry of records) {
    const verification = await verifyMemoryProvenance(projectRoot, entry.memory, entry.relativePath);
    if (!verification.ok) {
      throw new Error(
        `Cannot share memory "${entry.memory.title}": ${verification.reason ?? "memory provenance verification failed"}.`,
      );
    }
  }
}

function createSharePlan(records: StoredMemoryRecord[], includeSourceEvidence: boolean): SharePlan {
  const sortedRecords = [...records].sort((left, right) => right.memory.date.localeCompare(left.memory.date));
  const sourcePaths = includeSourceEvidence
    ? dedupe(
        sortedRecords.map((entry) => {
          if (!entry.memory.source_episode) {
            throw new Error(`Memory "${entry.memory.title}" has no source_episode and cannot be shared portably.`);
          }
          return sourceBlobRelativePath(entry.memory.source_episode);
        }),
      )
    : [];

  const recordPaths = sortedRecords.map((entry) => normalizePath(entry.relativePath));
  const addPaths = dedupe([...recordPaths, normalizePath(SHARED_MEMORY_INDEX_PATH), ...sourcePaths.map(normalizePath)]);
  const warnings = includeSourceEvidence
    ? ["Raw provenance source evidence is included. Review the selected source blob contents before committing."]
    : [
        "Raw provenance source evidence is excluded by default. Repository-reading agents can use the shared index and records, but shell-based provenance verification on another checkout requires rerunning share with --include-source-evidence after reviewing the raw source material.",
      ];

  return {
    records: sortedRecords,
    sourcePaths,
    sharedIndexPath: normalizePath(SHARED_MEMORY_INDEX_PATH),
    sharedIndexContent: renderSharedMemoryIndex(sortedRecords, includeSourceEvidence),
    includeSourceEvidence,
    warnings,
    commitMessage: buildCommitMessage(sortedRecords),
    addCommands: addPaths.map((entry) => `git add -f ${quoteForShell(entry)}`),
  };
}

function renderSharedMemoryIndex(records: StoredMemoryRecord[], includeSourceEvidence: boolean): string {
  const lines = [
    "# RepoBrain Shared Memory Index",
    "",
    "This index contains only memories explicitly selected by `brain share`.",
    "It is not the local RepoBrain runtime index and does not expose unselected candidates, working state, or logs.",
    "",
    `Source evidence included: ${includeSourceEvidence ? "yes" : "no"}`,
    "",
    "## Shared memories",
    "",
  ];

  for (const entry of records) {
    const recordPath = normalizePath(entry.relativePath);
    const link = relativeLinkFromSharedIndex(recordPath);
    lines.push(
      `- [${entry.memory.title}](${link}) | ${entry.memory.type} | ${entry.memory.importance} | ${entry.memory.date}`,
    );
    lines.push(`  - ${entry.memory.summary}`);
    if (entry.memory.tags.length > 0) {
      lines.push(`  - tags: ${entry.memory.tags.join(", ")}`);
    }
  }

  lines.push("");
  lines.push(
    includeSourceEvidence
      ? "The selected provenance source blobs are included in the share plan for full RepoBrain verification on another checkout."
      : "Raw provenance source blobs are intentionally not included. Use `brain share --include-source-evidence` only after reviewing the raw source material.",
  );
  lines.push("");

  return lines.join("\n");
}

function relativeLinkFromSharedIndex(recordPath: string): string {
  const relativeToBrain = recordPath.replace(/^\.brain\//u, "");
  return `../${relativeToBrain}`;
}

function matchStoredMemories(records: StoredMemoryRecord[], rawQuery: string): StoredMemoryRecord[] {
  const query = normalizeIdentifier(rawQuery);

  return records.filter((entry) => {
    const relativePath = normalizeIdentifier(entry.relativePath);
    const fileName = normalizeIdentifier(path.basename(entry.filePath, path.extname(entry.filePath)));
    const candidateId = normalizeIdentifier(getCandidateId(entry));
    const title = normalizeIdentifier(entry.memory.title);

    return relativePath.includes(query) || fileName === query || candidateId === query || title.includes(query);
  });
}

function buildCommitMessage(records: StoredMemoryRecord[]): string {
  if (records.length === 1) {
    const [entry] = records;
    if (!entry) {
      return "brain: sync active memories";
    }

    return `brain: add ${entry.memory.type} - ${toCommitSummary(entry.memory.title)}`;
  }

  const typeCounts = new Map<string, number>();
  for (const entry of records) {
    typeCounts.set(entry.memory.type, (typeCounts.get(entry.memory.type) ?? 0) + 1);
  }

  const summary = Array.from(typeCounts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${count} ${type}${count === 1 ? "" : "s"}`)
    .join(", ");

  return `brain: sync active memories - ${summary}`;
}

function toCommitSummary(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, 72);
}

function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-");
}

function getCandidateId(entry: StoredMemoryRecord): string {
  return path.basename(entry.filePath, path.extname(entry.filePath));
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function quoteForShell(value: string): string {
  return JSON.stringify(normalizePath(value));
}
