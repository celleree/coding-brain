import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { getBrainDir } from "../config.js";
import type { Memory, Preference } from "../types.js";
import {
  commitAtomicWriteOperations,
  createAtomicContentPreconditionOperation,
  createAtomicWriteOperation,
  type AtomicOperation,
} from "./atomic-write.js";

const DIGEST_REFERENCE_PATTERN = /^sha256:([a-f0-9]{64})$/u;

export interface ProvenanceWriteOptions {
  sourceBytes?: Uint8Array;
}

export interface ProvenanceVerification {
  ok: boolean;
  reason?: string;
}

export interface PreparedSourceBlob {
  reference: string;
  operation: AtomicOperation;
}

export function sourceEpisodeForBytes(bytes: Uint8Array): string {
  return `sha256:${sha256(bytes)}`;
}

export async function persistSourceBytes(projectRoot: string, bytes: Uint8Array): Promise<string> {
  const prepared = await prepareSourceBlobWrite(projectRoot, bytes);
  await commitAtomicWriteOperations([prepared.operation]);
  return prepared.reference;
}

export async function prepareSourceBlobWrite(projectRoot: string, bytes: Uint8Array): Promise<PreparedSourceBlob> {
  const buffer = Buffer.from(bytes);
  const reference = sourceEpisodeForBytes(buffer);
  const digest = reference.slice("sha256:".length);
  const filePath = getSourceBlobPath(projectRoot, digest);
  await mkdir(path.dirname(filePath), { recursive: true });

  try {
    const existing = await readFile(filePath);
    if (!existing.equals(buffer)) {
      throw new Error(`Source blob collision or corruption for ${reference}.`);
    }
    return {
      reference,
      operation: createAtomicContentPreconditionOperation(filePath, buffer),
    };
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  return {
    reference,
    operation: createAtomicWriteOperation(filePath, buffer, { targetMustNotExist: true }),
  };
}

export async function prepareSourceBlobReferenceCheck(
  projectRoot: string,
  reference: string,
): Promise<AtomicOperation> {
  const digest = parseDigestReference(reference);
  if (!digest) throw new Error("Cannot prepare an invalid source_episode reference.");

  const filePath = getSourceBlobPath(projectRoot, digest);
  try {
    const bytes = await readFile(filePath);
    if (sha256(bytes) !== digest) {
      throw new Error(`Source blob digest mismatch for ${reference}.`);
    }
    return createAtomicContentPreconditionOperation(filePath, bytes);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Source blob is missing for ${reference}.`, { cause: error });
    }
    throw error;
  }
}

export async function verifySourceEpisode(
  projectRoot: string,
  reference: string | undefined,
): Promise<ProvenanceVerification> {
  const digest = parseDigestReference(reference);
  if (!digest) return { ok: false, reason: "missing or invalid source_episode" };

  try {
    const bytes = await readFile(getSourceBlobPath(projectRoot, digest));
    if (sha256(bytes) !== digest) return { ok: false, reason: "source blob digest mismatch" };
    return { ok: true };
  } catch (error) {
    if (isMissingFileError(error)) return { ok: false, reason: "source blob is missing" };
    throw error;
  }
}

export function attestMemoryRecord(memory: Memory, relativePath: string): Memory {
  return { ...memory, record_digest: computeMemoryRecordDigest(memory, relativePath) };
}

export function attestPreferenceRecord(preference: Preference, relativePath: string): Preference {
  return { ...preference, record_digest: computePreferenceRecordDigest(preference, relativePath) };
}

export async function verifyMemoryProvenance(
  projectRoot: string,
  memory: Memory,
  relativePath: string,
): Promise<ProvenanceVerification> {
  const source = await verifySourceEpisode(projectRoot, memory.source_episode);
  if (!source.ok) return source;
  if (!parseDigestReference(memory.record_digest)) return { ok: false, reason: "missing or invalid record_digest" };
  if (memory.record_digest !== computeMemoryRecordDigest(memory, relativePath)) {
    return { ok: false, reason: "record digest mismatch" };
  }
  return { ok: true };
}

export async function verifyPreferenceProvenance(
  projectRoot: string,
  preference: Preference,
  relativePath: string,
): Promise<ProvenanceVerification> {
  const source = await verifySourceEpisode(projectRoot, preference.source_episode);
  if (!source.ok) return source;
  if (!parseDigestReference(preference.record_digest)) return { ok: false, reason: "missing or invalid record_digest" };
  if (preference.record_digest !== computePreferenceRecordDigest(preference, relativePath)) {
    return { ok: false, reason: "record digest mismatch" };
  }
  return { ok: true };
}

export function memorySourceFieldsChanged(before: Memory, after: Memory): boolean {
  return stableJson(projectMemorySourceFields(before)) !== stableJson(projectMemorySourceFields(after));
}

export function preferenceSourceFieldsChanged(before: Preference, after: Preference): boolean {
  return stableJson(projectPreferenceSourceFields(before)) !== stableJson(projectPreferenceSourceFields(after));
}

function computeMemoryRecordDigest(memory: Memory, relativePath: string): string {
  const { record_digest: _recordDigest, ...record } = memory;
  const persistedRecord = { ...record, detail: record.detail.trim() };
  return `sha256:${sha256(Buffer.from(stableJson({ relative_path: normalizeRelativePath(relativePath), record: persistedRecord }), "utf8"))}`;
}

function computePreferenceRecordDigest(preference: Preference, relativePath: string): string {
  const { record_digest: _recordDigest, ...record } = preference;
  const persistedRecord = { ...record, reason: record.reason.trim() };
  return `sha256:${sha256(Buffer.from(stableJson({ relative_path: normalizeRelativePath(relativePath), record: persistedRecord }), "utf8"))}`;
}

function projectMemorySourceFields(memory: Memory): unknown {
  return {
    type: memory.type,
    title: memory.title,
    summary: memory.summary,
    detail: memory.detail,
    tags: memory.tags,
    source: memory.source,
    origin: memory.origin,
    path_scope: memory.path_scope ?? [],
    files: memory.files ?? [],
    area: memory.area,
    recommended_skills: memory.recommended_skills ?? [],
    required_skills: memory.required_skills ?? [],
    suppressed_skills: memory.suppressed_skills ?? [],
    skill_trigger_paths: memory.skill_trigger_paths ?? [],
    skill_trigger_tasks: memory.skill_trigger_tasks ?? [],
    invocation_mode: memory.invocation_mode,
    risk_level: memory.risk_level,
    date: memory.date,
    created_at: memory.created_at,
    created: memory.created,
    source_episode: memory.source_episode,
  };
}

function projectPreferenceSourceFields(preference: Preference): unknown {
  return {
    kind: preference.kind,
    target_type: preference.target_type,
    target: preference.target,
    preference: preference.preference,
    reason: preference.reason,
    source: preference.source,
    task_hints: preference.task_hints ?? [],
    path_hints: preference.path_hints ?? [],
    created_at: preference.created_at,
    source_episode: preference.source_episode,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function normalizeRelativePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.brain\//u, "")
    .replace(/^\/+/, "");
}

function getSourceBlobPath(projectRoot: string, digest: string): string {
  return path.join(getBrainDir(projectRoot), "sources", "sha256", digest.slice(0, 2), `${digest}.blob`);
}

function parseDigestReference(reference: string | undefined): string | null {
  return reference?.match(DIGEST_REFERENCE_PATTERN)?.[1] ?? null;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
