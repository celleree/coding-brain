import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "cli.js");

import {
  applyRoutingFeedback as applyRoutingFeedbackRecord,
  initBrain,
  loadAllPreferences,
  loadStoredPreferenceRecords,
  parseRoutingFeedbackStdin,
  savePreference as savePreferenceRecord,
  shouldProcessRoutingFeedbackEvent,
} from "../dist/store-api.js";

function applyRoutingFeedback(projectRoot, events, provenance) {
  const sourceBytes = Buffer.from(events.map((event) => event.notes ?? event.type).join("\n"), "utf8");
  return applyRoutingFeedbackRecord(projectRoot, events, provenance ?? { sourceBytes });
}

function savePreference(preference, projectRoot, provenance) {
  return savePreferenceRecord(
    preference,
    projectRoot,
    provenance ?? { sourceBytes: Buffer.from(preference.reason, "utf8") },
  );
}

await runTest("parseRoutingFeedbackStdin accepts JSON array and NDJSON", () => {
  const a = parseRoutingFeedbackStdin(
    `[{"type":"skill_ignored","skill":"jest","notes":"plan asked for jest but agent used mocha"}]`,
  );
  assert.equal(a.length, 1);
  assert.equal(a[0].type, "skill_ignored");

  const b = parseRoutingFeedbackStdin(
    '{"type":"skill_followed","skill":"vitest","notes":"matched task-known routing"}\n{"type":"workflow_failure","workflow":"release","notes":"signing step failed"}',
  );
  assert.equal(b.length, 2);
});

await runTest("negative user feedback creates avoid preference candidate", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-rf-neg-"));
  try {
    await initBrain(tmpDir);
    const result = await applyRoutingFeedback(tmpDir, [
      {
        type: "skill_rejected_by_user",
        skill: "heavy-skill",
        notes: "用户明确说不要用这个 skill，这次体验很差",
      },
    ]);
    assert.ok(result.applied.some((x) => x.kind === "preference_candidate_saved"));
    const prefs = await loadAllPreferences(tmpDir);
    const cand = prefs.find((p) => p.target === "heavy-skill" && p.status === "candidate");
    assert.ok(cand);
    assert.equal(cand.preference, "avoid");
    assert.equal(cand.source, "routing_feedback");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("positive feedback bumps prefer confidence when safe", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-rf-pos-"));
  try {
    await initBrain(tmpDir);
    const now = new Date().toISOString();
    await savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "jest",
        preference: "prefer",
        reason: "unit tests",
        confidence: 0.7,
        source: "manual",
        created_at: now,
        updated_at: now,
        status: "active",
      },
      tmpDir,
    );

    const result = await applyRoutingFeedback(tmpDir, [
      {
        type: "skill_followed",
        skill: "jest",
        notes: "task completed and user confirmed routing was good",
        signal_strength: 1,
      },
    ]);
    assert.ok(result.applied.some((x) => x.kind === "preference_confidence_bumped"));
    const records = await loadStoredPreferenceRecords(tmpDir);
    const j = records.find((r) => r.preference.target === "jest" && r.preference.status === "active");
    const old = records.find((r) => r.preference.target === "jest" && r.preference.status === "superseded");
    assert.ok(j);
    assert.ok((j.preference.confidence ?? 0) > 0.7);
    assert.ok(old);
    assert.notEqual(j.preference.source_episode, old.preference.source_episode);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("skill_ignored queues routing feedback reminder in reinforce-pending", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-rf-ign-"));
  try {
    await initBrain(tmpDir);
    await applyRoutingFeedback(tmpDir, [
      {
        type: "skill_ignored",
        skill: "eslint",
        invocation_plan_id: "plan-2026-01",
        notes: "Agent did not run eslint despite invocation_plan recommending it",
      },
    ]);
    const raw = await readFile(path.join(tmpDir, ".brain", "reinforce-pending.json"), "utf8");
    const state = JSON.parse(raw);
    assert.ok(Array.isArray(state.routing_feedback_reminders));
    assert.ok(state.routing_feedback_reminders.length >= 1);
    assert.equal(state.routing_feedback_reminders[0].event_type, "skill_ignored");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("casual chat-like feedback is skipped", async () => {
  const ev = { type: "skill_followed", notes: "ok" };
  const gate = shouldProcessRoutingFeedbackEvent(ev);
  assert.equal(gate.ok, false);

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-rf-chat-"));
  try {
    await initBrain(tmpDir);
    const result = await applyRoutingFeedback(tmpDir, [
      {
        type: "skill_followed",
        notes: "ok cool",
        signal_strength: 1,
      },
    ]);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.applied.length, 0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("CLI routing-feedback applies stdin JSON", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-rf-cli-"));
  try {
    await initBrain(tmpDir);
    const payload = JSON.stringify([
      {
        type: "workflow_too_heavy",
        workflow: "full-verify",
        notes: "这个流程太繁琐，下次别这样搞全量验证",
      },
    ]);
    const result = await runCliProcess(["routing-feedback", "--json"], tmpDir, {}, payload);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed.applied));
    assert.ok(parsed.applied.length >= 1);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

console.log("All routing-feedback tests passed.");

function runCliProcess(args, cwd, extraEnv = {}, stdinText = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: [stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    if (stdinText !== undefined) {
      child.stdin.write(stdinText);
      child.stdin.end();
    }

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function runTest(name, callback) {
  it(name, callback);
}

const assert = {
  equal(actual, expected, message) {
    expect(actual, message).toBe(expected);
  },
  strictEqual(actual, expected, message) {
    expect(actual, message).toBe(expected);
  },
  notEqual(actual, expected, message) {
    expect(actual, message).not.toBe(expected);
  },
  deepEqual(actual, expected, message) {
    expect(actual, message).toEqual(expected);
  },
  notDeepEqual(actual, expected, message) {
    expect(actual, message).not.toEqual(expected);
  },
  ok(value, message) {
    expect(value, message).toBeTruthy();
  },
  match(value, pattern, message) {
    expect(value, message).toMatch(pattern);
  },
  doesNotMatch(value, pattern, message) {
    expect(value, message).not.toMatch(pattern);
  },
  throws(action, matcher, message) {
    if (matcher === undefined) {
      expect(action, message).toThrow();
      return;
    }
    expect(action, message).toThrow(matcher);
  },
  async rejects(action, matcher, message) {
    let failure;
    try {
      await action();
    } catch (error) {
      failure = error;
    }
    expect(failure, message ?? "expected promise to reject").toBeTruthy();
    if (typeof matcher === "function") {
      const handled = matcher(failure);
      expect(handled, message ?? "reject matcher should confirm the error").toBe(true);
      return;
    }
    if (matcher instanceof RegExp) {
      expect(failure.message, message).toMatch(matcher);
      return;
    }
    if (matcher && typeof matcher === "object") {
      expect(failure, message).toMatchObject(matcher);
    }
  },
  fail(message) {
    throw new Error(message ?? "assert.fail was called");
  },
};
