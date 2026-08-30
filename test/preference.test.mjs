import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "cli.js");

import {
  extractPreferenceFromNaturalLanguage,
  initBrain,
  loadAllMemories,
  loadAllPreferences,
  normalizePreference,
  parsePreference,
  saveMemory as saveMemoryRecord,
  savePreference as savePreferenceRecord,
  serializePreference,
  validatePreference,
} from "../dist/store-api.js";

function saveMemory(memory, projectRoot, provenance) {
  return saveMemoryRecord(memory, projectRoot, provenance ?? { sourceBytes: Buffer.from(memory.detail, "utf8") });
}

function savePreference(preference, projectRoot, provenance) {
  return savePreferenceRecord(
    preference,
    projectRoot,
    provenance ?? { sourceBytes: Buffer.from(preference.reason, "utf8") },
  );
}

await runTest("NL extraction: spec Chinese examples resolve to preferences", () => {
  const a = extractPreferenceFromNaturalLanguage("这个 skill 流程太繁琐，下次换一个快捷的");
  assert.ok(a);
  assert.equal(a.preference, "avoid");
  assert.equal(a.target_type, "workflow");
  assert.ok(a.target.includes("skill"));

  const b = extractPreferenceFromNaturalLanguage("除非高风险改动，否则不要走全量重验证流程");
  assert.ok(b);
  assert.equal(b.preference, "require_review");
  assert.equal(b.target_type, "workflow");
  assert.ok(b.target.includes("全量重验证"));

  const c = extractPreferenceFromNaturalLanguage("浏览器测试优先 Playwright 路线");
  assert.ok(c);
  assert.equal(c.preference, "prefer");
  assert.equal(c.target_type, "skill");
  assert.equal(c.target, "playwright");
});

await runTest("NL extraction: weak or vague input returns null", () => {
  assert.equal(extractPreferenceFromNaturalLanguage("maybe"), null);
  assert.equal(extractPreferenceFromNaturalLanguage("maybe we should think about it later"), null);
  assert.equal(extractPreferenceFromNaturalLanguage("I like pizza."), null);
  assert.equal(extractPreferenceFromNaturalLanguage("ok"), null);
});

await runTest("normalize, serialize, parse, validate preference records", async () => {
  const minimal = {
    kind: "routing_preference",
    target_type: "workflow",
    target: "full-verify",
    preference: "avoid",
    reason: "too slow for small fixes",
  };

  const normalized = normalizePreference(minimal);
  assert.equal(normalized.status, "active");
  assert.ok(normalized.created_at);
  validatePreference(normalized);

  const body = serializePreference(normalized);
  assert.match(body, /^---\r?\n/);
  assert.match(body, /kind:\s*"?routing_preference"?/);

  const roundTrip = parsePreference(body, "virtual.md");
  assert.equal(roundTrip.target, "full-verify");
  assert.equal(roundTrip.preference, "avoid");
  validatePreference(roundTrip);

  assert.throws(() => validatePreference({ ...normalized, kind: "not-a-kind" }));
});

await runTest("preferences stay isolated from durable memory loading", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-pref-isolation-"));
  try {
    await initBrain(tmpDir);

    await savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "jest",
        preference: "prefer",
        reason: "unit tests",
        confidence: 0.8,
        source: "manual",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "active",
      },
      tmpDir,
    );

    const memory = {
      type: "decision",
      title: "Use TypeScript",
      summary: "TS everywhere",
      detail: "## DECISION\n\nyes",
      tags: [],
      importance: "medium",
      date: "2026-04-05T10:00:00.000Z",
      score: 60,
      hit_count: 0,
      last_used: null,
      created_at: "2026-04-05T10:00:00.000Z",
      stale: false,
    };

    await saveMemory(memory, tmpDir);

    const memories = await loadAllMemories(tmpDir);
    const prefs = await loadAllPreferences(tmpDir);

    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.title, "Use TypeScript");
    assert.equal(prefs.length, 1);
    assert.equal(prefs[0]?.target, "jest");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("CLI capture-preference (stdin) and lint-preferences", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-pref-cli-"));
  try {
    await initBrain(tmpDir);

    const cap = await runCli(["capture-preference"], tmpDir, "浏览器测试优先 Playwright 路线\n");
    assert.equal(cap.code, 0, cap.stderr);

    const lint = await runCli(["lint-preferences"], tmpDir, "");
    assert.equal(lint.code, 0, lint.stderr);

    const prefs = await loadAllPreferences(tmpDir);
    assert.equal(prefs.length, 1);
    assert.equal(prefs[0]?.target, "playwright");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("CLI user errors stay concise without stack traces", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-pref-user-error-"));
  try {
    await initBrain(tmpDir);
    const cap = await runCli(["capture-preference"], tmpDir, "");
    assert.equal(cap.code, 1);
    assert.match(cap.stderr, /Provide natural language via --input or stdin/);
    assert.doesNotMatch(cap.stderr, /BrainUserError:/);
    assert.doesNotMatch(cap.stderr, /\s+at\s+/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("CLI debug mode prints stack traces for unexpected errors", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-pref-debug-error-"));
  try {
    await initBrain(tmpDir);
    const savedPath = await saveMemory(
      {
        type: "decision",
        title: "Use deterministic fixtures",
        summary: "Fixture data keeps tests stable",
        detail: "## DECISION\n\nUse deterministic fixtures.",
        tags: [],
        importance: "medium",
        date: new Date().toISOString(),
        score: 70,
        hit_count: 0,
        last_used: null,
        created_at: new Date().toISOString(),
        stale: false,
      },
      tmpDir,
    );
    const sameFile = path.basename(savedPath);
    const result = await runCli(["supersede", sameFile, sameFile], tmpDir, "", { REPOBRAIN_DEBUG: "1" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Choose two different memory files for supersede\./);
    assert.match(result.stderr, /\s+at\s+/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("CLI supersede-preference marks old file superseded", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-pref-super-"));
  try {
    await initBrain(tmpDir);
    await savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "jest",
        preference: "prefer",
        reason: "fast unit tests",
        confidence: 0.9,
        source: "manual",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "active",
      },
      tmpDir,
    );

    const sup = await runCli(
      [
        "supersede-preference",
        "jest",
        "--target",
        "vitest",
        "--type",
        "skill",
        "--pref",
        "prefer",
        "--reason",
        "team standard",
      ],
      tmpDir,
      "",
    );
    assert.equal(sup.code, 0, sup.stderr);

    const prefs = await loadAllPreferences(tmpDir);
    assert.equal(prefs.length, 2);
    const old = prefs.find((p) => p.target === "jest");
    const neu = prefs.find((p) => p.target === "vitest");
    assert.ok(old);
    assert.ok(neu);
    assert.equal(old.status, "superseded");
    assert.equal(neu.status, "active");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("lint: invalid frontmatter fails parse or validate", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-pref-lint-"));
  try {
    await initBrain(tmpDir);
    const badPath = path.join(tmpDir, ".brain", "preferences", "broken.md");
    await writeFile(
      badPath,
      ["---", 'kind: "routing_preference"', 'target_type: "skill"', 'target: "x"', "---", ""].join("\n"),
      "utf8",
    );

    const raw = await readFile(badPath, "utf8");
    assert.throws(() => parsePreference(raw, badPath), /missing required fields/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

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

function runCli(args, cwd, stdinText, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...envOverrides },
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
      resolve({ code: code ?? 1, stdout, stderr });
    });

    child.stdin.end(stdinText);
  });
}
