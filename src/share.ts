import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { sourceBlobRelativePath } from "./store/source-store.js";
import { getMemoryStatus, loadStoredMemoryRecords, verifyMemoryProvenance } from "./store.js";
import type { StoredMemoryRecord } from "./types.js";

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
  options: { allActive?: boolean; memoryId?: string; includeSourceEvidence?: boolean },
): Promise<SharePlan> {
  const active = (await loadStoredMemoryRecords(projectRoot)).filter(
    (entry) => getMemoryStatus(entry.memory) === "active",
  );
  const selected = options.allActive ? active : selectOne(active, options.memoryId);

  if (selected.length === 0) throw new Error("No active memories found.");
  await assertShareable(projectRoot, selected);

  const records = [...selected].sort((a, b) => b.memory.date.localeCompare(a.memory.date));
  const includeSourceEvidence = Boolean(options.includeSourceEvidence);
  const sourcePaths = includeSourceEvidence
    ? [...new Set(records.map((entry) => sourceBlobRelativePath(requireSource(entry))))]
    : [];
  const addPaths = [
    ...records.map((entry) => entry.relativePath),
    SHARED_MEMORY_INDEX_PATH,
    ...sourcePaths,
  ].map(normalizePath);

  return {
    records,
    sourcePaths,
    sharedIndexPath: normalizePath(SHARED_MEMORY_INDEX_PATH),
    sharedIndexContent: renderSharedIndex(records, includeSourceEvidence),
    includeSourceEvidence,
    warnings: [
      includeSourceEvidence
        ? "Raw provenance source evidence is included. Review selected blobs before committing."
        : "Raw provenance source evidence is excluded by default.",
    ],
    commitMessage: buildCommitMessage(records),
    addCommands: [...new Set(addPaths)].map((entry) => `git add -f ${JSON.stringify(entry)}`),
  };
}

export async function writeShareIndex(projectRoot: string, plan: SharePlan): Promise<void> {
  const target = path.join(projectRoot, plan.sharedIndexPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, plan.sharedIndexContent, "utf8");
}

async function assertShareable(projectRoot: string, records: StoredMemoryRecord[]): Promise<void> {
  for (const entry of records) {
    const result = await verifyMemoryProvenance(projectRoot, entry.memory, entry.relativePath);
    if (!result.ok) {
      throw new Error(
        `Cannot share memory "${entry.memory.title}": ${result.reason ?? "provenance verification failed"}.`,
      );
    }
  }
}

function selectOne(records: StoredMemoryRecord[], rawId?: string): StoredMemoryRecord[] {
  const query = rawId?.trim();
  if (!query) throw new Error('Provide a memory id or use "--all-active".');
  const normalized = normalizeId(query);
  const matches = records.filter((entry) => {
    const file = path.basename(entry.filePath, path.extname(entry.filePath));
    return (
      normalizeId(entry.relativePath).includes(normalized) ||
      normalizeId(file) === normalized ||
      normalizeId(entry.memory.title).includes(normalized)
    );
  });
  if (matches.length === 0) throw new Error(`No active memory matched "${query}".`);
  if (matches.length > 1) {
    throw new Error(`Multiple memories matched "${query}". Use a more specific id.`);
  }
  return matches;
}

function renderSharedIndex(records: StoredMemoryRecord[], includeSourceEvidence: boolean): string {
  const lines = [
    "# RepoBrain Shared Memory Index",
    "",
    "Contains only memories explicitly selected by `brain share`.",
    `Source evidence included: ${includeSourceEvidence ? "yes" : "no"}`,
    "",
  ];
  for (const entry of records) {
    const relative = normalizePath(entry.relativePath).replace(/^\.brain\//u, "");
    lines.push(`- [${entry.memory.title}](../${relative}) | ${entry.memory.type} | ${entry.memory.date}`);
    lines.push(`  - ${entry.memory.summary}`);
  }
  lines.push("");
  return lines.join("\n");
}

function requireSource(entry: StoredMemoryRecord): string {
  if (!entry.memory.source_episode) {
    throw new Error(`Memory "${entry.memory.title}" has no source_episode.`);
  }
  return entry.memory.source_episode;
}

function buildCommitMessage(records: StoredMemoryRecord[]): string {
  if (records.length === 1) {
    return `brain: add ${records[0]?.memory.type} - ${records[0]?.memory.title.slice(0, 72)}`;
  }
  return `brain: sync ${records.length} active memories`;
}

function normalizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}
