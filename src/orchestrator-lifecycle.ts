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
