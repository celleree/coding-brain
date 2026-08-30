export const MEMORY_TYPES = ["decision", "gotcha", "convention", "pattern", "working", "goal"] as const;
export const PREFERENCE_KINDS = ["routing_preference"] as const;
export const PREFERENCE_TARGET_TYPES = ["skill", "workflow", "task_class"] as const;
export const PREFERENCE_VALUES = ["prefer", "avoid", "require_review"] as const;
export const IMPORTANCE_LEVELS = ["high", "medium", "low"] as const;
export const MEMORY_SOURCES = ["session", "git-commit", "manual", "pr"] as const;
export const MEMORY_STATUSES = ["active", "candidate", "done", "stale", "superseded"] as const;
export const MEMORY_ORIGINS = ["failure"] as const;
export const EXTRACT_MODES = ["manual", "suggest", "auto"] as const;
export const TRIGGER_MODES = ["manual", "detect"] as const;
export const CAPTURE_MODES = ["direct", "candidate", "reviewable"] as const;
export const WORKFLOW_MODES = ["ultra-safe-manual", "recommended-semi-auto", "automation-first"] as const;
export const INVOCATION_MODES = ["required", "prefer", "optional", "suppress"] as const;
export const RISK_LEVELS = ["high", "medium", "low"] as const;
export const MEMORY_AREAS = ["auth", "api", "db", "infra", "ui", "testing", "general"] as const;
export const MEMORY_REVIEW_DECISIONS = ["accept", "merge", "supersede", "reject"] as const;
export const MEMORY_REVIEW_RELATIONS = [
  "duplicate",
  "additive_update",
  "full_replacement",
  "possible_split",
  "ambiguous_overlap",
] as const;
export const MEMORY_SCOPE_RELATIONS = ["same_scope", "overlapping_scope", "disjoint_scope"] as const;
export const MEMORY_REVIEW_REASONS = [
  "novel_memory",
  "same_scope_summary_overlap",
  "newer_memory_replaces_older",
  "duplicate_memory",
  "possible_scope_split",
  "ambiguous_existing_overlap",
  "temporary_detail",
  "insufficient_signal",
] as const;
export const MEMORY_AUDIT_ISSUE_TYPES = ["stale", "conflict", "low_signal", "overscoped"] as const;
export const MEMORY_SCHEMA_ISSUE_SEVERITIES = ["error", "warning"] as const;
/** Human review / lifecycle flag for durable knowledge; does not replace `status`. */
export const REVIEW_STATES = ["unset", "pending_review", "cleared"] as const;
export const INJECT_LAYERS = ["index", "summary", "full"] as const;
export const CONVERSATION_REFRESH_MODES = ["always", "task-change", "smart"] as const;
export const CONTEXT_LOAD_SOURCES = ["inject", "route", "conversation-start"] as const;
export const CONVERSATION_START_ACTIONS = ["start", "inject", "skip"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type PreferenceKind = (typeof PREFERENCE_KINDS)[number];
export type PreferenceTargetType = (typeof PREFERENCE_TARGET_TYPES)[number];
export type PreferenceValue = (typeof PREFERENCE_VALUES)[number];
export type Importance = (typeof IMPORTANCE_LEVELS)[number];
export type MemorySource = (typeof MEMORY_SOURCES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];
export type ExtractMode = (typeof EXTRACT_MODES)[number];
export type TriggerMode = (typeof TRIGGER_MODES)[number];
export type CaptureMode = (typeof CAPTURE_MODES)[number];
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];
export type InvocationMode = (typeof INVOCATION_MODES)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type MemoryArea = (typeof MEMORY_AREAS)[number];
export type MemoryReviewDecision = (typeof MEMORY_REVIEW_DECISIONS)[number];
export type MemoryReviewRelation = (typeof MEMORY_REVIEW_RELATIONS)[number];
export type MemoryScopeRelation = (typeof MEMORY_SCOPE_RELATIONS)[number];
export type MemoryReviewReason = (typeof MEMORY_REVIEW_REASONS)[number];
export type MemoryAuditIssueType = (typeof MEMORY_AUDIT_ISSUE_TYPES)[number];
export type MemorySchemaIssueSeverity = (typeof MEMORY_SCHEMA_ISSUE_SEVERITIES)[number];
export type ReviewState = (typeof REVIEW_STATES)[number];
export type InjectLayer = (typeof INJECT_LAYERS)[number];
export type ConversationRefreshMode = (typeof CONVERSATION_REFRESH_MODES)[number];
export type ContextLoadSource = (typeof CONTEXT_LOAD_SOURCES)[number];
export type ConversationStartAction = (typeof CONVERSATION_START_ACTIONS)[number];

export interface Memory {
  type: MemoryType;
  title: string;
  summary: string;
  detail: string;
  tags: string[];
  importance: Importance;
  date: string;
  score: number;
  hit_count: number;
  last_used: string | null;
  created_at: string;
  created?: string;
  updated?: string;
  stale: boolean;
  supersedes?: string | null;
  superseded_by?: string | null;
  version?: number;
  related?: string[];
  source?: MemorySource;
  status?: MemoryStatus;
  origin?: MemoryOrigin;
  path_scope?: string[];
  recommended_skills?: string[];
  required_skills?: string[];
  suppressed_skills?: string[];
  skill_trigger_paths?: string[];
  skill_trigger_tasks?: string[];
  invocation_mode?: InvocationMode;
  risk_level?: RiskLevel;
  area?: MemoryArea;
  files?: string[];
  expires?: string;
  /** Optional start of validity (ISO date or datetime). Backfilled from `created_at` when missing. */
  valid_from?: string;
  /** Optional end of validity (ISO date or datetime). Set when superseded or dismissed. */
  valid_until?: string;
  /** When the fact was last observed or confirmed (ISO datetime). */
  observed_at?: string;
  /** Free text explaining replacement (paired with lineage fields). */
  supersession_reason?: string | null;
  /** Confidence for ranking / routing signals, 0–1. Default 1. */
  confidence?: number;
  /** SHA-256 identity of the preserved raw source bytes shared by records from one episode. */
  source_episode?: string;
  /** SHA-256 attestation of the normalized persisted record and its .brain-relative path. */
  record_digest?: string;
  /** Review queue state; `pending_review` excludes inject / routing. */
  review_state?: ReviewState;
}

export interface DerivedMemoryIndexEntry {
  id: string;
  relativePath: string;
  title: string;
  summary: string;
  tags: string[];
  risk_level: RiskLevel;
  path_scope: string[];
  files: string[];
  token_size: number;
  updated_at: string;
  date: string;
  type: MemoryType;
  status: MemoryStatus;
  stale: boolean;
  review_state: ReviewState;
  superseded_by: string | null;
  valid_from: string | null;
  valid_until: string | null;
  expires: string | null;
  source_mtime_ms: number;
}

export interface DerivedMemoryIndexCache {
  version: number;
  generated_at: string;
  entry_count: number;
  entries: DerivedMemoryIndexEntry[];
}

export interface Preference {
  kind: PreferenceKind;
  target_type: PreferenceTargetType;
  target: string;
  preference: PreferenceValue;
  reason: string;
  confidence: number;
  source: string;
  created_at: string;
  updated_at: string;
  valid_from?: string;
  valid_until?: string;
  superseded_by?: string;
  status: MemoryStatus;
  task_hints?: string[];
  path_hints?: string[];
  observed_at?: string;
  supersession_reason?: string | null;
  /** SHA-256 identity of the preserved raw source bytes shared by records from one episode. */
  source_episode?: string;
  /** SHA-256 attestation of the normalized persisted record and its .brain-relative path. */
  record_digest?: string;
  review_state?: ReviewState;
}

export interface BrainConfig {
  workflowMode: WorkflowMode;
  maxInjectTokens: number;
  triggerMode: TriggerMode;
  captureMode: CaptureMode;
  /** @deprecated Use triggerMode + captureMode instead. Kept for backward compat during migration. */
  extractMode: ExtractMode;
  language: string;
  staleDays: number;
  sweepOnInject: boolean;
  injectDiversity: boolean;
  injectExplainMaxItems: number;
  autoApproveSafeCandidates: boolean;
  warnings?: string[];
}

export interface ExtractedMemoriesPayload {
  memories: Memory[];
}

export interface MemoryActivityEntry {
  type: MemoryType;
  title: string;
  importance: Importance;
  date: string;
}

export interface BrainActivityState {
  lastInjectedAt?: string;
  lastContextLoadedAt?: string;
  lastContextSource?: ContextLoadSource;
  lastSelectionContext?: {
    task?: string;
    paths?: string[];
    modules?: string[];
    includeSessionProfile?: boolean;
  };
  recentLoadedMemories: MemoryActivityEntry[];
}

export interface StoredMemoryRecord {
  filePath: string;
  relativePath: string;
  memory: Memory;
}

/** Preference file on disk (`.brain/preferences/*.md`). */
export interface StoredPreferenceRecord {
  filePath: string;
  relativePath: string;
  preference: Preference;
}

export interface CandidateMemoryReviewResult {
  decision: MemoryReviewDecision;
  target_memory_ids: string[];
  reason: MemoryReviewReason;
  confidence?: number;
  internal_relation?: MemoryReviewRelation | null;
  explanation?: CandidateMemoryReviewExplanation;
}

export interface MemoryReviewEvidenceItem {
  code: string;
  label: string;
  weight: number;
  value?: string | number | boolean;
}

export interface MemoryReviewEvidenceBucket {
  score: number;
  items: MemoryReviewEvidenceItem[];
}

export interface MemoryReviewEvidenceVector {
  identity: MemoryReviewEvidenceBucket;
  scope: MemoryReviewEvidenceBucket;
  title_summary_detail_overlap: MemoryReviewEvidenceBucket;
  replacement_wording: MemoryReviewEvidenceBucket;
  recency: MemoryReviewEvidenceBucket;
  status_lineage: MemoryReviewEvidenceBucket;
  total_score: number;
}

export interface MemoryReviewMatch {
  target_memory_id: string;
  target_status: MemoryStatus;
  target_updated_at: string;
  title_similarity: number;
  summary_similarity: number;
  detail_similarity: number;
  same_scope: boolean;
  overlapping_scope: boolean;
  scope_relation: MemoryScopeRelation;
  same_identity: boolean;
  candidate_is_newer: boolean;
  replacement_signal: boolean;
  relation: MemoryReviewRelation;
  confidence: number;
  evidence: MemoryReviewEvidenceVector;
  explain_summary: string;
}

export interface MemoryReviewContext {
  memory: Memory;
  comparable_matches: MemoryReviewMatch[];
  external_review_input?: ValidatedExternalReviewInput;
}

export interface MemoryAuditIssue {
  memory_id: string;
  relative_path: string;
  issue_type: MemoryAuditIssueType;
  reason: string;
  suggested_action: string;
  related_memory_ids?: string[];
}

export interface MemoryAuditSummary {
  total_issues: number;
  by_issue_type: Record<MemoryAuditIssueType, number>;
  schema_health?: MemorySchemaHealthSummary;
}

export interface MemoryAuditResult {
  generated_at: string;
  summary: MemoryAuditSummary;
  issues: MemoryAuditIssue[];
}

export interface MemorySchemaIssue {
  code:
    | "missing_field"
    | "invalid_enum"
    | "conflict_field"
    | "meaningless_scope"
    | "missing_skill_metadata"
    | "duplicate_skill_metadata"
    | "missing_provenance"
    | "invalid_provenance";
  severity: MemorySchemaIssueSeverity;
  field?: string;
  message: string;
}

export interface MemorySchemaFileReport {
  file_path: string;
  relative_path: string;
  memory_id: string;
  healthy: boolean;
  normalized: boolean;
  fixable: boolean;
  issues: MemorySchemaIssue[];
}

export interface MemorySchemaHealthSummary {
  total_files: number;
  healthy_files: number;
  files_with_warnings: number;
  files_with_errors: number;
  fixable_files: number;
  total_issues: number;
}

export interface MemorySchemaScanResult {
  generated_at: string;
  summary: MemorySchemaHealthSummary;
  files: MemorySchemaFileReport[];
}

export interface MemoryNormalizeResult {
  generated_at: string;
  summary: MemorySchemaHealthSummary & {
    normalized_files: number;
    skipped_files: number;
  };
  files: MemorySchemaFileReport[];
}

export interface ReviewedMemoryCandidate {
  memory: Memory;
  review: CandidateMemoryReviewResult;
}

export interface CandidateMemoryReviewExplanation {
  summary: string;
  winning_target_memory_ids: string[];
  considered_match_ids: string[];
  top_matches: Array<{
    target_memory_id: string;
    relation: MemoryReviewRelation;
    confidence: number;
    explain_summary: string;
  }>;
}

export interface MemoryReviewer {
  reviewCandidate(memory: Memory, existingRecords: StoredMemoryRecord[]): CandidateMemoryReviewResult;
}

export interface ExternalReviewSuggestion {
  decision: MemoryReviewDecision;
  target_memory_ids: string[];
  reason?: string;
}

export interface ValidatedExternalReviewInput {
  source: string;
  suggestion: ExternalReviewSuggestion;
}

export interface ReviewCandidateMemoriesOptions {
  resolveExternalReviewInput?: (memory: Memory, existingRecords: StoredMemoryRecord[]) => unknown;
}
