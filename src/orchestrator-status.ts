import type {
  OrchestratorCheckpoint,
  OrchestratorController,
  OrchestratorHostContextPressure,
  OrchestratorPhasePosition,
  OrchestratorRotationSignals,
  OrchestratorRotationState,
} from "./orchestrator-lifecycle.js";
import { readCurrentOrchestratorCheckpoint } from "./orchestrator-checkpoint-api.js";
import { readOrchestratorRuntimeHealth } from "./orchestrator-runtime-health.js";
import {
  evaluateOrchestratorRotation,
  type OrchestratorRotationReason,
} from "./orchestrator-rotation.js";

export interface OrchestratorStatusView {
  epoch_id: string;
  checkpoint_id: string;
  controller: OrchestratorController;
  phase_at_start?: OrchestratorPhasePosition;
  signals: OrchestratorRotationSignals;
  rotation_state: OrchestratorRotationState;
  rotation_recommendation: string;
  rotation_reasons: OrchestratorRotationReason[];
}

const ROTATION_RECOMMENDATIONS: Readonly<Record<OrchestratorRotationState, string>> = {
  CONTINUE: "continue current epoch",
  ROTATE_SOON: "rotate at the next safe orchestration boundary",
  ROTATE_NOW: "rotate before dispatching further orchestration work",
};

export async function buildOrchestratorStatus(projectRoot: string): Promise<OrchestratorStatusView> {
  const before = await readCurrentOrchestratorCheckpoint(projectRoot);
  if (before === null) {
    fail("no durable current epoch exists");
  }
  assertActiveCheckpoint(before);

  const health = await readOrchestratorRuntimeHealth(projectRoot);
  const after = await readCurrentOrchestratorCheckpoint(projectRoot);

  if (
    after === null ||
    !sameCheckpointSnapshot(before, after) ||
    health.epoch_id !== after.epoch.epoch_id ||
    health.base_checkpoint_id !== after.checkpoint_id
  ) {
    fail("durable checkpoint/runtime snapshot changed during status read; retry");
  }
  assertActiveCheckpoint(after);

  const evaluation = evaluateOrchestratorRotation(health.signals);
  return {
    epoch_id: health.epoch_id,
    checkpoint_id: health.base_checkpoint_id,
    controller: structuredClone(after.epoch.controller),
    ...(phaseKnown(after.epoch.phase_at_start)
      ? { phase_at_start: structuredClone(after.epoch.phase_at_start) }
      : {}),
    signals: structuredClone(health.signals),
    rotation_state: evaluation.rotation_state,
    rotation_recommendation: ROTATION_RECOMMENDATIONS[evaluation.rotation_state],
    rotation_reasons: evaluation.reasons.map((reason) => ({ ...reason })),
  };
}

export function renderOrchestratorStatus(status: Readonly<OrchestratorStatusView>): string {
  const lines = [
    `EPOCH: ${status.epoch_id}`,
    `CHECKPOINT: ${status.checkpoint_id}`,
    `CONTROLLER: ${renderController(status.controller)}`,
  ];

  if (phaseKnown(status.phase_at_start)) {
    lines.push(`PHASE AT START: ${renderPhase(status.phase_at_start)}`);
  }

  lines.push(
    `CYCLES: ${status.signals.meaningful_cycle_count}`,
    `STATE: ${status.rotation_state}`,
    `ROTATION RECOMMENDATION: ${status.rotation_recommendation}`,
    `TRIGGERS: ${
      status.rotation_reasons.length === 0
        ? "none"
        : status.rotation_reasons.map((reason) => reason.code).join(", ")
    }`,
    `STALE-STATE CORRECTIONS: ${status.signals.stale_state_correction_count}`,
    `ARCH/DEPENDENCY CHANGED: ${status.signals.architecture_or_dependency_changed ? "yes" : "no"}`,
    `PHASE BOUNDARY: ${status.signals.phase_boundary}`,
  );

  if (status.signals.host_context_pressure !== undefined) {
    lines.push(`HOST CONTEXT PRESSURE: ${renderHostContextPressure(status.signals.host_context_pressure)}`);
  }

  lines.push(`FORCED ROTATION: ${status.signals.forced_rotation ? "yes" : "no"}`);
  return lines.join("\n");
}

export function renderOrchestratorStatusJson(status: Readonly<OrchestratorStatusView>): string {
  return JSON.stringify(status, null, 2);
}

function sameCheckpointSnapshot(left: OrchestratorCheckpoint, right: OrchestratorCheckpoint): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertActiveCheckpoint(checkpoint: OrchestratorCheckpoint): void {
  if (
    checkpoint.epoch.closed_at !== undefined ||
    checkpoint.epoch.successor_epoch_id !== undefined ||
    checkpoint.epoch.phase_at_close !== undefined
  ) {
    fail("current durable epoch is closed/not active");
  }
}

function phaseKnown(phase: OrchestratorPhasePosition | undefined): phase is OrchestratorPhasePosition {
  return phase !== undefined && (phase.phase !== undefined || phase.sub_phase !== undefined);
}

function renderController(controller: OrchestratorController): string {
  return [controller.platform, controller.controller_id, controller.surface].filter(Boolean).join(" / ");
}

function renderPhase(phase: OrchestratorPhasePosition): string {
  return [phase.phase, phase.sub_phase].filter(Boolean).join(" / ");
}

function renderHostContextPressure(pressure: OrchestratorHostContextPressure): string {
  const details = [
    pressure.level,
    `source=${pressure.source}`,
    pressure.utilization_ratio === undefined ? undefined : `utilization_ratio=${pressure.utilization_ratio}`,
    pressure.remaining_tokens === undefined ? undefined : `remaining_tokens=${pressure.remaining_tokens}`,
  ].filter((value): value is string => value !== undefined);

  return details.join(" / ");
}

function fail(message: string): never {
  throw new Error("Orchestrator status error: " + message + ".");
}
