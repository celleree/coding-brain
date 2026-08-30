import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { getBrainDir } from "../config.js";
import { slugifyMemoryTitle } from "../memory-identity.js";
import type { Preference, ReviewState, StoredPreferenceRecord } from "../types.js";
import { initBrain } from "./core.js";
import { commitAtomicWriteOperations, createAtomicWriteOperation } from "./atomic-write.js";
import { extractFrontmatterAndBody, parseFrontmatter } from "./serialize.js";
import { DEFAULT_REVIEW_STATE, normalizePreference, validatePreference } from "./validate.js";
import {
  attestPreferenceRecord,
  prepareSourceBlobReferenceCheck,
  prepareSourceBlobWrite,
  preferenceSourceFieldsChanged,
  sourceEpisodeForBytes,
  type ProvenanceWriteOptions,
  verifyPreferenceProvenance,
  verifySourceEpisode,
} from "./source-store.js";

export interface PreferenceSupersessionResult {
  filePath: string;
  supersededCount: number;
}

export async function savePreference(
  preference: Preference,
  projectRoot: string,
  provenance: ProvenanceWriteOptions = {},
): Promise<string> {
  const normalizedPreference = await preparePreferenceForSave(preference, projectRoot, provenance);
  const sourceBlobReferenceOperation =
    provenance.sourceBytes === undefined
      ? await prepareSourceBlobReferenceCheck(projectRoot, normalizedPreference.source_episode)
      : null;
  await initBrain(projectRoot);
  const brainDir = getBrainDir(projectRoot);
  const fileName = `pref-${normalizedPreference.target_type}-${slugifyMemoryTitle(normalizedPreference.target)}.md`;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const relativePath = path.join(
      "preferences",
      ensureUniquePreferenceFileNameSuffix(normalizedPreference, fileName, attempt),
    );
    const filePath = path.join(brainDir, relativePath);
    if (await fileExists(filePath)) continue;
    const sourceBlobOperation =
      provenance.sourceBytes === undefined
        ? sourceBlobReferenceOperation
        : (await prepareSourceBlobWrite(projectRoot, provenance.sourceBytes)).operation;
    const content = serializePreference(attestPreferenceRecord(normalizedPreference, relativePath));
    try {
      await commitAtomicWriteOperations([
        ...(sourceBlobOperation ? [sourceBlobOperation] : []),
        createAtomicWriteOperation(filePath, content, { targetMustNotExist: true }),
      ]);
      return filePath;
    } catch (error) {
      if (isFileAlreadyExistsError(error)) continue;
      throw error;
    }
  }
  throw new Error(`Failed to allocate a unique preference file name for "${normalizedPreference.target}".`);
}

export async function savePreferenceWithSupersessions(
  preference: Preference,
  projectRoot: string,
  oldTarget: string,
  provenance: ProvenanceWriteOptions = {},
): Promise<PreferenceSupersessionResult> {
  const normalizedPreference = await preparePreferenceForSave(preference, projectRoot, provenance);
  const sourceBlobReferenceOperation =
    provenance.sourceBytes === undefined
      ? await prepareSourceBlobReferenceCheck(projectRoot, normalizedPreference.source_episode)
      : null;
  const existingRecords = await loadStoredPreferenceRecords(projectRoot);
  const matchingRecords = existingRecords.filter(
    (record) => record.preference.status === "active" && record.preference.target === oldTarget.trim(),
  );
  const currentMatches = await rereadAndVerifyPreferenceRecords(projectRoot, matchingRecords);
  const invalidMatch = currentMatches.find((record) => !record.provenance.ok);
  if (invalidMatch) {
    throw new Error(`Cannot supersede preferences with invalid provenance: ${invalidMatch.provenance.reason}.`);
  }

  await initBrain(projectRoot);
  const brainDir = getBrainDir(projectRoot);
  const fileName = `pref-${normalizedPreference.target_type}-${slugifyMemoryTitle(normalizedPreference.target)}.md`;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const relativePath = path.join(
      "preferences",
      ensureUniquePreferenceFileNameSuffix(normalizedPreference, fileName, attempt),
    );
    const filePath = path.join(brainDir, relativePath);
    if (await fileExists(filePath)) continue;
    const sourceBlobOperation =
      provenance.sourceBytes === undefined
        ? sourceBlobReferenceOperation
        : (await prepareSourceBlobWrite(projectRoot, provenance.sourceBytes)).operation;

    const now = new Date().toISOString();
    const activated = normalizePreference({
      ...normalizedPreference,
      status: "active",
      review_state: "cleared",
      observed_at: normalizedPreference.observed_at ?? now,
    });
    if (preferenceSourceFieldsChanged(normalizedPreference, activated)) {
      throw new Error("Preference supersession may only update lifecycle fields on the newly sourced record.");
    }
    validatePreference(activated);

    const operations = [
      ...(sourceBlobOperation ? [sourceBlobOperation] : []),
      createAtomicWriteOperation(filePath, serializePreference(attestPreferenceRecord(activated, relativePath)), {
        targetMustNotExist: true,
      }),
      ...currentMatches.map((record) => createPreferenceSupersessionOperation(record, relativePath, now)),
    ];
    try {
      await commitAtomicWriteOperations(operations);
      return { filePath, supersededCount: currentMatches.length };
    } catch (error) {
      if (isFileAlreadyExistsError(error)) continue;
      throw error;
    }
  }

  throw new Error(`Failed to allocate a unique preference file name for "${normalizedPreference.target}".`);
}

export async function loadAllPreferences(projectRoot: string): Promise<Preference[]> {
  const records = await loadStoredPreferenceRecords(projectRoot);
  return records
    .map((entry) => entry.preference)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export async function loadStoredPreferenceRecords(projectRoot: string): Promise<StoredPreferenceRecord[]> {
  const brainDir = getBrainDir(projectRoot);
  const directory = path.join(brainDir, "preferences");
  try {
    const files = await readdir(directory, { withFileTypes: true });
    const markdownFiles = files.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
    const loaded = await Promise.all(
      markdownFiles.map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        const content = await readFile(filePath, "utf8");
        const preference = parsePreference(content, filePath);
        const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
        return { filePath, relativePath, preference };
      }),
    );
    return loaded.sort((left, right) => right.preference.updated_at.localeCompare(left.preference.updated_at));
  } catch (error) {
    if (isMissingDirectoryError(error)) return [];
    throw error;
  }
}

export async function overwriteStoredPreference(record: StoredPreferenceRecord): Promise<void> {
  const current = parsePreference(await readFile(record.filePath, "utf8"), record.filePath);
  const projectRoot = path.dirname(getBrainDirFromRecord(record));
  const provenance = await verifyPreferenceProvenance(projectRoot, current, record.relativePath);
  if (!provenance.ok) {
    throw new Error(`Cannot mutate preference with invalid provenance: ${provenance.reason}.`);
  }
  const normalized = normalizePreference(record.preference);
  if (preferenceSourceFieldsChanged(current, normalized)) {
    throw new Error("Semantic or evidence-driven preference changes require a newly sourced successor.");
  }
  validatePreference(normalized);
  await writeFile(
    record.filePath,
    serializePreference(attestPreferenceRecord(normalized, record.relativePath)),
    "utf8",
  );
}

export async function rewriteStoredPreferenceFormatting(record: StoredPreferenceRecord): Promise<void> {
  const normalized = normalizePreference(record.preference);
  validatePreference(normalized);
  const provenance = await verifyPreferenceProvenance(
    path.dirname(getBrainDirFromRecord(record)),
    normalized,
    record.relativePath,
  );
  if (!provenance.ok) {
    throw new Error(`Cannot normalize preference with invalid provenance: ${provenance.reason}.`);
  }
  await writeFile(record.filePath, serializePreference(normalized), "utf8");
}

export async function supersedePreferencePair(
  newRecord: StoredPreferenceRecord,
  oldRecord: StoredPreferenceRecord,
): Promise<number> {
  if (newRecord.filePath === oldRecord.filePath) {
    throw new Error("Choose two different preference files for supersession.");
  }
  const projectRoot = path.dirname(getBrainDirFromRecord(oldRecord));
  const existingRecords = await loadStoredPreferenceRecords(projectRoot);
  const matchingRecords = existingRecords.filter(
    (record) =>
      record.filePath !== newRecord.filePath &&
      (record.filePath === oldRecord.filePath ||
        (record.preference.status === "active" && record.preference.target === oldRecord.preference.target)),
  );
  const [currentNewRecord, ...currentMatches] = await rereadAndVerifyPreferenceRecords(projectRoot, [
    newRecord,
    ...matchingRecords,
  ]);
  if (!currentNewRecord) {
    throw new Error("New preference could not be reread for supersession.");
  }
  const invalidRecord = [currentNewRecord, ...currentMatches].find((record) => !record.provenance.ok);
  if (invalidRecord) {
    throw new Error(`Cannot supersede preferences with invalid provenance: ${invalidRecord.provenance.reason}.`);
  }
  const now = new Date().toISOString();
  const activated = normalizePreference({
    ...currentNewRecord.preference,
    status: "active",
    review_state: "cleared",
    observed_at: currentNewRecord.preference.observed_at ?? now,
  });
  if (preferenceSourceFieldsChanged(currentNewRecord.preference, activated)) {
    throw new Error("Preference supersession may only update lifecycle fields on existing sourced records.");
  }
  validatePreference(activated);
  await commitAtomicWriteOperations([
    createAtomicWriteOperation(
      newRecord.filePath,
      serializePreference(attestPreferenceRecord(activated, newRecord.relativePath)),
      { expectedContent: currentNewRecord.content },
    ),
    ...currentMatches.map((record) => createPreferenceSupersessionOperation(record, newRecord.relativePath, now)),
  ]);
  return currentMatches.length;
}

export function serializePreference(pref: Preference): string {
  const normalized = normalizePreference(pref);
  const frontmatter: Record<string, unknown> = {
    kind: normalized.kind,
    target_type: normalized.target_type,
    target: normalized.target,
    preference: normalized.preference,
    confidence: normalized.confidence,
    source: normalized.source,
    created_at: normalized.created_at,
    updated_at: normalized.updated_at,
    status: normalized.status,
  };
  if (normalized.valid_from) frontmatter.valid_from = normalized.valid_from;
  if (normalized.valid_until) frontmatter.valid_until = normalized.valid_until;
  if (normalized.superseded_by) frontmatter.superseded_by = normalized.superseded_by;
  frontmatter.observed_at = normalized.observed_at ?? normalized.updated_at;
  if (normalized.supersession_reason) frontmatter.supersession_reason = normalized.supersession_reason;
  if ((normalized.review_state ?? DEFAULT_REVIEW_STATE) !== DEFAULT_REVIEW_STATE) {
    frontmatter.review_state = normalized.review_state ?? DEFAULT_REVIEW_STATE;
  }
  if (normalized.source_episode) frontmatter.source_episode = normalized.source_episode;
  if (normalized.record_digest) frontmatter.record_digest = normalized.record_digest;
  frontmatter.task_hints = normalized.task_hints ?? [];
  frontmatter.path_hints = normalized.path_hints ?? [];
  return ["---", stringifyFrontmatter(frontmatter), "---", "", normalized.reason.trim(), ""].join("\n");
}

export function parsePreference(content: string, filePath: string): Preference {
  const extracted = extractFrontmatterAndBody(content);
  if (!extracted) {
    throw new Error(`Preference file "${filePath}" is missing valid frontmatter.`);
  }
  const { rawFrontmatter, body: rawReason } = extracted;
  if (rawFrontmatter === undefined || rawReason === undefined) {
    throw new Error(`Preference file "${filePath}" has invalid structure.`);
  }
  const frontmatter = parseFrontmatter(rawFrontmatter);
  if (!frontmatter.kind || !frontmatter.target_type || !frontmatter.target || !frontmatter.preference) {
    throw new Error(`Preference file "${filePath}" is missing required fields.`);
  }
  const prefInput: Preference = {
    kind: frontmatter.kind as any,
    target_type: frontmatter.target_type as any,
    target: frontmatter.target as string,
    preference: frontmatter.preference as any,
    reason: (rawReason ?? "").trim(),
    confidence: frontmatter.confidence ?? 0.5,
    source: frontmatter.source ?? "manual",
    created_at: frontmatter.created_at ?? new Date().toISOString(),
    updated_at: frontmatter.updated_at ?? frontmatter.created_at ?? new Date().toISOString(),
    status: (frontmatter.status as any) ?? "active",
  };
  if (frontmatter.valid_from) prefInput.valid_from = frontmatter.valid_from;
  if (frontmatter.valid_until) prefInput.valid_until = frontmatter.valid_until;
  if (frontmatter.superseded_by) prefInput.superseded_by = frontmatter.superseded_by;
  if (frontmatter.observed_at) prefInput.observed_at = frontmatter.observed_at;
  if (frontmatter.supersession_reason !== undefined && frontmatter.supersession_reason !== null) {
    prefInput.supersession_reason = frontmatter.supersession_reason;
  }
  if (frontmatter.source_episode) prefInput.source_episode = frontmatter.source_episode;
  if (frontmatter.record_digest) prefInput.record_digest = frontmatter.record_digest;
  if (frontmatter.review_state) prefInput.review_state = frontmatter.review_state as ReviewState;
  if (frontmatter.task_hints && frontmatter.task_hints.length > 0) prefInput.task_hints = frontmatter.task_hints;
  if (frontmatter.path_hints && frontmatter.path_hints.length > 0) prefInput.path_hints = frontmatter.path_hints;
  return normalizePreference(prefInput);
}

function stringifyFrontmatter(frontmatter: Record<string, unknown>): string {
  return stringifyYaml(frontmatter, {
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
    lineWidth: 0,
  }).trimEnd();
}

function ensureUniquePreferenceFileNameSuffix(_pref: Preference, fileName: string, attempt = 0): string {
  const extension = path.extname(fileName);
  const baseName = fileName.slice(0, -extension.length);
  const parts = [baseName];
  if (attempt > 0) parts.push(String(attempt + 1));
  return `${parts.join("-")}${extension}`;
}

function isMissingDirectoryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && error.code === "ENOENT";
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function preparePreferenceForSave(
  preference: Preference,
  projectRoot: string,
  provenance: ProvenanceWriteOptions,
): Promise<Preference & { source_episode: string }> {
  let normalizedPreference = normalizePreference(preference);
  const sourceBytes = provenance.sourceBytes;
  if (sourceBytes !== undefined) {
    const sourceEpisode = sourceEpisodeForBytes(sourceBytes);
    if (normalizedPreference.source_episode && normalizedPreference.source_episode !== sourceEpisode) {
      throw new Error("Preference source_episode does not match the provided source bytes.");
    }
    normalizedPreference = normalizePreference({ ...normalizedPreference, source_episode: sourceEpisode });
  }
  if (!normalizedPreference.source_episode) {
    throw new Error("Cannot save preference without source bytes or a valid source_episode.");
  }
  if (sourceBytes === undefined) {
    const sourceVerification = await verifySourceEpisode(projectRoot, normalizedPreference.source_episode);
    if (!sourceVerification.ok) {
      throw new Error(`Cannot save preference with invalid provenance: ${sourceVerification.reason}.`);
    }
  }
  validatePreference(normalizedPreference);
  return { ...normalizedPreference, source_episode: normalizedPreference.source_episode };
}

async function rereadAndVerifyPreferenceRecords(projectRoot: string, records: StoredPreferenceRecord[]) {
  return Promise.all(
    records.map(async (record) => {
      const content = await readFile(record.filePath, "utf8");
      const preference = parsePreference(content, record.filePath);
      const provenance = await verifyPreferenceProvenance(projectRoot, preference, record.relativePath);
      return { ...record, preference, provenance, content };
    }),
  );
}

function createPreferenceSupersessionOperation(
  record: StoredPreferenceRecord & { content: string },
  newRelativePath: string,
  now: string,
) {
  const superseded = normalizePreference({
    ...record.preference,
    status: "superseded",
    superseded_by: newRelativePath,
    valid_until: record.preference.valid_until ?? now,
    updated_at: now,
    supersession_reason: record.preference.supersession_reason ?? "Superseded by newly sourced preference evidence",
  });
  if (preferenceSourceFieldsChanged(record.preference, superseded)) {
    throw new Error("Preference supersession may only update lifecycle fields on existing sourced records.");
  }
  validatePreference(superseded);
  return createAtomicWriteOperation(
    record.filePath,
    serializePreference(attestPreferenceRecord(superseded, record.relativePath)),
    { expectedContent: record.content },
  );
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

function getBrainDirFromRecord(record: StoredPreferenceRecord): string {
  let brainDir = record.filePath;
  const relativeParts = record.relativePath.replace(/\\/g, "/").split("/");
  const brainIndex = relativeParts.lastIndexOf(".brain");
  const suffixLength = brainIndex >= 0 ? relativeParts.length - brainIndex - 1 : 2;
  for (let index = 0; index < suffixLength; index += 1) brainDir = path.dirname(brainDir);
  return brainDir;
}
