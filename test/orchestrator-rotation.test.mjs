import { describe, expect, it } from "vitest";

import { DEFAULT_ORCHESTRATOR_ROTATION_POLICY, evaluateOrchestratorRotation } from "../dist/index.js";

function baseSignals(overrides = {}) {
  return {
    meaningful_cycle_count: 0,
    stale_state_correction_count: 0,
    architecture_or_dependency_changed: false,
    phase_boundary: "NONE",
    forced_rotation: false,
    ...overrides,
  };
}

function hostPressure(level) {
  return {
    source: "test-host",
    reported_at: "2026-09-16T20:00:00.000Z",
    ...(level ? { level } : {}),
    utilization_ratio: 0.99,
    remaining_tokens: 1,
  };
}

function reasonCodes(result) {
  return result.reasons.map((reason) => reason.code);
}

function expectReason(overrides, expectedState, expectedReason) {
  const result = evaluateOrchestratorRotation(baseSignals(overrides));
  expect(result.rotation_state).toBe(expectedState);
  expect(reasonCodes(result)).toContain(expectedReason);
}

describe("orchestrator rotation evaluator", () => {
  it("continues when no trigger applies", () => {
    expect(evaluateOrchestratorRotation(baseSignals())).toEqual({ rotation_state: "CONTINUE", reasons: [] });
  });

  it("rotates now when rotation is forced", () => {
    expectReason({ forced_rotation: true }, "ROTATE_NOW", "FORCED_ROTATION");
  });

  it("rotates now after an architecture or dependency change", () => {
    expectReason({ architecture_or_dependency_changed: true }, "ROTATE_NOW", "ARCHITECTURE_OR_DEPENDENCY_CHANGED");
  });

  it("rotates now at a completed phase boundary", () => {
    expectReason({ phase_boundary: "COMPLETED" }, "ROTATE_NOW", "PHASE_BOUNDARY_COMPLETED");
  });

  it("rotates now at the hard cycle ceiling", () => {
    expectReason({ meaningful_cycle_count: 16 }, "ROTATE_NOW", "HARD_CYCLE_CEILING_REACHED");
  });

  it("rotates now at the stale-state hard threshold", () => {
    expectReason({ stale_state_correction_count: 2 }, "ROTATE_NOW", "STALE_STATE_ROTATE_NOW_THRESHOLD_REACHED");
  });

  it("rotates now at critical host context pressure", () => {
    expectReason(
      { host_context_pressure: hostPressure("CRITICAL") },
      "ROTATE_NOW",
      "HOST_CONTEXT_PRESSURE_ROTATE_NOW_THRESHOLD_REACHED",
    );
  });

  it("rotates soon at an imminent phase boundary", () => {
    expectReason({ phase_boundary: "IMMINENT" }, "ROTATE_SOON", "PHASE_BOUNDARY_IMMINENT");
  });

  it("rotates soon at the soft cycle threshold", () => {
    expectReason({ meaningful_cycle_count: 12 }, "ROTATE_SOON", "SOFT_CYCLE_THRESHOLD_REACHED");
  });

  it("rotates soon at the stale-state soft threshold", () => {
    expectReason({ stale_state_correction_count: 1 }, "ROTATE_SOON", "STALE_STATE_ROTATE_SOON_THRESHOLD_REACHED");
  });

  it("rotates soon at high host context pressure", () => {
    expectReason(
      { host_context_pressure: hostPressure("HIGH") },
      "ROTATE_SOON",
      "HOST_CONTEXT_PRESSURE_ROTATE_SOON_THRESHOLD_REACHED",
    );
  });

  it("uses inclusive cycle and stale-correction thresholds", () => {
    expect(evaluateOrchestratorRotation(baseSignals({ meaningful_cycle_count: 12 })).rotation_state).toBe(
      "ROTATE_SOON",
    );
    expect(evaluateOrchestratorRotation(baseSignals({ meaningful_cycle_count: 16 })).rotation_state).toBe("ROTATE_NOW");
    expect(evaluateOrchestratorRotation(baseSignals({ stale_state_correction_count: 1 })).rotation_state).toBe(
      "ROTATE_SOON",
    );
    expect(evaluateOrchestratorRotation(baseSignals({ stale_state_correction_count: 2 })).rotation_state).toBe(
      "ROTATE_NOW",
    );
  });

  it("does not infer context pressure when pressure is absent", () => {
    expect(evaluateOrchestratorRotation(baseSignals()).rotation_state).toBe("CONTINUE");
  });

  it("does not infer pressure from utilization or token metadata", () => {
    const signals = baseSignals({ host_context_pressure: hostPressure() });
    expect(evaluateOrchestratorRotation(signals).rotation_state).toBe("CONTINUE");
  });

  it("lets custom policy thresholds change behavior", () => {
    const policy = {
      ...DEFAULT_ORCHESTRATOR_ROTATION_POLICY,
      soft_cycle_threshold: 2,
      hard_cycle_ceiling: 4,
      stale_state_correction_rotate_soon_threshold: 3,
      stale_state_correction_rotate_now_threshold: 5,
      rotate_soon_context_pressure: "MODERATE",
      rotate_now_context_pressure: "HIGH",
    };

    expect(evaluateOrchestratorRotation(baseSignals({ meaningful_cycle_count: 2 }), policy).rotation_state).toBe(
      "ROTATE_SOON",
    );
    const highPressure = baseSignals({ host_context_pressure: hostPressure("HIGH") });
    expect(evaluateOrchestratorRotation(highPressure, policy).rotation_state).toBe("ROTATE_NOW");
  });

  it("returns all applicable reasons deterministically and gives ROTATE_NOW precedence", () => {
    const result = evaluateOrchestratorRotation(
      baseSignals({
        meaningful_cycle_count: 16,
        stale_state_correction_count: 2,
        architecture_or_dependency_changed: true,
        phase_boundary: "COMPLETED",
        forced_rotation: true,
        host_context_pressure: hostPressure("CRITICAL"),
      }),
    );

    expect(result.rotation_state).toBe("ROTATE_NOW");
    expect(reasonCodes(result)).toEqual([
      "FORCED_ROTATION",
      "ARCHITECTURE_OR_DEPENDENCY_CHANGED",
      "PHASE_BOUNDARY_COMPLETED",
      "HARD_CYCLE_CEILING_REACHED",
      "STALE_STATE_ROTATE_NOW_THRESHOLD_REACHED",
      "HOST_CONTEXT_PRESSURE_ROTATE_NOW_THRESHOLD_REACHED",
      "SOFT_CYCLE_THRESHOLD_REACHED",
      "STALE_STATE_ROTATE_SOON_THRESHOLD_REACHED",
      "HOST_CONTEXT_PRESSURE_ROTATE_SOON_THRESHOLD_REACHED",
    ]);
  });

  it("rejects contradictory policy ordering deterministically", () => {
    const badCycleOrder = {
      ...DEFAULT_ORCHESTRATOR_ROTATION_POLICY,
      soft_cycle_threshold: 17,
      hard_cycle_ceiling: 16,
    };
    const badStaleOrder = {
      ...DEFAULT_ORCHESTRATOR_ROTATION_POLICY,
      stale_state_correction_rotate_soon_threshold: 3,
      stale_state_correction_rotate_now_threshold: 2,
    };
    const badContextOrder = {
      ...DEFAULT_ORCHESTRATOR_ROTATION_POLICY,
      rotate_soon_context_pressure: "CRITICAL",
      rotate_now_context_pressure: "HIGH",
    };

    expect(() => evaluateOrchestratorRotation(baseSignals(), badCycleOrder)).toThrow(
      /Invalid orchestrator rotation policy/,
    );
    expect(() => evaluateOrchestratorRotation(baseSignals(), badStaleOrder)).toThrow(
      /Invalid orchestrator rotation policy/,
    );
    expect(() => evaluateOrchestratorRotation(baseSignals(), badContextOrder)).toThrow(
      /Invalid orchestrator rotation policy/,
    );
  });

  it("does not mutate signal or policy inputs", () => {
    const signals = baseSignals({ host_context_pressure: hostPressure("HIGH") });
    const policy = { ...DEFAULT_ORCHESTRATOR_ROTATION_POLICY };
    const signalsBefore = structuredClone(signals);
    const policyBefore = structuredClone(policy);

    evaluateOrchestratorRotation(signals, policy);

    expect(signals).toEqual(signalsBefore);
    expect(policy).toEqual(policyBefore);
  });
});
