import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type {
  InvocationMode,
  Memory,
  MemoryArea,
  MemoryOrigin,
  MemorySource,
  MemoryStatus,
  MemoryType,
  ReviewState,
  RiskLevel,
} from "../types.js";
import {
  normalizeMemory,
  DEFAULT_INVOCATION_MODE,
  DEFAULT_MEMORY_CONFIDENCE,
  DEFAULT_MEMORY_HIT_COUNT,
  DEFAULT_MEMORY_LAST_USED,
  DEFAULT_MEMORY_SCORE,
  DEFAULT_MEMORY_STALE,
  DEFAULT_MEMORY_SUPERSEDES,
  DEFAULT_MEMORY_SUPERSEDED_BY,
  DEFAULT_MEMORY_VERSION,
  DEFAULT_REVIEW_STATE,
  DEFAULT_RISK_LEVEL,
  isoDateOnlyFromKnownDate,
  validateMemory,
} from "./validate.js";

export const ARRAY_FRONTMATTER_FIELDS = [
  "tags",
  "files",
  "related",
  "path_scope",
  "recommended_skills",
  "required_skills",
  "suppressed_skills",
  "skill_trigger_paths",
  "skill_trigger_tasks",
  "task_hints",
  "path_hints",
] as const;

export function quoteYaml(value: string): string {
  return stringifyYaml({ value }, { defaultStringType: "QUOTE_DOUBLE", lineWidth: 0 })
    .trim()
    .replace(/^value:\s*/, "");
}

export function serializeMemory(memory: Memory): string {
  const normalizedMemory = normalizeMemory(memory);
  const frontmatter: Record<string, unknown> = {
    type: normalizedMemory.type,
    title: normalizedMemory.title,
    summary: normalizedMemory.summary,
    tags: normalizedMemory.tags,
    importance: normalizedMemory.importance,
    score: normalizedMemory.score,
    hit_count: normalizedMemory.hit_count,
    last_used: normalizedMemory.last_used,
    created_at: normalizedMemory.created_at,
    created: normalizedMemory.created ?? isoDateOnlyFromKnownDate(normalizedMemory.created_at),
    updated: normalizedMemory.updated ?? isoDateOnlyFromKnownDate(normalizedMemory.date),
    stale: normalizedMemory.stale,
    supersedes: normalizedMemory.supersedes ?? DEFAULT_MEMORY_SUPERSEDES,
    superseded_by: normalizedMemory.superseded_by ?? DEFAULT_MEMORY_SUPERSEDED_BY,
    version: normalizedMemory.version ?? DEFAULT_MEMORY_VERSION,
    date: normalizedMemory.date,
  };
  if (normalizedMemory.source) frontmatter.source = normalizedMemory.source;
  if (normalizedMemory.status) frontmatter.status = normalizedMemory.status;
  if (normalizedMemory.origin) frontmatter.origin = normalizedMemory.origin;
  frontmatter.related = normalizedMemory.related ?? [];
  frontmatter.path_scope = normalizedMemory.path_scope ?? [];
  frontmatter.files = normalizedMemory.files ?? [];
  frontmatter.recommended_skills = normalizedMemory.recommended_skills ?? [];
  frontmatter.required_skills = normalizedMemory.required_skills ?? [];
  frontmatter.suppressed_skills = normalizedMemory.suppressed_skills ?? [];
  frontmatter.skill_trigger_paths = normalizedMemory.skill_trigger_paths ?? [];
  frontmatter.skill_trigger_tasks = normalizedMemory.skill_trigger_tasks ?? [];
  if (normalizedMemory.area) frontmatter.area = normalizedMemory.area;
  if (normalizedMemory.expires) frontmatter.expires = normalizedMemory.expires;
  if (normalizedMemory.valid_from) frontmatter.valid_from = normalizedMemory.valid_from;
  if (normalizedMemory.valid_until) frontmatter.valid_until = normalizedMemory.valid_until;
  if (normalizedMemory.observed_at) frontmatter.observed_at = normalizedMemory.observed_at;
  if (normalizedMemory.supersession_reason) frontmatter.supersession_reason = normalizedMemory.supersession_reason;
  if ((normalizedMemory.confidence ?? DEFAULT_MEMORY_CONFIDENCE) !== DEFAULT_MEMORY_CONFIDENCE) {
    frontmatter.confidence = normalizedMemory.confidence ?? DEFAULT_MEMORY_CONFIDENCE;
  }
  if (normalizedMemory.source_episode) frontmatter.source_episode = normalizedMemory.source_episode;
  if (normalizedMemory.record_digest) frontmatter.record_digest = normalizedMemory.record_digest;
  if ((normalizedMemory.review_state ?? DEFAULT_REVIEW_STATE) !== DEFAULT_REVIEW_STATE) {
    frontmatter.review_state = normalizedMemory.review_state ?? DEFAULT_REVIEW_STATE;
  }
  frontmatter.invocation_mode = normalizedMemory.invocation_mode ?? DEFAULT_INVOCATION_MODE;
  frontmatter.risk_level = normalizedMemory.risk_level ?? DEFAULT_RISK_LEVEL;
  return ["---", stringifyFrontmatter(frontmatter), "---", "", normalizedMemory.detail.trim(), ""].join("\n");
}

export function parseMemory(content: string, filePath: string): Memory {
  const extracted = extractFrontmatterAndBody(content);
  if (!extracted) {
    throw new Error(`Memory file "${filePath}" is missing valid frontmatter.`);
  }
  const { rawFrontmatter, body: rawDetail } = extracted;
  const frontmatter = parseFrontmatter(rawFrontmatter);
  const type = frontmatter.type;
  const importance = frontmatter.importance;
  const source = frontmatter.source;
  const status = frontmatter.status;
  const origin = frontmatter.origin;
  if (!type || !importance || !frontmatter.title || !frontmatter.summary || !frontmatter.date) {
    throw new Error(
      `Memory file "${filePath}" must include type, title, summary, importance, and date in frontmatter.`,
    );
  }

  const memoryInput: Memory = {
    type: type as MemoryType,
    title: frontmatter.title,
    summary: frontmatter.summary,
    detail: rawDetail.trim(),
    tags: frontmatter.tags,
    importance: importance as Memory["importance"],
    date: frontmatter.date,
    score: frontmatter.score ?? DEFAULT_MEMORY_SCORE,
    hit_count: frontmatter.hit_count ?? DEFAULT_MEMORY_HIT_COUNT,
    last_used: frontmatter.last_used ?? DEFAULT_MEMORY_LAST_USED,
    created_at: frontmatter.created_at ?? frontmatter.date,
    stale: (frontmatter.stale ?? DEFAULT_MEMORY_STALE) as Memory["stale"],
    supersedes: frontmatter.supersedes ?? DEFAULT_MEMORY_SUPERSEDES,
    superseded_by: frontmatter.superseded_by ?? DEFAULT_MEMORY_SUPERSEDED_BY,
    version: frontmatter.version ?? DEFAULT_MEMORY_VERSION,
    files: frontmatter.files,
    related: frontmatter.related,
    path_scope: frontmatter.path_scope,
    recommended_skills: frontmatter.recommended_skills,
    required_skills: frontmatter.required_skills,
    suppressed_skills: frontmatter.suppressed_skills,
    skill_trigger_paths: frontmatter.skill_trigger_paths,
    skill_trigger_tasks: frontmatter.skill_trigger_tasks,
    ...(frontmatter.created ? { created: frontmatter.created } : {}),
    ...(frontmatter.updated ? { updated: frontmatter.updated } : {}),
    ...(frontmatter.area ? { area: frontmatter.area as MemoryArea } : {}),
    ...(frontmatter.expires ? { expires: frontmatter.expires } : {}),
    ...(frontmatter.valid_from ? { valid_from: frontmatter.valid_from } : {}),
    ...(frontmatter.valid_until ? { valid_until: frontmatter.valid_until } : {}),
    ...(frontmatter.observed_at ? { observed_at: frontmatter.observed_at } : {}),
    ...(frontmatter.supersession_reason !== undefined ? { supersession_reason: frontmatter.supersession_reason } : {}),
    ...(frontmatter.confidence !== undefined ? { confidence: frontmatter.confidence } : {}),
    ...(frontmatter.source_episode ? { source_episode: frontmatter.source_episode } : {}),
    ...(frontmatter.record_digest ? { record_digest: frontmatter.record_digest } : {}),
    ...(frontmatter.review_state ? { review_state: frontmatter.review_state as ReviewState } : {}),
  };
  if (frontmatter.invocation_mode) {
    memoryInput.invocation_mode = frontmatter.invocation_mode as InvocationMode;
  }
  if (frontmatter.risk_level) {
    memoryInput.risk_level = frontmatter.risk_level as RiskLevel;
  }
  const memory = normalizeMemory(memoryInput);
  if (source) memory.source = source as MemorySource;
  if (status) memory.status = status as MemoryStatus;
  if (origin) memory.origin = origin as MemoryOrigin;
  validateMemory(memory, `Memory file "${filePath}"`);
  return memory;
}

export function parseFrontmatter(raw: string): {
  type?: string;
  title?: string;
  summary?: string;
  tags: string[];
  files: string[];
  related: string[];
  path_scope: string[];
  recommended_skills: string[];
  required_skills: string[];
  suppressed_skills: string[];
  skill_trigger_paths: string[];
  skill_trigger_tasks: string[];
  task_hints: string[];
  path_hints: string[];
  importance?: string;
  date?: string;
  score?: number;
  hit_count?: number;
  last_used?: string | null;
  created_at?: string;
  created?: string;
  updated?: string;
  updated_at?: string;
  stale?: boolean | string;
  supersedes?: string | null;
  superseded_by?: string | null;
  version?: number;
  source?: string;
  status?: string;
  origin?: string;
  invocation_mode?: string;
  risk_level?: string;
  area?: string;
  expires?: string;
  kind?: string;
  target_type?: string;
  target?: string;
  preference?: string;
  confidence?: number;
  valid_from?: string;
  valid_until?: string;
  observed_at?: string;
  supersession_reason?: string | null;
  source_episode?: string;
  record_digest?: string;
  review_state?: string;
} {
  const result: ReturnType<typeof parseFrontmatter> = {
    tags: [],
    files: [],
    related: [],
    path_scope: [],
    recommended_skills: [],
    required_skills: [],
    suppressed_skills: [],
    skill_trigger_paths: [],
    skill_trigger_tasks: [],
    task_hints: [],
    path_hints: [],
  };
  const frontmatterRaw = extractFrontmatterRaw(raw);
  const parsedDocument = parseYaml(frontmatterRaw) ?? {};
  const parsed = isRecord(parsedDocument) ? parsedDocument : {};
  for (const field of ARRAY_FRONTMATTER_FIELDS) {
    result[field] = toStringArray(parsed[field]);
  }
  assignIfDefined(result, "type", toOptionalString(parsed.type));
  assignIfDefined(result, "title", toOptionalString(parsed.title));
  assignIfDefined(result, "summary", toOptionalString(parsed.summary));
  assignIfDefined(result, "importance", toOptionalString(parsed.importance));
  assignIfDefined(result, "date", toOptionalString(parsed.date));
  assignIfDefined(result, "created_at", toOptionalString(parsed.created_at));
  assignIfDefined(result, "created", toOptionalString(parsed.created));
  assignIfDefined(result, "updated", toOptionalString(parsed.updated));
  assignIfDefined(result, "source", toOptionalString(parsed.source));
  assignIfDefined(result, "status", toOptionalString(parsed.status));
  assignIfDefined(result, "origin", toOptionalString(parsed.origin));
  assignIfDefined(result, "invocation_mode", toOptionalString(parsed.invocation_mode));
  assignIfDefined(result, "risk_level", toOptionalString(parsed.risk_level));
  assignIfDefined(result, "area", toOptionalString(parsed.area));
  assignIfDefined(result, "expires", toOptionalString(parsed.expires));
  assignIfDefined(result, "kind", toOptionalString(parsed.kind));
  assignIfDefined(result, "target_type", toOptionalString(parsed.target_type));
  assignIfDefined(result, "target", toOptionalString(parsed.target));
  assignIfDefined(result, "preference", toOptionalString(parsed.preference));
  assignIfDefined(result, "valid_from", toOptionalString(parsed.valid_from));
  assignIfDefined(result, "valid_until", toOptionalString(parsed.valid_until));
  assignIfDefined(result, "updated_at", toOptionalString(parsed.updated_at));
  assignIfDefined(result, "observed_at", toOptionalString(parsed.observed_at));
  assignIfDefined(result, "source_episode", toOptionalString(parsed.source_episode));
  assignIfDefined(result, "record_digest", toOptionalString(parsed.record_digest));
  assignIfDefined(result, "review_state", toOptionalString(parsed.review_state));
  assignIfDefined(result, "score", toOptionalNumber(parsed.score));
  assignIfDefined(result, "hit_count", toOptionalNumber(parsed.hit_count));
  assignIfDefined(result, "confidence", toOptionalNumber(parsed.confidence));
  assignIfDefined(result, "version", toOptionalNumber(parsed.version));
  assignIfDefined(result, "last_used", toOptionalNullableString(parsed.last_used));
  assignIfDefined(result, "supersedes", toOptionalNullableString(parsed.supersedes));
  assignIfDefined(result, "superseded_by", toOptionalNullableString(parsed.superseded_by));
  assignIfDefined(result, "supersession_reason", toOptionalNullableString(parsed.supersession_reason));
  assignIfDefined(result, "stale", toOptionalBoolean(parsed.stale));
  return result;
}

function stringifyFrontmatter(frontmatter: Record<string, unknown>): string {
  return stringifyYaml(frontmatter, {
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
    lineWidth: 0,
  }).trimEnd();
}

export function extractFrontmatterAndBody(content: string): { rawFrontmatter: string; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const rawFrontmatter = match[1];
  const body = match[2];
  if (!rawFrontmatter || body === undefined) return null;
  return { rawFrontmatter, body };
}

function extractFrontmatterRaw(raw: string): string {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\s*$/);
  if (match?.[1]) return match[1];
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function toOptionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return toOptionalString(value);
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = toOptionalString(value);
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function toOptionalBoolean(value: unknown): boolean | string | undefined {
  if (typeof value === "boolean") return value;
  const text = toOptionalString(value);
  if (!text) return undefined;
  if (text === "true") return true;
  if (text === "false") return false;
  return text;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => toOptionalString(entry)).filter((entry): entry is string => typeof entry === "string");
}

function assignIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
