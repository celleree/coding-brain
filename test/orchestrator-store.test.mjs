import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  commitAtomicWriteOperations,
  ensureOrchestratorStorageLayout,
  getCurrentOrchestratorCheckpointPath,
  getHistoricalOrchestratorHandoffPath,
  getOrchestratorHandoffsDir,
  getOrchestratorStorageDir,
  initBrain,
  parseOrchestratorCheckpointJson,
  prepareCurrentOrchestratorCheckpointWrite,
  prepareHistoricalOrchestratorHandoffWrite,
  serializeOrchestratorCheckpoint,
  validateOrchestratorCheckpoint,
} from "../dist/store-api.js";

const VERSION = "repobrain.orchestrator-lifecycle.v1";
const KIND = "repobrain.orchestrator_checkpoint";
const OBSERVATION_STATE = "LAST OBSERVED — REVERIFY BEFORE USE";

function checkpoint(overrides = {}) {
  const controller = { platform: "test-host", controller_id: "controller-1", surface: "test-surface" };
  const value = {
    contract_version: VERSION,
    kind: KIND,
    checkpoint_id: "checkpoint-1",
    created_at: "2026-09-16T20:00:00.000Z",
    epoch: {
      contract_version: VERSION,
      epoch_id: "epoch-1",
      controller: { ...controller },
      started_at: "2026-09-16T19:00:00.000Z",
      phase_at_start: { phase: "B", sub_phase: "B1" },
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
        host_context_pressure: {
          source: "host",
          reported_at: "2026-09-16T19:59:00.000Z",
          utilization_ratio: 0.7,
          remaining_tokens: 12000,
        },
        forced_rotation: false,
      },
      rotation_state: "CONTINUE",
      evaluated_at: "2026-09-16T20:00:00.000Z",
    },
    canonical_decisions: ["Keep B1 storage-only."],
    active_workstreams: ["Phase B1"],
    blocked_work: [],
    dependencies: ["A1", "A2"],
    unresolved_decisions: [],
    risks_conflicts: [],
    next_recommended_actions: ["Implement B2 later."],
    parallel_safe_work: [],
    last_observed_repository_state: {
      verification_state: OBSERVATION_STATE,
      observed_at: "2026-09-16T19:58:00.000Z",
      repository: "celleree/coding-brain",
      facts: [
        { kind: "branch", value: "main", label: "base branch" },
        { kind: "sha", value: "f510c135720069040bf1386b989ba41e378b9170" },
      ],
    },
  };
  return Object.assign(value, overrides);
}

function closedCheckpoint(overrides = {}) {
  const value = checkpoint(overrides);
  value.epoch.closed_at = "2026-09-16T20:05:00.000Z";
  value.epoch.phase_at_close = { phase: "B", sub_phase: "B1" };
  return value;
}

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), "repobrain-orchestrator-store-"));
}

async function expectDirectory(directory) {
  expect((await stat(directory)).isDirectory()).toBe(true);
}

describe("orchestrator durable storage foundation", () => {
  it("initializes durable orchestration directories outside runtime without ignoring them", async () => {
    const projectRoot = await tempRoot();
    await initBrain(projectRoot);

    await expectDirectory(getOrchestratorStorageDir(projectRoot));
    await expectDirectory(getOrchestratorHandoffsDir(projectRoot));
    await expectDirectory(path.join(projectRoot, ".brain", "runtime"));
    expect(path.relative(path.join(projectRoot, ".brain", "runtime"), getOrchestratorStorageDir(projectRoot))).toMatch(
      /^\.\./,
    );

    const gitignore = await readFile(path.join(projectRoot, ".brain", ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/).map((line) => line.trim())).toContain("runtime/");
    expect(gitignore).not.toMatch(/(^|\n)\s*orchestration\/?\s*($|\n)/);
  });

  it("can initialize the orchestration layout directly", async () => {
    const projectRoot = await tempRoot();
    await ensureOrchestratorStorageLayout(projectRoot);
    await expectDirectory(getOrchestratorStorageDir(projectRoot));
    await expectDirectory(getOrchestratorHandoffsDir(projectRoot));
  });

  it("serializes deterministically and parses a valid checkpoint round trip", () => {
    const original = checkpoint();
    const serialized = serializeOrchestratorCheckpoint(original);
    const parsed = parseOrchestratorCheckpointJson(serialized);

    expect(parsed).toEqual(original);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(Object.keys(JSON.parse(serialized))).toEqual([
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
    ]);
  });

  it("fails closed on malformed JSON with a deterministic error", () => {
    expect(() => parseOrchestratorCheckpointJson('{"kind":')).toThrow(
      "Orchestrator checkpoint JSON is not valid JSON.",
    );
  });

  it("rejects unsupported lifecycle versions and checkpoint kinds", () => {
    const wrongVersion = checkpoint({ contract_version: "repobrain.orchestrator-lifecycle.v2" });
    const wrongKind = checkpoint({ kind: "wrong" });
    expect(() => validateOrchestratorCheckpoint(wrongVersion)).toThrow(/checkpoint\.contract_version/);
    expect(() => validateOrchestratorCheckpoint(wrongKind)).toThrow(/checkpoint\.kind/);
  });

  it("rejects invalid rotation, phase-boundary, and explicit context-pressure enums", () => {
    const badRotation = checkpoint();
    badRotation.status.rotation_state = "LATER";
    expect(() => validateOrchestratorCheckpoint(badRotation)).toThrow(/rotation_state/);

    const badPhase = checkpoint();
    badPhase.status.signals.phase_boundary = "MAYBE";
    expect(() => validateOrchestratorCheckpoint(badPhase)).toThrow(/phase_boundary/);

    const badPressure = checkpoint();
    badPressure.status.signals.host_context_pressure.level = "EXTREME";
    expect(() => validateOrchestratorCheckpoint(badPressure)).toThrow(/host_context_pressure\.level/);
  });

  it("does not infer missing host context pressure level", () => {
    const value = checkpoint();
    expect(value.status.signals.host_context_pressure).not.toHaveProperty("level");
    expect(validateOrchestratorCheckpoint(value).status.signals.host_context_pressure).not.toHaveProperty("level");
  });

  it("rejects negative or fractional lifecycle counters", () => {
    const negative = checkpoint();
    negative.status.signals.meaningful_cycle_count = -1;
    expect(() => validateOrchestratorCheckpoint(negative)).toThrow(/meaningful_cycle_count/);

    const fractional = checkpoint();
    fractional.status.signals.stale_state_correction_count = 1.5;
    expect(() => validateOrchestratorCheckpoint(fractional)).toThrow(/stale_state_correction_count/);
  });

  it("rejects epoch/status identity contradictions", () => {
    const idMismatch = checkpoint();
    idMismatch.status.epoch_id = "other-epoch";
    expect(() => validateOrchestratorCheckpoint(idMismatch)).toThrow(/epoch\/status epoch_id/);

    const controllerMismatch = checkpoint();
    controllerMismatch.status.controller.controller_id = "other-controller";
    expect(() => validateOrchestratorCheckpoint(controllerMismatch)).toThrow(/controller identities/);
  });

  it("rejects epoch self-links", () => {
    const predecessor = checkpoint();
    predecessor.epoch.predecessor_epoch_id = predecessor.epoch.epoch_id;
    expect(() => validateOrchestratorCheckpoint(predecessor)).toThrow(/self-link/);

    const successor = checkpoint();
    successor.epoch.successor_epoch_id = successor.epoch.epoch_id;
    expect(() => validateOrchestratorCheckpoint(successor)).toThrow(/self-link/);
  });

  it("requires provider-neutral controller identities to be non-empty", () => {
    const value = checkpoint();
    value.epoch.controller.platform = "";
    expect(() => validateOrchestratorCheckpoint(value)).toThrow(/controller\.platform/);

    const providerNeutral = checkpoint();
    providerNeutral.epoch.controller.platform = "future-provider";
    providerNeutral.status.controller.platform = "future-provider";
    expect(validateOrchestratorCheckpoint(providerNeutral).epoch.controller.platform).toBe("future-provider");
  });

  it("rejects invalid repository observation markers and malformed facts", () => {
    const wrongMarker = checkpoint();
    wrongMarker.last_observed_repository_state.verification_state = "CURRENT";
    expect(() => validateOrchestratorCheckpoint(wrongMarker)).toThrow(/verification_state/);

    const wrongFactKind = checkpoint();
    wrongFactKind.last_observed_repository_state.facts[0].kind = "commit";
    expect(() => validateOrchestratorCheckpoint(wrongFactKind)).toThrow(/facts\[0\]\.kind/);

    const emptyFact = checkpoint();
    emptyFact.last_observed_repository_state.facts[0].value = "";
    expect(() => validateOrchestratorCheckpoint(emptyFact)).toThrow(/facts\[0\]\.value/);
  });

  it("preserves the exact repository re-verification marker through serialization", () => {
    const parsed = parseOrchestratorCheckpointJson(serializeOrchestratorCheckpoint(checkpoint()));
    expect(parsed.last_observed_repository_state.verification_state).toBe(OBSERVATION_STATE);
  });

  it("rejects historical handoff preparation for an active epoch", async () => {
    const projectRoot = await tempRoot();
    await initBrain(projectRoot);
    expect(() => prepareHistoricalOrchestratorHandoffWrite(projectRoot, checkpoint())).toThrow(/closed_at/);
  });

  it("requires an explicit current-write precondition", async () => {
    const projectRoot = await tempRoot();
    await initBrain(projectRoot);
    expect(() => prepareCurrentOrchestratorCheckpointWrite(projectRoot, checkpoint())).toThrow(
      /current-write precondition/,
    );
  });

  it("current create-only writes cannot replace an existing checkpoint", async () => {
    const projectRoot = await tempRoot();
    await initBrain(projectRoot);
    const first = checkpoint();
    const currentPath = getCurrentOrchestratorCheckpointPath(projectRoot);

    await commitAtomicWriteOperations([
      prepareCurrentOrchestratorCheckpointWrite(projectRoot, first, { kind: "create-only" }),
    ]);
    const originalBytes = await readFile(currentPath, "utf8");

    const replacement = checkpoint({ checkpoint_id: "checkpoint-2" });
    await expect(
      commitAtomicWriteOperations([
        prepareCurrentOrchestratorCheckpointWrite(projectRoot, replacement, { kind: "create-only" }),
      ]),
    ).rejects.toBeTruthy();
    expect(await readFile(currentPath, "utf8")).toBe(originalBytes);
  });

  it("current replacement fails if expected previous bytes do not match", async () => {
    const projectRoot = await tempRoot();
    await initBrain(projectRoot);
    const currentPath = getCurrentOrchestratorCheckpointPath(projectRoot);
    await commitAtomicWriteOperations([
      prepareCurrentOrchestratorCheckpointWrite(projectRoot, checkpoint(), { kind: "create-only" }),
    ]);
    const originalBytes = await readFile(currentPath, "utf8");

    await expect(
      commitAtomicWriteOperations([
        prepareCurrentOrchestratorCheckpointWrite(projectRoot, checkpoint({ checkpoint_id: "checkpoint-2" }), {
          kind: "replace",
          expectedContent: "wrong previous bytes",
        }),
      ]),
    ).rejects.toThrow(/precondition failed/);
    expect(await readFile(currentPath, "utf8")).toBe(originalBytes);
  });

  it("current replacement succeeds only against exact expected previous bytes", async () => {
    const projectRoot = await tempRoot();
    await initBrain(projectRoot);
    const currentPath = getCurrentOrchestratorCheckpointPath(projectRoot);
    await commitAtomicWriteOperations([
      prepareCurrentOrchestratorCheckpointWrite(projectRoot, checkpoint(), { kind: "create-only" }),
    ]);
    const originalBytes = await readFile(currentPath, "utf8");
    const replacement = checkpoint({ checkpoint_id: "checkpoint-2" });

    await commitAtomicWriteOperations([
      prepareCurrentOrchestratorCheckpointWrite(projectRoot, replacement, {
        kind: "replace",
        expectedContent: originalBytes,
      }),
    ]);
    expect(parseOrchestratorCheckpointJson(await readFile(currentPath, "utf8")).checkpoint_id).toBe("checkpoint-2");
  });

  it("historical handoff writes are create-only and duplicate writes preserve original bytes", async () => {
    const projectRoot = await tempRoot();
    await initBrain(projectRoot);
    const first = closedCheckpoint();
    const operation = prepareHistoricalOrchestratorHandoffWrite(projectRoot, first);
    expect(operation.targetMustNotExist).toBe(true);

    await commitAtomicWriteOperations([operation]);
    const historicalPath = getHistoricalOrchestratorHandoffPath(projectRoot, first.epoch.epoch_id);
    const originalBytes = await readFile(historicalPath, "utf8");

    const second = closedCheckpoint({ checkpoint_id: "checkpoint-2" });
    await expect(
      commitAtomicWriteOperations([prepareHistoricalOrchestratorHandoffWrite(projectRoot, second)]),
    ).rejects.toBeTruthy();
    expect(await readFile(historicalPath, "utf8")).toBe(originalBytes);
  });

  it("hostile epoch IDs cannot escape the handoff directory", async () => {
    const projectRoot = await tempRoot();
    const handoffsDir = getOrchestratorHandoffsDir(projectRoot);
    for (const epochId of ["../../outside", "..\\..\\outside", "/tmp/outside", "epoch/../../outside"]) {
      const target = getHistoricalOrchestratorHandoffPath(projectRoot, epochId);
      const relative = path.relative(handoffsDir, target);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(relative.startsWith(".." + path.sep)).toBe(false);
      expect(relative).not.toContain("/");
      expect(relative).not.toContain("\\");
      expect(path.extname(target)).toBe(".json");
    }
  });
});
