import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeShadowReceipts, validateShadowReceipt } from "../scripts/laya-shadow.mjs";

// Synthetic schema fixtures only, never real-task measurements or holdout cases.
function fixture() {
  return {
    schema_version: "laya-shadow.v1",
    task_id: "synthetic-1",
    source: "new_operator_task",
    labeler_id: "operator-1",
    labels: {
      complexity: "normal",
      risk: "low",
      scope: "isolated",
      uncertainty: "low",
      prior_failures: "none",
      root_cause_required: "no",
      architecture_required: "no",
      sensitivity: "low",
    },
    existing_route: "Terra",
    shadow: {
      status: "proposed",
      proposed_route: "Terra",
      candidate_id: "synthetic-candidate",
      contract_commit: "a".repeat(40),
      latency_ms: null,
    },
    outcome: { status: "pending", rework_count: null, wall_time_ms: null, observed_usage: null, evidence_id: null },
  };
}
describe("offline shadow receipts", () => {
  it("CLI writes no files and emits no task identifiers or malformed-input content", () => {
    const directory = mkdtempSync(join(tmpdir(), "laya-shadow-"));
    const script = fileURLToPath(new URL("../scripts/laya-shadow.mjs", import.meta.url));
    try {
      const success = spawnSync(process.execPath, [script], {
        cwd: directory,
        input: JSON.stringify([fixture()]),
        encoding: "utf8",
      });
      expect(success.status).toBe(0);
      expect(JSON.parse(success.stdout).replacement_ready).toBe(false);
      expect(success.stdout).not.toContain("synthetic-1");
      expect(readdirSync(directory)).toEqual([]);
      const failure = spawnSync(process.execPath, [script], {
        cwd: directory,
        input: "private-malformed-content",
        encoding: "utf8",
      });
      expect(failure.status).toBe(1);
      expect(failure.stderr).toContain("valid JSON required");
      expect(failure.stderr).not.toContain("private-malformed-content");
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("preserves unknown measurements and cannot enable routing even with agreement", () => {
    const receipt = fixture();
    const before = JSON.stringify(receipt);
    const result = summarizeShadowReceipts([receipt]);
    expect(result).toMatchObject({
      global_routing_enabled: false,
      replacement_ready: false,
      route_agreements: 1,
      tasks_with_observed_usage: 0,
    });
    expect(JSON.stringify(receipt)).toBe(before);
    expect(summarizeShadowReceipts([]).route_comparisons).toBe(0);
  });
  it.each(["abstained", "timeout", "invalid", "unavailable"])(
    "records %s as fallback without inventing a route",
    (status) => {
      const receipt = fixture();
      receipt.shadow = { status, proposed_route: null, candidate_id: null, contract_commit: null, latency_ms: null };
      receipt.labels.risk = null;
      expect(summarizeShadowReceipts([receipt])).toMatchObject({ fallback_to_existing_route: 1, route_comparisons: 0 });
    },
  );
  it("counts disagreement separately and records measured outcomes with evidence", () => {
    const receipt = fixture();
    receipt.shadow.proposed_route = "Sol";
    receipt.outcome = {
      status: "completed",
      rework_count: 1,
      wall_time_ms: 123,
      observed_usage: { unit: "credits", value: 2, evidence_id: "usage-1" },
      evidence_id: "completion-1",
    };
    expect(summarizeShadowReceipts([receipt])).toMatchObject({
      route_agreements: 0,
      route_comparisons: 1,
      completed_existing_route_tasks: 1,
      tasks_with_observed_usage: 1,
    });
  });
  it("rejects duplicate tasks rather than inflating the sample", () => {
    expect(() => summarizeShadowReceipts([fixture(), fixture()])).toThrow("duplicate");
  });
  it.each([
    (r) => {
      r.raw_task = "do not accept task text";
    },
    (r) => {
      r.source = "challenge_v2";
    },
    (r) => {
      r.labels.risk = null;
    },
    (r) => {
      r.shadow.contract_commit = "draft";
    },
    (r) => {
      r.outcome.wall_time_ms = -1;
    },
    (r) => {
      r.outcome.rework_count = 0.5;
    },
    (r) => {
      r.outcome.status = "completed";
    },
    (r) => {
      r.labels.extra = "secret";
    },
  ])("rejects invalid or unsupported evidence", (mutate) => {
    const receipt = fixture();
    mutate(receipt);
    expect(() => validateShadowReceipt(receipt)).toThrow();
  });
});
