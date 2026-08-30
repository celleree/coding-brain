import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { getBrainDir } from "../config.js";
import type { BrainActivityState, ContextLoadSource, Memory, MemoryActivityEntry, MemoryType } from "../types.js";
import { IMPORTANCE_LEVELS, MEMORY_TYPES } from "../types.js";
import { commitAtomicWriteOperations, createAtomicWriteOperation, type AtomicWriteOperation } from "./atomic-write.js";
import { loadStoredMemoryRecords } from "./memory-store.js";
import { serializeMemory } from "./serialize.js";
import { looksLikeCorruptedPlaceholderText, normalizeMemory, validateMemory } from "./validate.js";
import { attestMemoryRecord, verifyMemoryProvenance } from "./source-store.js";

export async function recordInjectedMemories(
  projectRoot: string,
  memories: Memory[],
  options: {
    task?: string;
    paths?: string[];
    modules?: string[];
    includeSessionProfile?: boolean;
    source?: ContextLoadSource;
  } = {},
): Promise<void> {
  const brainDir = getBrainDir(projectRoot);
  await mkdir(brainDir, { recursive: true });
  const loadedAt = new Date().toISOString();
  const injectedAt = loadedAt.slice(0, 10);
  const activityStatePath = getActivityStatePath(projectRoot);

  const operations: AtomicWriteOperation[] = [];
  if (memories.length > 0) {
    const touchedKeys = new Set(memories.map((memory) => getMemoryKey(memory)));
    const existingRecords = await loadStoredMemoryRecords(projectRoot);
    for (const entry of existingRecords) {
      if (!touchedKeys.has(getMemoryKey(entry.memory))) continue;
      const provenance = await verifyMemoryProvenance(projectRoot, entry.memory, entry.relativePath);
      if (!provenance.ok) continue;
      const normalizedMemory = normalizeMemory({
        ...entry.memory,
        hit_count: entry.memory.hit_count + 1,
        last_used: injectedAt,
        stale: false,
      });
      validateMemory(normalizedMemory);
      operations.push(
        createAtomicWriteOperation(
          entry.filePath,
          serializeMemory(attestMemoryRecord(normalizedMemory, entry.relativePath)),
        ),
      );
    }
  }

  const state: BrainActivityState = {
    lastInjectedAt: injectedAt,
    lastContextLoadedAt: loadedAt,
    lastContextSource: options.source ?? "inject",
    lastSelectionContext: {
      ...(options.task?.trim() ? { task: options.task.trim() } : {}),
      ...((options.paths ?? []).length > 0 ? { paths: normalizeActivityValues(options.paths ?? []) } : {}),
      ...((options.modules ?? []).length > 0 ? { modules: normalizeActivityValues(options.modules ?? []) } : {}),
      includeSessionProfile: options.includeSessionProfile !== false,
    },
    recentLoadedMemories: memories.slice(0, 5).map(toActivityEntry),
  };
  operations.push(createAtomicWriteOperation(activityStatePath, JSON.stringify(state, null, 2)));
  await commitAtomicWriteOperations(operations);
}

export async function loadActivityState(projectRoot: string): Promise<BrainActivityState> {
  try {
    const raw = await readFile(getActivityStatePath(projectRoot), "utf8");
    return parseActivityState(raw);
  } catch {
    return { recentLoadedMemories: [] };
  }
}

function getActivityStatePath(projectRoot: string): string {
  return path.join(getBrainDir(projectRoot), "activity.json");
}

function getMemoryKey(memory: Pick<Memory, "type" | "title" | "date">): string {
  return `${memory.type}|${memory.title}|${memory.date}`;
}

function toActivityEntry(memory: Memory): MemoryActivityEntry {
  return {
    type: memory.type,
    title: memory.title,
    importance: memory.importance,
    date: memory.date,
  };
}

function parseActivityState(raw: string): BrainActivityState {
  try {
    const parsed = JSON.parse(raw) as {
      lastInjectedAt?: unknown;
      lastContextLoadedAt?: unknown;
      lastContextSource?: unknown;
      lastSelectionContext?: unknown;
      recentLoadedMemories?: unknown;
    };
    const recentLoadedMemories = Array.isArray(parsed.recentLoadedMemories)
      ? parsed.recentLoadedMemories
          .map((entry) => parseActivityEntry(entry))
          .filter((entry): entry is MemoryActivityEntry => entry !== null)
      : [];
    const lastInjectedAt =
      typeof parsed.lastInjectedAt === "string" && parsed.lastInjectedAt.trim() ? parsed.lastInjectedAt : null;
    const lastContextLoadedAt =
      typeof parsed.lastContextLoadedAt === "string" && parsed.lastContextLoadedAt.trim()
        ? parsed.lastContextLoadedAt
        : null;
    const lastContextSource =
      parsed.lastContextSource === "inject" ||
      parsed.lastContextSource === "route" ||
      parsed.lastContextSource === "conversation-start"
        ? parsed.lastContextSource
        : undefined;
    const lastSelectionContext = parseSelectionContext(parsed.lastSelectionContext);

    return {
      ...(lastInjectedAt ? { lastInjectedAt } : {}),
      ...(lastContextLoadedAt ? { lastContextLoadedAt } : {}),
      ...(lastContextSource ? { lastContextSource } : {}),
      ...(lastSelectionContext ? { lastSelectionContext } : {}),
      recentLoadedMemories,
    };
  } catch {
    return { recentLoadedMemories: [] };
  }
}

function parseSelectionContext(value: unknown): BrainActivityState["lastSelectionContext"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const task = typeof candidate.task === "string" && candidate.task.trim() ? candidate.task.trim() : undefined;
  const paths = Array.isArray(candidate.paths)
    ? candidate.paths.map((entry) => String(entry).trim()).filter(Boolean)
    : undefined;
  const modules = Array.isArray(candidate.modules)
    ? candidate.modules.map((entry) => String(entry).trim()).filter(Boolean)
    : undefined;
  const includeSessionProfile =
    candidate.includeSessionProfile === true || candidate.includeSessionProfile === false
      ? candidate.includeSessionProfile
      : undefined;

  if (!task && !paths?.length && !modules?.length && includeSessionProfile === undefined) {
    return undefined;
  }

  return {
    ...(task ? { task } : {}),
    ...(paths?.length ? { paths: normalizeActivityValues(paths) } : {}),
    ...(modules?.length ? { modules: normalizeActivityValues(modules) } : {}),
    ...(includeSessionProfile !== undefined ? { includeSessionProfile } : {}),
  };
}

function normalizeActivityValues(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim().replace(/\\/g, "/"))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right)),
    ),
  );
}

function parseActivityEntry(value: unknown): MemoryActivityEntry | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const type = typeof candidate.type === "string" ? candidate.type : null;
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const importance = typeof candidate.importance === "string" ? candidate.importance : null;
  const date = typeof candidate.date === "string" ? candidate.date.trim() : "";
  if (
    !type ||
    !title ||
    !importance ||
    !date ||
    looksLikeCorruptedPlaceholderText(title) ||
    !MEMORY_TYPES.includes(type as MemoryType) ||
    !IMPORTANCE_LEVELS.includes(importance as Memory["importance"])
  ) {
    return null;
  }
  return {
    type: type as MemoryType,
    title,
    importance: importance as Memory["importance"],
    date,
  };
}
