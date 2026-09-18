import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const checkpointReadHooks = vi.hoisted(() => ({ callCount: 0, afterCall: null }));

vi.mock("../dist/orchestrator-checkpoint-api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readCurrentOrchestratorCheckpoint: async (...args) => {
      const result = await actual.readCurrentOrchestratorCheckpoint(...args);
      checkpointReadHooks.callCount += 1;
      if (checkpointReadHooks.afterCall !== null) {
        await checkpointReadHooks.afterCall(checkpointReadHooks.callCount);
      }
      return result;
    },
  };
});

import {
  buildOrchestratorStatus,
  closeOrchestratorEpoch,
  getOrchestratorRuntimeHealthPath,
  mutateOrchestratorRuntimeHealth,
  renderOrchestratorStatus,
  renderOrchestratorStatusJson,
  startOrchestratorEpoch,
  writeOrchestratorCheckpoint,
} from "../dist/index.js";

const VERSION = "repobrain.orchestrator-lifecycle.v1";
const CHECKPOINT_KIND = "repobrain.orchestrator_checkpoint";

function signals(overrides = {}) {
  return {
    meaningful_cycle_count: 3,
    stale_state_correction_count: 0,
    architecture_or_dependency_changed: false,
    phase_boundary: "NONE",
    forced_rotation: false,
    ...overrides,
  };
}

function checkpoint({
  checkpointId = "checkpoint-1",
  signalValues = signals(),
  phaseAtStart = { phase: "C", sub_phase: "C2" },
} = {}) {
  const controller = { platform: "chatgpt", controller_id: "controller-1", surface: "orchestrator" };
  return {
    contract_version: VERSION,
    kind: CHECKPOINT_KIND,
    checkpoint_id: checkpointId,
    created_at: "2026-09-18T16:30:00.000Z",
    epoch: {
      contract_version: VERSION,
      epoch_id: "epoch-1",
      controller: { ...controller },
      started_at: "2026-09-18T16:00:00.000Z",
      ...(phaseAtStart ? { phase_at_start: phaseAtStart } : {}),
    },
    status: {
      contract_version: VERSION,
      epoch_id: "epoch-1",
      controller: { ...controller },
      signals: structuredClone(signalValues),
      rotation_state: "CONTINUE",
      evaluated_at: "2026-09-18T16:30:00.000Z",
    },
    canonical_decisions: [],
    active_workstreams: ["C2"],
    blocked_work: [],
    dependencies: ["C1", "A2"],
    unresolved_decisions: [],
    risks_conflicts: [],
    next_recommended_actions: [],
    parallel_safe_work: [],
  };
}

function nextCheckpoint(current, checkpointId, signalValues = current.status.signals) {
  const next = structuredClone(current);
  next.checkpoint_id = checkpointId;
  next.created_at = "2026-09-18T16:31:00.000Z";
  next.status.evaluated_at = next.created_at;
  next.status.signals = structuredClone(signalValues);
  return next;
}

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), "repobrain-orchestrator-status-"));
}

async function startActive(projectRoot, options = {}) {
  const active = checkpoint(options);
  await startOrchestratorEpoch(projectRoot, active);
  return active;
}

describe("orchestrator C2 status", () => {
  it("renders compact active epoch/controller/cycles/state and valid structured JSON", async () => {
    const projectRoot = await tempRoot();
    await startActive(projectRoot);

    const status = await buildOrchestratorStatus(projectRoot);
    const human = renderOrchestratorStatus(status);
    expect(human).toContain("EPOCH: epoch-1");
    expect(human).toContain("CONTROLLER: chatgpt / controller-1 / orchestrator");
    expect(human).toContain("PHASE AT START: C / C2");
    expect(human).toContain("CYCLES: 3");
    expect(human).toContain("STATE: CONTINUE");
    expect(human).toContain("TRIGGERS: none");

    const json = JSON.parse(renderOrchestratorStatusJson(status));
    expect(json).toMatchObject({
      epoch_id: "epoch-1",
      checkpoint_id: "checkpoint-1",
      controller: { platform: "chatgpt", controller_id: "controller-1" },
      signals: { meaningful_cycle_count: 3 },
      rotation_state: "CONTINUE",
      rotation_reasons: [],
    });
  });

  it("exposes exact A2 ROTATE_SOON triggers", async () => {
    const projectRoot = await tempRoot();
    await startActive(projectRoot, {
      signalValues: signals({ meaningful_cycle_count: 12, phase_boundary: "IMMINENT" }),
    });

    const status = await buildOrchestratorStatus(projectRoot);
    expect(status.rotation_state).toBe("ROTATE_SOON");
    expect(status.rotation_reasons.map((reason) => reason.code)).toEqual([
      "PHASE_BOUNDARY_IMMINENT",
      "SOFT_CYCLE_THRESHOLD_REACHED",
    ]);
  });

  it("exposes exact A2 ROTATE_NOW triggers and preserves simultaneous reasons", async () => {
    const projectRoot = await tempRoot();
    await startActive(projectRoot, {
      signalValues: signals({
        meaningful_cycle_count: 16,
        stale_state_correction_count: 2,
        architecture_or_dependency_changed: true,
        phase_boundary: "COMPLETED",
        forced_rotation: true,
      }),
    });

    const status = await buildOrchestratorStatus(projectRoot);
    expect(status.rotation_state).toBe("ROTATE_NOW");
    expect(status.rotation_reasons.map((reason) => reason.code)).toEqual([
      "FORCED_ROTATION",
      "ARCHITECTURE_OR_DEPENDENCY_CHANGED",
      "PHASE_BOUNDARY_COMPLETED",
      "HARD_CYCLE_CEILING_REACHED",
      "STALE_STATE_ROTATE_NOW_THRESHOLD_REACHED",
      "SOFT_CYCLE_THRESHOLD_REACHED",
      "STALE_STATE_ROTATE_SOON_THRESHOLD_REACHED",
    ]);
  });

  it("keeps absent host context and phase absent instead of guessing", async () => {
    const projectRoot = await tempRoot();
    await startActive(projectRoot, { phaseAtStart: undefined });

    const status = await buildOrchestratorStatus(projectRoot);
    expect(status.phase_at_start).toBeUndefined();
    expect(status.signals.host_context_pressure).toBeUndefined();
    const human = renderOrchestratorStatus(status);
    expect(human).not.toContain("PHASE AT START:");
    expect(human).not.toContain("HOST CONTEXT PRESSURE:");
  });

  it("is read-only and does not create or mutate runtime health", async () => {
    const projectRoot = await tempRoot();
    await startActive(projectRoot);
    const runtimePath = getOrchestratorRuntimeHealthPath(projectRoot);

    await buildOrchestratorStatus(projectRoot);
    await expect(stat(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });

    await mutateOrchestratorRuntimeHealth(projectRoot, {
      type: "MEANINGFUL_CYCLE_COMPLETED",
      cycle_kind: "VERIFICATION_GATE",
    });
    const before = await readFile(runtimePath, "utf8");
    const status = await buildOrchestratorStatus(projectRoot);
    const after = await readFile(runtimePath, "utf8");
    expect(status.signals.meaningful_cycle_count).toBe(4);
    expect(after).toBe(before);
  });

  it("fails closed when durable checkpoint changes during the status snapshot", async () => {
    const projectRoot = await tempRoot();
    const initial = await startActive(projectRoot);
    const updated = nextCheckpoint(initial, "checkpoint-2", signals({ meaningful_cycle_count: 9 }));

    checkpointReadHooks.callCount = 0;
    checkpointReadHooks.afterCall = async (callCount) => {
      if (callCount === 1) {
        checkpointReadHooks.afterCall = null;
        await writeOrchestratorCheckpoint(projectRoot, updated, initial.checkpoint_id);
      }
    };

    try {
      await expect(buildOrchestratorStatus(projectRoot)).rejects.toThrow(/snapshot changed.*retry/);
    } finally {
      checkpointReadHooks.callCount = 0;
      checkpointReadHooks.afterCall = null;
    }
  });

  it("fails for no durable current epoch, closed current epoch, and malformed bound runtime state", async () => {
    const emptyRoot = await tempRoot();
    await expect(buildOrchestratorStatus(emptyRoot)).rejects.toThrow(/no durable current epoch/);

    const closedRoot = await tempRoot();
    const initial = await startActive(closedRoot);
    const closed = nextCheckpoint(initial, "checkpoint-closed");
    closed.epoch.closed_at = "2026-09-18T16:40:00.000Z";
    closed.epoch.phase_at_close = { phase: "C", sub_phase: "C2" };
    await closeOrchestratorEpoch(closedRoot, closed, initial.checkpoint_id);
    await expect(buildOrchestratorStatus(closedRoot)).rejects.toThrow(/closed\/not active/);

    const malformedRoot = await tempRoot();
    const active = await startActive(malformedRoot);
    await mutateOrchestratorRuntimeHealth(malformedRoot, { type: "FORCED_ROTATION" });
    const malformed = JSON.parse(await readFile(getOrchestratorRuntimeHealthPath(malformedRoot), "utf8"));
    malformed.signals.meaningful_cycle_count = -1;
    await writeFile(getOrchestratorRuntimeHealthPath(malformedRoot), JSON.stringify(malformed), "utf8");
    await expect(buildOrchestratorStatus(malformedRoot)).rejects.toThrow(/meaningful_cycle_count/);
    expect(active.checkpoint_id).toBe("checkpoint-1");
  });
});
