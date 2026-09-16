import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { getBrainDir } from "../config.js";
import {
  ORCHESTRATOR_CHECKPOINT_KIND,
  ORCHESTRATOR_CONTEXT_PRESSURE_LEVELS,
  ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION,
  ORCHESTRATOR_PHASE_BOUNDARY_SIGNALS,
  ORCHESTRATOR_REPOSITORY_OBSERVATION_STATE,
  ORCHESTRATOR_ROTATION_STATES,
  type OrchestratorCheckpoint,
  type OrchestratorController,
  type OrchestratorEpoch,
  type OrchestratorHostContextPressure,
  type OrchestratorPhasePosition,
  type OrchestratorRepositoryFact,
  type OrchestratorRepositoryFactKind,
  type OrchestratorRepositoryObservation,
  type OrchestratorRotationSignals,
  type OrchestratorStatus,
} from "../orchestrator-lifecycle.js";
import { createAtomicWriteOperation, type AtomicWriteOperation } from "./atomic-write.js";

export const ORCHESTRATOR_STORAGE_DIRECTORY = "orchestration" as const;
export const ORCHESTRATOR_HANDOFFS_DIRECTORY = "handoffs" as const;
export const ORCHESTRATOR_CURRENT_FILENAME = "current.json" as const;

const REPOSITORY_FACT_KINDS = [
  "repository",
  "branch",
  "sha",
  "pull_request",
  "ci",
  "deployment",
  "other",
] as const satisfies readonly OrchestratorRepositoryFactKind[];

const ORCHESTRATOR_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/;

export type CurrentOrchestratorWritePrecondition =
  | { kind: "create-only" }
  | { kind: "replace"; expectedContent: string | Uint8Array };

export function getOrchestratorStorageDir(projectRoot: string): string {
  return path.join(getBrainDir(projectRoot), ORCHESTRATOR_STORAGE_DIRECTORY);
}

export function getOrchestratorHandoffsDir(projectRoot: string): string {
  return path.join(getOrchestratorStorageDir(projectRoot), ORCHESTRATOR_HANDOFFS_DIRECTORY);
}

export function getCurrentOrchestratorCheckpointPath(projectRoot: string): string {
  return path.join(getOrchestratorStorageDir(projectRoot), ORCHESTRATOR_CURRENT_FILENAME);
}

export function getHistoricalOrchestratorHandoffPath(projectRoot: string, epochId: string): string {
  const logicalEpochId = requireNonEmptyString(epochId, "epoch_id");
  const safeEpochId = createHash("sha256").update(logicalEpochId, "utf8").digest("hex");
  return path.join(getOrchestratorHandoffsDir(projectRoot), `${safeEpochId}.json`);
}

export async function ensureOrchestratorStorageLayout(projectRoot: string): Promise<void> {
  await mkdir(getOrchestratorStorageDir(projectRoot), { recursive: true });
  await mkdir(getOrchestratorHandoffsDir(projectRoot), { recursive: true });
}

export function validateOrchestratorCheckpoint(value: unknown): OrchestratorCheckpoint {
  const checkpoint = requireObject(value, "checkpoint");
  assertKnownKeys(
    checkpoint,
    [
      "contract_version",
      "kind",
      "checkpoint_id",
      "created_at",
      "epoch",
      "status",
      "canonical_decisions",
      "active_workstreams",
      "blocked_work",
      "dependencies",
      "unresolved_decisions",
      "risks_conflicts",
      "next_recommended_actions",
      "parallel_safe_work",
      "last_observed_repository_state",
    ],
    "checkpoint",
  );
  requireExact(checkpoint.contract_version, ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION, "checkpoint.contract_version");
  requireExact(checkpoint.kind, ORCHESTRATOR_CHECKPOINT_KIND, "checkpoint.kind");

  const epoch = validateEpoch(checkpoint.epoch);
  const status = validateStatus(checkpoint.status);
  if (epoch.epoch_id !== status.epoch_id) {
    invalid("checkpoint", "epoch/status epoch_id values must match");
  }
  if (!controllersEqual(epoch.controller, status.controller)) {
    invalid("checkpoint", "epoch/status controller identities must match");
  }

  const lastObserved =
    checkpoint.last_observed_repository_state === undefined
      ? undefined
      : validateRepositoryObservation(checkpoint.last_observed_repository_state);

  return {
    contract_version: ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION,
    kind: ORCHESTRATOR_CHECKPOINT_KIND,
    checkpoint_id: requireNonEmptyString(checkpoint.checkpoint_id, "checkpoint.checkpoint_id"),
    created_at: requireTimestamp(checkpoint.created_at, "checkpoint.created_at"),
    epoch,
    status,
    canonical_decisions: requireStringArray(checkpoint.canonical_decisions, "checkpoint.canonical_decisions"),
    active_workstreams: requireStringArray(checkpoint.active_workstreams, "checkpoint.active_workstreams"),
    blocked_work: requireStringArray(checkpoint.blocked_work, "checkpoint.blocked_work"),
    dependencies: requireStringArray(checkpoint.dependencies, "checkpoint.dependencies"),
    unresolved_decisions: requireStringArray(checkpoint.unresolved_decisions, "checkpoint.unresolved_decisions"),
    risks_conflicts: requireStringArray(checkpoint.risks_conflicts, "checkpoint.risks_conflicts"),
    next_recommended_actions: requireStringArray(
      checkpoint.next_recommended_actions,
      "checkpoint.next_recommended_actions",
    ),
    parallel_safe_work: requireStringArray(checkpoint.parallel_safe_work, "checkpoint.parallel_safe_work"),
    ...(lastObserved === undefined ? {} : { last_observed_repository_state: lastObserved }),
  };
}

export function parseOrchestratorCheckpointJson(raw: string): OrchestratorCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Orchestrator checkpoint JSON is not valid JSON.");
  }
  return validateOrchestratorCheckpoint(parsed);
}

export function serializeOrchestratorCheckpoint(value: unknown): string {
  return serializeValidatedCheckpoint(validateOrchestratorCheckpoint(value));
}

export function prepareCurrentOrchestratorCheckpointWrite(
  projectRoot: string,
  checkpoint: unknown,
  precondition: CurrentOrchestratorWritePrecondition,
): AtomicWriteOperation {
  const content = serializeOrchestratorCheckpoint(checkpoint);
  const targetPath = getCurrentOrchestratorCheckpointPath(projectRoot);
  const checkedPrecondition = validateCurrentWritePrecondition(precondition);
  return checkedPrecondition.kind === "create-only"
    ? createAtomicWriteOperation(targetPath, content, { targetMustNotExist: true })
    : createAtomicWriteOperation(targetPath, content, { expectedContent: checkedPrecondition.expectedContent });
}

export function prepareHistoricalOrchestratorHandoffWrite(
  projectRoot: string,
  checkpoint: unknown,
): AtomicWriteOperation {
  const validated = validateOrchestratorCheckpoint(checkpoint);
  if (validated.epoch.closed_at === undefined) {
    invalid("checkpoint.epoch.closed_at", "is required for historical handoff storage");
  }
  return createAtomicWriteOperation(
    getHistoricalOrchestratorHandoffPath(projectRoot, validated.epoch.epoch_id),
    serializeValidatedCheckpoint(validated),
    { targetMustNotExist: true },
  );
}

function validateCurrentWritePrecondition(value: unknown): CurrentOrchestratorWritePrecondition {
  const precondition = requireObject(value, "current-write precondition");
  if (precondition.kind === "create-only") {
    assertKnownKeys(precondition, ["kind"], "current-write precondition");
    return { kind: "create-only" };
  }
  if (precondition.kind === "replace") {
    assertKnownKeys(precondition, ["kind", "expectedContent"], "current-write precondition");
    if (typeof precondition.expectedContent !== "string" && !(precondition.expectedContent instanceof Uint8Array)) {
      throw new Error("Invalid current-write precondition: replace requires expectedContent bytes.");
    }
    return { kind: "replace", expectedContent: precondition.expectedContent };
  }
  throw new Error('Invalid current-write precondition: kind must be "create-only" or "replace".');
}

function validateEpoch(value: unknown): OrchestratorEpoch {
  const epoch = requireObject(value, "checkpoint.epoch");
  assertKnownKeys(
    epoch,
    [
      "contract_version",
      "epoch_id",
      "controller",
      "predecessor_epoch_id",
      "successor_epoch_id",
      "started_at",
      "closed_at",
      "phase_at_start",
      "phase_at_close",
    ],
    "checkpoint.epoch",
  );
  requireExact(epoch.contract_version, ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION, "checkpoint.epoch.contract_version");
  const epochId = requireNonEmptyString(epoch.epoch_id, "checkpoint.epoch.epoch_id");
  const predecessor = optionalNonEmptyString(epoch.predecessor_epoch_id, "checkpoint.epoch.predecessor_epoch_id");
  const successor = optionalNonEmptyString(epoch.successor_epoch_id, "checkpoint.epoch.successor_epoch_id");
  if (predecessor === epochId || successor === epochId) {
    invalid("checkpoint.epoch", "predecessor/successor epoch IDs must not self-link");
  }
  const closedAt = optionalTimestamp(epoch.closed_at, "checkpoint.epoch.closed_at");
  const phaseAtStart = optionalPhasePosition(epoch.phase_at_start, "checkpoint.epoch.phase_at_start");
  const phaseAtClose = optionalPhasePosition(epoch.phase_at_close, "checkpoint.epoch.phase_at_close");
  return {
    contract_version: ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION,
    epoch_id: epochId,
    controller: validateController(epoch.controller, "checkpoint.epoch.controller"),
    ...(predecessor === undefined ? {} : { predecessor_epoch_id: predecessor }),
    ...(successor === undefined ? {} : { successor_epoch_id: successor }),
    started_at: requireTimestamp(epoch.started_at, "checkpoint.epoch.started_at"),
    ...(closedAt === undefined ? {} : { closed_at: closedAt }),
    ...(phaseAtStart === undefined ? {} : { phase_at_start: phaseAtStart }),
    ...(phaseAtClose === undefined ? {} : { phase_at_close: phaseAtClose }),
  };
}

function validateStatus(value: unknown): OrchestratorStatus {
  const status = requireObject(value, "checkpoint.status");
  assertKnownKeys(
    status,
    ["contract_version", "epoch_id", "controller", "signals", "rotation_state", "evaluated_at"],
    "checkpoint.status",
  );
  requireExact(status.contract_version, ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION, "checkpoint.status.contract_version");
  const rotationState = requireEnum(
    status.rotation_state,
    ORCHESTRATOR_ROTATION_STATES,
    "checkpoint.status.rotation_state",
  );
  return {
    contract_version: ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION,
    epoch_id: requireNonEmptyString(status.epoch_id, "checkpoint.status.epoch_id"),
    controller: validateController(status.controller, "checkpoint.status.controller"),
    signals: validateSignals(status.signals),
    rotation_state: rotationState,
    evaluated_at: requireTimestamp(status.evaluated_at, "checkpoint.status.evaluated_at"),
  };
}

function validateSignals(value: unknown): OrchestratorRotationSignals {
  const signals = requireObject(value, "checkpoint.status.signals");
  assertKnownKeys(
    signals,
    [
      "meaningful_cycle_count",
      "stale_state_correction_count",
      "architecture_or_dependency_changed",
      "phase_boundary",
      "host_context_pressure",
      "forced_rotation",
    ],
    "checkpoint.status.signals",
  );
  const hostPressure =
    signals.host_context_pressure === undefined
      ? undefined
      : validateHostContextPressure(signals.host_context_pressure);
  return {
    meaningful_cycle_count: requireNonNegativeInteger(
      signals.meaningful_cycle_count,
      "checkpoint.status.signals.meaningful_cycle_count",
    ),
    stale_state_correction_count: requireNonNegativeInteger(
      signals.stale_state_correction_count,
      "checkpoint.status.signals.stale_state_correction_count",
    ),
    architecture_or_dependency_changed: requireBoolean(
      signals.architecture_or_dependency_changed,
      "checkpoint.status.signals.architecture_or_dependency_changed",
    ),
    phase_boundary: requireEnum(
      signals.phase_boundary,
      ORCHESTRATOR_PHASE_BOUNDARY_SIGNALS,
      "checkpoint.status.signals.phase_boundary",
    ),
    ...(hostPressure === undefined ? {} : { host_context_pressure: hostPressure }),
    forced_rotation: requireBoolean(signals.forced_rotation, "checkpoint.status.signals.forced_rotation"),
  };
}

function validateHostContextPressure(value: unknown): OrchestratorHostContextPressure {
  const pressure = requireObject(value, "checkpoint.status.signals.host_context_pressure");
  assertKnownKeys(
    pressure,
    ["source", "reported_at", "level", "utilization_ratio", "remaining_tokens"],
    "checkpoint.status.signals.host_context_pressure",
  );
  const level =
    pressure.level === undefined
      ? undefined
      : requireEnum(
          pressure.level,
          ORCHESTRATOR_CONTEXT_PRESSURE_LEVELS,
          "checkpoint.status.signals.host_context_pressure.level",
        );
  const utilization = optionalFiniteNumber(
    pressure.utilization_ratio,
    "checkpoint.status.signals.host_context_pressure.utilization_ratio",
  );
  if (utilization !== undefined && (utilization < 0 || utilization > 1)) {
    invalid("checkpoint.status.signals.host_context_pressure.utilization_ratio", "must be between 0 and 1");
  }
  const remainingTokens =
    pressure.remaining_tokens === undefined
      ? undefined
      : requireNonNegativeInteger(
          pressure.remaining_tokens,
          "checkpoint.status.signals.host_context_pressure.remaining_tokens",
        );
  return {
    source: requireNonEmptyString(pressure.source, "checkpoint.status.signals.host_context_pressure.source"),
    reported_at: requireTimestamp(pressure.reported_at, "checkpoint.status.signals.host_context_pressure.reported_at"),
    ...(level === undefined ? {} : { level }),
    ...(utilization === undefined ? {} : { utilization_ratio: utilization }),
    ...(remainingTokens === undefined ? {} : { remaining_tokens: remainingTokens }),
  };
}

function validateRepositoryObservation(value: unknown): OrchestratorRepositoryObservation {
  const observation = requireObject(value, "checkpoint.last_observed_repository_state");
  assertKnownKeys(
    observation,
    ["verification_state", "observed_at", "repository", "facts"],
    "checkpoint.last_observed_repository_state",
  );
  requireExact(
    observation.verification_state,
    ORCHESTRATOR_REPOSITORY_OBSERVATION_STATE,
    "checkpoint.last_observed_repository_state.verification_state",
  );
  if (!Array.isArray(observation.facts)) {
    invalid("checkpoint.last_observed_repository_state.facts", "must be an array");
  }
  const repository = optionalNonEmptyString(
    observation.repository,
    "checkpoint.last_observed_repository_state.repository",
  );
  return {
    verification_state: ORCHESTRATOR_REPOSITORY_OBSERVATION_STATE,
    observed_at: requireTimestamp(observation.observed_at, "checkpoint.last_observed_repository_state.observed_at"),
    ...(repository === undefined ? {} : { repository }),
    facts: observation.facts.map((fact, index) => validateRepositoryFact(fact, index)),
  };
}

function validateRepositoryFact(value: unknown, index: number): OrchestratorRepositoryFact {
  const field = `checkpoint.last_observed_repository_state.facts[${index}]`;
  const fact = requireObject(value, field);
  assertKnownKeys(fact, ["kind", "value", "label"], field);
  const label = optionalNonEmptyString(fact.label, `${field}.label`);
  return {
    kind: requireEnum(fact.kind, REPOSITORY_FACT_KINDS, `${field}.kind`),
    value: requireNonEmptyString(fact.value, `${field}.value`),
    ...(label === undefined ? {} : { label }),
  };
}

function validateController(value: unknown, field: string): OrchestratorController {
  const controller = requireObject(value, field);
  assertKnownKeys(controller, ["platform", "controller_id", "surface"], field);
  const surface = optionalNonEmptyString(controller.surface, `${field}.surface`);
  return {
    platform: requireNonEmptyString(controller.platform, `${field}.platform`),
    controller_id: requireNonEmptyString(controller.controller_id, `${field}.controller_id`),
    ...(surface === undefined ? {} : { surface }),
  };
}

function optionalPhasePosition(value: unknown, field: string): OrchestratorPhasePosition | undefined {
  if (value === undefined) return undefined;
  const position = requireObject(value, field);
  assertKnownKeys(position, ["phase", "sub_phase"], field);
  const phase = optionalNonEmptyString(position.phase, `${field}.phase`);
  const subPhase = optionalNonEmptyString(position.sub_phase, `${field}.sub_phase`);
  return {
    ...(phase === undefined ? {} : { phase }),
    ...(subPhase === undefined ? {} : { sub_phase: subPhase }),
  };
}

function controllersEqual(left: OrchestratorController, right: OrchestratorController): boolean {
  return (
    left.platform === right.platform && left.controller_id === right.controller_id && left.surface === right.surface
  );
}

function serializeValidatedCheckpoint(checkpoint: OrchestratorCheckpoint): string {
  return `${JSON.stringify(checkpoint, null, 2)}\n`;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(field, "must be an object");
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) invalid(`${field}.${unknown}`, "is not supported by this lifecycle contract version");
}

function requireExact(value: unknown, expected: string, field: string): void {
  if (value !== expected) invalid(field, `must equal ${JSON.stringify(expected)}`);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(field, "must be a non-empty string");
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, field);
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireNonEmptyString(value, field);
  if (!isStrictOrchestratorTimestamp(timestamp)) {
    invalid(field, "must be a valid ISO-8601 timestamp with an explicit timezone");
  }
  return timestamp;
}

function isStrictOrchestratorTimestamp(value: string): boolean {
  const match = ORCHESTRATOR_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  if (match[8] !== "Z") {
    const offsetHour = Number(match[9]);
    const offsetMinute = Number(match[10]);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }

  return true;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireTimestamp(value, field);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalid(field, "must be an array of strings");
  }
  return [...value] as string[];
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field, "must be a boolean");
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalid(field, "must be a non-negative integer");
  }
  return value;
}

function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field, "must be a finite number");
  return value;
}

function requireEnum<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    invalid(field, `must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function invalid(field: string, message: string): never {
  throw new Error(`Invalid orchestrator checkpoint: ${field} ${message}.`);
}
