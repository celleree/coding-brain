import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  OrchestratorCheckpoint,
  OrchestratorController,
  OrchestratorPhasePosition,
} from "./orchestrator-lifecycle.js";
import { commitAtomicWriteOperations, createAtomicContentPreconditionOperation } from "./store/atomic-write.js";
import {
  ensureOrchestratorStorageLayout,
  getCurrentOrchestratorCheckpointPath,
  getHistoricalOrchestratorHandoffPath,
  getOrchestratorHandoffsDir,
  parseOrchestratorCheckpointJson,
  prepareCurrentOrchestratorCheckpointWrite,
  prepareHistoricalOrchestratorHandoffWrite,
  serializeOrchestratorCheckpoint,
  validateOrchestratorCheckpoint,
} from "./store/orchestrator-store.js";

interface StoredCheckpoint {
  checkpoint: OrchestratorCheckpoint;
  raw: string;
}

const COMPARABLE_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

/** Read the current durable orchestrator checkpoint, or null when none exists. */
export async function readCurrentOrchestratorCheckpoint(projectRoot: string): Promise<OrchestratorCheckpoint | null> {
  const stored = await readCurrentStoredCheckpoint(projectRoot);
  return stored?.checkpoint ?? null;
}

/**
 * Start the first epoch, or install a verified successor over a closed predecessor.
 * Callers supply the complete checkpoint, including all IDs and timestamps.
 */
export async function startOrchestratorEpoch(
  projectRoot: string,
  checkpoint: OrchestratorCheckpoint,
): Promise<OrchestratorCheckpoint> {
  await ensureOrchestratorStorageLayout(projectRoot);
  const proposed = validateOrchestratorCheckpoint(checkpoint);
  assertOpenCheckpoint(proposed, "new orchestrator epoch");

  const current = await readCurrentStoredCheckpoint(projectRoot);
  if (current === null) {
    if (proposed.epoch.predecessor_epoch_id !== undefined) {
      fail("an initial epoch must not declare an unverified predecessor");
    }
    if ((await findLatestCompletedOrchestratorHandoff(projectRoot)) !== null) {
      fail("cannot start an initial epoch while durable historical handoffs already exist");
    }

    await commitAtomicWriteOperations([
      prepareCurrentOrchestratorCheckpointWrite(projectRoot, proposed, { kind: "create-only" }),
    ]);
    return proposed;
  }

  if (current.checkpoint.epoch.closed_at === undefined) {
    fail(`cannot start epoch "${proposed.epoch.epoch_id}" while the current epoch is active`);
  }

  const predecessorHistory = await readHistoricalOrchestratorHandoff(projectRoot, current.checkpoint.epoch.epoch_id);
  if (!checkpointsEquivalent(current.checkpoint, predecessorHistory.checkpoint)) {
    fail("closed current checkpoint and historical predecessor handoff disagree");
  }

  validateOrchestratorEpochLinkage(current.checkpoint, proposed);
  const predecessorHistoryPath = getHistoricalOrchestratorHandoffPath(projectRoot, current.checkpoint.epoch.epoch_id);
  await commitAtomicWriteOperations([
    prepareCurrentOrchestratorCheckpointWrite(projectRoot, proposed, {
      kind: "replace",
      expectedContent: current.raw,
    }),
    createAtomicContentPreconditionOperation(predecessorHistoryPath, predecessorHistory.raw),
  ]);
  return proposed;
}

/** Write a new checkpoint for the active epoch using checkpoint identity as a concurrency token. */
export async function writeOrchestratorCheckpoint(
  projectRoot: string,
  checkpoint: OrchestratorCheckpoint,
  expectedCheckpointId: string,
): Promise<OrchestratorCheckpoint> {
  const expectedId = requireCheckpointId(expectedCheckpointId, "expected checkpoint ID");
  const current = await requireCurrentStoredCheckpoint(projectRoot);
  assertExpectedCheckpoint(current.checkpoint, expectedId);
  assertActiveCurrentCheckpoint(current.checkpoint);

  const proposed = validateOrchestratorCheckpoint(checkpoint);
  assertNewCheckpointId(current.checkpoint, proposed);
  assertSameEpochOpeningIdentity(current.checkpoint, proposed);
  assertOpenCheckpoint(proposed, "active checkpoint update");

  await commitAtomicWriteOperations([
    prepareCurrentOrchestratorCheckpointWrite(projectRoot, proposed, {
      kind: "replace",
      expectedContent: current.raw,
    }),
  ]);
  return proposed;
}

/**
 * Close the active epoch and atomically create its immutable historical handoff.
 * A successor ID is optional; omitting it is a terminal close.
 */
export async function closeOrchestratorEpoch(
  projectRoot: string,
  checkpoint: OrchestratorCheckpoint,
  expectedCheckpointId: string,
): Promise<OrchestratorCheckpoint> {
  const expectedId = requireCheckpointId(expectedCheckpointId, "expected checkpoint ID");
  const current = await requireCurrentStoredCheckpoint(projectRoot);
  assertExpectedCheckpoint(current.checkpoint, expectedId);
  assertActiveCurrentCheckpoint(current.checkpoint);

  const proposed = validateOrchestratorCheckpoint(checkpoint);
  assertNewCheckpointId(current.checkpoint, proposed);
  assertSameEpochOpeningIdentity(current.checkpoint, proposed);
  if (proposed.epoch.closed_at === undefined) {
    fail("close transition requires epoch.closed_at");
  }

  await commitAtomicWriteOperations([
    prepareCurrentOrchestratorCheckpointWrite(projectRoot, proposed, {
      kind: "replace",
      expectedContent: current.raw,
    }),
    prepareHistoricalOrchestratorHandoffWrite(projectRoot, proposed),
  ]);
  return proposed;
}

/** Validate reciprocal predecessor/successor linkage without requiring controller continuity. */
export function validateOrchestratorEpochLinkage(
  predecessorCheckpoint: OrchestratorCheckpoint,
  successorCheckpoint: OrchestratorCheckpoint,
): void {
  const predecessor = validateOrchestratorCheckpoint(predecessorCheckpoint);
  const successor = validateOrchestratorCheckpoint(successorCheckpoint);
  const predecessorId = predecessor.epoch.epoch_id;
  const successorId = successor.epoch.epoch_id;

  if (predecessorId === successorId) {
    fail("predecessor and successor epoch IDs must differ");
  }
  if (predecessor.epoch.closed_at === undefined) {
    fail("predecessor epoch must be closed before successor linkage is valid");
  }
  if (predecessor.epoch.successor_epoch_id !== successorId) {
    fail(`predecessor epoch "${predecessorId}" does not declare successor "${successorId}"`);
  }
  if (successor.epoch.predecessor_epoch_id !== predecessorId) {
    fail(`successor epoch "${successorId}" does not declare predecessor "${predecessorId}"`);
  }
}

/** Find the most recently completed durable handoff by completion instant, not filesystem metadata. */
export async function findLatestCompletedOrchestratorHandoff(
  projectRoot: string,
): Promise<OrchestratorCheckpoint | null> {
  const handoffsDir = getOrchestratorHandoffsDir(projectRoot);
  let entries;
  try {
    entries = await readdir(handoffsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }

  let latest: OrchestratorCheckpoint | null = null;
  let latestInstant: bigint | null = null;

  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) {
      fail(`historical handoff entry "${entry.name}" is not a regular JSON file`);
    }

    const raw = await readFile(path.join(handoffsDir, entry.name), "utf8");
    const candidate = parseOrchestratorCheckpointJson(raw);
    if (candidate.epoch.closed_at === undefined) {
      fail(`historical handoff "${entry.name}" contains an open epoch`);
    }

    const expectedFilename = path.basename(getHistoricalOrchestratorHandoffPath(projectRoot, candidate.epoch.epoch_id));
    if (entry.name !== expectedFilename) {
      fail(`historical handoff filename "${entry.name}" does not match epoch "${candidate.epoch.epoch_id}" identity`);
    }

    const completionInstant = timestampInstantNanoseconds(candidate.epoch.closed_at);
    if (
      latest === null ||
      latestInstant === null ||
      completionInstant > latestInstant ||
      (completionInstant === latestInstant && candidate.epoch.epoch_id > latest.epoch.epoch_id)
    ) {
      latest = candidate;
      latestInstant = completionInstant;
    }
  }

  return latest;
}

async function readCurrentStoredCheckpoint(projectRoot: string): Promise<StoredCheckpoint | null> {
  const currentPath = getCurrentOrchestratorCheckpointPath(projectRoot);
  try {
    const raw = await readFile(currentPath, "utf8");
    return { checkpoint: parseOrchestratorCheckpointJson(raw), raw };
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function requireCurrentStoredCheckpoint(projectRoot: string): Promise<StoredCheckpoint> {
  const current = await readCurrentStoredCheckpoint(projectRoot);
  if (current === null) {
    fail("no current orchestrator checkpoint exists");
  }
  return current;
}

async function readHistoricalOrchestratorHandoff(projectRoot: string, epochId: string): Promise<StoredCheckpoint> {
  const historicalPath = getHistoricalOrchestratorHandoffPath(projectRoot, epochId);
  let raw: string;
  try {
    raw = await readFile(historicalPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      fail(`historical handoff for epoch "${epochId}" is missing`);
    }
    throw error;
  }

  const checkpoint = parseOrchestratorCheckpointJson(raw);
  if (checkpoint.epoch.closed_at === undefined) {
    fail(`historical handoff for epoch "${epochId}" contains an open epoch`);
  }
  if (checkpoint.epoch.epoch_id !== epochId) {
    fail(`historical handoff for epoch "${epochId}" contains epoch "${checkpoint.epoch.epoch_id}"`);
  }
  return { checkpoint, raw };
}

function assertExpectedCheckpoint(current: OrchestratorCheckpoint, expectedCheckpointId: string): void {
  if (current.checkpoint_id !== expectedCheckpointId) {
    fail(`stale checkpoint identity: expected "${expectedCheckpointId}" but current is "${current.checkpoint_id}"`);
  }
}

function assertNewCheckpointId(current: OrchestratorCheckpoint, proposed: OrchestratorCheckpoint): void {
  if (current.checkpoint_id === proposed.checkpoint_id) {
    fail("the next checkpoint must use a new checkpoint_id");
  }
}

function assertActiveCurrentCheckpoint(checkpoint: OrchestratorCheckpoint): void {
  if (checkpoint.epoch.closed_at !== undefined) {
    fail(`current epoch "${checkpoint.epoch.epoch_id}" is already closed`);
  }
  if (checkpoint.epoch.successor_epoch_id !== undefined) {
    fail(`active current epoch "${checkpoint.epoch.epoch_id}" already declares a successor`);
  }
  if (checkpoint.epoch.phase_at_close !== undefined) {
    fail(`active current epoch "${checkpoint.epoch.epoch_id}" must not set epoch.phase_at_close`);
  }
}

function assertOpenCheckpoint(checkpoint: OrchestratorCheckpoint, context: string): void {
  if (checkpoint.epoch.closed_at !== undefined) {
    fail(`${context} must be open and must not set epoch.closed_at`);
  }
  if (checkpoint.epoch.successor_epoch_id !== undefined) {
    fail(`${context} must not assign epoch.successor_epoch_id`);
  }
  if (checkpoint.epoch.phase_at_close !== undefined) {
    fail(`${context} must not set epoch.phase_at_close`);
  }
}

function assertSameEpochOpeningIdentity(current: OrchestratorCheckpoint, proposed: OrchestratorCheckpoint): void {
  if (current.epoch.epoch_id !== proposed.epoch.epoch_id) {
    fail("checkpoint update cannot change epoch_id");
  }
  if (!controllersEqual(current.epoch.controller, proposed.epoch.controller)) {
    fail("checkpoint update cannot change controller identity");
  }
  if (current.epoch.predecessor_epoch_id !== proposed.epoch.predecessor_epoch_id) {
    fail("checkpoint update cannot change predecessor_epoch_id");
  }
  if (current.epoch.started_at !== proposed.epoch.started_at) {
    fail("checkpoint update cannot change started_at");
  }
  if (!phasePositionsEqual(current.epoch.phase_at_start, proposed.epoch.phase_at_start)) {
    fail("checkpoint update cannot change phase_at_start");
  }
}

function controllersEqual(left: OrchestratorController, right: OrchestratorController): boolean {
  return (
    left.platform === right.platform && left.controller_id === right.controller_id && left.surface === right.surface
  );
}

function phasePositionsEqual(
  left: OrchestratorPhasePosition | undefined,
  right: OrchestratorPhasePosition | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.phase === right.phase && left.sub_phase === right.sub_phase;
}

function checkpointsEquivalent(left: OrchestratorCheckpoint, right: OrchestratorCheckpoint): boolean {
  return serializeOrchestratorCheckpoint(left) === serializeOrchestratorCheckpoint(right);
}

function timestampInstantNanoseconds(timestamp: string): bigint {
  const match = COMPARABLE_TIMESTAMP_PATTERN.exec(timestamp);
  if (match === null) {
    fail(`validated timestamp "${timestamp}" cannot be compared`);
  }

  const [, year, month, day, hour, minute, second, fraction = "", zone, sign, offsetHour, offsetMinute] = match;
  const utcAtLocalSecond = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  if (!Number.isFinite(utcAtLocalSecond)) {
    fail(`validated timestamp "${timestamp}" cannot be converted to an instant`);
  }

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const direction = sign === "+" ? 1 : -1;
    offsetMinutes = direction * (Number(offsetHour) * 60 + Number(offsetMinute));
  }

  const wholeSecondNanoseconds = BigInt(utcAtLocalSecond - offsetMinutes * 60_000) * 1_000_000n;
  const fractionalNanoseconds = BigInt((fraction || "0").padEnd(9, "0"));
  return wholeSecondNanoseconds + fractionalNanoseconds;
}

function requireCheckpointId(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function fail(message: string): never {
  throw new Error(`Orchestrator checkpoint lifecycle error: ${message}.`);
}
