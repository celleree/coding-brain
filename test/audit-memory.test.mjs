import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildMemoryAudit, renderMemoryAuditResult } from "../dist/audit-memory.js";
import { initBrain } from "../dist/store-api.js";
import { saveMemory } from "./provenance-fixtures.mjs";

const AUDIT_NOW = "2026-04-02T00:00:00.000Z";

await runTest("audit-memory marks old candidate memories as stale", async () => {
  await withTempRepo(async (projectRoot) => {
    const filePath = await saveMemory(
      {
        type: "gotcha",
        title: "Temporary Redis migration workaround",
        summary: "Legacy Redis migration workaround kept as a candidate after the rollout.",
        detail:
          "## GOTCHA\n\nTemporary Redis migration workaround for the old cluster. Remove it once the rollout is confirmed.",
        tags: ["redis"],
        importance: "low",
        date: "2025-01-01T00:00:00.000Z",
        status: "candidate",
      },
      projectRoot,
    );

    const result = await buildMemoryAudit(projectRoot, { now: AUDIT_NOW });
    const staleIssue = result.issues.find((issue) => issue.issue_type === "stale");

    assert.ok(staleIssue);
    assert.equal(staleIssue.memory_id, path.basename(filePath, ".md"));
    assert.equal(staleIssue.suggested_action, "archive");
  });
});

await runTest("audit-memory marks conflicting same-scope decisions for review", async () => {
  await withTempRepo(async (projectRoot) => {
    const firstPath = await saveMemory(
      {
        type: "decision",
        title: "Auth boundary enforcement via wrapper",
        summary: "Always route auth writes through the permission wrapper.",
        detail:
          "## DECISION\n\nAlways route auth writes through the permission wrapper when touching src/auth/** so permission checks stay centralized.",
        tags: ["auth"],
        importance: "high",
        date: "2026-03-20T00:00:00.000Z",
        status: "active",
        path_scope: ["src/auth/**"],
      },
      projectRoot,
    );

    const secondPath = await saveMemory(
      {
        type: "decision",
        title: "Auth boundary enforcement without wrapper",
        summary: "Never route auth writes through the permission wrapper.",
        detail:
          "## DECISION\n\nNever route auth writes through the permission wrapper when touching src/auth/** because a direct path is now required.",
        tags: ["auth"],
        importance: "high",
        date: "2026-03-21T00:00:00.000Z",
        status: "active",
        path_scope: ["src/auth/**"],
      },
      projectRoot,
    );

    const result = await buildMemoryAudit(projectRoot, { now: AUDIT_NOW });
    const conflictIssues = result.issues.filter((issue) => issue.issue_type === "conflict");

    assert.equal(conflictIssues.length, 2);
    assert.deepEqual(
      conflictIssues.map((issue) => issue.memory_id).sort(),
      [path.basename(firstPath, ".md"), path.basename(secondPath, ".md")].sort(),
    );
    assert.ok(conflictIssues.every((issue) => issue.suggested_action === "review"));
  });
});

await runTest("audit-memory flags low-signal entries that are too thin to be durable knowledge", async () => {
  await withTempRepo(async (projectRoot) => {
    const filePath = await saveMemory(
      {
        type: "pattern",
        title: "Misc notes",
        summary: "Remember this later.",
        detail: "## PATTERN\n\nMisc update.",
        tags: [],
        importance: "low",
        date: "2026-03-30T00:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    const result = await buildMemoryAudit(projectRoot, { now: AUDIT_NOW });
    const lowSignalIssue = result.issues.find((issue) => issue.issue_type === "low_signal");

    assert.ok(lowSignalIssue);
    assert.equal(lowSignalIssue.memory_id, path.basename(filePath, ".md"));
    assert.equal(lowSignalIssue.suggested_action, "rewrite");
  });
});

await runTest("audit-memory flags overscoped entries with overly broad applicability", async () => {
  await withTempRepo(async (projectRoot) => {
    const filePath = await saveMemory(
      {
        type: "convention",
        title: "Apply migration review everywhere",
        summary: "Use this rule for all code changes across the whole repo.",
        detail:
          "## CONVENTION\n\nThis rule should apply to any change across the entire repo, without narrowing it to a smaller area.",
        tags: ["workflow"],
        importance: "medium",
        date: "2026-03-29T00:00:00.000Z",
        status: "active",
        path_scope: ["src/**"],
      },
      projectRoot,
    );

    const result = await buildMemoryAudit(projectRoot, { now: AUDIT_NOW });
    const overscopedIssue = result.issues.find((issue) => issue.issue_type === "overscoped");

    assert.ok(overscopedIssue);
    assert.equal(overscopedIssue.memory_id, path.basename(filePath, ".md"));
    assert.equal(overscopedIssue.suggested_action, "narrow_scope");

    const stdout = renderMemoryAuditResult(result);
    assert.match(stdout, /overscoped/);
    assert.match(stdout, new RegExp(path.basename(filePath, ".md")));
    assert.match(stdout, /Schema health:/);
  });
});

console.log("All audit-memory tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-audit-"));

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
