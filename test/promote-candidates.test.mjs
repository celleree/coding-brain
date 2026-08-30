import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  approveCandidateMemory,
  getMemoryStatus,
  initBrain,
  isSafeForAutoApproval,
  loadStoredMemoryRecords,
  looksTemporary,
  reviewCandidateMemory,
  saveMemory as saveMemoryRecord,
} from "../dist/store-api.js";

function saveMemory(memory, projectRoot, provenance) {
  return saveMemoryRecord(memory, projectRoot, provenance ?? { sourceBytes: Buffer.from(memory.detail, "utf8") });
}

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "cli.js");

await runTest("isSafeForAutoApproval rejects working memories", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "working",
        title: "Temporary session context for payment refactor",
        summary: "Keep the current payment flow context available during the refactor.",
        detail: "## WORKING\n\nKeep the current payment flow context available during the refactor session.",
        tags: ["payments"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "candidate",
        path_scope: ["src/payments/**"],
      },
      projectRoot,
    );

    const records = await loadStoredMemoryRecords(projectRoot);
    const candidate = records.find((r) => r.memory.type === "working");
    assert.ok(candidate);

    const review = reviewCandidateMemory(
      candidate.memory,
      records.filter((r) => r.filePath !== candidate.filePath),
    );

    assert.equal(isSafeForAutoApproval(candidate.memory, review), false);
  });
});

await runTest("isSafeForAutoApproval rejects temporary-looking memories", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "pattern",
        title: "Debug only pattern for error logging",
        summary: "This debug only pattern logs extra context when debugging auth issues locally.",
        detail:
          "## PATTERN\n\nThis debug only pattern logs extra context when debugging auth issues locally. Should not go into production.",
        tags: ["debug"],
        importance: "low",
        date: "2026-04-01T08:00:00.000Z",
        status: "candidate",
        path_scope: ["src/auth/**"],
      },
      projectRoot,
    );

    const records = await loadStoredMemoryRecords(projectRoot);
    const candidate = records[0];
    assert.ok(candidate);
    assert.equal(looksTemporary(candidate.memory), true);

    const review = reviewCandidateMemory(candidate.memory, []);

    assert.equal(isSafeForAutoApproval(candidate.memory, review), false);
  });
});

await runTest("isSafeForAutoApproval accepts novel non-working non-temporary candidates", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "convention",
        title: "Use structured logging for all API handlers",
        summary: "API handlers should use the structured logger instead of console.log for consistent log formats.",
        detail:
          "## CONVENTION\n\nAPI handlers should use the structured logger instead of console.log for consistent log formats across staging and production.",
        tags: ["api", "logging"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "candidate",
        path_scope: ["src/api/**"],
      },
      projectRoot,
    );

    const records = await loadStoredMemoryRecords(projectRoot);
    const candidate = records[0];
    assert.ok(candidate);

    const review = reviewCandidateMemory(candidate.memory, []);

    assert.equal(review.decision, "accept");
    assert.equal(review.reason, "novel_memory");
    assert.equal(isSafeForAutoApproval(candidate.memory, review), true);
  });
});

await runTest("isSafeForAutoApproval rejects merge/supersede candidates", async () => {
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
    const candidate = records.find((r) => r.memory.status === "candidate");
    assert.ok(candidate);

    const review = reviewCandidateMemory(
      candidate.memory,
      records.filter((r) => r.filePath !== candidate.filePath),
    );

    assert.notEqual(review.decision, "accept");
    assert.equal(isSafeForAutoApproval(candidate.memory, review), false);
  });
});

await runTest("brain promote-candidates respects config guard", async () => {
  await withTempRepo(async (projectRoot) => {
    const result = await runCliProcess(["promote-candidates"], projectRoot);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /autoApproveSafeCandidates is disabled/);
  });
});

await runTest("brain promote-candidates promotes safe candidates and keeps unsafe ones", async () => {
  await withTempRepo(async (projectRoot) => {
    await enableAutoApprove(projectRoot);

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

    const result = await runCliProcess(["promote-candidates"], projectRoot);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Promoted 1 safe candidate/);
    assert.match(result.stdout, /1 candidate remains? for manual review/);

    const records = await loadStoredMemoryRecords(projectRoot);
    const promoted = records.find((r) => r.memory.title === "Use focused fixtures for CLI smoke tests");
    const kept = records.find((r) => r.memory.title === "Keep refund writes inside the transaction helper");

    assert.equal(promoted?.memory.status, "active");
    assert.equal(kept?.memory.status, "candidate");
  });
});

await runTest("brain promote-candidates --dry-run does not change files", async () => {
  await withTempRepo(async (projectRoot) => {
    await enableAutoApprove(projectRoot);

    await saveMemory(
      {
        type: "convention",
        title: "Use structured logging for all API handlers",
        summary: "API handlers should use the structured logger instead of console.log for consistent log formats.",
        detail:
          "## CONVENTION\n\nAPI handlers should use the structured logger instead of console.log for consistent log formats across staging and production.",
        tags: ["api", "logging"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "candidate",
        path_scope: ["src/api/**"],
      },
      projectRoot,
    );

    const result = await runCliProcess(["promote-candidates", "--dry-run"], projectRoot);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /\[dry-run\] Would promote 1 candidate/);

    const records = await loadStoredMemoryRecords(projectRoot);
    const candidate = records[0];
    assert.equal(candidate?.memory.status, "candidate");
  });
});

await runTest("brain promote-candidates skips working memories even when review says accept", async () => {
  await withTempRepo(async (projectRoot) => {
    await enableAutoApprove(projectRoot);

    await saveMemory(
      {
        type: "working",
        title: "Current refactor context for payment module redesign",
        summary: "Keep context about the ongoing payment module redesign effort available during this sprint.",
        detail:
          "## WORKING\n\nKeep context about the ongoing payment module redesign effort available during this sprint.",
        tags: ["payments"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "candidate",
        path_scope: ["src/payments/**"],
        expires: "2026-04-08",
      },
      projectRoot,
    );

    const result = await runCliProcess(["promote-candidates"], projectRoot);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Promoted 0 safe candidates/);

    const records = await loadStoredMemoryRecords(projectRoot);
    assert.equal(records[0]?.memory.status, "candidate");
  });
});

console.log("All promote-candidates tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-promote-"));

  try {
    await initBrain(projectRoot);
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function enableAutoApprove(projectRoot) {
  const configPath = path.join(projectRoot, ".brain", "config.yaml");
  const existing = await readFile(configPath, "utf8").catch(() => "");
  await writeFile(configPath, existing + "\nautoApproveSafeCandidates: true\n", "utf8");
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
