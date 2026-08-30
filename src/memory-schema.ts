import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getBrainDir } from "./config.js";
import {
  ARRAY_FRONTMATTER_FIELDS,
  DEFAULT_MEMORY_HIT_COUNT,
  DEFAULT_MEMORY_LAST_USED,
  DEFAULT_MEMORY_SCORE,
  DEFAULT_MEMORY_STALE,
  DEFAULT_MEMORY_SUPERSEDES,
  DEFAULT_MEMORY_SUPERSEDED_BY,
  DEFAULT_MEMORY_VERSION,
  normalizeMemory,
  parseFrontmatter,
  serializeMemory,
  validateMemory,
} from "./store.js";
import type {
  Memory,
  MemoryNormalizeResult,
  MemorySchemaFileReport,
  MemorySchemaHealthSummary,
  MemorySchemaIssue,
  MemorySchemaScanResult,
  ReviewState,
  StoredMemoryRecord,
} from "./types.js";
import { verifyMemoryProvenance } from "./store/source-store.js";
import {
  IMPORTANCE_LEVELS,
  INVOCATION_MODES,
  MEMORY_AREAS,
  MEMORY_ORIGINS,
  MEMORY_SOURCES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  REVIEW_STATES,
  RISK_LEVELS,
} from "./types.js";

const DIRECTORY_BY_TYPE: Record<(typeof MEMORY_TYPES)[number], string> = {
  decision: "decisions",
  gotcha: "gotchas",
  convention: "conventions",
  pattern: "patterns",
  working: "working",
  goal: "goals",
};

type RawFrontmatter = ReturnType<typeof parseFrontmatter>;

interface ScannedMemoryFile {
  report: MemorySchemaFileReport;
  normalizedMemory: Memory | null;
  normalizedContent: string | null;
  record: StoredMemoryRecord | null;
}

export async function buildMemorySchemaReport(projectRoot: string): Promise<MemorySchemaScanResult> {
  const scanned = await scanMemoryFiles(projectRoot);
  return {
    generated_at: new Date().toISOString(),
    summary: summarizeSchemaHealth(scanned),
    files: scanned.map((entry) => entry.report),
  };
}

export async function normalizeMemorySchemas(projectRoot: string): Promise<MemoryNormalizeResult> {
  const scanned = await scanMemoryFiles(projectRoot);
  let normalizedFiles = 0;

  for (const entry of scanned) {
    if (!entry.report.fixable || !entry.report.normalized || !entry.normalizedContent) {
      continue;
    }

    await writeFile(entry.report.file_path, entry.normalizedContent, "utf8");
    normalizedFiles += 1;
  }

  const summary = summarizeSchemaHealth(scanned);
  return {
    generated_at: new Date().toISOString(),
    summary: {
      ...summary,
      normalized_files: normalizedFiles,
      skipped_files: summary.total_files - normalizedFiles,
    },
    files: scanned.map((entry) => entry.report),
  };
}

export function renderMemorySchemaReport(result: MemorySchemaScanResult): string {
  const lines = [
    `Memory schema health generated at ${result.generated_at}`,
    renderSchemaHealthSummary(result.summary),
    "",
    "Files:",
  ];

  if (result.files.length === 0) {
    lines.push("- None.");
    return lines.join("\n");
  }

  for (const file of result.files) {
    const status = file.healthy ? "healthy" : file.fixable ? "needs_normalize" : "needs_manual_fix";
    lines.push(`- ${file.memory_id} | ${status} | ${toDisplayPath(file.relative_path)}`);
    if (file.issues.length === 0) {
      lines.push("  Issues: none");
      continue;
    }

    for (const issue of file.issues) {
      const field = issue.field ? ` | field=${issue.field}` : "";
      lines.push(`  - ${issue.severity} | ${issue.code}${field} | ${issue.message}`);
    }
  }

  return lines.join("\n");
}

export function renderMemoryNormalizeReport(result: MemoryNormalizeResult): string {
  return [
    `Memory normalization generated at ${result.generated_at}`,
    renderSchemaHealthSummary(result.summary),
    `Normalized files: ${result.summary.normalized_files}`,
    `Skipped files: ${result.summary.skipped_files}`,
  ].join("\n");
}

export async function scanMemoryFiles(projectRoot: string): Promise<ScannedMemoryFile[]> {
  const brainDir = getBrainDir(projectRoot);
  const filesByType = await Promise.all(
    MEMORY_TYPES.map(async (type) => {
      const directory = path.join(brainDir, DIRECTORY_BY_TYPE[type]);

      try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
          .map((entry) => path.join(directory, entry.name));
      } catch (error) {
        if (isMissingDirectoryError(error)) {
          return [];
        }

        throw error;
      }
    }),
  );

  const filePaths = filesByType.flat().sort((left, right) => left.localeCompare(right));
  return Promise.all(
    filePaths.map(async (filePath) => {
      const content = await readFile(filePath, "utf8");
      return scanMemoryFile(projectRoot, filePath, content);
    }),
  );
}

export async function loadSchemaValidatedMemoryRecords(projectRoot: string): Promise<{
  records: StoredMemoryRecord[];
  schema: MemorySchemaScanResult;
}> {
  const scanned = await scanMemoryFiles(projectRoot);
  return {
    records: scanned
      .map((entry) => entry.record)
      .filter((entry): entry is StoredMemoryRecord => entry !== null)
      .sort((left, right) => right.memory.date.localeCompare(left.memory.date)),
    schema: {
      generated_at: new Date().toISOString(),
      summary: summarizeSchemaHealth(scanned),
      files: scanned.map((entry) => entry.report),
    },
  };
}

async function scanMemoryFile(projectRoot: string, filePath: string, content: string): Promise<ScannedMemoryFile> {
  const relativePath = path.relative(projectRoot, filePath);
  const memoryId = path.basename(filePath, ".md");
  const issues: MemorySchemaIssue[] = [];
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

  if (!match) {
    issues.push({
      code: "missing_field",
      severity: "error",
      field: "frontmatter",
      message: "Missing valid Markdown frontmatter block.",
    });
    return finalizeScannedFile(filePath, relativePath, memoryId, issues, null, null, null, content);
  }

  const rawFrontmatter = match[1] ?? "";
  const rawDetail = (match[2] ?? "").trim();
  const frontmatter = parseFrontmatter(rawFrontmatter);
  collectRequiredFieldIssues(frontmatter, rawDetail, issues);
  collectEnumIssues(frontmatter, issues);

  const normalizedMemory = buildNormalizedMemory(frontmatter, rawDetail);
  if (normalizedMemory) {
    collectConflictIssues(normalizedMemory, issues);
    collectMeaninglessScopeIssues(frontmatter, normalizedMemory, issues);
    collectSkillMetadataIssues(frontmatter, normalizedMemory, issues);
  }

  if (!normalizedMemory) {
    return finalizeScannedFile(filePath, relativePath, memoryId, issues, null, null, null, content);
  }

  try {
    validateMemory(normalizedMemory, `Memory file "${filePath}"`);
  } catch (error) {
    issues.push({
      code: "conflict_field",
      severity: "error",
      message: error instanceof Error ? error.message : "Failed schema validation.",
    });
    return finalizeScannedFile(filePath, relativePath, memoryId, issues, normalizedMemory, null, null, content);
  }

  const normalizedContent = serializeMemory(normalizedMemory);
  const record: StoredMemoryRecord = {
    filePath,
    relativePath,
    memory: normalizedMemory,
  };

  const provenance = await verifyMemoryProvenance(projectRoot, normalizedMemory, relativePath);
  if (!provenance.ok) {
    issues.push({
      code:
        normalizedMemory.source_episode && normalizedMemory.record_digest ? "invalid_provenance" : "missing_provenance",
      severity: "error",
      field: normalizedMemory.source_episode ? "record_digest" : "source_episode",
      message: `Provenance verification failed: ${provenance.reason}.`,
    });
  }

  return finalizeScannedFile(
    filePath,
    relativePath,
    memoryId,
    issues,
    normalizedMemory,
    normalizedContent,
    record,
    content,
  );
}

function buildNormalizedMemory(frontmatter: RawFrontmatter, rawDetail: string): Memory | null {
  if (
    !frontmatter.type ||
    !frontmatter.title ||
    !frontmatter.summary ||
    !frontmatter.importance ||
    !frontmatter.date ||
    !rawDetail
  ) {
    return null;
  }

  const memory: Memory = {
    type: frontmatter.type as Memory["type"],
    title: frontmatter.title,
    summary: frontmatter.summary,
    detail: rawDetail,
    tags: frontmatter.tags,
    importance: frontmatter.importance as Memory["importance"],
    date: frontmatter.date,
    score: frontmatter.score ?? DEFAULT_MEMORY_SCORE,
    hit_count: frontmatter.hit_count ?? DEFAULT_MEMORY_HIT_COUNT,
    last_used: frontmatter.last_used ?? DEFAULT_MEMORY_LAST_USED,
    created_at: frontmatter.created_at ?? frontmatter.date,
    stale: typeof frontmatter.stale === "boolean" ? frontmatter.stale : DEFAULT_MEMORY_STALE,
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
  };

  if (frontmatter.created) {
    memory.created = frontmatter.created;
  }
  if (frontmatter.updated) {
    memory.updated = frontmatter.updated;
  }
  if (frontmatter.source) {
    memory.source = frontmatter.source as NonNullable<Memory["source"]>;
  }
  if (frontmatter.status) {
    memory.status = frontmatter.status as NonNullable<Memory["status"]>;
  }
  if (frontmatter.origin) {
    memory.origin = frontmatter.origin as NonNullable<Memory["origin"]>;
  }
  if (frontmatter.invocation_mode) {
    memory.invocation_mode = frontmatter.invocation_mode as NonNullable<Memory["invocation_mode"]>;
  }
  if (frontmatter.risk_level) {
    memory.risk_level = frontmatter.risk_level as NonNullable<Memory["risk_level"]>;
  }
  if (frontmatter.area) {
    memory.area = frontmatter.area as NonNullable<Memory["area"]>;
  }
  if (frontmatter.expires) {
    memory.expires = frontmatter.expires;
  }
  if (frontmatter.valid_from) {
    memory.valid_from = frontmatter.valid_from;
  }
  if (frontmatter.valid_until) {
    memory.valid_until = frontmatter.valid_until;
  }
  if (frontmatter.observed_at) {
    memory.observed_at = frontmatter.observed_at;
  }
  if (frontmatter.supersession_reason !== undefined) {
    memory.supersession_reason = frontmatter.supersession_reason;
  }
  if (frontmatter.confidence !== undefined) {
    memory.confidence = frontmatter.confidence;
  }
  if (frontmatter.source_episode) {
    memory.source_episode = frontmatter.source_episode;
  }
  if (frontmatter.record_digest) {
    memory.record_digest = frontmatter.record_digest;
  }
  if (frontmatter.review_state?.trim()) {
    memory.review_state = frontmatter.review_state.trim() as ReviewState;
  }

  return normalizeMemory(memory);
}

function finalizeScannedFile(
  filePath: string,
  relativePath: string,
  memoryId: string,
  issues: MemorySchemaIssue[],
  normalizedMemory: Memory | null,
  normalizedContent: string | null,
  record: StoredMemoryRecord | null,
  originalContent: string,
): ScannedMemoryFile {
  const hasErrors = issues.some((issue) => issue.severity === "error");
  const normalized =
    normalizedContent !== null && normalizeFileContent(normalizedContent) !== normalizeFileContent(originalContent);
  const fixable = !hasErrors && normalized;

  return {
    report: {
      file_path: filePath,
      relative_path: relativePath,
      memory_id: memoryId,
      healthy: issues.length === 0,
      normalized,
      fixable,
      issues: sortIssues(issues),
    },
    normalizedMemory,
    normalizedContent,
    record,
  };
}

function collectRequiredFieldIssues(frontmatter: RawFrontmatter, rawDetail: string, issues: MemorySchemaIssue[]): void {
  const requiredFields: Array<{ field: keyof RawFrontmatter | "detail"; present: boolean }> = [
    { field: "type", present: Boolean(frontmatter.type?.trim()) },
    { field: "title", present: Boolean(frontmatter.title?.trim()) },
    { field: "summary", present: Boolean(frontmatter.summary?.trim()) },
    { field: "importance", present: Boolean(frontmatter.importance?.trim()) },
    { field: "date", present: Boolean(frontmatter.date?.trim()) },
    { field: "detail", present: Boolean(rawDetail.trim()) },
  ];

  for (const entry of requiredFields) {
    if (entry.present) {
      continue;
    }

    issues.push({
      code: "missing_field",
      severity: "error",
      field: entry.field,
      message: `Required field "${entry.field}" is missing.`,
    });
  }
}

function collectEnumIssues(frontmatter: RawFrontmatter, issues: MemorySchemaIssue[]): void {
  const checks: Array<{ field: keyof RawFrontmatter; value: string | undefined; allowed: readonly string[] }> = [
    { field: "type", value: frontmatter.type, allowed: MEMORY_TYPES },
    { field: "importance", value: frontmatter.importance, allowed: IMPORTANCE_LEVELS },
    { field: "source", value: frontmatter.source, allowed: MEMORY_SOURCES },
    { field: "status", value: frontmatter.status, allowed: MEMORY_STATUSES },
    { field: "origin", value: frontmatter.origin, allowed: MEMORY_ORIGINS },
    { field: "invocation_mode", value: frontmatter.invocation_mode, allowed: INVOCATION_MODES },
    { field: "risk_level", value: frontmatter.risk_level, allowed: RISK_LEVELS },
    { field: "area", value: frontmatter.area, allowed: MEMORY_AREAS },
    { field: "review_state", value: frontmatter.review_state, allowed: REVIEW_STATES },
  ];

  for (const check of checks) {
    if (!check.value || check.allowed.includes(check.value)) {
      continue;
    }

    issues.push({
      code: "invalid_enum",
      severity: "error",
      field: String(check.field),
      message: `Unsupported value "${check.value}". Expected one of: ${check.allowed.join(", ")}.`,
    });
  }
}

function collectConflictIssues(memory: Memory, issues: MemorySchemaIssue[]): void {
  if (memory.status === "superseded" && !memory.superseded_by) {
    issues.push({
      code: "conflict_field",
      severity: "error",
      field: "superseded_by",
      message: 'status "superseded" requires a matching "superseded_by" path.',
    });
  }

  if ((memory.status === "stale" || memory.status === "superseded") && memory.stale !== true) {
    issues.push({
      code: "conflict_field",
      severity: "warning",
      field: "stale",
      message: `status "${memory.status}" should normally carry stale: true for clearer lifecycle metadata.`,
    });
  }

  if (memory.supersedes && memory.superseded_by && memory.supersedes === memory.superseded_by) {
    issues.push({
      code: "conflict_field",
      severity: "error",
      field: "supersedes",
      message: '"supersedes" and "superseded_by" cannot point at the same memory file.',
    });
  }

  const overlaps = [
    ...findSkillOverlap(
      memory.required_skills ?? [],
      memory.recommended_skills ?? [],
      "required_skills",
      "recommended_skills",
    ),
    ...findSkillOverlap(
      memory.required_skills ?? [],
      memory.suppressed_skills ?? [],
      "required_skills",
      "suppressed_skills",
    ),
    ...findSkillOverlap(
      memory.recommended_skills ?? [],
      memory.suppressed_skills ?? [],
      "recommended_skills",
      "suppressed_skills",
    ),
  ];
  issues.push(...overlaps);
}

function collectMeaninglessScopeIssues(frontmatter: RawFrontmatter, memory: Memory, issues: MemorySchemaIssue[]): void {
  for (const field of ["path_scope", "files", "skill_trigger_paths"] satisfies Array<keyof RawFrontmatter>) {
    const original = frontmatter[field];
    const normalized =
      field === "path_scope"
        ? (memory.path_scope ?? [])
        : field === "files"
          ? (memory.files ?? [])
          : (memory.skill_trigger_paths ?? []);

    if (original.length > 0 && normalized.length === 0) {
      issues.push({
        code: "meaningless_scope",
        severity: "warning",
        field,
        message: `All "${field}" entries normalize away, so this scope metadata is currently meaningless.`,
      });
    } else if (original.length > normalized.length) {
      issues.push({
        code: "meaningless_scope",
        severity: "warning",
        field,
        message: `"${field}" contains duplicates or root-like entries that will be normalized away.`,
      });
    }
  }

  if (sameStringSet(memory.path_scope ?? [], memory.files ?? []) && (memory.path_scope ?? []).length > 0) {
    issues.push({
      code: "meaningless_scope",
      severity: "warning",
      field: "path_scope",
      message: '"path_scope" and "files" are identical. Keep the narrower field that you actually use for routing.',
    });
  }
}

function collectSkillMetadataIssues(frontmatter: RawFrontmatter, memory: Memory, issues: MemorySchemaIssue[]): void {
  for (const field of ["recommended_skills", "required_skills", "suppressed_skills"] as const) {
    const original = normalizeLooseArray(frontmatter[field]);
    const normalized =
      field === "recommended_skills"
        ? (memory.recommended_skills ?? [])
        : field === "required_skills"
          ? (memory.required_skills ?? [])
          : (memory.suppressed_skills ?? []);

    if (original.length > normalized.length) {
      issues.push({
        code: "duplicate_skill_metadata",
        severity: "warning",
        field,
        message: `"${field}" contains duplicate skill ids that should be deduplicated.`,
      });
    }
  }

  const hasSkillLists =
    (memory.recommended_skills ?? []).length > 0 ||
    (memory.required_skills ?? []).length > 0 ||
    (memory.suppressed_skills ?? []).length > 0;
  const hasRoutingHints =
    (memory.skill_trigger_paths ?? []).length > 0 ||
    (memory.skill_trigger_tasks ?? []).length > 0 ||
    (memory.path_scope ?? []).length > 0 ||
    (memory.files ?? []).length > 0;

  if (hasSkillLists && !hasRoutingHints) {
    issues.push({
      code: "missing_skill_metadata",
      severity: "warning",
      field: "skill_trigger_paths",
      message:
        "Skill metadata exists, but there are no path/task triggers or scoped files to explain when it should apply.",
    });
  }
}

function findSkillOverlap(left: string[], right: string[], leftField: string, rightField: string): MemorySchemaIssue[] {
  const rightSet = new Set(right);
  return left
    .filter((skill) => rightSet.has(skill))
    .map((skill) => ({
      code: "conflict_field" as const,
      severity: "error" as const,
      field: `${leftField},${rightField}`,
      message: `Skill "${skill}" appears in both "${leftField}" and "${rightField}".`,
    }));
}

function summarizeSchemaHealth(scanned: ScannedMemoryFile[]): MemorySchemaHealthSummary {
  const totalFiles = scanned.length;
  const healthyFiles = scanned.filter((entry) => entry.report.healthy).length;
  const filesWithErrors = scanned.filter((entry) =>
    entry.report.issues.some((issue) => issue.severity === "error"),
  ).length;
  const filesWithWarnings = scanned.filter((entry) =>
    entry.report.issues.some((issue) => issue.severity === "warning"),
  ).length;
  const fixableFiles = scanned.filter((entry) => entry.report.fixable).length;
  const totalIssues = scanned.reduce((sum, entry) => sum + entry.report.issues.length, 0);

  return {
    total_files: totalFiles,
    healthy_files: healthyFiles,
    files_with_warnings: filesWithWarnings,
    files_with_errors: filesWithErrors,
    fixable_files: fixableFiles,
    total_issues: totalIssues,
  };
}

export function renderSchemaHealthSummary(summary: MemorySchemaHealthSummary): string {
  return [
    `Schema health: healthy=${summary.healthy_files}/${summary.total_files}`,
    `warnings=${summary.files_with_warnings}`,
    `errors=${summary.files_with_errors}`,
    `fixable=${summary.fixable_files}`,
    `issues=${summary.total_issues}`,
  ].join(" | ");
}

function normalizeLooseArray(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeFileContent(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function sortIssues(issues: MemorySchemaIssue[]): MemorySchemaIssue[] {
  return [...issues].sort((left, right) => {
    const severityOrder = left.severity === right.severity ? 0 : left.severity === "error" ? -1 : 1;
    if (severityOrder !== 0) {
      return severityOrder;
    }

    const fieldOrder = (left.field ?? "").localeCompare(right.field ?? "");
    if (fieldOrder !== 0) {
      return fieldOrder;
    }

    return left.code.localeCompare(right.code);
  });
}

function isMissingDirectoryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && error.code === "ENOENT";
}

function toDisplayPath(value: string): string {
  return value.replace(/\\/g, "/");
}
