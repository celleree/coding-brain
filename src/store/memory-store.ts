import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getBrainDir } from "../config.js";
import { buildMemoryIdentity as buildScopedMemoryIdentity, slugifyMemoryTitle } from "../memory-identity.js";
import type { Memory, MemoryStatus, MemoryType, StoredMemoryRecord } from "../types.js";
import { MEMORY_TYPES } from "../types.js";
import { initBrain } from "./core.js";
import { parseMemory, serializeMemory } from "./serialize.js";
import { writeMemoryIndexCache } from "./memory-index.js";
import { DEFAULT_MEMORY_VERSION, getMemoryStatus, normalizeMemory, validateMemory } from "./validate.js";
import { commitAtomicWriteOperations, createAtomicWriteOperation } from "./atomic-write.js";
import {
  attestMemoryRecord,
  memorySourceFieldsChanged,
  prepareSourceBlobReferenceCheck,
  prepareSourceBlobWrite,
  sourceEpisodeForBytes,
  type ProvenanceWriteOptions,
  verifyMemoryProvenance,
  verifySourceEpisode,
} from "./source-store.js";

const DIRECTORY_BY_TYPE: Record<MemoryType, string> = {
  decision: "decisions",
  gotcha: "gotchas",
  convention: "conventions",
  pattern: "patterns",
  working: "working",
  goal: "goals",
};

export async function saveMemory(
  memory: Memory,
  projectRoot: string,
  provenance: ProvenanceWriteOptions = {},
): Promise<string> {
  let normalizedMemory = normalizeMemory({ ...memory, source: memory.source ?? "manual" });
  const sourceBytes = provenance.sourceBytes;
  if (sourceBytes !== undefined) {
    const sourceEpisode = sourceEpisodeForBytes(sourceBytes);
    if (normalizedMemory.source_episode && normalizedMemory.source_episode !== sourceEpisode) {
      throw new Error("Memory source_episode does not match the provided source bytes.");
    }
    normalizedMemory = normalizeMemory({ ...normalizedMemory, source_episode: sourceEpisode });
  }
  if (!normalizedMemory.source_episode) {
    throw new Error("Cannot save memory without source bytes or a valid source_episode.");
  }
  if (sourceBytes === undefined) {
    const sourceVerification = await verifySourceEpisode(projectRoot, normalizedMemory.source_episode);
    if (!sourceVerification.ok) {
      throw new Error(`Cannot save memory with invalid provenance: ${sourceVerification.reason}.`);
    }
  }
  validateMemory(normalizedMemory);
  const sourceBlobReferenceOperation =
    sourceBytes === undefined
      ? await prepareSourceBlobReferenceCheck(projectRoot, normalizedMemory.source_episode)
      : null;

  const supersessionOperations =
    getMemoryStatus(normalizedMemory) === "active"
      ? await prepareMatchingActiveMemorySupersessions(normalizedMemory, projectRoot)
      : [];

  await initBrain(projectRoot);
  const directory = DIRECTORY_BY_TYPE[normalizedMemory.type];
  const fileName = `${normalizedMemory.date.slice(0, 10)}-${slugifyMemoryTitle(normalizedMemory.title)}.md`;
  const brainDir = getBrainDir(projectRoot);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const relativePath = path.join(directory, ensureUniqueFileNameSuffix(normalizedMemory, fileName, attempt));
    const filePath = path.join(brainDir, relativePath);
    if (await fileExists(filePath)) continue;
    const sourceBlobOperation =
      sourceBytes === undefined
        ? sourceBlobReferenceOperation
        : (await prepareSourceBlobWrite(projectRoot, sourceBytes)).operation;
    const attestedMemory = attestMemoryRecord(normalizedMemory, relativePath);
    const content = serializeMemory(attestedMemory);
    try {
      await commitAtomicWriteOperations([
        ...(sourceBlobOperation ? [sourceBlobOperation] : []),
        ...supersessionOperations,
        createAtomicWriteOperation(filePath, content, { targetMustNotExist: true }),
      ]);
      return filePath;
    } catch (error) {
      if (isFileAlreadyExistsError(error)) continue;
      throw error;
    }
  }
  throw new Error(`Failed to allocate a unique memory file name for "${normalizedMemory.title}".`);
}

export async function loadAllMemories(projectRoot: string): Promise<Memory[]> {
  const storedMemories = await loadStoredMemories(projectRoot);
  return storedMemories.map((entry) => entry.memory).sort((left, right) => right.date.localeCompare(left.date));
}

export async function loadStoredMemoryRecords(projectRoot: string): Promise<StoredMemoryRecord[]> {
  return loadStoredMemories(projectRoot);
}

export async function updateIndex(projectRoot: string): Promise<void> {
  const records = await loadStoredMemories(projectRoot);
  const memories = records.map((entry) => entry.memory).sort((left, right) => right.date.localeCompare(left.date));
  const brainDir = getBrainDir(projectRoot);
  const indexPath = path.join(brainDir, "index.md");
  const byType = new Map<MemoryType, Memory[]>(
    MEMORY_TYPES.map((type) => [type, memories.filter((memory) => memory.type === type)]),
  );
  const total = memories.length;
  const lastUpdated = memories[0]?.date ?? "N/A";
  const sections = MEMORY_TYPES.map((type) => {
    const title = titleForType(type);
    const items = byType.get(type) ?? [];
    if (items.length === 0) {
      return [`## ${title}`, "", "_No memories yet._", ""].join("\n");
    }
    const lines = items.map((memory) => {
      const tags = memory.tags.length > 0 ? ` | tags: ${memory.tags.join(", ")}` : "";
      const status = memory.status ? ` | status: ${memory.status}` : "";
      return `- [${memory.importance}] ${memory.title} (${memory.date}) - ${memory.summary}${tags}${status}`;
    });
    return [`## ${title}`, "", ...lines, ""].join("\n");
  });
  const content = [
    "# Project Brain Index",
    "",
    `Updated: ${new Date().toISOString()}`,
    `Total memories: ${total}`,
    `Last memory date: ${lastUpdated}`,
    "",
    ...sections,
  ].join("\n");
  await writeFile(indexPath, content, "utf8");

  try {
    await writeMemoryIndexCache(projectRoot, records);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[brain] warning: failed to update derived memory index cache: ${message}\n`);
  }
}

export async function overwriteStoredMemory(record: StoredMemoryRecord): Promise<void> {
  const current = parseMemory(await readFile(record.filePath, "utf8"), record.filePath);
  const currentVerification = await verifyMemoryProvenance(
    path.dirname(getBrainDirFromRecord(record)),
    current,
    record.relativePath,
  );
  if (!currentVerification.ok) {
    throw new Error(`Cannot mutate memory with invalid provenance: ${currentVerification.reason}.`);
  }
  const normalizedMemory = normalizeMemory(record.memory);
  if (memorySourceFieldsChanged(current, normalizedMemory)) {
    throw new Error("Semantic or evidence-driven memory changes require a newly sourced successor.");
  }
  validateMemory(normalizedMemory);
  const attestedMemory = attestMemoryRecord(normalizedMemory, record.relativePath);
  await writeFile(record.filePath, serializeMemory(attestedMemory), "utf8");
}

export async function supersedeMemoryPair(
  newRecord: StoredMemoryRecord,
  oldRecord: StoredMemoryRecord,
  options: { activateNew?: boolean } = {},
): Promise<{ newVersion: number }> {
  const newRelativePath = toBrainRelativePath(newRecord.relativePath);
  const oldRelativePath = toBrainRelativePath(oldRecord.relativePath);
  const projectRoot = path.dirname(getBrainDirFromRecord(oldRecord));
  const [currentNewContent, currentOldContent] = await Promise.all([
    readFile(newRecord.filePath, "utf8"),
    readFile(oldRecord.filePath, "utf8"),
  ]);
  const currentNewMemory = parseMemory(currentNewContent, newRecord.filePath);
  const currentOldMemory = parseMemory(currentOldContent, oldRecord.filePath);
  const [newVerification, oldVerification] = await Promise.all([
    verifyMemoryProvenance(projectRoot, currentNewMemory, newRecord.relativePath),
    verifyMemoryProvenance(projectRoot, currentOldMemory, oldRecord.relativePath),
  ]);
  if (!newVerification.ok || !oldVerification.ok) {
    throw new Error(
      `Cannot supersede memories with invalid provenance: ${newVerification.reason ?? oldVerification.reason}.`,
    );
  }
  const nextVersion = (currentOldMemory.version ?? DEFAULT_MEMORY_VERSION) + 1;
  const nowIso = new Date().toISOString();
  const updatedNewMemory = normalizeMemory({
    ...currentNewMemory,
    ...(options.activateNew ? { status: "active" as const, review_state: "cleared" as const } : {}),
    supersedes: oldRelativePath,
    version: nextVersion,
    observed_at: currentNewMemory.observed_at ?? nowIso,
  });
  const updatedOldMemory = normalizeMemory({
    ...currentOldMemory,
    status: "superseded",
    superseded_by: newRelativePath,
    stale: true,
    valid_until: currentOldMemory.valid_until ?? nowIso,
    supersession_reason: currentOldMemory.supersession_reason ?? "Superseded by linked newer memory",
  });
  validateMemory(updatedNewMemory, `Memory file "${newRecord.filePath}"`);
  validateMemory(updatedOldMemory, `Memory file "${oldRecord.filePath}"`);
  if (
    memorySourceFieldsChanged(currentNewMemory, updatedNewMemory) ||
    memorySourceFieldsChanged(currentOldMemory, updatedOldMemory)
  ) {
    throw new Error("Supersession may only update lifecycle and lineage fields on existing sourced records.");
  }
  const attestedNewMemory = attestMemoryRecord(updatedNewMemory, newRecord.relativePath);
  const attestedOldMemory = attestMemoryRecord(updatedOldMemory, oldRecord.relativePath);
  await commitAtomicWriteOperations([
    createAtomicWriteOperation(newRecord.filePath, serializeMemory(attestedNewMemory), {
      expectedContent: currentNewContent,
    }),
    createAtomicWriteOperation(oldRecord.filePath, serializeMemory(attestedOldMemory), {
      expectedContent: currentOldContent,
    }),
  ]);
  return { newVersion: nextVersion };
}

export async function approveCandidateMemory(record: StoredMemoryRecord, projectRoot: string): Promise<void> {
  const currentCandidateContent = await readFile(record.filePath, "utf8");
  const currentCandidate = parseMemory(currentCandidateContent, record.filePath);
  const provenance = await verifyMemoryProvenance(projectRoot, currentCandidate, record.relativePath);
  if (!provenance.ok) {
    throw new Error(`Cannot promote memory with invalid provenance: ${provenance.reason}.`);
  }
  if (getMemoryStatus(currentCandidate) !== "candidate") {
    throw new Error("Cannot promote memory because the current persisted record is not a candidate.");
  }
  const nowIso = new Date().toISOString();
  const promotedMemory: Memory = normalizeMemory({
    ...currentCandidate,
    status: "active",
    stale: false,
    observed_at: currentCandidate.observed_at ?? nowIso,
    review_state: "cleared",
    valid_from: currentCandidate.valid_from ?? nowIso.slice(0, 10),
  });
  if (memorySourceFieldsChanged(currentCandidate, promotedMemory)) {
    throw new Error("Promotion may only update lifecycle fields on the sourced candidate.");
  }
  validateMemory(promotedMemory);

  const operations = [
    createAtomicWriteOperation(
      record.filePath,
      serializeMemory(attestMemoryRecord(promotedMemory, record.relativePath)),
      { expectedContent: currentCandidateContent },
    ),
  ];
  const nextIdentity = buildScopedMemoryIdentity(promotedMemory);
  const existingMemories = await loadStoredMemories(projectRoot);
  for (const entry of existingMemories) {
    if (entry.filePath === record.filePath || getMemoryStatus(entry.memory) !== "active") continue;
    if (buildScopedMemoryIdentity(entry.memory) !== nextIdentity) continue;

    const currentActiveContent = await readFile(entry.filePath, "utf8");
    const currentActive = parseMemory(currentActiveContent, entry.filePath);
    const activeProvenance = await verifyMemoryProvenance(projectRoot, currentActive, entry.relativePath);
    if (!activeProvenance.ok) {
      throw new Error(`Cannot promote memory while matching active provenance is invalid: ${activeProvenance.reason}.`);
    }
    const supersededMemory = normalizeMemory({
      ...currentActive,
      status: "superseded",
      stale: true,
      valid_until: currentActive.valid_until ?? nowIso,
      supersession_reason:
        currentActive.supersession_reason ?? "Superseded by newer active memory with the same identity",
    });
    if (memorySourceFieldsChanged(currentActive, supersededMemory)) {
      throw new Error("Promotion supersession may only update lifecycle fields on existing sourced records.");
    }
    validateMemory(supersededMemory);
    operations.push(
      createAtomicWriteOperation(
        entry.filePath,
        serializeMemory(attestMemoryRecord(supersededMemory, entry.relativePath)),
        { expectedContent: currentActiveContent },
      ),
    );
  }

  await commitAtomicWriteOperations(operations);
}

export async function updateStoredMemoryStatus(record: StoredMemoryRecord, status: MemoryStatus): Promise<void> {
  const nowIso = new Date().toISOString();
  const nextMemory: Memory = {
    ...record.memory,
    status,
    stale: status === "stale" ? true : record.memory.stale,
  };
  if (status === "stale") {
    nextMemory.valid_until = record.memory.valid_until ?? nowIso;
    nextMemory.supersession_reason =
      record.memory.supersession_reason ?? "Marked stale via brain dismiss or score workflow";
  }
  if (status === "superseded") {
    nextMemory.valid_until = record.memory.valid_until ?? nowIso;
    nextMemory.supersession_reason = record.memory.supersession_reason ?? "Marked superseded via brain status update";
  }
  await overwriteStoredMemory({ ...record, memory: normalizeMemory(nextMemory) });
}

export function buildMemoryIdentity(memory: Memory): string {
  return buildScopedMemoryIdentity(memory);
}

async function loadStoredMemories(projectRoot: string): Promise<StoredMemoryRecord[]> {
  const brainDir = getBrainDir(projectRoot);
  const memoriesByType = await Promise.all(
    MEMORY_TYPES.map(async (type) => {
      const directory = path.join(brainDir, DIRECTORY_BY_TYPE[type]);
      try {
        const files = await readdir(directory, { withFileTypes: true });
        const markdownFiles = files.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
        const loaded = await Promise.all(
          markdownFiles.map(async (entry) => {
            const filePath = path.join(directory, entry.name);
            const content = await readFile(filePath, "utf8");
            const memory = parseMemory(content, filePath);
            return { filePath, relativePath: path.relative(projectRoot, filePath), memory };
          }),
        );
        return loaded;
      } catch (error) {
        if (isMissingDirectoryError(error)) return [];
        throw error;
      }
    }),
  );
  return memoriesByType.flat().sort((left, right) => right.memory.date.localeCompare(left.memory.date));
}

async function prepareMatchingActiveMemorySupersessions(memory: Memory, projectRoot: string) {
  const existingMemories = await loadStoredMemories(projectRoot);
  const nextIdentity = buildScopedMemoryIdentity(memory);
  const matchingMemories = existingMemories.filter(
    (entry) => getMemoryStatus(entry.memory) === "active" && buildScopedMemoryIdentity(entry.memory) === nextIdentity,
  );

  const currentMatches = await Promise.all(
    matchingMemories.map(async (entry) => {
      const content = await readFile(entry.filePath, "utf8");
      const current = parseMemory(content, entry.filePath);
      const provenance = await verifyMemoryProvenance(projectRoot, current, entry.relativePath);
      return { ...entry, memory: current, provenance, content };
    }),
  );
  const invalidMatch = currentMatches.find((entry) => !entry.provenance.ok);
  if (invalidMatch) {
    throw new Error(
      `Cannot save active memory while matching active provenance is invalid: ${invalidMatch.provenance.reason}.`,
    );
  }

  const nowIso = new Date().toISOString();
  return currentMatches.map((entry) => {
    const updatedMemory = normalizeMemory({
      ...entry.memory,
      status: "superseded",
      stale: true,
      valid_until: entry.memory.valid_until ?? nowIso,
      supersession_reason:
        entry.memory.supersession_reason ?? "Superseded by newer active memory with the same identity",
    });
    if (memorySourceFieldsChanged(entry.memory, updatedMemory)) {
      throw new Error("Save supersession may only update lifecycle fields on existing sourced records.");
    }
    validateMemory(updatedMemory);
    return createAtomicWriteOperation(
      entry.filePath,
      serializeMemory(attestMemoryRecord(updatedMemory, entry.relativePath)),
      { expectedContent: entry.content },
    );
  });
}

function toBrainRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.brain\//, "");
}

function getBrainDirFromRecord(record: StoredMemoryRecord): string {
  const relativeParts = record.relativePath.replace(/\\/g, "/").split("/");
  const brainIndex = relativeParts.lastIndexOf(".brain");
  const suffixLength = brainIndex >= 0 ? relativeParts.length - brainIndex - 1 : 2;
  let brainDir = record.filePath;
  for (let index = 0; index < suffixLength; index += 1) brainDir = path.dirname(brainDir);
  return brainDir;
}

function ensureUniqueFileNameSuffix(memory: Memory, fileName: string, attempt = 0): string {
  const stamp = memory.date.replace(/[^\d]/g, "").slice(8, 17);
  const extension = path.extname(fileName);
  const baseName = fileName.slice(0, -extension.length);
  const parts = [baseName];
  if (stamp) parts.push(stamp);
  if (attempt > 0) parts.push(String(attempt + 1));
  return `${parts.join("-")}${extension}`;
}

function titleForType(type: MemoryType): string {
  switch (type) {
    case "decision":
      return "Decisions";
    case "gotcha":
      return "Gotchas";
    case "convention":
      return "Conventions";
    case "pattern":
      return "Patterns";
    case "working":
      return "Working";
    case "goal":
      return "Goals";
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch (error) {
    if (isMissingDirectoryError(error)) return false;
    throw error;
  }
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissingDirectoryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && error.code === "ENOENT";
}
