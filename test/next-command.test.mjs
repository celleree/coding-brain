import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initBrain } from "../dist/store-api.js";
import { saveMemory } from "./provenance-fixtures.mjs";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "cli.js");

await runTest("brain next recommends review and safe approval for pending candidates", async () => {
  await withTempRepo(async (projectRoot) => {
    await initBrain(projectRoot);
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

    const result = await runCliProcess(["next"], projectRoot);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Workflow: Recommended semi-auto/);
    assert.match(result.stdout, /brain review/);
    assert.match(result.stdout, /brain approve --safe/);
  });
});

await runTest("brain status surfaces reinforce and cleanup reminders", async () => {
  await withTempRepo(async (projectRoot) => {
    await initBrain(projectRoot);
    await saveMemory(
      {
        type: "decision",
        title: "Keep auth writes transactional",
        summary: "Old auth guidance that should show up in cleanup reminders.",
        detail: "## DECISION\n\nKeep auth writes transactional.",
        tags: ["auth"],
        importance: "high",
        date: "2025-12-03T09:00:00.000Z",
        updated: "2025-12-03",
        status: "active",
      },
      projectRoot,
    );

    await writeFile(
      path.join(projectRoot, ".brain", "reinforce-pending.json"),
      JSON.stringify(
        {
          updatedAt: "2026-04-03T10:00:00.000Z",
          events: [
            {
              kind: "new_failure",
              description: "Repeated failure worth extracting.",
              suggestedAction: "extract_new",
              draftContent: "gotcha: avoid repeating this failure",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runCliProcess(["status"], projectRoot);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Pending reinforce: 1/);
    assert.match(result.stdout, /Pending cleanup: 1/);
    assert.match(result.stdout, /Reminders:/);
    assert.match(result.stdout, /reinforcement suggestion/);
    assert.match(result.stdout, /brain reinforce --pending/);
    assert.match(result.stdout, /brain score|brain sweep --dry-run/);
  });
});

console.log("All next command tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-next-"));

  try {
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
