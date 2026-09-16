import { describe, expect, it } from "vitest";

import {
  ORCHESTRATOR_CHECKPOINT_KIND,
  ORCHESTRATOR_CONTEXT_PRESSURE_LEVELS,
  ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION,
  ORCHESTRATOR_PHASE_BOUNDARY_SIGNALS,
  ORCHESTRATOR_REPOSITORY_OBSERVATION_STATE,
  ORCHESTRATOR_ROTATION_STATES,
} from "../dist/index.js";

describe("orchestrator lifecycle contracts", () => {
  it("publishes stable version and kind constants", () => {
    expect(ORCHESTRATOR_LIFECYCLE_CONTRACT_VERSION).toBe("repobrain.orchestrator-lifecycle.v1");
    expect(ORCHESTRATOR_CHECKPOINT_KIND).toBe("repobrain.orchestrator_checkpoint");
  });

  it("exposes only the allowed rotation states", () => {
    expect(ORCHESTRATOR_ROTATION_STATES).toEqual(["CONTINUE", "ROTATE_SOON", "ROTATE_NOW"]);
    expect(ORCHESTRATOR_PHASE_BOUNDARY_SIGNALS).toEqual(["NONE", "IMMINENT", "COMPLETED"]);
    expect(ORCHESTRATOR_CONTEXT_PRESSURE_LEVELS).toEqual(["LOW", "MODERATE", "HIGH", "CRITICAL"]);
  });

  it("does not require host context pressure when the host cannot report it", () => {
    const signals = {
      meaningful_cycle_count: 3,
      stale_state_correction_count: 0,
      architecture_or_dependency_changed: false,
      phase_boundary: "NONE",
      forced_rotation: false,
    };

    expect(signals).not.toHaveProperty("host_context_pressure");
  });

  it("marks repository observations as stale until they are reverified", () => {
    const observation = {
      verification_state: ORCHESTRATOR_REPOSITORY_OBSERVATION_STATE,
      observed_at: "2026-09-16T19:30:00.000Z",
      repository: "celleree/coding-brain",
      facts: [
        { kind: "branch", value: "main" },
        { kind: "sha", value: "ff01a5ee561f01ea99f386455844789243d46c9d" },
      ],
    };

    expect(observation.verification_state).toBe("LAST OBSERVED — REVERIFY BEFORE USE");
  });
});
