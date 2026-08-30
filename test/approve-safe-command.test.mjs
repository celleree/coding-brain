import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initBrain, loadStoredMemoryRecords } from "../dist/store-api.js";
import { saveMemory } from "./provenance-fixtures.mjs";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "cli.js");

await runTest("brain approve --safe only promotes low-risk novel candidates", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Keep payment writes inside the transaction helper",
        summary: "Payment writes should stay inside the transaction helper for rollback safety.",
        detail: "## DECISION\n\nPayment writes should stay inside the transaction helper for rollback safety.",
        tags: ["payments"],
        importance: "high",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["src/payments/**"],
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "pattern",
        title: "Use focused fixtures for CLI smoke tests",
        summary: "CLI smoke tests stay easier to debug with focused fixtures instead of the full demo repo.",
        detail:
          "## PATTERN\n\nCLI smoke tests stay easier to debug with focused fixtures instead of the full demo repo.",
        tags: ["cli", "tests"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "candidate",
        path_scope: ["test/**"],
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Keep refund writes inside the transaction helper",
        summary: "Refund writes should also stay inside the transaction helper so the same rollback rule applies.",
        detail:
          "## DECISION\n\nRefund writes should also stay inside the transaction helper so the same rollback rule applies.",
        tags: ["payments", "refunds"],
        importance: "medium",
        date: "2026-04-01T10:00:00.000Z",
        status: "candidate",
        path_scope: ["src/payments/**"],
      },
      projectRoot,
    );

    const result = await runCliProcess(["approve", "--safe"], projectRoot);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Approved 1 safe candidate memory\./);
    assert.match(result.stdout, /1 candidate memory still requires manual review\./);

    const records = await loadStoredMemoryRecords(projectRoot);
    const safeCandidate = records.find((entry) => entry.memory.title === "Use focused fixtures for CLI smoke tests");
    const manualCandidate = records.find(
      (entry) => entry.memory.title === "Keep refund writes inside the transaction helper",
    );

    assert.equal(safeCandidate?.memory.status, "active");
    assert.equal(manualCandidate?.memory.status, "candidate");
  });
});

await runTest("brain approve --safe rejects a specific candidate that still needs manual review", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Keep payment writes inside the transaction helper",
        summary: "Payment writes should stay inside the transaction helper for rollback safety.",
        detail: "## DECISION\n\nPayment writes should stay inside the transaction helper for rollback safety.",
        tags: ["payments"],
        importance: "high",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["src/payments/**"],
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Keep refund writes inside the transaction helper",
        summary: "Refund writes should also stay inside the transaction helper so the same rollback rule applies.",
        detail:
          "## DECISION\n\nRefund writes should also stay inside the transaction helper so the same rollback rule applies.",
        tags: ["payments", "refunds"],
        importance: "medium",
        date: "2026-04-01T10:00:00.000Z",
        status: "candidate",
        path_scope: ["src/payments/**"],
      },
      projectRoot,
    );

    const records = await loadStoredMemoryRecords(projectRoot);
    const candidate = records.find((entry) => entry.memory.status === "candidate");
    assert.ok(candidate);

    const result = await runCliProcess(
      ["approve", candidate ? path.basename(candidate.filePath, ".md") : "", "--safe"],
      projectRoot,
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /still requires manual review \(merge: same_scope_summary_overlap\)/);
  });
});

console.log("All approve --safe command tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-approve-safe-"));

  try {
    await initBrain(projectRoot);
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
      resolve({
        code,
        stdout,
        stderr,
      });
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
