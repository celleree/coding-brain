import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fsReadHooks = vi.hoisted(() => ({ targetPath: null, afterReadFile: null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: (...args) => {
      const hook = fsReadHooks.afterReadFile;
      if (hook === null || String(args[0]) !== fsReadHooks.targetPath) {
        return actual.readFile(...args);
      }
      return actual.readFile(...args).then(async (result) => {
        const activeHook = fsReadHooks.afterReadFile;
        if (activeHook !== null && String(args[0]) === fsReadHooks.targetPath) {
          await activeHook();
        }
        return result;
      });
    },
  };
});

import {
  ORCHESTRATOR_RUNTIME_HEALTH_CONTRACT_VERSION,
  ORCHESTRATOR_RUNTIME_HEALTH_KIND,
  MEANINGFUL_ORCHESTRATION_CYCLE_DEFINITION,
  closeOrchestratorEpoch,
  evaluateOrchestratorRotation,
  getOrchestratorRuntimeHealthPath,
  mutateOrchestratorRuntimeHealth,
  readOrchestratorRuntimeHealth,
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
  epochId = "epoch-1",
  predecessorEpochId,
  successorEpochId,
  closedAt,
  phaseAtClose,
  signalValues = signals(),
  controllerId = "controller-1",
  platform = "chatgpt",
} = {}) {
  const controller = { platform, controller_id: controllerId, surface: "worker" };
  return {
    contract_version: VERSION,
    kind: CHECKPOINT_KIND,
    checkpoint_id: checkpointId,
    created_at: "2026-09-18T02:00:00.000Z",
    epoch: {
      contract_version: VERSION,
      epoch_id: epochId,
      controller: { ...controller },
      ...(predecessorEpochId ? { predecessor_epoch_id: predecessorEpochId } : {}),
      ...(successorEpochId ? { successor_epoch_id: successorEpochId } : {}),
      started_at: "2026-09-18T01:30:00.000Z",
      ...(closedAt ? { closed_at: closedAt } : {}),
      phase_at_start: { phase: "C", sub_phase: "C1" },
      ...(phaseAtClose ? { phase_at_close: phaseAtClose } : {}),
    },
    status: {
      contract_version: VERSION,
      epoch_id: epochId,
      controller: { ...controller },
      signals: structuredClone(signalValues),
      rotation_state: "CONTINUE",
      evaluated_at: "2026-09-18T02:00:00.000Z",
    },
    canonical_decisions: [],
    active_workstreams: ["C1"],
    blocked_work: [],
    dependencies: ["A1", "A2", "B1", "B2"],
    unresolved_decisions: [],
    risks_conflicts: [],
    next_recommended_actions: [],
    parallel_safe_work: [],
  };
}

function nextCheckpoint(current, checkpointId, signalValues = current.status.signals) {
  const next = structuredClone(current);
  next.checkpoint_id = checkpointId;
  next.created_at = "2026-09-18T02:01:00.000Z";
  next.status.evaluated_at = next.created_at;
  next.status.signals = structuredClone(signalValues);
  return next;
}

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), "repobrain-runtime-health-"));
}

async function startActive(projectRoot, overrides = {}) {
  const active = checkpoint(overrides);
  await startOrchestratorEpoch(projectRoot, active);
  return active;
}

describe("orchestrator C1 runtime health", () => {
  it("uses .brain/runtime and missing runtime state starts from active checkpoint signals without mutating on read", async () => {
    const projectRoot = await tempRoot();
    const active = await startActive(projectRoot);
    const runtimePath = getOrchestratorRuntimeHealthPath(projectRoot);

    expect(runtimePath).toBe(path.join(projectRoot, ".brain", "runtime", "orchestrator-health.json"));
    const health = await readOrchestratorRuntimeHealth(projectRoot);
    expect(health).toEqual({
      contract_version: ORCHESTRATOR_RUNTIME_HEALTH_CONTRACT_VERSION,
      kind: ORCHESTRATOR_RUNTIME_HEALTH_KIND,
      epoch_id: active.epoch.epoch_id,
      base_checkpoint_id: active.checkpoint_id,
      signals: active.status.signals,
    });
    await expect(stat(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });

    const again = await readOrchestratorRuntimeHealth(projectRoot);
    expect(again.signals.meaningful_cycle_count).toBe(active.status.signals.meaningful_cycle_count);
  });

  it("rebases stale base_checkpoint_id to current durable signals", async () => {
    const projectRoot = await tempRoot();
    const initial = await startActive(projectRoot);
    await mutateOrchestratorRuntimeHealth(projectRoot, {
      type: "MEANINGFUL_CYCLE_COMPLETED",
      cycle_kind: "WORK_DISPATCH",
    });

    const durableSignals = signals({ meaningful_cycle_count: 9, stale_state_correction_count: 1 });
    const updated = nextCheckpoint(initial, "checkpoint-2", durableSignals);
    await writeOrchestratorCheckpoint(projectRoot, updated, initial.checkpoint_id);

    const rebased = await readOrchestratorRuntimeHealth(projectRoot);
    expect(rebased.base_checkpoint_id).toBe("checkpoint-2");
    expect(rebased.signals).toEqual(durableSignals);

    await mutateOrchestratorRuntimeHealth(projectRoot, { type: "FORCED_ROTATION" });
    const persisted = JSON.parse(await readFile(getOrchestratorRuntimeHealthPath(projectRoot), "utf8"));
    expect(persisted.base_checkpoint_id).toBe("checkpoint-2");
    expect(persisted.signals.meaningful_cycle_count).toBe(9);
    expect(persisted.signals.forced_rotation).toBe(true);
  });

  it("rejects a runtime mutation if durable current advances after the binding read", async () => {
    const projectRoot = await tempRoot();
    const initial = await startActive(projectRoot);
    const runtimePath = getOrchestratorRuntimeHealthPath(projectRoot);
    const currentPath = path.join(projectRoot, ".brain", "orchestration", "current.json");
    const durableSignals = signals({ meaningful_cycle_count: 9, stale_state_correction_count: 1 });
    const updated = nextCheckpoint(initial, "checkpoint-2", durableSignals);

    fsReadHooks.targetPath = currentPath;
    fsReadHooks.afterReadFile = async () => {
      fsReadHooks.targetPath = null;
      fsReadHooks.afterReadFile = null;
      await writeOrchestratorCheckpoint(projectRoot, updated, initial.checkpoint_id);
    };

    try {
      await expect(mutateOrchestratorRuntimeHealth(projectRoot, { type: "FORCED_ROTATION" })).rejects.toThrow(
        /Atomic write precondition failed because .*current\.json.*changed/,
      );
    } finally {
      fsReadHooks.targetPath = null;
      fsReadHooks.afterReadFile = null;
    }

    await expect(stat(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });
    const rebased = await readOrchestratorRuntimeHealth(projectRoot);
    expect(rebased.base_checkpoint_id).toBe("checkpoint-2");
    expect(rebased.signals).toEqual(durableSignals);

    const retried = await mutateOrchestratorRuntimeHealth(projectRoot, { type: "FORCED_ROTATION" });
    expect(retried.base_checkpoint_id).toBe("checkpoint-2");
    expect(retried.signals.forced_rotation).toBe(true);

    const persisted = JSON.parse(await readFile(runtimePath, "utf8"));
    expect(persisted.base_checkpoint_id).toBe("checkpoint-2");
    expect(persisted.signals.forced_rotation).toBe(true);
  });

  it("does not leak predecessor runtime signals into a successor epoch", async () => {
    const projectRoot = await tempRoot();
    const initial = await startActive(projectRoot);
    await mutateOrchestratorRuntimeHealth(projectRoot, {
      type: "MEANINGFUL_CYCLE_COMPLETED",
      cycle_kind: "ROADMAP_ADVANCE",
    });
    await mutateOrchestratorRuntimeHealth(projectRoot, { type: "FORCED_ROTATION" });

    const closed = nextCheckpoint(initial, "checkpoint-closed");
    closed.epoch.closed_at = "2026-09-18T02:05:00.000Z";
    closed.epoch.phase_at_close = { phase: "C", sub_phase: "C1" };
    closed.epoch.successor_epoch_id = "epoch-2";
    await closeOrchestratorEpoch(projectRoot, closed, initial.checkpoint_id);

    const successorSignals = signals({ meaningful_cycle_count: 0 });
    const successor = checkpoint({
      checkpointId: "checkpoint-successor",
      epochId: "epoch-2",
      predecessorEpochId: "epoch-1",
      controllerId: "controller-2",
      signalValues: successorSignals,
    });
    successor.epoch.started_at = "2026-09-18T02:06:00.000Z";
    successor.created_at = "2026-09-18T02:06:30.000Z";
    successor.status.evaluated_at = successor.created_at;
    await startOrchestratorEpoch(projectRoot, successor);

    const health = await readOrchestratorRuntimeHealth(projectRoot);
    expect(health.epoch_id).toBe("epoch-2");
    expect(health.base_checkpoint_id).toBe("checkpoint-successor");
    expect(health.signals).toEqual(successorSignals);
  });

  it("fails closed for malformed runtime state bound to the active epoch", async () => {
    const projectRoot = await tempRoot();
    const active = await startActive(projectRoot);
    await mutateOrchestratorRuntimeHealth(projectRoot, { type: "FORCED_ROTATION" });

    const malformed = {
      contract_version: ORCHESTRATOR_RUNTIME_HEALTH_CONTRACT_VERSION,
      kind: ORCHESTRATOR_RUNTIME_HEALTH_KIND,
      epoch_id: active.epoch.epoch_id,
      base_checkpoint_id: active.checkpoint_id,
      signals: { ...signals(), meaningful_cycle_count: -1 },
    };
    await writeFile(getOrchestratorRuntimeHealthPath(projectRoot), JSON.stringify(malformed), "utf8");

    await expect(readOrchestratorRuntimeHealth(projectRoot)).rejects.toThrow(/meaningful_cycle_count/);
    await expect(mutateOrchestratorRuntimeHealth(projectRoot, { type: "FORCED_ROTATION" })).rejects.toThrow(
      /meaningful_cycle_count/,
    );
  });

  it("only explicit valid meaningful-cycle mutations increment the cycle counter", async () => {
    const projectRoot = await tempRoot();
    await startActive(projectRoot);

    expect(MEANINGFUL_ORCHESTRATION_CYCLE_DEFINITION).toMatch(/materially advances or re-evaluates project execution/);

    await mutateOrchestratorRuntimeHealth(projectRoot, { type: "ARCHITECTURE_OR_DEPENDENCY_CHANGE" });
    await mutateOrchestratorRuntimeHealth(projectRoot, { type: "PHASE_BOUNDARY_SIGNAL", phase_boundary: "IMMINENT" });
    await mutateOrchestratorRuntimeHealth(projectRoot, {
      type: "HOST_CONTEXT_PRESSURE_SET",
      pressure: { source: "chatgpt", reported_at: "2026-09-18T02:02:00.000Z", level: "HIGH" },
    });
    await mutateOrchestratorRuntimeHealth(projectRoot, { type: "FORCED_ROTATION" });
    expect((await readOrchestratorRuntimeHealth(projectRoot)).signals.meaningful_cycle_count).toBe(3);

    await expect(
      mutateOrchestratorRuntimeHealth(projectRoot, {
        type: "MEANINGFUL_CYCLE_COMPLETED",
        cycle_kind: "ACKNOWLEDGEMENT",
      }),
    ).rejects.toThrow(/cycle_kind/);
    expect((await readOrchestratorRuntimeHealth(projectRoot)).signals.meaningful_cycle_count).toBe(3);

    await mutateOrchestratorRuntimeHealth(projectRoot, {
      type: "MEANINGFUL_CYCLE_COMPLETED",
      cycle_kind: "RESULT_RECONCILIATION",
    });
    expect((await readOrchestratorRuntimeHealth(projectRoot)).signals.meaningful_cycle_count).toBe(4);
  });

  it("stale correction increments only its intended counter", async () => {
    const projectRoot = await tempRoot();
    await startActive(projectRoot);
    const before = (await readOrchestratorRuntimeHealth(projectRoot)).signals;

    const health = await mutateOrchestratorRuntimeHealth(projectRoot, { type: "STALE_STATE_CORRECTION" });
    expect(health.signals).toEqual({
      ...before,
      stale_state_correction_count: before.stale_state_correction_count + 1,
    });
  });

  it("round-trips architecture, phase, optional host pressure, and forced-rotation signals", async () => {
    const projectRoot = await tempRoot();
    await startActive(projectRoot, { signalValues: signals() });
    expect((await readOrchestratorRuntimeHealth(projectRoot)).signals.host_context_pressure).toBeUndefined();

    await mutateOrchestratorRuntimeHealth(projectRoot, { type: "ARCHITECTURE_OR_DEPENDENCY_CHANGE" });
    await mutateOrchestratorRuntimeHealth(projectRoot, { type: "PHASE_BOUNDARY_SIGNAL", phase_boundary: "COMPLETED" });
    await mutateOrchestratorRuntimeHealth(projectRoot, {
      type: "HOST_CONTEXT_PRESSURE_SET",
      pressure: {
        source: "chatgpt",
        reported_at: "2026-09-18T02:02:00.000Z",
        level: "CRITICAL",
        utilization_ratio: 0.97,
        remaining_tokens: 1500,
      },
    });
    await mutateOrchestratorRuntimeHealth(projectRoot, { type: "FORCED_ROTATION" });

    let health = await readOrchestratorRuntimeHealth(projectRoot);
    expect(health.signals.architecture_or_dependency_changed).toBe(true);
    expect(health.signals.phase_boundary).toBe("COMPLETED");
    expect(health.signals.host_context_pressure).toEqual({
      source: "chatgpt",
      reported_at: "2026-09-18T02:02:00.000Z",
      level: "CRITICAL",
      utilization_ratio: 0.97,
      remaining_tokens: 1500,
    });
    expect(health.signals.forced_rotation).toBe(true);

    health = await mutateOrchestratorRuntimeHealth(projectRoot, { type: "HOST_CONTEXT_PRESSURE_CLEAR" });
    expect(health.signals.host_context_pressure).toBeUndefined();
  });

  it("never silently loses a concurrent increment", async () => {
    const projectRoot = await tempRoot();
    await startActive(projectRoot);
    await mutateOrchestratorRuntimeHealth(projectRoot, {
      type: "MEANINGFUL_CYCLE_COMPLETED",
      cycle_kind: "WORK_DISPATCH",
    });

    const results = await Promise.allSettled([
      mutateOrchestratorRuntimeHealth(projectRoot, {
        type: "MEANINGFUL_CYCLE_COMPLETED",
        cycle_kind: "VERIFICATION_GATE",
      }),
      mutateOrchestratorRuntimeHealth(projectRoot, {
        type: "MEANINGFUL_CYCLE_COMPLETED",
        cycle_kind: "REPLAN",
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled").length;
    const finalHealth = await readOrchestratorRuntimeHealth(projectRoot);

    expect(fulfilled).toBe(2);
    expect(finalHealth.signals.meaningful_cycle_count).toBe(6);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);
  });

  it("feeds stored signals directly into the existing A2 evaluator without persisting a rotation result", async () => {
    const projectRoot = await tempRoot();
    await startActive(projectRoot);
    await mutateOrchestratorRuntimeHealth(projectRoot, { type: "FORCED_ROTATION" });

    const health = await readOrchestratorRuntimeHealth(projectRoot);
    const evaluation = evaluateOrchestratorRotation(health.signals);
    expect(evaluation.rotation_state).toBe("ROTATE_NOW");
    expect(evaluation.reasons.map((reason) => reason.code)).toContain("FORCED_ROTATION");

    const persisted = JSON.parse(await readFile(getOrchestratorRuntimeHealthPath(projectRoot), "utf8"));
    expect(persisted.rotation_state).toBeUndefined();
    expect(persisted.reasons).toBeUndefined();
    expect(Object.keys(persisted)).toEqual(["contract_version", "kind", "epoch_id", "base_checkpoint_id", "signals"]);
  });

  it("requires an active/open durable epoch", async () => {
    const projectRoot = await tempRoot();
    await expect(readOrchestratorRuntimeHealth(projectRoot)).rejects.toThrow(/no current durable/);

    const initial = await startActive(projectRoot);
    const closed = nextCheckpoint(initial, "checkpoint-closed");
    closed.epoch.closed_at = "2026-09-18T02:05:00.000Z";
    closed.epoch.phase_at_close = { phase: "C", sub_phase: "C1" };
    await closeOrchestratorEpoch(projectRoot, closed, initial.checkpoint_id);

    await expect(readOrchestratorRuntimeHealth(projectRoot)).rejects.toThrow(/active\/open epoch/);
  });
});
