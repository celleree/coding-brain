import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { startOrchestratorEpoch } from "../dist/index.js";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "cli.js");
const VERSION = "repobrain.orchestrator-lifecycle.v1";
const CHECKPOINT_KIND = "repobrain.orchestrator_checkpoint";

function checkpoint() {
  const controller = {
    platform: "chatgpt",
    controller_id: "controller-1",
    surface: "orchestrator",
  };
  return {
    contract_version: VERSION,
    kind: CHECKPOINT_KIND,
    checkpoint_id: "checkpoint-1",
    created_at: "2026-09-18T16:30:00.000Z",
    epoch: {
      contract_version: VERSION,
      epoch_id: "epoch-1",
      controller: { ...controller },
      started_at: "2026-09-18T16:00:00.000Z",
      phase_at_start: { phase: "C", sub_phase: "C2" },
    },
    status: {
      contract_version: VERSION,
      epoch_id: "epoch-1",
      controller: { ...controller },
      signals: {
        meaningful_cycle_count: 3,
        stale_state_correction_count: 0,
        architecture_or_dependency_changed: false,
        phase_boundary: "NONE",
        forced_rotation: false,
      },
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

describe("brain orchestrator-status CLI", () => {
  it("--json exits successfully and emits structured JSON", async () => {
    await withActiveEpoch(async (projectRoot) => {
      const result = await runCliProcess(["orchestrator-status", "--json"], projectRoot);

      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({
        epoch_id: "epoch-1",
        checkpoint_id: "checkpoint-1",
        rotation_state: "CONTINUE",
      });
    });
  });

  it("plain command still emits human-readable output", async () => {
    await withActiveEpoch(async (projectRoot) => {
      const result = await runCliProcess(["orchestrator-status"], projectRoot);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("EPOCH: epoch-1");
      expect(result.stdout).toContain("CHECKPOINT: checkpoint-1");
      expect(result.stdout).toContain("STATE: CONTINUE");
    });
  });

  it("--format json emits valid JSON", async () => {
    await withActiveEpoch(async (projectRoot) => {
      const result = await runCliProcess(["orchestrator-status", "--format", "json"], projectRoot);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        epoch_id: "epoch-1",
        checkpoint_id: "checkpoint-1",
        rotation_state: "CONTINUE",
      });
    });
  });

  it("--format markdown emits human-readable output", async () => {
    await withActiveEpoch(async (projectRoot) => {
      const result = await runCliProcess(
        ["orchestrator-status", "--format", "markdown"],
        projectRoot,
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("EPOCH: epoch-1");
      expect(result.stdout).toContain("STATE: CONTINUE");
    });
  });

  it("explicit conflicting output options still fail", async () => {
    await withActiveEpoch(async (projectRoot) => {
      const result = await runCliProcess(
        ["orchestrator-status", "--json", "--format", "markdown"],
        projectRoot,
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        'Use either "--json" or "--format json", not both with different values.',
      );
    });
  });
});

async function withActiveEpoch(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-orchestrator-status-cli-"));

  try {
    await startOrchestratorEpoch(projectRoot, checkpoint());
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function runCliProcess(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
