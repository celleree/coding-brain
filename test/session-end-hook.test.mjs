import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initBrain, loadStoredMemoryRecords } from "../dist/store-api.js";
import { saveMemory } from "./provenance-fixtures.mjs";

const repoRoot = process.cwd();
const hookPath = path.join(repoRoot, "dist", "hooks", "session-end.js");
const fixturePath = path.join(repoRoot, "test", "fixtures", "reinforce-llm-fixture.mjs");
const zhFixturePath = path.join(repoRoot, "test", "fixtures", "extractor-echo-zh-fixture.mjs");
const fixtureCommand = `"${process.execPath}" "${fixturePath}"`;
const zhFixtureCommand = `"${process.execPath}" "${zhFixturePath}"`;

await runTest("session-end hook queues reinforcement suggestions instead of applying them immediately", async () => {
  await withTempRepo(async (projectRoot) => {
    const existingPath = await saveMemory(
      {
        type: "decision",
        title: "Keep payment writes inside the transaction helper",
        summary: "Route payment writes through the helper.",
        detail: "## DECISION\n\nAlways route payment writes through the transaction helper.",
        tags: ["payments"],
        importance: "high",
        date: "2026-04-01T08:00:00.000Z",
        score: 60,
        hit_count: 0,
        last_used: null,
        created_at: "2026-04-01",
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    const result = await runNodeProcess(
      [hookPath],
      projectRoot,
      [
        "The agent updated the refund flow.",
        "It skipped the transaction helper and wrote directly to payments storage.",
        "It also retried a flaky browser test without opening the Playwright trace first.",
      ].join("\n"),
      {
        BRAIN_EXTRACTOR_COMMAND: fixtureCommand,
        DETECT_RELATED_FILE: path.basename(existingPath),
      },
    );

    assert.equal(result.code, 0);

    const existingRaw = await readFile(existingPath, "utf8");
    assert.match(existingRaw, /score: 60/);

    const pendingRaw = await readFile(path.join(projectRoot, ".brain", "reinforce-pending.json"), "utf8");
    const pending = JSON.parse(pendingRaw);
    assert.equal(pending.events.length, 2);
    assert.equal(pending.events[0]?.suggestedAction, "boost_score");
    assert.equal(pending.events[1]?.suggestedAction, "extract_new");

    const records = await loadStoredMemoryRecords(projectRoot);
    assert.equal(
      records.some((entry) => entry.memory.origin === "failure"),
      false,
    );
  });
});

await runTest("session-end hook decodes Windows GB18030 stdin before extraction", async () => {
  await withTempRepo(async (projectRoot) => {
    const result = await runNodeProcessBuffer(
      [hookPath],
      projectRoot,
      Buffer.concat([Buffer.from("gotcha: ", "utf8"), Buffer.from([0xd6, 0xd0])]),
      {
        BRAIN_EXTRACTOR_COMMAND: zhFixtureCommand,
      },
    );
    assert.equal(result.code, 0);

    const records = await loadStoredMemoryRecords(projectRoot);
    assert.ok(
      records.some((entry) => entry.memory.title.includes("中文上下文")),
      "expected extracted zh memory",
    );
  });
});

console.log("All session-end hook tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-session-end-"));

  try {
    await initBrain(projectRoot);
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function runNodeProcess(args, cwd, stdinText = "", extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...extraEnv,
      },
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

async function runNodeProcessBuffer(args, cwd, stdinBuffer, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...extraEnv,
      },
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

    child.stdin.end(stdinBuffer);
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
