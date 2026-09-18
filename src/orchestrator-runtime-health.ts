import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ORCHESTRATOR_PHASE_BOUNDARY_SIGNALS,
  type OrchestratorCheckpoint,
  type OrchestratorHostContextPressure,
  type OrchestratorPhaseBoundarySignal,
  type OrchestratorRotationSignals,
} from "./orchestrator-lifecycle.js";
import { ensureSessionRuntimeLayout, getRuntimeDir } from "./session-profile.js";
import {
  commitAtomicWriteOperations,
  createAtomicContentPreconditionOperation,
  createAtomicWriteOperation,
} from "./store/atomic-write.js";
import {
  getCurrentOrchestratorCheckpointPath,
  parseOrchestratorCheckpointJson,
  validateOrchestratorRotationSignals,
} from "./store/orchestrator-store.js";

export const ORCHESTRATOR_RUNTIME_HEALTH_CONTRACT_VERSION = "repobrain.orchestrator-runtime-health.v1" as const;
export const ORCHESTRATOR_RUNTIME_HEALTH_KIND = "repobrain.orchestrator_runtime_health" as const;
export const ORCHESTRATOR_RUNTIME_HEALTH_FILENAME = "orchestrator-health.json" as const;

export const MEANINGFUL_ORCHESTRATION_CYCLE_DEFINITION =
  "A completed orchestration operation that materially advances or re-evaluates project execution after authoritative state/dependencies are considered." as const;

export const ORCHESTRATOR_MEANINGFUL_CYCLE_KINDS = [
  "WORK_DISPATCH",
  "RESULT_RECONCILIATION",
  "VERIFICATION_GATE",
  "ROADMAP_ADVANCE",
  "REPLAN",
] as const;

export type OrchestratorMeaningfulCycleKind = (typeof ORCHESTRATOR_MEANINGFUL_CYCLE_KINDS)[number];

export interface OrchestratorRuntimeHealth {
  contract_version: typeof ORCHESTRATOR_RUNTIME_HEALTH_CONTRACT_VERSION;
  kind: typeof ORCHESTRATOR_RUNTIME_HEALTH_KIND;
  epoch_id: string;
  base_checkpoint_id: string;
  signals: OrchestratorRotationSignals;
}

export type OrchestratorRuntimeHealthMutation =
  | { type: "MEANINGFUL_CYCLE_COMPLETED"; cycle_kind: OrchestratorMeaningfulCycleKind }
  | { type: "STALE_STATE_CORRECTION" }
  | { type: "ARCHITECTURE_OR_DEPENDENCY_CHANGE" }
  | { type: "PHASE_BOUNDARY_SIGNAL"; phase_boundary: OrchestratorPhaseBoundarySignal }
  | { type: "HOST_CONTEXT_PRESSURE_SET"; pressure: OrchestratorHostContextPressure }
  | { type: "HOST_CONTEXT_PRESSURE_CLEAR" }
  | { type: "FORCED_ROTATION" };

interface ActiveBinding {
  epochId: string;
  checkpointId: string;
  signals: OrchestratorRotationSignals;
  durableCurrentPath: string;
  durableCurrentContent: Uint8Array;
}

interface BoundRuntimeRead {
  health: OrchestratorRuntimeHealth;
  raw: string | null;
}

export function getOrchestratorRuntimeHealthPath(projectRoot: string): string {
  return path.join(getRuntimeDir(projectRoot), ORCHESTRATOR_RUNTIME_HEALTH_FILENAME);
}

export async function readOrchestratorRuntimeHealth(projectRoot: string): Promise<OrchestratorRuntimeHealth> {
  const binding = await requireActiveBinding(projectRoot);
  return (await readBoundRuntimeHealth(projectRoot, binding)).health;
}

export async function mutateOrchestratorRuntimeHealth(
  projectRoot: string,
  mutation: OrchestratorRuntimeHealthMutation,
): Promise<OrchestratorRuntimeHealth> {
  const binding = await requireActiveBinding(projectRoot);
  const checkedMutation = validateRuntimeMutation(mutation);
  await ensureSessionRuntimeLayout(projectRoot);

  const current = await readBoundRuntimeHealth(projectRoot, binding);
  const next: OrchestratorRuntimeHealth = {
    ...current.health,
    signals: applyMutation(current.health.signals, checkedMutation),
  };
  const targetPath = getOrchestratorRuntimeHealthPath(projectRoot);
  const content = serializeRuntimeHealth(next);
  const operation =
    current.raw === null
      ? createAtomicWriteOperation(targetPath, content, { targetMustNotExist: true })
      : createAtomicWriteOperation(targetPath, content, { expectedContent: current.raw });

  const durableCurrentPrecondition = createAtomicContentPreconditionOperation(
    binding.durableCurrentPath,
    binding.durableCurrentContent,
  );
  await commitAtomicWriteOperations([operation, durableCurrentPrecondition]);
  return next;
}

async function requireActiveBinding(projectRoot: string): Promise<ActiveBinding> {
  const durableCurrentPath = getCurrentOrchestratorCheckpointPath(projectRoot);
  let durableCurrentContent: Buffer;
  try {
    durableCurrentContent = await readFile(durableCurrentPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      fail("no current durable orchestrator checkpoint exists");
    }
    throw error;
  }

  const checkpoint = parseOrchestratorCheckpointJson(durableCurrentContent.toString("utf8"));
  assertActiveCheckpoint(checkpoint);
  return {
    epochId: checkpoint.epoch.epoch_id,
    checkpointId: checkpoint.checkpoint_id,
    signals: validateOrchestratorRotationSignals(checkpoint.status.signals),
    durableCurrentPath,
    durableCurrentContent,
  };
}

function assertActiveCheckpoint(checkpoint: OrchestratorCheckpoint): void {
  if (
    checkpoint.epoch.closed_at !== undefined ||
    checkpoint.epoch.successor_epoch_id !== undefined ||
    checkpoint.epoch.phase_at_close !== undefined
  ) {
    fail("current durable orchestrator checkpoint does not represent an active/open epoch");
  }
}

async function readBoundRuntimeHealth(projectRoot: string, binding: ActiveBinding): Promise<BoundRuntimeRead> {
  const runtimePath = getOrchestratorRuntimeHealthPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(runtimePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { health: baselineHealth(binding), raw: null };
    }
    throw error;
  }

  const parsed = parseRuntimeJson(raw);
  const envelope = validateRuntimeEnvelope(parsed);
  if (envelope.epoch_id !== binding.epochId || envelope.base_checkpoint_id !== binding.checkpointId) {
    return { health: baselineHealth(binding), raw };
  }

  return { health: validateRuntimeHealth(parsed), raw };
}

function baselineHealth(binding: ActiveBinding): OrchestratorRuntimeHealth {
  return {
    contract_version: ORCHESTRATOR_RUNTIME_HEALTH_CONTRACT_VERSION,
    kind: ORCHESTRATOR_RUNTIME_HEALTH_KIND,
    epoch_id: binding.epochId,
    base_checkpoint_id: binding.checkpointId,
    signals: validateOrchestratorRotationSignals(binding.signals),
  };
}

function parseRuntimeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    fail("runtime health JSON is not valid JSON");
  }
}

function validateRuntimeEnvelope(value: unknown): { epoch_id: string; base_checkpoint_id: string } {
  const obj = requireObject(value, "runtime health");
  requireExact(obj.contract_version, ORCHESTRATOR_RUNTIME_HEALTH_CONTRACT_VERSION, "contract_version");
  requireExact(obj.kind, ORCHESTRATOR_RUNTIME_HEALTH_KIND, "kind");
  return {
    epoch_id: requireNonEmptyString(obj.epoch_id, "epoch_id"),
    base_checkpoint_id: requireNonEmptyString(obj.base_checkpoint_id, "base_checkpoint_id"),
  };
}

function validateRuntimeHealth(value: unknown): OrchestratorRuntimeHealth {
  const obj = requireObject(value, "runtime health");
  assertKnownKeys(obj, ["contract_version", "kind", "epoch_id", "base_checkpoint_id", "signals"]);
  const envelope = validateRuntimeEnvelope(obj);
  return {
    contract_version: ORCHESTRATOR_RUNTIME_HEALTH_CONTRACT_VERSION,
    kind: ORCHESTRATOR_RUNTIME_HEALTH_KIND,
    epoch_id: envelope.epoch_id,
    base_checkpoint_id: envelope.base_checkpoint_id,
    signals: validateOrchestratorRotationSignals(obj.signals),
  };
}

function serializeRuntimeHealth(value: OrchestratorRuntimeHealth): string {
  return JSON.stringify(validateRuntimeHealth(value), null, 2) + "\n";
}

function validateRuntimeMutation(value: unknown): OrchestratorRuntimeHealthMutation {
  const mutation = requireObject(value, "mutation");
  const type = mutation.type;
  if (type === "MEANINGFUL_CYCLE_COMPLETED") {
    assertKnownKeys(mutation, ["type", "cycle_kind"]);
    return { type, cycle_kind: requireCycleKind(mutation.cycle_kind) };
  }
  if (
    type === "STALE_STATE_CORRECTION" ||
    type === "ARCHITECTURE_OR_DEPENDENCY_CHANGE" ||
    type === "HOST_CONTEXT_PRESSURE_CLEAR" ||
    type === "FORCED_ROTATION"
  ) {
    assertKnownKeys(mutation, ["type"]);
    return { type };
  }
  if (type === "PHASE_BOUNDARY_SIGNAL") {
    assertKnownKeys(mutation, ["type", "phase_boundary"]);
    const phase = mutation.phase_boundary;
    if (
      typeof phase !== "string" ||
      !ORCHESTRATOR_PHASE_BOUNDARY_SIGNALS.includes(phase as OrchestratorPhaseBoundarySignal)
    ) {
      fail("mutation.phase_boundary must use an existing orchestrator phase-boundary signal");
    }
    return { type, phase_boundary: phase as OrchestratorPhaseBoundarySignal };
  }
  if (type === "HOST_CONTEXT_PRESSURE_SET") {
    assertKnownKeys(mutation, ["type", "pressure"]);
    return { type, pressure: validateHostPressure(mutation.pressure) };
  }
  fail("mutation.type is not supported");
}

function validateHostPressure(value: unknown): OrchestratorHostContextPressure {
  const signals = validateOrchestratorRotationSignals({
    meaningful_cycle_count: 0,
    stale_state_correction_count: 0,
    architecture_or_dependency_changed: false,
    phase_boundary: "NONE",
    host_context_pressure: value,
    forced_rotation: false,
  });
  if (signals.host_context_pressure === undefined) {
    fail("mutation.pressure is required");
  }
  return signals.host_context_pressure;
}

function applyMutation(
  signals: OrchestratorRotationSignals,
  mutation: OrchestratorRuntimeHealthMutation,
): OrchestratorRotationSignals {
  const next = structuredClone(signals);
  switch (mutation.type) {
    case "MEANINGFUL_CYCLE_COMPLETED":
      next.meaningful_cycle_count += 1;
      break;
    case "STALE_STATE_CORRECTION":
      next.stale_state_correction_count += 1;
      break;
    case "ARCHITECTURE_OR_DEPENDENCY_CHANGE":
      next.architecture_or_dependency_changed = true;
      break;
    case "PHASE_BOUNDARY_SIGNAL":
      next.phase_boundary = mutation.phase_boundary;
      break;
    case "HOST_CONTEXT_PRESSURE_SET":
      next.host_context_pressure = mutation.pressure;
      break;
    case "HOST_CONTEXT_PRESSURE_CLEAR":
      delete next.host_context_pressure;
      break;
    case "FORCED_ROTATION":
      next.forced_rotation = true;
      break;
  }
  return validateOrchestratorRotationSignals(next);
}

function requireCycleKind(value: unknown): OrchestratorMeaningfulCycleKind {
  if (
    typeof value !== "string" ||
    !ORCHESTRATOR_MEANINGFUL_CYCLE_KINDS.includes(value as OrchestratorMeaningfulCycleKind)
  ) {
    fail("mutation.cycle_kind must identify a meaningful orchestration operation");
  }
  return value as OrchestratorMeaningfulCycleKind;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(field + " must be an object");
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    fail("unsupported field " + unknownKey);
  }
}

function requireExact(value: unknown, expected: string, field: string): void {
  if (value !== expected) {
    fail(field + " must equal " + JSON.stringify(expected));
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(field + " must be a non-empty string");
  }
  return value;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function fail(message: string): never {
  throw new Error("Orchestrator runtime health error: " + message + ".");
}
