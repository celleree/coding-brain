import { parseTemporalInstant } from "../temporal.js";
import type {
  InvocationMode,
  Memory,
  MemoryArea,
  MemoryStatus,
  MemoryType,
  Preference,
  ReviewState,
  RiskLevel,
} from "../types.js";
import {
  IMPORTANCE_LEVELS,
  INVOCATION_MODES,
  MEMORY_AREAS,
  MEMORY_ORIGINS,
  MEMORY_SOURCES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  PREFERENCE_KINDS,
  PREFERENCE_TARGET_TYPES,
  PREFERENCE_VALUES,
  REVIEW_STATES,
  RISK_LEVELS,
} from "../types.js";

export const DEFAULT_INVOCATION_MODE: InvocationMode = "optional";
export const DEFAULT_RISK_LEVEL: RiskLevel = "low";
export const DEFAULT_MEMORY_SCORE = 60;
export const DEFAULT_MEMORY_HIT_COUNT = 0;
export const DEFAULT_MEMORY_LAST_USED: string | null = null;
export const DEFAULT_MEMORY_STALE = false;
export const DEFAULT_MEMORY_SUPERSEDES: string | null = null;
export const DEFAULT_MEMORY_SUPERSEDED_BY: string | null = null;
export const DEFAULT_MEMORY_VERSION = 1;
export const DEFAULT_MEMORY_AREA: MemoryArea = "general";
export const DEFAULT_GOAL_STATUS: MemoryStatus = "active";
export const DEFAULT_MEMORY_CONFIDENCE = 1;
export const DEFAULT_REVIEW_STATE: ReviewState = "unset";

export function isNonEmptyIsoDateString(value: string): boolean {
  return Boolean(value.trim()) && !Number.isNaN(Date.parse(value));
}

export function looksLikeCorruptedPlaceholderText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  // A long run of placeholder question marks usually means encoding already degraded.
  if (/[?？]{6,}/u.test(trimmed)) {
    return true;
  }

  const questionMarks = (trimmed.match(/[?？]/g) ?? []).length;
  if (questionMarks < 4) {
    return false;
  }
  if (questionMarks >= 8) {
    return true;
  }

  const meaningful = (trimmed.match(/[\p{L}\p{N}\u4e00-\u9fff]/gu) ?? []).length;
  const ratio = questionMarks / trimmed.length;

  // Keep existing strict rule for all-placeholder strings, plus a mixed-text fallback.
  return meaningful === 0 && ratio >= 0.45;
}

export function isIsoDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function normalizeOptionalIsoDateOnly(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isIsoDateOnly(trimmed)) {
    return trimmed;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return trimmed;
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

export function isoDateOnlyFromKnownDate(value: string): string {
  const normalized = normalizeOptionalIsoDateOnly(value);
  return normalized ?? value.slice(0, 10);
}

export function normalizeStringArray(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawValue of values) {
    const value = rawValue.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function normalizeBrainRelativePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\.brain\//, "")
    .replace(/^\/+/, "");
}

export function normalizeNullableBrainRelativePath(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = normalizeBrainRelativePath(value);
  return normalized || null;
}

function normalizeTagArray(values: string[]): string[] {
  return normalizeStringArray(values).sort((left, right) => left.localeCompare(right));
}

function normalizeSkillArray(values: string[]): string[] {
  return normalizeStringArray(values).sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}

function normalizeRelativePathArray(values: string[]): string[] {
  return normalizeStringArray(values.map((value) => normalizeBrainRelativePath(value))).sort((left, right) =>
    left.localeCompare(right),
  );
}

function normalizeRepoPathPattern(value: string): string {
  return value
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

function isMeaninglessScopeValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return !normalized || normalized === "." || normalized === "*" || normalized === "**" || normalized === "/";
}

function normalizePathArray(values: string[]): string[] {
  return normalizeStringArray(values.map((value) => normalizeRepoPathPattern(value)))
    .filter((value) => !isMeaninglessScopeValue(value))
    .sort((left, right) => left.localeCompare(right));
}

function normalizeIsoDateTime(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return trimmed;
  }
  return new Date(parsed).toISOString();
}

function normalizeCreatedAt(createdAt: string | undefined, created: string | undefined, fallbackDate: string): string {
  const explicit = normalizeIsoDateTime(createdAt);
  if (explicit) {
    return explicit;
  }
  const createdDate = normalizeOptionalIsoDateOnly(created);
  if (createdDate) {
    return `${createdDate}T00:00:00.000Z`;
  }
  return normalizeIsoDateTime(fallbackDate) ?? fallbackDate;
}

function clampUnitInterval(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeOptionalTemporalBoundary(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const trimmed = value.trim();
  const t = parseTemporalInstant(trimmed);
  if (t === null) {
    return undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  return new Date(t).toISOString();
}

function normalizeMemoryStatus(type: MemoryType, status: MemoryStatus | undefined): MemoryStatus | undefined {
  if (type === "goal") {
    return status ?? DEFAULT_GOAL_STATUS;
  }
  return status;
}

export function normalizeMemory(memory: Memory): Memory {
  const normalizedCreatedAt = normalizeCreatedAt(memory.created_at, memory.created, memory.date);
  const created = normalizeOptionalIsoDateOnly(memory.created ?? isoDateOnlyFromKnownDate(normalizedCreatedAt));
  const updated = normalizeOptionalIsoDateOnly(memory.updated ?? created ?? isoDateOnlyFromKnownDate(memory.date));
  const expires = normalizeOptionalIsoDateOnly(memory.expires);
  const status = normalizeMemoryStatus(memory.type, memory.status);
  const valid_from = normalizeOptionalIsoDateOnly(memory.valid_from) ?? isoDateOnlyFromKnownDate(normalizedCreatedAt);
  const valid_until = normalizeOptionalTemporalBoundary(memory.valid_until);
  const observed_at = normalizeOptionalTemporalBoundary(memory.observed_at) ?? normalizedCreatedAt;
  const confidence = clampUnitInterval(memory.confidence ?? DEFAULT_MEMORY_CONFIDENCE);
  const review_state = (memory.review_state ?? DEFAULT_REVIEW_STATE) as ReviewState;

  return {
    ...memory,
    tags: normalizeTagArray(memory.tags),
    files: normalizePathArray(memory.files ?? []),
    related: normalizeRelativePathArray(memory.related ?? []),
    path_scope: normalizePathArray(memory.path_scope ?? []),
    recommended_skills: normalizeSkillArray(memory.recommended_skills ?? []),
    required_skills: normalizeSkillArray(memory.required_skills ?? []),
    suppressed_skills: normalizeSkillArray(memory.suppressed_skills ?? []),
    skill_trigger_paths: normalizePathArray(memory.skill_trigger_paths ?? []),
    skill_trigger_tasks: normalizeStringArray(memory.skill_trigger_tasks ?? []),
    score: memory.score ?? DEFAULT_MEMORY_SCORE,
    hit_count: memory.hit_count ?? DEFAULT_MEMORY_HIT_COUNT,
    last_used: memory.last_used ?? DEFAULT_MEMORY_LAST_USED,
    created_at: normalizedCreatedAt,
    created: created ?? isoDateOnlyFromKnownDate(normalizedCreatedAt),
    updated: updated ?? created ?? isoDateOnlyFromKnownDate(memory.date),
    stale: memory.stale ?? DEFAULT_MEMORY_STALE,
    supersedes: normalizeNullableBrainRelativePath(memory.supersedes ?? DEFAULT_MEMORY_SUPERSEDES),
    superseded_by: normalizeNullableBrainRelativePath(memory.superseded_by ?? DEFAULT_MEMORY_SUPERSEDED_BY),
    version: memory.version ?? DEFAULT_MEMORY_VERSION,
    invocation_mode: memory.invocation_mode ?? DEFAULT_INVOCATION_MODE,
    risk_level: memory.risk_level ?? DEFAULT_RISK_LEVEL,
    valid_from,
    ...(valid_until ? { valid_until } : {}),
    observed_at,
    supersession_reason: memory.supersession_reason ?? null,
    confidence,
    review_state,
    ...(memory.source_episode?.trim() ? { source_episode: memory.source_episode.trim() } : {}),
    ...(memory.record_digest?.trim() ? { record_digest: memory.record_digest.trim() } : {}),
    ...(memory.area ? { area: memory.area } : {}),
    ...(expires ? { expires } : {}),
    ...(status ? { status } : {}),
  };
}

export function normalizePreference(pref: Preference): Preference {
  const updated_at = pref.updated_at || pref.created_at || new Date().toISOString();
  const created_at = pref.created_at || new Date().toISOString();
  const observed_at = normalizeOptionalTemporalBoundary(pref.observed_at) ?? updated_at;
  return {
    ...pref,
    confidence: clampUnitInterval(pref.confidence ?? 0.5),
    source: pref.source ?? "manual",
    status: pref.status ?? "active",
    created_at,
    updated_at,
    task_hints: normalizeStringArray(pref.task_hints ?? []),
    path_hints: normalizePathArray(pref.path_hints ?? []),
    review_state: (pref.review_state ?? DEFAULT_REVIEW_STATE) as ReviewState,
    observed_at,
    supersession_reason: pref.supersession_reason ?? null,
    ...(pref.source_episode?.trim() ? { source_episode: pref.source_episode.trim() } : {}),
    ...(pref.record_digest?.trim() ? { record_digest: pref.record_digest.trim() } : {}),
  };
}

function validateOptionalTemporalIso(value: string | undefined, field: string, context: string): void {
  if (value === undefined) return;
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${context} field "${field}" cannot be empty.`);
  }
  if (parseTemporalInstant(trimmed) === null && !isIsoDateOnly(trimmed)) {
    throw new Error(`${context} has invalid ${field} "${value}". Expected an ISO date or datetime.`);
  }
}

function validateStringArray(values: unknown, fieldName: string, context: string): void {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(`${context} field "${fieldName}" must be an array of non-empty strings.`);
  }
}

function validateOptionalDigestReference(
  value: string | undefined,
  fieldName: "source_episode" | "record_digest",
  context: string,
): void {
  if (value === undefined) return;
  if (fieldName === "source_episode") return;
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${context} has invalid ${fieldName}. Expected sha256:<64 lowercase hex characters>.`);
  }
}

function validateNullableRelativeBrainPath(
  value: string | null,
  fieldName: "supersedes" | "superseded_by",
  context: string,
): void {
  if (value === null) return;
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new Error(`${context} field "${fieldName}" must be a non-empty relative .brain path or null.`);
  }
  const normalized = normalizeBrainRelativePath(trimmed);
  if (!normalized || trimmed.startsWith("/") || normalized.startsWith("../") || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error(`${context} field "${fieldName}" must stay relative to .brain/.`);
  }
}

function validateVersion(value: number, context: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${context} has invalid version "${value}". Expected an integer >= 1.`);
  }
}

export function getMemoryStatus(memory: Memory): MemoryStatus {
  return memory.status ?? "active";
}

export function validateMemory(memory: Memory, context = "Memory"): void {
  if (!MEMORY_TYPES.includes(memory.type)) {
    throw new Error(`${context} has unsupported type "${memory.type}". Expected one of: ${MEMORY_TYPES.join(", ")}.`);
  }
  if (!IMPORTANCE_LEVELS.includes(memory.importance)) {
    throw new Error(
      `${context} has unsupported importance "${memory.importance}". Expected one of: ${IMPORTANCE_LEVELS.join(", ")}.`,
    );
  }
  if (memory.source && !MEMORY_SOURCES.includes(memory.source)) {
    throw new Error(
      `${context} has unsupported source "${memory.source}". Expected one of: ${MEMORY_SOURCES.join(", ")}.`,
    );
  }
  if (memory.status && !MEMORY_STATUSES.includes(memory.status)) {
    throw new Error(
      `${context} has unsupported status "${memory.status}". Expected one of: ${MEMORY_STATUSES.join(", ")}.`,
    );
  }
  if (memory.origin && !MEMORY_ORIGINS.includes(memory.origin)) {
    throw new Error(
      `${context} has unsupported origin "${memory.origin}". Expected one of: ${MEMORY_ORIGINS.join(", ")}.`,
    );
  }
  if (!INVOCATION_MODES.includes(memory.invocation_mode ?? DEFAULT_INVOCATION_MODE)) {
    throw new Error(
      `${context} has unsupported invocation_mode "${memory.invocation_mode}". Expected one of: ${INVOCATION_MODES.join(", ")}.`,
    );
  }
  if (!RISK_LEVELS.includes(memory.risk_level ?? DEFAULT_RISK_LEVEL)) {
    throw new Error(
      `${context} has unsupported risk_level "${memory.risk_level}". Expected one of: ${RISK_LEVELS.join(", ")}.`,
    );
  }
  if (memory.area && !MEMORY_AREAS.includes(memory.area)) {
    throw new Error(`${context} has unsupported area "${memory.area}". Expected one of: ${MEMORY_AREAS.join(", ")}.`);
  }
  if (!memory.title.trim() || !memory.summary.trim() || !memory.detail.trim()) {
    throw new Error(`${context} requires non-empty title, summary, and detail.`);
  }
  if (looksLikeCorruptedPlaceholderText(memory.title) || looksLikeCorruptedPlaceholderText(memory.summary)) {
    throw new Error(
      `${context} appears to contain corrupted placeholder text (for example "????"). ` +
        "Check shell encoding/pipeline input and retry capture with UTF-8 text.",
    );
  }
  if (!Number.isFinite(memory.score) || memory.score < 0 || memory.score > 100) {
    throw new Error(`${context} has invalid score "${memory.score}". Expected a number between 0 and 100.`);
  }
  if (!Number.isInteger(memory.hit_count) || memory.hit_count < 0) {
    throw new Error(`${context} has invalid hit_count "${memory.hit_count}". Expected a non-negative integer.`);
  }
  if (memory.last_used !== null && !isNonEmptyIsoDateString(memory.last_used)) {
    throw new Error(`${context} has invalid last_used "${memory.last_used}". Expected an ISO date string or null.`);
  }
  if (!isNonEmptyIsoDateString(memory.created_at)) {
    throw new Error(`${context} has invalid created_at "${memory.created_at}". Expected an ISO date string.`);
  }
  if (memory.created !== undefined && !isIsoDateOnly(memory.created)) {
    throw new Error(`${context} has invalid created "${memory.created}". Expected YYYY-MM-DD.`);
  }
  if (memory.updated !== undefined && !isIsoDateOnly(memory.updated)) {
    throw new Error(`${context} has invalid updated "${memory.updated}". Expected YYYY-MM-DD.`);
  }
  if (memory.expires !== undefined && !isIsoDateOnly(memory.expires)) {
    throw new Error(`${context} has invalid expires "${memory.expires}". Expected YYYY-MM-DD.`);
  }
  validateOptionalTemporalIso(memory.valid_from, "valid_from", context);
  validateOptionalTemporalIso(memory.valid_until, "valid_until", context);
  validateOptionalTemporalIso(memory.observed_at, "observed_at", context);
  if (
    memory.supersession_reason !== undefined &&
    memory.supersession_reason !== null &&
    typeof memory.supersession_reason !== "string"
  ) {
    throw new Error(`${context} has invalid supersession_reason.`);
  }
  if (
    memory.confidence !== undefined &&
    (!Number.isFinite(memory.confidence) || memory.confidence < 0 || memory.confidence > 1)
  ) {
    throw new Error(`${context} has invalid confidence "${memory.confidence}". Expected a number between 0 and 1.`);
  }
  if (memory.source_episode !== undefined && typeof memory.source_episode !== "string") {
    throw new Error(`${context} has invalid source_episode.`);
  }
  validateOptionalDigestReference(memory.source_episode, "source_episode", context);
  validateOptionalDigestReference(memory.record_digest, "record_digest", context);
  if (memory.review_state !== undefined && !REVIEW_STATES.includes(memory.review_state)) {
    throw new Error(
      `${context} has unsupported review_state "${memory.review_state}". Expected one of: ${REVIEW_STATES.join(", ")}.`,
    );
  }
  if (typeof memory.stale !== "boolean") {
    throw new Error(`${context} has invalid stale "${memory.stale}". Expected a boolean.`);
  }
  validateStringArray(memory.tags, "tags", context);
  validateStringArray(memory.files ?? [], "files", context);
  validateNullableRelativeBrainPath(memory.supersedes ?? DEFAULT_MEMORY_SUPERSEDES, "supersedes", context);
  validateNullableRelativeBrainPath(memory.superseded_by ?? DEFAULT_MEMORY_SUPERSEDED_BY, "superseded_by", context);
  validateVersion(memory.version ?? DEFAULT_MEMORY_VERSION, context);
  validateStringArray(memory.related ?? [], "related", context);
  validateStringArray(memory.path_scope ?? [], "path_scope", context);
  validateStringArray(memory.recommended_skills ?? [], "recommended_skills", context);
  validateStringArray(memory.required_skills ?? [], "required_skills", context);
  validateStringArray(memory.suppressed_skills ?? [], "suppressed_skills", context);
  validateStringArray(memory.skill_trigger_paths ?? [], "skill_trigger_paths", context);
  validateStringArray(memory.skill_trigger_tasks ?? [], "skill_trigger_tasks", context);
}

export function validatePreference(pref: Preference, context = "Preference"): void {
  if (!PREFERENCE_KINDS.includes(pref.kind)) {
    throw new Error(`${context} has unsupported kind "${pref.kind}".`);
  }
  if (!PREFERENCE_TARGET_TYPES.includes(pref.target_type)) {
    throw new Error(`${context} has unsupported target_type "${pref.target_type}".`);
  }
  if (!PREFERENCE_VALUES.includes(pref.preference)) {
    throw new Error(`${context} has unsupported preference value "${pref.preference}".`);
  }
  if (!MEMORY_STATUSES.includes(pref.status)) {
    throw new Error(`${context} has unsupported status "${pref.status}".`);
  }
  if (!pref.target.trim()) {
    throw new Error(`${context} requires a non-empty target.`);
  }
  if (!pref.reason.trim()) {
    throw new Error(`${context} requires a non-empty reason.`);
  }
  if (!Number.isFinite(pref.confidence) || pref.confidence < 0 || pref.confidence > 1) {
    throw new Error(`${context} has invalid confidence "${pref.confidence}". Expected a number between 0 and 1.`);
  }
  validateOptionalDigestReference(pref.source_episode, "source_episode", context);
  validateOptionalDigestReference(pref.record_digest, "record_digest", context);
  validateOptionalTemporalIso(pref.valid_from, "valid_from", context);
  validateOptionalTemporalIso(pref.valid_until, "valid_until", context);
  validateOptionalTemporalIso(pref.observed_at, "observed_at", context);
  if (
    pref.supersession_reason !== undefined &&
    pref.supersession_reason !== null &&
    typeof pref.supersession_reason !== "string"
  ) {
    throw new Error(`${context} has invalid supersession_reason.`);
  }
  if (pref.review_state !== undefined && !REVIEW_STATES.includes(pref.review_state)) {
    throw new Error(
      `${context} has unsupported review_state "${pref.review_state}". Expected one of: ${REVIEW_STATES.join(", ")}.`,
    );
  }
}
