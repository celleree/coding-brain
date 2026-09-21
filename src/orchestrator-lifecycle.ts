export const ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION = "repobrain.orchestrator-lifecycle.v1" as const;
export const ORCHESTRATOR_CHECKPOINT_KIND = "repobrain.orchestrator_checkpoint" as const;

export const ORCHESTRATOR_ROTATION_STATES = ["CONTINUE", "ROTATE_SOON", "ROTATE_NOW"] as const;
export type OrchestratorRotationState = (typeof ORCHESTRATOR_ROTATION_STATES)[number];

export const ORCHESTRATOR_PHASE_BOUNDARY_SIGNALS = ["NONE", "IMMINENT", "COMPLETED"] as const;
export type OrchestratorPhaseBoundarySignal = (typeof ORCHESTRATOR_PHASE_BOUNDARY_SIGNALS)[number];

export const ORCHESTRATOR_CONTEXT_PRESSURE_LEVELS = ["LOW", "MODERATE", "HIGH", "CRITICAL"] as const;
export type OrchestratorContextPressureLevel = (typeof ORCHESTRATOR_CONTEXT_PRESSURE_LEVELS)[number];

export const ORCHESTRATOR_REPOSITORY_OBSERVATION_STATE = "LAST OBSERVED — REVERIFY BEFORE USE" as const;

/** Provider-neutral controller identity. Core lifecycle contracts do not enumerate providers or surfaces. */
export interface OrchestratorController {
  platform: string;
  controller_id: string;
  surface?: string;
}

export interface OrchestratorPhasePosition {
  phase?: string;
  sub_phase?: string;
}

/** One bounded orchestration tenure. Persistence and mutation semantics are intentionally out of scope here. */
export interface OrchestratorEpoch {
  contract_version: typeof ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION;
  epoch_id: string;
  controller: OrchestratorController;
  predecessor_epoch_id?: string;
  successor_epoch_id?: string;
  started_at: string;
  closed_at?: string;
  phase_at_start?: OrchestratorPhasePosition;
  phase_at_close?: OrchestratorPhasePosition;
}

/**
 * Host-supplied context pressure only. Omit this object entirely when the host does not expose a reliable signal.
 */
export interface OrchestratorHostContextPressure {
  source: string;
  reported_at: string;
  level?: OrchestratorContextPressureLevel;
  utilization_ratio?: number;
  remaining_tokens?: number;
}

export interface OrchestratorRotationSignals {
  meaningful_cycle_count: number;
  stale_state_correction_count: number;
  architecture_or_dependency_changed: boolean;
  phase_boundary: OrchestratorPhaseBoundarySignal;
  host_context_pressure?: OrchestratorHostContextPressure;
  forced_rotation: boolean;
}

/** Versioned thresholds consumed by the future pure rotation evaluator. */
export interface OrchestratorRotationPolicy {
  contract_version: typeof ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION;
  policy_id: string;
  policy_version: string;
  soft_cycle_threshold: number;
  hard_cycle_ceiling: number;
  stale_state_correction_rotate_soon_threshold: number;
  stale_state_correction_rotate_now_threshold: number;
  rotate_soon_context_pressure?: OrchestratorContextPressureLevel;
  rotate_now_context_pressure?: OrchestratorContextPressureLevel;
}

export interface OrchestratorStatus {
  contract_version: typeof ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION;
  epoch_id: string;
  controller: OrchestratorController;
  signals: OrchestratorRotationSignals;
  rotation_state: OrchestratorRotationState;
  evaluated_at: string;
}

export type OrchestratorRepositoryFactKind =
  | "repository"
  | "branch"
  | "sha"
  | "pull_request"
  | "ci"
  | "deployment"
  | "other";

export interface OrchestratorRepositoryFact {
  kind: OrchestratorRepositoryFactKind;
  value: string;
  label?: string;
}

/**
 * Repository facts captured in a checkpoint are observations, never durable assertions of current live state.
 */
export interface OrchestratorRepositoryObservation {
  verification_state: typeof ORCHESTRATOR_REPOSITORY_OBSERVATION_STATE;
  observed_at: string;
  repository?: string;
  facts: OrchestratorRepositoryFact[];
}

export interface OrchestratorCheckpoint {
  contract_version: typeof ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION;
  kind: typeof ORCHESTRATOR_CHECKPOINT_KIND;
  checkpoint_id: string;
  created_at: string;
  epoch: OrchestratorEpoch;
  status: OrchestratorStatus;
  canonical_decisions: string[];
  active_workstreams: string[];
  blocked_work: string[];
  dependencies: string[];
  unresolved_decisions: string[];
  risks_conflicts: string[];
  next_recommended_actions: string[];
  parallel_safe_work: string[];
  last_observed_repository_state?: OrchestratorRepositoryObservation;
}


export const REVIEW_READINESS_CONTRACT_VERSION = "repobrain.review-readiness.v1" as const;
export const REVIEW_WORKFLOW_STATUSES = ["IN_PROGRESS", "REVIEW_READY"] as const;
export type ReviewWorkflowStatus = (typeof REVIEW_WORKFLOW_STATUSES)[number];

export const REVIEW_READINESS_STATES = ["NOT_READY", "READY", "STALE", "INVALID"] as const;
export type ReviewReadinessState = (typeof REVIEW_READINESS_STATES)[number];

export interface ReviewReadinessDeclaration {
  contract_version: typeof REVIEW_READINESS_CONTRACT_VERSION;
  status: ReviewWorkflowStatus;
  review_sha?: string;
}

export interface ReviewReadinessEvaluation {
  state: ReviewReadinessState;
  current_head_sha?: string;
  declared_review_sha?: string;
  reason: string;
}

export const EXACT_HEAD_REVIEW_OUTCOMES = ["PASS", "FAIL"] as const;
export type ExactHeadReviewOutcome = (typeof EXACT_HEAD_REVIEW_OUTCOMES)[number];

export interface ExactHeadReviewResult {
  contract_version: typeof REVIEW_READINESS_CONTRACT_VERSION;
  reviewed_sha: string;
  outcome: ExactHeadReviewOutcome;
}

export type ExactHeadReviewValidity = "CURRENT" | "STALE" | "INVALID";

export interface ExactHeadReviewEvaluation {
  state: ExactHeadReviewValidity;
  current_head_sha?: string;
  reviewed_sha?: string;
  reason: string;
}

const REVIEW_READINESS_BLOCK_START = "<!-- repobrain-review-readiness";
const REVIEW_READINESS_BLOCK_END = "-->";
const EXACT_GIT_SHA = /^[0-9a-f]{40}$/i;

/**
 * Provider-neutral readiness evaluator. Callers supply the observed current HEAD;
 * core lifecycle logic does not fetch provider state.
 */
export function evaluateReviewReadiness(
  declaration: unknown,
  currentHeadSha: unknown,
): ReviewReadinessEvaluation {
  const currentHead = normalizeGitSha(currentHeadSha);
  if (currentHead === null) {
    return { state: "INVALID", reason: "current HEAD SHA must be a full 40-character Git SHA" };
  }
  if (!isRecord(declaration)) {
    return invalidReadiness(currentHead, "review-readiness declaration is missing or malformed");
  }

  const keys = Object.keys(declaration);
  if (keys.some((key) => !["contract_version", "status", "review_sha"].includes(key))) {
    return invalidReadiness(currentHead, "review-readiness declaration contains unsupported fields");
  }
  if (declaration.contract_version !== REVIEW_READINESS_CONTRACT_VERSION) {
    return invalidReadiness(currentHead, "review-readiness contract version is missing or unsupported");
  }
  if (
    typeof declaration.status !== "string" ||
    !REVIEW_WORKFLOW_STATUSES.includes(declaration.status as ReviewWorkflowStatus)
  ) {
    return invalidReadiness(currentHead, "review-readiness status is missing or unsupported");
  }

  if (declaration.status === "IN_PROGRESS") {
    if (declaration.review_sha !== undefined) {
      return invalidReadiness(currentHead, "IN_PROGRESS must not retain a declared review SHA");
    }
    return {
      state: "NOT_READY",
      current_head_sha: currentHead,
      reason: "implementation is still in progress",
    };
  }

  const declaredSha = normalizeGitSha(declaration.review_sha);
  if (declaredSha === null) {
    return invalidReadiness(currentHead, "REVIEW_READY requires a full 40-character review SHA");
  }
  if (declaredSha !== currentHead) {
    return {
      state: "STALE",
      current_head_sha: currentHead,
      declared_review_sha: declaredSha,
      reason: "STALE — HEAD MOVED",
    };
  }
  return {
    state: "READY",
    current_head_sha: currentHead,
    declared_review_sha: declaredSha,
    reason: "declared review SHA matches current HEAD",
  };
}

/**
 * Parse the reusable readiness block used by provider adapters such as GitHub PR checks.
 * Missing, duplicate, or malformed fields fail closed as INVALID.
 */
export function evaluateReviewReadinessText(
  source: unknown,
  currentHeadSha: unknown,
): ReviewReadinessEvaluation {
  const currentHead = normalizeGitSha(currentHeadSha);
  if (currentHead === null) {
    return { state: "INVALID", reason: "current HEAD SHA must be a full 40-character Git SHA" };
  }
  if (typeof source !== "string") {
    return invalidReadiness(currentHead, "review-readiness source must be text");
  }

  const start = source.indexOf(REVIEW_READINESS_BLOCK_START);
  if (start < 0) {
    return invalidReadiness(currentHead, "review-readiness block is missing");
  }
  if (
    source.indexOf(REVIEW_READINESS_BLOCK_START, start + REVIEW_READINESS_BLOCK_START.length) >= 0
  ) {
    return invalidReadiness(currentHead, "multiple review-readiness blocks are not allowed");
  }
  const bodyStart = start + REVIEW_READINESS_BLOCK_START.length;
  const end = source.indexOf(REVIEW_READINESS_BLOCK_END, bodyStart);
  if (end < 0) {
    return invalidReadiness(currentHead, "review-readiness block is not closed");
  }

  const fields: Record<string, string> = {};
  const allowed = new Set(["CONTRACT_VERSION", "STATUS", "REVIEW_SHA"]);
  for (const line of source.slice(bodyStart, end).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      return invalidReadiness(currentHead, "review-readiness block contains a malformed line");
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!allowed.has(key) || key in fields || value.length === 0) {
      return invalidReadiness(currentHead, "review-readiness block contains invalid or duplicate fields");
    }
    fields[key] = value;
  }

  const declaration: Record<string, unknown> = {
    contract_version: fields.CONTRACT_VERSION,
    status: fields.STATUS,
  };
  if (fields.REVIEW_SHA !== undefined) declaration.review_sha = fields.REVIEW_SHA;
  return evaluateReviewReadiness(declaration, currentHead);
}

/**
 * A review result is only current for the exact live SHA it reviewed.
 * A later commit makes the prior result stale rather than transferable.
 */
export function evaluateExactHeadReviewResult(
  result: unknown,
  currentHeadSha: unknown,
): ExactHeadReviewEvaluation {
  const currentHead = normalizeGitSha(currentHeadSha);
  if (currentHead === null) {
    return { state: "INVALID", reason: "current HEAD SHA must be a full 40-character Git SHA" };
  }
  if (!isRecord(result)) {
    return {
      state: "INVALID",
      current_head_sha: currentHead,
      reason: "exact-HEAD review result is missing or malformed",
    };
  }
  const keys = Object.keys(result);
  if (keys.some((key) => !["contract_version", "reviewed_sha", "outcome"].includes(key))) {
    return {
      state: "INVALID",
      current_head_sha: currentHead,
      reason: "exact-HEAD review result contains unsupported fields",
    };
  }
  const reviewedSha = normalizeGitSha(result.reviewed_sha);
  if (
    result.contract_version !== REVIEW_READINESS_CONTRACT_VERSION ||
    reviewedSha === null ||
    typeof result.outcome !== "string" ||
    !EXACT_HEAD_REVIEW_OUTCOMES.includes(result.outcome as ExactHeadReviewOutcome)
  ) {
    return {
      state: "INVALID",
      current_head_sha: currentHead,
      reason: "exact-HEAD review result is invalid",
    };
  }
  if (reviewedSha !== currentHead) {
    return {
      state: "STALE",
      current_head_sha: currentHead,
      reviewed_sha: reviewedSha,
      reason: "STALE — HEAD MOVED",
    };
  }
  return {
    state: "CURRENT",
    current_head_sha: currentHead,
    reviewed_sha: reviewedSha,
    reason: "review result applies to current HEAD",
  };
}

function invalidReadiness(currentHeadSha: string, reason: string): ReviewReadinessEvaluation {
  return { state: "INVALID", current_head_sha: currentHeadSha, reason };
}

function normalizeGitSha(value: unknown): string | null {
  return typeof value === "string" && EXACT_GIT_SHA.test(value) ? value.toLowerCase() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
