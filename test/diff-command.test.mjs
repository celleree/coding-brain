import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initBrain } from "../dist/store-api.js";
import { saveMemory } from "./provenance-fixtures.mjs";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "cli.js");

await runTest("brain diff shows empty sections for an empty repo", async () => {
  await withTempRepo(async (projectRoot) => {
    await initBrain(projectRoot);

    const result = await runCliProcess(["diff"], projectRoot);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /# Memory Diff/);
    assert.match(result.stdout, /## Added \(0\)/);
    assert.match(result.stdout, /## Modified \(0\)/);
    assert.match(result.stdout, /## Expired \(0\)/);
    assert.match(result.stdout, /## Promoted \(0\)/);
  });
});

await runTest("brain diff reports newly added memories in text output", async () => {
  await withTempRepo(async (projectRoot) => {
    await initBrain(projectRoot);
    const createdAt = new Date().toISOString();
    const createdDate = createdAt.slice(0, 10);

    await saveMemory(
      {
        type: "decision",
        title: "Keep routing decisions deterministic",
        summary: "New memory should show up in the added section.",
        detail: "## DECISION\n\nKeep routing deterministic for reproducible task handoffs.",
        tags: ["routing"],
        importance: "high",
        date: createdAt,
        score: 80,
        hit_count: 0,
        last_used: null,
        created_at: createdDate,
        updated: createdDate,
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    const result = await runCliProcess(["diff", "--since-days", "1"], projectRoot);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /## Added \(1\)/);
    assert.match(result.stdout, /Keep routing decisions deterministic/);
  });
});

await runTest("brain diff --since-days filters out older memories", async () => {
  await withTempRepo(async (projectRoot) => {
    await initBrain(projectRoot);

    await saveMemory(
      {
        type: "decision",
        title: "Old memory outside the window",
        summary: "This should not appear for a 2 day window.",
        detail: "## DECISION\n\nOld memory.",
        tags: ["old"],
        importance: "medium",
        date: isoDaysAgo(5),
        score: 50,
        hit_count: 0,
        last_used: null,
        created_at: dateOnlyDaysAgo(5),
        updated: dateOnlyDaysAgo(5),
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Recent memory inside the window",
        summary: "This should remain visible for a 2 day window.",
        detail: "## DECISION\n\nRecent memory.",
        tags: ["recent"],
        importance: "high",
        date: isoDaysAgo(1),
        score: 70,
        hit_count: 0,
        last_used: null,
        created_at: dateOnlyDaysAgo(1),
        updated: dateOnlyDaysAgo(1),
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    const result = await runCliProcess(["diff", "--since-days", "2"], projectRoot);

    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout, /Old memory outside the window/);
    assert.match(result.stdout, /Recent memory inside the window/);
  });
});

await runTest("brain diff --format json outputs structured JSON", async () => {
  await withTempRepo(async (projectRoot) => {
    await initBrain(projectRoot);

    await saveMemory(
      {
        type: "pattern",
        title: "Recent JSON diff memory",
        summary: "Should appear in added JSON results.",
        detail: "## PATTERN\n\nRecent JSON diff memory.",
        tags: ["json"],
        importance: "medium",
        date: isoDaysAgo(0),
        score: 60,
        hit_count: 0,
        last_used: null,
        created_at: dateOnlyDaysAgo(0),
        updated: dateOnlyDaysAgo(0),
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    const result = await runCliProcess(["diff", "--since-days", "2", "--format", "json"], projectRoot);

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(typeof parsed.since, "string");
    assert.equal(typeof parsed.until, "string");
    assert.equal(parsed.added.length, 1);
    assert.equal(parsed.added[0].memory.title, "Recent JSON diff memory");
    assert.deepEqual(parsed.modified, []);
    assert.deepEqual(parsed.expired, []);
    assert.deepEqual(parsed.promoted, []);
  });
});

await runTest("brain diff defaults to the last inject window from activity state", async () => {
  await withTempRepo(async (projectRoot) => {
    await initBrain(projectRoot);
    const brainDir = path.join(projectRoot, ".brain");
    const since = "2026-04-08T00:00:00.000Z";

    await writeFile(
      path.join(brainDir, "activity.json"),
      JSON.stringify(
        {
          lastInjectedAt: "2026-04-08",
          lastContextLoadedAt: since,
          lastContextSource: "inject",
          recentLoadedMemories: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    await saveMemory(
      {
        type: "decision",
        title: "Memory before last inject",
        summary: "Created before the default window and should stay hidden.",
        detail: "## DECISION\n\nBefore last inject.",
        tags: ["before"],
        importance: "medium",
        date: "2026-04-07T10:00:00.000Z",
        score: 50,
        hit_count: 0,
        last_used: null,
        created_at: "2026-04-07",
        updated: "2026-04-07",
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Memory after last inject",
        summary: "Created after the default window and should be visible.",
        detail: "## DECISION\n\nAfter last inject.",
        tags: ["after"],
        importance: "high",
        date: "2026-04-09T10:00:00.000Z",
        score: 90,
        hit_count: 0,
        last_used: null,
        created_at: "2026-04-09",
        updated: "2026-04-09",
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    const result = await runCliProcess(["diff"], projectRoot);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Window: 2026-04-08T00:00:00\.000Z/);
    assert.match(result.stdout, /Memory after last inject/);
    assert.doesNotMatch(result.stdout, /Memory before last inject/);
  });
});

console.log("All diff command tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-diff-"));

  try {
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function runCliProcess(args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
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

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout,
        stderr,
      });
    });
  });
}

function isoDaysAgo(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

function dateOnlyDaysAgo(days) {
  return isoDaysAgo(days).slice(0, 10);
}

function runTest(name, callback) {
  it(name, callback);
}

const assert = {
  equal(actual, expected, message) {
    expect(actual, message).toBe(expected);
  },
  deepEqual(actual, expected, message) {
    expect(actual, message).toEqual(expected);
  },
  match(value, pattern, message) {
    expect(value, message).toMatch(pattern);
  },
  doesNotMatch(value, pattern, message) {
    expect(value, message).not.toMatch(pattern);
  },
};
