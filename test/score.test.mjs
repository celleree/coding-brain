import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initBrain, loadStoredMemoryRecords } from "../dist/store-api.js";
import { saveMemory } from "./provenance-fixtures.mjs";

const repoRoot = process.cwd();

await runTest("brain score reviews stale and low-quality memories interactively", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Old memory",
        summary: "Old last_used should trigger condition A.",
        detail: "## DECISION\n\nThis entry is old.",
        tags: ["score"],
        importance: "medium",
        date: "2026-01-01T08:00:00.000Z",
        score: 65,
        hit_count: 2,
        last_used: "2025-01-01",
        created_at: "2026-01-01",
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "gotcha",
        title: "Low score memory",
        summary: "Very low score should trigger condition B.",
        detail: "## GOTCHA\n\nThis entry is low quality.",
        tags: ["score"],
        importance: "low",
        date: "2026-01-02T08:00:00.000Z",
        score: 20,
        hit_count: 1,
        last_used: null,
        created_at: "2026-01-02",
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "convention",
        title: "Frequently used but fuzzy memory",
        summary: "High hit count with low score should trigger condition C.",
        detail: "## CONVENTION\n\nThis entry is too vague.",
        tags: ["score"],
        importance: "medium",
        date: "2026-01-03T08:00:00.000Z",
        score: 40,
        hit_count: 8,
        last_used: "2026-03-01",
        created_at: "2026-01-03",
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    const result = await runCliProcess(["score"], projectRoot, ["k", "d", "s"].join("\n"));

    assert.equal(result.code, 0);
    assert.match(result.stdout, /File\s+\|\s+Type\s+\|\s+Score\s+\|\s+Hit Count\s+\|\s+Last Used\s+\|\s+Trigger/);
    assert.match(result.stdout, /A:last_used>180d/);
    assert.match(result.stdout, /B:score<30/);
    assert.match(result.stdout, /C:high-hit-low-score/);
    assert.match(result.stdout, /Summary: marked=1, deleted=1, skipped=1/);
    assert.ok(
      result.stdout.indexOf("2026-01-03-frequently-used-but-fuzzy") <
        result.stdout.indexOf("2026-01-02-low-score-memory"),
      "expected condition C entries to rank ahead of condition B entries",
    );
    assert.ok(
      result.stdout.indexOf("2026-01-02-low-score-memory") < result.stdout.indexOf("2026-01-01-old-memory"),
      "expected condition B entries to rank ahead of condition A entries",
    );

    const records = await loadStoredMemoryRecords(projectRoot);
    assert.equal(records.length, 2);

    const oldMemory = records.find((entry) => entry.memory.title === "Old memory");
    const fuzzyMemory = records.find((entry) => entry.memory.title === "Frequently used but fuzzy memory");
    const deletedMemory = records.find((entry) => entry.memory.title === "Low score memory");

    assert.ok(oldMemory);
    assert.equal(oldMemory.memory.stale, true);
    assert.ok(fuzzyMemory);
    assert.equal(fuzzyMemory.memory.stale, false);
    assert.equal(deletedMemory, undefined);
  });
});

await runTest("brain score exits cleanly when nothing matches", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Healthy memory",
        summary: "This entry should not be flagged.",
        detail: "## DECISION\n\nThis entry remains healthy.",
        tags: ["score"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        score: 70,
        hit_count: 1,
        last_used: "2026-04-01",
        created_at: "2026-04-01",
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    const result = await runCliProcess(["score"], projectRoot);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No memories matched the current score review rules/);
  });
});

await runTest("brain score supports --mark-all for matched memories", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "gotcha",
        title: "Mark all candidate",
        summary: "This should be marked stale.",
        detail: "## GOTCHA\n\nThis entry should be marked stale.",
        tags: ["score"],
        importance: "low",
        date: "2026-01-02T08:00:00.000Z",
        score: 20,
        hit_count: 1,
        last_used: null,
        created_at: "2026-01-02",
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    const result = await runCliProcess(["score", "--mark-all"], projectRoot);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Summary: marked=1, deleted=0, skipped=0/);

    const records = await loadStoredMemoryRecords(projectRoot);
    assert.equal(records[0]?.memory.stale, true);
  });
});

await runTest("brain score supports --delete-all for matched memories", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "gotcha",
        title: "Delete all candidate",
        summary: "This should be deleted.",
        detail: "## GOTCHA\n\nThis entry should be deleted.",
        tags: ["score"],
        importance: "low",
        date: "2026-01-02T08:00:00.000Z",
        score: 20,
        hit_count: 1,
        last_used: null,
        created_at: "2026-01-02",
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    const result = await runCliProcess(["score", "--delete-all"], projectRoot);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Summary: marked=0, deleted=1, skipped=0/);

    const records = await loadStoredMemoryRecords(projectRoot);
    assert.equal(records.length, 0);
  });
});

await runTest("brain score supports --json without prompting", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "gotcha",
        title: "Json candidate",
        summary: "This should appear in JSON output.",
        detail: "## GOTCHA\n\nThis entry should appear in JSON output.",
        tags: ["score"],
        importance: "low",
        date: "2026-01-02T08:00:00.000Z",
        score: 20,
        hit_count: 1,
        last_used: null,
        created_at: "2026-01-02",
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    const result = await runCliProcess(["score", "--json"], projectRoot);
    assert.equal(result.code, 0);

    const parsed = JSON.parse(result.stdout);
    assert.equal(Array.isArray(parsed), true);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.type, "gotcha");
    assert.deepEqual(parsed[0]?.triggers, ["B:score<30"]);
  });
});

console.log("All score command tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-score-"));

  try {
    await initBrain(projectRoot);
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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

async function runCliProcess(args, cwd, stdinText = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "dist", "cli.js"), ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
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
      resolve({
        code,
        stdout,
        stderr,
      });
    });

    child.stdin.end(stdinText);
  });
}
