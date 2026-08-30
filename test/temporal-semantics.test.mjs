import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildInjection } from "../dist/inject.js";
import { normalizeMemorySchemas } from "../dist/store-api.js";
import {
  buildMemoryEvolutionChain,
  initBrain,
  isMemoryCurrentlyValid,
  loadStoredMemoryRecords,
  normalizeMemory,
  saveMemory as saveMemoryRecord,
  serializeMemory,
  supersedeMemoryPair,
} from "../dist/store-api.js";
import { buildSkillShortlist } from "../dist/suggest-skills.js";

function saveMemory(memory, projectRoot, provenance) {
  return saveMemoryRecord(memory, projectRoot, provenance ?? { sourceBytes: Buffer.from(memory.detail, "utf8") });
}

const DEFAULT_BRAIN_CONFIG = {
  workflowMode: "recommended-semi-auto",
  maxInjectTokens: 1200,
  triggerMode: "detect",
  captureMode: "candidate",
  extractMode: "suggest",
  language: "zh-CN",
  staleDays: 90,
  sweepOnInject: false,
  injectDiversity: true,
  injectExplainMaxItems: 4,
};

await runTest("superseded memory (explicit pair) is not injectable and has valid_until metadata", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Temporal chain A",
        summary: "older",
        detail: "## DECISION\n\nolder",
        tags: ["t"],
        importance: "high",
        date: "2026-01-01T10:00:00.000Z",
        score: 60,
        hit_count: 0,
        last_used: null,
        created_at: "2026-01-01T10:00:00.000Z",
        status: "active",
        stale: false,
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Temporal chain B",
        summary: "newer",
        detail: "## DECISION\n\nnewer",
        tags: ["t"],
        importance: "high",
        date: "2026-02-01T10:00:00.000Z",
        score: 60,
        hit_count: 0,
        last_used: null,
        created_at: "2026-02-01T10:00:00.000Z",
        status: "active",
        stale: false,
      },
      projectRoot,
    );

    let records = await loadStoredMemoryRecords(projectRoot);
    const oldRec = records.find((r) => r.memory.title === "Temporal chain A");
    const newRec = records.find((r) => r.memory.title === "Temporal chain B");
    assert.ok(oldRec && newRec);

    await supersedeMemoryPair(newRec, oldRec);
    records = await loadStoredMemoryRecords(projectRoot);
    const oldAgain = records.find((r) => r.filePath === oldRec.filePath);
    assert.ok(oldAgain.memory.superseded_by);
    assert.ok(oldAgain.memory.valid_until);
    assert.ok(oldAgain.memory.supersession_reason);

    assert.equal(isMemoryCurrentlyValid(oldAgain.memory, new Date()), false);

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, { noContext: true });
    assert.match(injection, /Temporal chain B/);
    assert.ok(!injection.includes("Temporal chain A"));
  });
});

await runTest("inject ignores memories outside validity window or pending_review", async () => {
  await withTempRepo(async (projectRoot) => {
    const future = "2099-01-01";
    await saveMemory(
      {
        type: "convention",
        title: "Future only",
        summary: "x",
        detail: "## CONVENTION\n\nx",
        tags: [],
        importance: "low",
        date: "2026-03-01T10:00:00.000Z",
        score: 90,
        hit_count: 0,
        last_used: null,
        created_at: "2026-03-01T10:00:00.000Z",
        status: "active",
        stale: false,
        valid_from: future,
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "convention",
        title: "Pending human review",
        summary: "y",
        detail: "## CONVENTION\n\ny",
        tags: [],
        importance: "high",
        date: "2026-03-02T10:00:00.000Z",
        score: 90,
        hit_count: 0,
        last_used: null,
        created_at: "2026-03-02T10:00:00.000Z",
        status: "active",
        stale: false,
        review_state: "pending_review",
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, { noContext: true });
    assert.ok(!injection.includes("Future only"));
    assert.ok(!injection.includes("Pending human review"));
    assert.match(injection, /\[RepoBrain\] injected 0\/0 eligible memories\./);
  });
});

await runTest("buildMemoryEvolutionChain orders oldest to newest along supersedes", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "pattern",
        title: "Evo A",
        summary: "a",
        detail: "## PATTERN\n\na",
        tags: [],
        importance: "low",
        date: "2026-01-01T10:00:00.000Z",
        score: 60,
        hit_count: 0,
        last_used: null,
        created_at: "2026-01-01T10:00:00.000Z",
        status: "active",
        stale: false,
      },
      projectRoot,
    );
    await saveMemory(
      {
        type: "pattern",
        title: "Evo B",
        summary: "b",
        detail: "## PATTERN\n\nb",
        tags: [],
        importance: "low",
        date: "2026-02-01T10:00:00.000Z",
        score: 60,
        hit_count: 0,
        last_used: null,
        created_at: "2026-02-01T10:00:00.000Z",
        status: "active",
        stale: false,
      },
      projectRoot,
    );

    let records = await loadStoredMemoryRecords(projectRoot);
    const a = records.find((r) => r.memory.title === "Evo A");
    const b = records.find((r) => r.memory.title === "Evo B");
    await supersedeMemoryPair(b, a);
    records = await loadStoredMemoryRecords(projectRoot);
    const b2 = records.find((r) => r.memory.title === "Evo B");
    const chain = buildMemoryEvolutionChain(records, b2);
    assert.equal(chain.length, 2);
    assert.equal(chain[0].memory.title, "Evo A");
    assert.equal(chain[1].memory.title, "Evo B");
  });
});

await runTest("normalizeMemorySchemas leaves unsourced temporal records unchanged", async () => {
  await withTempRepo(async (projectRoot) => {
    const brainDir = path.join(projectRoot, ".brain");
    const memPath = path.join(brainDir, "decisions", "2026-04-05-legacy.md");
    const body = normalizeMemory({
      type: "decision",
      title: "Legacy temporal",
      summary: "s",
      detail: "## DECISION\n\nlegacy body",
      tags: [],
      importance: "medium",
      date: "2026-04-05T12:00:00.000Z",
      score: 60,
      hit_count: 0,
      last_used: null,
      created_at: "2026-04-05T12:00:00.000Z",
      stale: false,
      status: "active",
    });
    const full = serializeMemory(body);
    const stripped = full.replace(/^valid_from:.*\n/m, "").replace(/^observed_at:.*\n/m, "");
    await writeFile(memPath, stripped, "utf8");

    const before = await readFile(memPath, "utf8");
    assert.ok(!before.includes("valid_from:"));

    const result = await normalizeMemorySchemas(projectRoot);
    const after = await readFile(memPath, "utf8");
    const file = result.files.find((entry) => entry.file_path === memPath);
    assert.ok(file);
    assert.equal(file.fixable, false);
    assert.match(JSON.stringify(file.issues), /missing_provenance/);
    assert.equal(after, before);
  });
});

await runTest("suggest-skills does not match memories invalidated by superseded_by", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "convention",
        title: "Skill old",
        summary: "s",
        detail: "## CONVENTION\n\nx",
        tags: [],
        importance: "high",
        date: "2026-01-01T10:00:00.000Z",
        score: 80,
        hit_count: 0,
        last_used: null,
        created_at: "2026-01-01T10:00:00.000Z",
        status: "active",
        stale: false,
        skill_trigger_tasks: ["refund"],
        recommended_skills: ["old-skill"],
      },
      projectRoot,
    );
    await saveMemory(
      {
        type: "convention",
        title: "Skill new",
        summary: "s",
        detail: "## CONVENTION\n\ny",
        tags: [],
        importance: "high",
        date: "2026-02-01T10:00:00.000Z",
        score: 80,
        hit_count: 0,
        last_used: null,
        created_at: "2026-02-01T10:00:00.000Z",
        status: "active",
        stale: false,
        skill_trigger_tasks: ["refund"],
        recommended_skills: ["new-skill"],
      },
      projectRoot,
    );

    let records = await loadStoredMemoryRecords(projectRoot);
    const oldR = records.find((r) => r.memory.title === "Skill old");
    const newR = records.find((r) => r.memory.title === "Skill new");
    await supersedeMemoryPair(newR, oldR);

    const result = await buildSkillShortlist(projectRoot, {
      task: "refund bug",
      paths: [],
      path_source: "explicit",
    });
    const titles = result.matched_memories.map((m) => m.record.memory.title);
    assert.ok(titles.includes("Skill new"));
    assert.ok(!titles.includes("Skill old"));
  });
});

console.log("All temporal semantics tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-temporal-"));
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
