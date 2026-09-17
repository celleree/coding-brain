import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  closeOrchestratorEpoch,
  findLatestCompletedOrchestratorHandoff,
  readCurrentOrchestratorCheckpoint,
  startOrchestratorEpoch,
  validateOrchestratorEpochLinkage,
  writeOrchestratorCheckpoint,
} from "../dist/index.js";
import {
  commitAtomicWriteOperations,
  ensureOrchestratorStorageLayout,
  getCurrentOrchestratorCheckpointPath,
  getHistoricalOrchestratorHandoffPath,
  getOrchestratorHandoffsDir,
  prepareCurrentOrchestratorCheckpointWrite,
  prepareHistoricalOrchestratorHandoffWrite,
  serializeOrchestratorCheckpoint,
} from "../dist/store-api.js";

const VERSION = "repobrain.orchestrator-lifecycle.v1";
const KIND = "repobrain.orchestrator_checkpoint";

function checkpoint({
  checkpointId = "checkpoint-1",
  epochId = "epoch-1",
  platform = "test-host",
  controllerId = "controller-1",
  surface = "test-surface",
  predecessorEpochId,
  successorEpochId,
  startedAt = "2026-09-16T19:00:00.000Z",
  closedAt,
  createdAt = "2026-09-16T20:00:00.000Z",
  phaseAtStart = { phase: "B", sub_phase: "B2" },
  phaseAtClose,
} = {}) {
  const controller = { platform, controller_id: controllerId, surface };
  return {
    contract_version: VERSION,
    kind: KIND,
    checkpoint_id: checkpointId,
    created_at: createdAt,
    epoch: {
      contract_version: VERSION,
      epoch_id: epochId,
      controller: { ...controller },
      ...(predecessorEpochId === undefined ? {} : { predecessor_epoch_id: predecessorEpochId }),
      ...(successorEpochId === undefined ? {} : { successor_epoch_id: successorEpochId }),
      started_at: startedAt,
      ...(closedAt === undefined ? {} : { closed_at: closedAt }),
      ...(phaseAtStart === undefined ? {} : { phase_at_start: structuredClone(phaseAtStart) }),
      ...(phaseAtClose === undefined ? {} : { phase_at_close: structuredClone(phaseAtClose) }),
    },
    status: {
      contract_version: VERSION,
      epoch_id: epochId,
      controller: { ...controller },
      signals: {
        meaningful_cycle_count: 3,
        stale_state_correction_count: 0,
        architecture_or_dependency_changed: false,
        phase_boundary: "NONE",
        forced_rotation: false,
      },
      rotation_state: "CONTINUE",
      evaluated_at: createdAt,
    },
    canonical_decisions: ["Keep B2 provider-neutral."],
    active_workstreams: ["Phase B2"],
    blocked_work: [],
    dependencies: ["A1", "A2", "B1"],
    unresolved_decisions: [],
    risks_conflicts: [],
    next_recommended_actions: ["Review B2 independently."],
    parallel_safe_work: [],
  };
}

function nextCheckpoint(current, checkpointId = "checkpoint-2") {
  const next = structuredClone(current);
  next.checkpoint_id = checkpointId;
  next.created_at = "2026-09-16T20:01:00.000Z";
  next.status.evaluated_at = next.created_at;
  next.status.signals.meaningful_cycle_count += 1;
  next.canonical_decisions.push(`Saved ${checkpointId}.`);
  return next;
}

function closeCheckpoint(current, { checkpointId = "checkpoint-closed", successorEpochId } = {}) {
  const closed = nextCheckpoint(current, checkpointId);
  closed.epoch.closed_at = "2026-09-16T20:05:00.000Z";
  closed.epoch.phase_at_close = { phase: "B", sub_phase: "B2" };
  if (successorEpochId !== undefined) closed.epoch.successor_epoch_id = successorEpochId;
  return closed;
}

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), "repobrain-orchestrator-api-"));
}

async function writeHistorical(projectRoot, value) {
  await ensureOrchestratorStorageLayout(projectRoot);
  await commitAtomicWriteOperations([prepareHistoricalOrchestratorHandoffWrite(projectRoot, value)]);
}

async function writeCurrentCreateOnly(projectRoot, value) {
  await ensureOrchestratorStorageLayout(projectRoot);
  await commitAtomicWriteOperations([
    prepareCurrentOrchestratorCheckpointWrite(projectRoot, value, { kind: "create-only" }),
  ]);
}

describe("orchestrator checkpoint programmatic API", () => {
  it("reads a missing current checkpoint as null", async () => {
    const projectRoot = await tempRoot();
    await expect(readCurrentOrchestratorCheckpoint(projectRoot)).resolves.toBeNull();
  });

  it("fails closed on malformed current JSON", async () => {
    const projectRoot = await tempRoot();
    await ensureOrchestratorStorageLayout(projectRoot);
    await writeFile(getCurrentOrchestratorCheckpointPath(projectRoot), '{"kind":', "utf8");
    await expect(readCurrentOrchestratorCheckpoint(projectRoot)).rejects.toThrow(/not valid JSON/);
  });

  it("starts an initial epoch when durable orchestration state is empty", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();

    await expect(startOrchestratorEpoch(projectRoot, initial)).resolves.toEqual(initial);
    await expect(readCurrentOrchestratorCheckpoint(projectRoot)).resolves.toEqual(initial);
  });

  it("uses create-only semantics when two initial starts race", async () => {
    const projectRoot = await tempRoot();
    const first = checkpoint({ checkpointId: "checkpoint-race-a", epochId: "epoch-race-a" });
    const second = checkpoint({ checkpointId: "checkpoint-race-b", epochId: "epoch-race-b" });

    const results = await Promise.allSettled([
      startOrchestratorEpoch(projectRoot, first),
      startOrchestratorEpoch(projectRoot, second),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const persisted = await readCurrentOrchestratorCheckpoint(projectRoot);
    expect([first.checkpoint_id, second.checkpoint_id]).toContain(persisted?.checkpoint_id);
  });

  it("preserves the first current epoch when a second start is attempted while active", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const originalBytes = await readFile(getCurrentOrchestratorCheckpointPath(projectRoot), "utf8");

    await expect(startOrchestratorEpoch(projectRoot, checkpoint({ epochId: "epoch-2" }))).rejects.toThrow(
      /current epoch is active/,
    );
    expect(await readFile(getCurrentOrchestratorCheckpointPath(projectRoot), "utf8")).toBe(originalBytes);
  });

  it("rejects an initial epoch that declares an unverified predecessor", async () => {
    const projectRoot = await tempRoot();
    await expect(
      startOrchestratorEpoch(projectRoot, checkpoint({ predecessorEpochId: "missing-epoch" })),
    ).rejects.toThrow(/initial epoch must not declare/);
  });

  it("rejects initial start when historical state already exists without current", async () => {
    const projectRoot = await tempRoot();
    await writeHistorical(
      projectRoot,
      checkpoint({ checkpointId: "old-closed", epochId: "old", closedAt: "2026-09-16T18:00:00Z" }),
    );

    await expect(startOrchestratorEpoch(projectRoot, checkpoint())).rejects.toThrow(
      /historical handoffs already exist/,
    );
  });

  it("writes an active checkpoint when the expected checkpoint ID matches", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const next = nextCheckpoint(initial);

    await expect(writeOrchestratorCheckpoint(projectRoot, next, initial.checkpoint_id)).resolves.toEqual(next);
    await expect(readCurrentOrchestratorCheckpoint(projectRoot)).resolves.toEqual(next);
  });

  it("requires a new checkpoint ID for an active checkpoint update", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const next = nextCheckpoint(initial, initial.checkpoint_id);

    await expect(writeOrchestratorCheckpoint(projectRoot, next, initial.checkpoint_id)).rejects.toThrow(
      /new checkpoint_id/,
    );
  });

  it("rejects a stale expected checkpoint ID and preserves current", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const next = nextCheckpoint(initial);

    await expect(writeOrchestratorCheckpoint(projectRoot, next, "stale-checkpoint")).rejects.toThrow(
      /stale checkpoint identity/,
    );
    await expect(readCurrentOrchestratorCheckpoint(projectRoot)).resolves.toEqual(initial);
  });

  it("B1 exact-content protection rejects stale bytes before overwrite", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const currentPath = getCurrentOrchestratorCheckpointPath(projectRoot);
    const semanticReadBytes = await readFile(currentPath, "utf8");
    const next = nextCheckpoint(initial);
    const prepared = prepareCurrentOrchestratorCheckpointWrite(projectRoot, next, {
      kind: "replace",
      expectedContent: semanticReadBytes,
    });

    const concurrentlyChanged = nextCheckpoint(initial, "checkpoint-concurrent");
    const concurrentBytes = serializeOrchestratorCheckpoint(concurrentlyChanged);
    await writeFile(currentPath, concurrentBytes, "utf8");

    await expect(commitAtomicWriteOperations([prepared])).rejects.toThrow(/precondition failed/);
    expect(await readFile(currentPath, "utf8")).toBe(concurrentBytes);
  });

  it("normal checkpoint writes cannot rewrite epoch-opening identity", async () => {
    const cases = [
      [
        "epoch_id",
        (value) => {
          value.epoch.epoch_id = "other-epoch";
          value.status.epoch_id = "other-epoch";
        },
      ],
      [
        "controller",
        (value) => {
          value.epoch.controller.controller_id = "other-controller";
          value.status.controller.controller_id = "other-controller";
        },
      ],
      [
        "predecessor",
        (value) => {
          value.epoch.predecessor_epoch_id = "unexpected-predecessor";
        },
      ],
      [
        "started_at",
        (value) => {
          value.epoch.started_at = "2026-09-16T19:00:01.000Z";
        },
      ],
      [
        "phase_at_start",
        (value) => {
          value.epoch.phase_at_start = { phase: "C", sub_phase: "C1" };
        },
      ],
    ];

    for (const [label, mutate] of cases) {
      const projectRoot = await tempRoot();
      const initial = checkpoint();
      await startOrchestratorEpoch(projectRoot, initial);
      const next = nextCheckpoint(initial);
      mutate(next);
      await expect(writeOrchestratorCheckpoint(projectRoot, next, initial.checkpoint_id), label).rejects.toThrow(
        /cannot change/,
      );
      await expect(readCurrentOrchestratorCheckpoint(projectRoot)).resolves.toEqual(initial);
    }
  });

  it("normal checkpoint writes cannot close the epoch or assign a successor", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);

    const closing = nextCheckpoint(initial);
    closing.epoch.closed_at = "2026-09-16T20:05:00.000Z";
    await expect(writeOrchestratorCheckpoint(projectRoot, closing, initial.checkpoint_id)).rejects.toThrow(
      /must be open/,
    );

    const linking = nextCheckpoint(initial, "checkpoint-3");
    linking.epoch.successor_epoch_id = "epoch-2";
    await expect(writeOrchestratorCheckpoint(projectRoot, linking, initial.checkpoint_id)).rejects.toThrow(
      /must not assign/,
    );
  });

  it("closes atomically with matching closed current and immutable historical handoff", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const closed = closeCheckpoint(initial, { successorEpochId: "epoch-2" });

    await expect(closeOrchestratorEpoch(projectRoot, closed, initial.checkpoint_id)).resolves.toEqual(closed);
    const currentBytes = await readFile(getCurrentOrchestratorCheckpointPath(projectRoot), "utf8");
    const historicalBytes = await readFile(
      getHistoricalOrchestratorHandoffPath(projectRoot, initial.epoch.epoch_id),
      "utf8",
    );
    expect(currentBytes).toBe(historicalBytes);
    await expect(readCurrentOrchestratorCheckpoint(projectRoot)).resolves.toEqual(closed);
  });

  it("rejects close with a stale expected checkpoint ID", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const closed = closeCheckpoint(initial);

    await expect(closeOrchestratorEpoch(projectRoot, closed, "stale-checkpoint")).rejects.toThrow(
      /stale checkpoint identity/,
    );
    await expect(readCurrentOrchestratorCheckpoint(projectRoot)).resolves.toEqual(initial);
  });

  it("rolls current back when historical handoff creation collides", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const originalBytes = await readFile(getCurrentOrchestratorCheckpointPath(projectRoot), "utf8");
    const existingHistory = closeCheckpoint(initial, { checkpointId: "preexisting-history" });
    await writeHistorical(projectRoot, existingHistory);

    const proposedClose = closeCheckpoint(initial, { checkpointId: "new-close" });
    await expect(closeOrchestratorEpoch(projectRoot, proposedClose, initial.checkpoint_id)).rejects.toBeTruthy();
    expect(await readFile(getCurrentOrchestratorCheckpointPath(projectRoot), "utf8")).toBe(originalBytes);
    expect(
      await readFile(getHistoricalOrchestratorHandoffPath(projectRoot, initial.epoch.epoch_id), "utf8"),
    ).toBe(serializeOrchestratorCheckpoint(existingHistory));
  });

  it("accepts valid reciprocal predecessor/successor linkage", () => {
    const predecessor = checkpoint({
      checkpointId: "pred-closed",
      epochId: "epoch-1",
      successorEpochId: "epoch-2",
      closedAt: "2026-09-16T20:05:00Z",
    });
    const successor = checkpoint({
      checkpointId: "succ-open",
      epochId: "epoch-2",
      predecessorEpochId: "epoch-1",
    });
    expect(() => validateOrchestratorEpochLinkage(predecessor, successor)).not.toThrow();
  });

  it("rejects invalid predecessor/successor linkage", () => {
    const validPredecessor = checkpoint({
      checkpointId: "pred-closed",
      epochId: "epoch-1",
      successorEpochId: "epoch-2",
      closedAt: "2026-09-16T20:05:00Z",
    });
    const validSuccessor = checkpoint({
      checkpointId: "succ-open",
      epochId: "epoch-2",
      predecessorEpochId: "epoch-1",
    });

    const cases = [
      ["open predecessor", checkpoint({ epochId: "epoch-1", successorEpochId: "epoch-2" }), validSuccessor],
      [
        "wrong successor",
        checkpoint({ epochId: "epoch-1", successorEpochId: "epoch-3", closedAt: "2026-09-16T20:05:00Z" }),
        validSuccessor,
      ],
      [
        "missing predecessor",
        validPredecessor,
        checkpoint({ checkpointId: "succ-no-pred", epochId: "epoch-2" }),
      ],
      [
        "wrong predecessor",
        validPredecessor,
        checkpoint({ checkpointId: "succ-wrong-pred", epochId: "epoch-2", predecessorEpochId: "epoch-x" }),
      ],
      [
        "self linkage",
        checkpoint({
          checkpointId: "self-linked",
          epochId: "epoch-self",
          successorEpochId: "epoch-self",
          closedAt: "2026-09-16T20:05:00Z",
        }),
        validSuccessor,
      ],
    ];

    for (const [label, predecessor, successor] of cases) {
      expect(() => validateOrchestratorEpochLinkage(predecessor, successor), label).toThrow();
    }
  });

  it("allows linked epochs to use different controllers", () => {
    const predecessor = checkpoint({
      checkpointId: "pred-closed",
      epochId: "epoch-1",
      platform: "chatgpt",
      controllerId: "chatgpt-controller",
      successorEpochId: "epoch-2",
      closedAt: "2026-09-16T20:05:00Z",
    });
    const successor = checkpoint({
      checkpointId: "succ-open",
      epochId: "epoch-2",
      platform: "codex",
      controllerId: "codex-controller",
      predecessorEpochId: "epoch-1",
    });
    expect(() => validateOrchestratorEpochLinkage(predecessor, successor)).not.toThrow();
  });

  it("starts a successor from a matching closed predecessor and historical handoff", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const closed = closeCheckpoint(initial, { successorEpochId: "epoch-2" });
    await closeOrchestratorEpoch(projectRoot, closed, initial.checkpoint_id);

    const successor = checkpoint({
      checkpointId: "successor-1",
      epochId: "epoch-2",
      platform: "other-host",
      controllerId: "controller-2",
      predecessorEpochId: "epoch-1",
      startedAt: "2026-09-16T20:06:00Z",
      createdAt: "2026-09-16T20:06:30Z",
    });
    await expect(startOrchestratorEpoch(projectRoot, successor)).resolves.toEqual(successor);
    await expect(readCurrentOrchestratorCheckpoint(projectRoot)).resolves.toEqual(successor);
  });

  it("rejects successor start while predecessor is still active", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const successor = checkpoint({
      checkpointId: "succ",
      epochId: "epoch-2",
      predecessorEpochId: "epoch-1",
    });

    await expect(startOrchestratorEpoch(projectRoot, successor)).rejects.toThrow(/current epoch is active/);
  });

  it("rejects successor start when closed current and historical predecessor disagree", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const closed = closeCheckpoint(initial, { successorEpochId: "epoch-2" });
    await closeOrchestratorEpoch(projectRoot, closed, initial.checkpoint_id);

    const changedCurrent = structuredClone(closed);
    changedCurrent.checkpoint_id = "changed-current-only";
    await writeFile(
      getCurrentOrchestratorCheckpointPath(projectRoot),
      serializeOrchestratorCheckpoint(changedCurrent),
      "utf8",
    );
    const successor = checkpoint({
      checkpointId: "succ",
      epochId: "epoch-2",
      predecessorEpochId: "epoch-1",
    });

    await expect(startOrchestratorEpoch(projectRoot, successor)).rejects.toThrow(
      /current checkpoint and historical/,
    );
  });

  it("rejects successor start when historical predecessor is missing", async () => {
    const projectRoot = await tempRoot();
    const closed = checkpoint({
      checkpointId: "pred-closed",
      epochId: "epoch-1",
      successorEpochId: "epoch-2",
      closedAt: "2026-09-16T20:05:00Z",
    });
    await writeCurrentCreateOnly(projectRoot, closed);
    const successor = checkpoint({
      checkpointId: "succ",
      epochId: "epoch-2",
      predecessorEpochId: "epoch-1",
    });

    await expect(startOrchestratorEpoch(projectRoot, successor)).rejects.toThrow(/historical handoff.*missing/);
  });

  it("rejects successor start after a terminal close with no declared successor", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const closed = closeCheckpoint(initial);
    await closeOrchestratorEpoch(projectRoot, closed, initial.checkpoint_id);
    const successor = checkpoint({
      checkpointId: "succ",
      epochId: "epoch-2",
      predecessorEpochId: "epoch-1",
    });

    await expect(startOrchestratorEpoch(projectRoot, successor)).rejects.toThrow(/does not declare successor/);
  });

  it("rejects successor start with mismatched reciprocal linkage", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const closed = closeCheckpoint(initial, { successorEpochId: "epoch-2" });
    await closeOrchestratorEpoch(projectRoot, closed, initial.checkpoint_id);
    const wrongSuccessor = checkpoint({
      checkpointId: "succ",
      epochId: "epoch-2",
      predecessorEpochId: "other-predecessor",
    });

    await expect(startOrchestratorEpoch(projectRoot, wrongSuccessor)).rejects.toThrow(/does not declare predecessor/);
  });

  it("returns null when there are no completed handoffs", async () => {
    const projectRoot = await tempRoot();
    await expect(findLatestCompletedOrchestratorHandoff(projectRoot)).resolves.toBeNull();
  });

  it("selects latest completed handoff by closed_at instead of filename or filesystem mtime", async () => {
    const projectRoot = await tempRoot();
    const older = checkpoint({
      checkpointId: "older",
      epochId: "zzzz-epoch",
      closedAt: "2026-09-16T19:00:00Z",
    });
    const newer = checkpoint({
      checkpointId: "newer",
      epochId: "aaaa-epoch",
      closedAt: "2026-09-16T20:00:00Z",
    });
    await writeHistorical(projectRoot, older);
    await writeHistorical(projectRoot, newer);

    const newMtime = new Date("2026-09-16T22:00:00Z");
    const oldMtime = new Date("2026-09-16T18:00:00Z");
    await utimes(getHistoricalOrchestratorHandoffPath(projectRoot, older.epoch.epoch_id), newMtime, newMtime);
    await utimes(getHistoricalOrchestratorHandoffPath(projectRoot, newer.epoch.epoch_id), oldMtime, oldMtime);

    await expect(findLatestCompletedOrchestratorHandoff(projectRoot)).resolves.toEqual(newer);
  });

  it("orders timezone-offset completion timestamps by their actual instant", async () => {
    const projectRoot = await tempRoot();
    const textuallyLaterButEarlierInstant = checkpoint({
      checkpointId: "offset-a",
      epochId: "epoch-a",
      closedAt: "2026-09-16T20:00:00+02:00",
    });
    const actuallyLater = checkpoint({
      checkpointId: "offset-b",
      epochId: "epoch-b",
      closedAt: "2026-09-16T18:30:00Z",
    });
    await writeHistorical(projectRoot, textuallyLaterButEarlierInstant);
    await writeHistorical(projectRoot, actuallyLater);

    await expect(findLatestCompletedOrchestratorHandoff(projectRoot)).resolves.toEqual(actuallyLater);
  });

  it("preserves fractional-second precision when ordering completion instants", async () => {
    const projectRoot = await tempRoot();
    const first = checkpoint({
      checkpointId: "fraction-a",
      epochId: "epoch-a",
      closedAt: "2026-09-16T20:00:00.000000001Z",
    });
    const second = checkpoint({
      checkpointId: "fraction-b",
      epochId: "epoch-b",
      closedAt: "2026-09-16T20:00:00.000000002Z",
    });
    await writeHistorical(projectRoot, first);
    await writeHistorical(projectRoot, second);

    await expect(findLatestCompletedOrchestratorHandoff(projectRoot)).resolves.toEqual(second);
  });

  it("uses epoch ID as a deterministic tie-break for equal completion instants", async () => {
    const projectRoot = await tempRoot();
    const first = checkpoint({ checkpointId: "tie-a", epochId: "epoch-a", closedAt: "2026-09-16T20:00:00Z" });
    const second = checkpoint({ checkpointId: "tie-b", epochId: "epoch-b", closedAt: "2026-09-16T20:00:00Z" });
    await writeHistorical(projectRoot, first);
    await writeHistorical(projectRoot, second);

    await expect(findLatestCompletedOrchestratorHandoff(projectRoot)).resolves.toEqual(second);
  });

  it("fails closed on malformed historical JSON", async () => {
    const projectRoot = await tempRoot();
    await ensureOrchestratorStorageLayout(projectRoot);
    await writeFile(path.join(getOrchestratorHandoffsDir(projectRoot), "bad.json"), '{"kind":', "utf8");

    await expect(findLatestCompletedOrchestratorHandoff(projectRoot)).rejects.toThrow(/not valid JSON/);
  });

  it("fails closed when historical storage contains an open checkpoint", async () => {
    const projectRoot = await tempRoot();
    const active = checkpoint({ checkpointId: "open-history", epochId: "epoch-open" });
    await ensureOrchestratorStorageLayout(projectRoot);
    await writeFile(
      getHistoricalOrchestratorHandoffPath(projectRoot, active.epoch.epoch_id),
      serializeOrchestratorCheckpoint(active),
      "utf8",
    );

    await expect(findLatestCompletedOrchestratorHandoff(projectRoot)).rejects.toThrow(/contains an open epoch/);
  });

  it("fails closed when historical filename identity does not match the checkpoint epoch", async () => {
    const projectRoot = await tempRoot();
    const closed = checkpoint({
      checkpointId: "renamed",
      epochId: "epoch-renamed",
      closedAt: "2026-09-16T20:00:00Z",
    });
    await ensureOrchestratorStorageLayout(projectRoot);
    await writeFile(
      path.join(getOrchestratorHandoffsDir(projectRoot), "renamed.json"),
      serializeOrchestratorCheckpoint(closed),
      "utf8",
    );

    await expect(findLatestCompletedOrchestratorHandoff(projectRoot)).rejects.toThrow(/filename.*does not match epoch/);
  });
});
