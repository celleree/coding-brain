import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  closeOrchestratorEpoch,
  readCurrentOrchestratorCheckpoint,
  startOrchestratorEpoch,
  writeOrchestratorCheckpoint,
} from "../dist/index.js";
import {
  getCurrentOrchestratorCheckpointPath,
  getHistoricalOrchestratorHandoffPath,
  serializeOrchestratorCheckpoint,
} from "../dist/store-api.js";

const VERSION = "repobrain.orchestrator-lifecycle.v1";
const KIND = "repobrain.orchestrator_checkpoint";
const PHASE_AT_CLOSE = { phase: "B", sub_phase: "B2" };

function checkpoint({
  checkpointId = "checkpoint-1",
  epochId = "epoch-1",
  platform = "test-host",
  controllerId = "controller-1",
  predecessorEpochId,
  successorEpochId,
  startedAt = "2026-09-16T19:00:00.000Z",
  closedAt,
  createdAt = "2026-09-16T20:00:00.000Z",
  phaseAtClose,
} = {}) {
  const controller = { platform, controller_id: controllerId, surface: "test-surface" };
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
      phase_at_start: { phase: "B", sub_phase: "B2" },
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
  return next;
}

function closeCheckpoint(current, { checkpointId = "checkpoint-closed", successorEpochId } = {}) {
  const closed = nextCheckpoint(current, checkpointId);
  closed.epoch.closed_at = "2026-09-16T20:05:00.000Z";
  closed.epoch.phase_at_close = structuredClone(PHASE_AT_CLOSE);
  if (successorEpochId !== undefined) closed.epoch.successor_epoch_id = successorEpochId;
  return closed;
}

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), "repobrain-orchestrator-repair-"));
}

describe("orchestrator checkpoint B2 review repairs", () => {
  it("rejects an initial open epoch containing phase_at_close without creating current", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint({ phaseAtClose: PHASE_AT_CLOSE });

    await expect(startOrchestratorEpoch(projectRoot, initial)).rejects.toThrow(/phase_at_close/);
    await expect(readCurrentOrchestratorCheckpoint(projectRoot)).resolves.toBeNull();
  });

  it("rejects an open successor containing phase_at_close and preserves the closed predecessor", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const closed = closeCheckpoint(initial, { successorEpochId: "epoch-2" });
    await closeOrchestratorEpoch(projectRoot, closed, initial.checkpoint_id);
    const currentPath = getCurrentOrchestratorCheckpointPath(projectRoot);
    const closedBytes = await readFile(currentPath, "utf8");

    const successor = checkpoint({
      checkpointId: "successor-with-close-phase",
      epochId: "epoch-2",
      predecessorEpochId: "epoch-1",
      startedAt: "2026-09-16T20:06:00.000Z",
      createdAt: "2026-09-16T20:06:30.000Z",
      phaseAtClose: PHASE_AT_CLOSE,
    });

    await expect(startOrchestratorEpoch(projectRoot, successor)).rejects.toThrow(/phase_at_close/);
    expect(await readFile(currentPath, "utf8")).toBe(closedBytes);
    await expect(readCurrentOrchestratorCheckpoint(projectRoot)).resolves.toEqual(closed);
  });

  it("rejects an active checkpoint update that adds phase_at_close and preserves current", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const currentPath = getCurrentOrchestratorCheckpointPath(projectRoot);
    const initialBytes = await readFile(currentPath, "utf8");
    const next = nextCheckpoint(initial);
    next.epoch.phase_at_close = structuredClone(PHASE_AT_CLOSE);

    await expect(writeOrchestratorCheckpoint(projectRoot, next, initial.checkpoint_id)).rejects.toThrow(
      /phase_at_close/,
    );
    expect(await readFile(currentPath, "utf8")).toBe(initialBytes);
  });

  it("rejects an active write when the persisted open current already contains phase_at_close", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const currentPath = getCurrentOrchestratorCheckpointPath(projectRoot);
    const corruptCurrent = structuredClone(initial);
    corruptCurrent.epoch.phase_at_close = structuredClone(PHASE_AT_CLOSE);
    const corruptBytes = serializeOrchestratorCheckpoint(corruptCurrent);
    await writeFile(currentPath, corruptBytes, "utf8");

    await expect(
      writeOrchestratorCheckpoint(projectRoot, nextCheckpoint(initial), initial.checkpoint_id),
    ).rejects.toThrow(/phase_at_close/);
    expect(await readFile(currentPath, "utf8")).toBe(corruptBytes);
  });

  it("rejects close when the persisted open current already contains phase_at_close", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const currentPath = getCurrentOrchestratorCheckpointPath(projectRoot);
    const corruptCurrent = structuredClone(initial);
    corruptCurrent.epoch.phase_at_close = structuredClone(PHASE_AT_CLOSE);
    const corruptBytes = serializeOrchestratorCheckpoint(corruptCurrent);
    await writeFile(currentPath, corruptBytes, "utf8");

    await expect(closeOrchestratorEpoch(projectRoot, closeCheckpoint(initial), initial.checkpoint_id)).rejects.toThrow(
      /phase_at_close/,
    );
    expect(await readFile(currentPath, "utf8")).toBe(corruptBytes);
  });

  it("accepts a valid proposed close containing phase_at_close", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const closed = closeCheckpoint(initial);

    await expect(closeOrchestratorEpoch(projectRoot, closed, initial.checkpoint_id)).resolves.toEqual(closed);
    await expect(readCurrentOrchestratorCheckpoint(projectRoot)).resolves.toEqual(closed);
  });

  it("rolls successor current back when predecessor history changes at post-write verification", async () => {
    const projectRoot = await tempRoot();
    const initial = checkpoint();
    await startOrchestratorEpoch(projectRoot, initial);
    const closed = closeCheckpoint(initial, { successorEpochId: "epoch-2" });
    await closeOrchestratorEpoch(projectRoot, closed, initial.checkpoint_id);

    const currentPath = getCurrentOrchestratorCheckpointPath(projectRoot);
    const historyPath = getHistoricalOrchestratorHandoffPath(projectRoot, closed.epoch.epoch_id);
    const originalClosedBytes = await readFile(currentPath, "utf8");
    const tamperedHistory = structuredClone(closed);
    tamperedHistory.canonical_decisions.push("Changed after successor semantic validation.");
    const tamperedHistoryBytes = serializeOrchestratorCheckpoint(tamperedHistory);
    const successor = checkpoint({
      checkpointId: "successor-1",
      epochId: "epoch-2",
      platform: "other-host",
      controllerId: "controller-2",
      predecessorEpochId: "epoch-1",
      startedAt: "2026-09-16T20:06:00.000Z",
      createdAt: "2026-09-16T20:06:30.000Z",
    });

    let historyReadCount = 0;
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual("node:fs/promises");
      return {
        ...actual,
        readFile: async (...args) => {
          const targetPath = String(args[0]);
          if (path.resolve(targetPath) === path.resolve(historyPath)) {
            historyReadCount += 1;
            if (historyReadCount === 3) {
              await actual.writeFile(historyPath, tamperedHistoryBytes, "utf8");
            }
          }
          return actual.readFile(...args);
        },
      };
    });

    try {
      const sourceApi = await import("../src/orchestrator-checkpoint-api.ts");
      await expect(sourceApi.startOrchestratorEpoch(projectRoot, successor)).rejects.toThrow(/precondition failed/);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }

    expect(historyReadCount).toBe(3);
    expect(await readFile(currentPath, "utf8")).toBe(originalClosedBytes);
    await expect(readCurrentOrchestratorCheckpoint(projectRoot)).resolves.toEqual(closed);
    expect(await readFile(historyPath, "utf8")).toBe(tamperedHistoryBytes);
  });
});
