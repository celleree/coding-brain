import {
  ORCHESTRATOR_CONTEXT_PRESSURE_LEVELS,
  ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION,
  type OrchestratorContextPressureLevel,
  type OrchestratorRotationPolicy,
  type OrchestratorRotationSignals,
  type OrchestratorRotationState,
} from "./orchestrator-lifecycle.js";

export const DEFAULT_ORCHESTRATOR_ROTATION_POLICY = Object.freeze({
  contract_version: ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION,
  policy_id: "repobrain.orchestrator-rotation.default",
  policy_version: "1",
  soft_cycle_threshold: 12,
  hard_cycle_ceiling: 16,
  stale_state_correction_rotate_soon_threshold: 1,
  stale_state_correction_rotate_now_threshold: 2,
  rotate_soon_context_pressure: "HIGH",
  rotate_now_context_pressure: "CRITICAL",
} satisfies OrchestratorRotationPolicy);

export const ORCHESTRATOR_ROTATION_REASON_CODES = [
  "FORCED_ROTATION",
  "ARCHITECTURE_OR_DEPENDENCY_CHANGED",
  "PHASE_BOUNDARY_COMPLETED",
  "HARD_CYCLE_CEILING_REACHED",
  "STALE_STATE_ROTATE_NOW_THRESHOLD_REACHED",
  "HOST_CONTEXT_PRESSURE_ROTATE_NOW_THRESHOLD_REACHED",
  "PHASE_BOUNDARY_IMMINENT",
  "SOFT_CYCLE_THRESHOLD_REACHED",
  "STALE_STATE_ROTATE_SOON_THRESHOLD_REACHED",
  "HOST_CONTEXT_PRESSURE_ROTATE_SOON_THRESHOLD_REACHED",
] as const;

export type OrchestratorRotationReasonCode = (typeof ORCHESTRATOR_ROTATION_REASON_CODES)[number];

export interface OrchestratorRotationReason {
  code: OrchestratorRotationReasonCode;
  rotation_state: Exclude<OrchestratorRotationState, "CONTINUE">;
}

export interface OrchestratorRotationEvaluation {
  rotation_state: OrchestratorRotationState;
  reasons: OrchestratorRotationReason[];
}

function contextPressureRank(level: OrchestratorContextPressureLevel): number {
  return ORCHESTRATOR_CONTEXT_PRESSURE_LEVELS.indexOf(level);
}

function contextPressureMeets(
  level: OrchestratorContextPressureLevel | undefined,
  threshold: OrchestratorContextPressureLevel | undefined,
): boolean {
  if (level === undefined || threshold === undefined) return false;
  return contextPressureRank(level) >= contextPressureRank(threshold);
}

function assertThreshold(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid orchestrator rotation policy: ${name} must be a non-negative integer.`);
  }
}

export function validateOrchestratorRotationPolicy(policy: Readonly<OrchestratorRotationPolicy>): void {
  assertThreshold("soft_cycle_threshold", policy.soft_cycle_threshold);
  assertThreshold("hard_cycle_ceiling", policy.hard_cycle_ceiling);
  assertThreshold("stale_state_correction_rotate_soon_threshold", policy.stale_state_correction_rotate_soon_threshold);
  assertThreshold("stale_state_correction_rotate_now_threshold", policy.stale_state_correction_rotate_now_threshold);

  if (policy.soft_cycle_threshold > policy.hard_cycle_ceiling) {
    throw new Error("Invalid orchestrator rotation policy: soft cycle threshold exceeds hard cycle ceiling.");
  }

  const staleSoon = policy.stale_state_correction_rotate_soon_threshold;
  const staleNow = policy.stale_state_correction_rotate_now_threshold;
  if (staleSoon > staleNow) {
    throw new Error("Invalid orchestrator rotation policy: stale soon threshold exceeds stale now threshold.");
  }

  const contextSoon = policy.rotate_soon_context_pressure;
  const contextNow = policy.rotate_now_context_pressure;
  if (
    contextSoon !== undefined &&
    contextNow !== undefined &&
    contextPressureRank(contextSoon) > contextPressureRank(contextNow)
  ) {
    throw new Error("Invalid orchestrator rotation policy: context soon threshold exceeds context now threshold.");
  }
}

export function evaluateOrchestratorRotation(
  signals: Readonly<OrchestratorRotationSignals>,
  policy: Readonly<OrchestratorRotationPolicy> = DEFAULT_ORCHESTRATOR_ROTATION_POLICY,
): OrchestratorRotationEvaluation {
  validateOrchestratorRotationPolicy(policy);

  const reasons: OrchestratorRotationReason[] = [];
  const addReason = (
    condition: boolean,
    rotation_state: Exclude<OrchestratorRotationState, "CONTINUE">,
    code: OrchestratorRotationReasonCode,
  ): void => {
    if (condition) reasons.push({ code, rotation_state });
  };

  const contextLevel = signals.host_context_pressure?.level;

  addReason(signals.forced_rotation, "ROTATE_NOW", "FORCED_ROTATION");
  addReason(signals.architecture_or_dependency_changed, "ROTATE_NOW", "ARCHITECTURE_OR_DEPENDENCY_CHANGED");
  addReason(signals.phase_boundary === "COMPLETED", "ROTATE_NOW", "PHASE_BOUNDARY_COMPLETED");
  addReason(signals.meaningful_cycle_count >= policy.hard_cycle_ceiling, "ROTATE_NOW", "HARD_CYCLE_CEILING_REACHED");
  addReason(
    signals.stale_state_correction_count >= policy.stale_state_correction_rotate_now_threshold,
    "ROTATE_NOW",
    "STALE_STATE_ROTATE_NOW_THRESHOLD_REACHED",
  );
  addReason(
    contextPressureMeets(contextLevel, policy.rotate_now_context_pressure),
    "ROTATE_NOW",
    "HOST_CONTEXT_PRESSURE_ROTATE_NOW_THRESHOLD_REACHED",
  );

  addReason(signals.phase_boundary === "IMMINENT", "ROTATE_SOON", "PHASE_BOUNDARY_IMMINENT");
  addReason(
    signals.meaningful_cycle_count >= policy.soft_cycle_threshold,
    "ROTATE_SOON",
    "SOFT_CYCLE_THRESHOLD_REACHED",
  );
  addReason(
    signals.stale_state_correction_count >= policy.stale_state_correction_rotate_soon_threshold,
    "ROTATE_SOON",
    "STALE_STATE_ROTATE_SOON_THRESHOLD_REACHED",
  );
  addReason(
    contextPressureMeets(contextLevel, policy.rotate_soon_context_pressure),
    "ROTATE_SOON",
    "HOST_CONTEXT_PRESSURE_ROTATE_SOON_THRESHOLD_REACHED",
  );

  let rotation_state: OrchestratorRotationState = "CONTINUE";
  if (reasons.some((reason) => reason.rotation_state === "ROTATE_NOW")) {
    rotation_state = "ROTATE_NOW";
  } else if (reasons.length > 0) {
    rotation_state = "ROTATE_SOON";
  }

  return { rotation_state, reasons };
}
