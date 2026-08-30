import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildSkillShortlist,
  initBrain,
  saveMemory as saveMemoryRecord,
  savePreference as savePreferenceRecord,
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

await runTest("routing with static memories only matches prior invocation_plan shape", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Route browser test work through Playwright guidance",
        summary: "Prefer Playwright-specific guidance for browser test debugging.",
        detail: "## DECISION\n\nUse Playwright-oriented guidance first for browser-heavy tasks.",
        tags: ["playwright", "skills"],
        importance: "high",
        date: "2026-04-01T12:00:00.000Z",
        status: "active",
        recommended_skills: ["github:gh-fix-ci"],
        required_skills: ["playwright"],
        suppressed_skills: ["imagegen"],
        skill_trigger_paths: ["tests/e2e/", "playwright.config.ts"],
        skill_trigger_tasks: ["debug flaky browser tests"],
        invocation_mode: "prefer",
        risk_level: "medium",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "pattern",
        title: "Keep browser triage docs nearby",
        summary: "Optional fallback references are still useful if the primary skill is unavailable.",
        detail: "## PATTERN\n\nUse the internal browser checklist as a fallback when needed.",
        tags: ["browser", "skills"],
        importance: "low",
        date: "2026-04-01T12:03:00.000Z",
        status: "active",
        recommended_skills: ["browser-checklist"],
        skill_trigger_tasks: ["debug flaky browser tests"],
        invocation_mode: "optional",
        risk_level: "low",
      },
      projectRoot,
    );

    const result = await buildSkillShortlist(projectRoot, {
      task: "debug flaky browser tests in CI",
      paths: ["tests/e2e/login.spec.ts", "playwright.config.ts"],
    });

    assert.deepEqual(result.invocation_plan.required, ["playwright"]);
    assert.deepEqual(result.invocation_plan.prefer_first, ["github:gh-fix-ci"]);
    assert.deepEqual(result.invocation_plan.optional_fallback, ["browser-checklist"]);
    assert.deepEqual(result.invocation_plan.suppress, ["imagegen"]);
    assert.ok(result.routing_explanation);
    assert.ok(result.routing_explanation.priority_order.length > 0);
    assert.ok(result.routing_explanation.skill_evidence.playwright);
  });
});

await runTest("active skill preference can add a skill when no memory matches", async () => {
  await withTempRepo(async (projectRoot) => {
    await savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "jest",
        preference: "prefer",
        reason: "default unit test runner",
        confidence: 0.9,
        source: "manual",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "active",
      },
      projectRoot,
    );

    const result = await buildSkillShortlist(projectRoot, {
      task: "run unit tests for checkout",
      paths: [],
      path_source: "none",
    });

    assert.equal(result.matched_memories.length, 0);
    assert.deepEqual(result.invocation_plan.prefer_first, ["jest"]);
    const jestSources = result.resolved_skills.find((s) => s.skill === "jest");
    assert.ok(jestSources?.sources.some((s) => s.relation === "preference_prefer"));
  });
});

await runTest("superseded preference is skipped and does not affect routing", async () => {
  await withTempRepo(async (projectRoot) => {
    await savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "legacy-tool",
        preference: "prefer",
        reason: "should not apply",
        confidence: 1,
        source: "manual",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "active",
        superseded_by: "pref-skill-new-tool.md",
      },
      projectRoot,
    );

    const result = await buildSkillShortlist(projectRoot, {
      task: "anything",
      paths: [],
      path_source: "none",
    });

    assert.equal(result.resolved_skills.filter((s) => s.skill === "legacy-tool").length, 0);
    assert.ok(result.routing_explanation?.notes.some((n) => n.includes("Skipped preference for legacy-tool")));
  });
});

await runTest("stale preference status does not participate in routing", async () => {
  await withTempRepo(async (projectRoot) => {
    await savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "stale-skill",
        preference: "prefer",
        reason: "old",
        confidence: 1,
        source: "manual",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "stale",
      },
      projectRoot,
    );

    const result = await buildSkillShortlist(projectRoot, {
      task: "task",
      paths: [],
      path_source: "none",
    });

    assert.equal(result.resolved_skills.filter((s) => s.skill === "stale-skill").length, 0);
  });
});

await runTest("memory.required vs preference.avoid surfaces explainable conflict when scores are tight", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Require Playwright",
        summary: "Playwright for e2e.",
        detail: "## DECISION\n\n",
        tags: ["t"],
        importance: "low",
        date: "2026-04-01T12:00:00.000Z",
        status: "active",
        required_skills: ["playwright"],
        skill_trigger_tasks: ["e2e"],
        invocation_mode: "optional",
        risk_level: "low",
      },
      projectRoot,
    );

    await savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "playwright",
        preference: "avoid",
        reason: "prefer cypress for now",
        confidence: 1,
        source: "manual",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "active",
      },
      projectRoot,
    );

    const result = await buildSkillShortlist(projectRoot, {
      task: "e2e login flow",
      paths: [],
      path_source: "none",
    });

    const pc = result.conflicts.find((c) => c.skill === "playwright");
    assert.ok(pc);
    assert.equal(pc.kind, "required_vs_suppressed");
    assert.ok(pc.reason.toLowerCase().includes("required"));
    assert.ok(result.routing_explanation?.skill_evidence.playwright?.some((l) => l.includes("preference_avoid")));
  });
});

await runTest("routing excludes provenance-invalid active memories and preferences", async () => {
  await withTempRepo(async (projectRoot) => {
    const memoryPath = await saveMemory(
      {
        type: "decision",
        title: "Tamper-gated routing memory",
        summary: "Route matching work through a protected skill.",
        detail: "## DECISION\n\nUse the protected skill.",
        tags: ["provenance"],
        importance: "high",
        date: "2026-08-29T12:00:00.000Z",
        score: 80,
        hit_count: 0,
        last_used: null,
        created_at: "2026-08-29T12:00:00.000Z",
        stale: false,
        source: "manual",
        status: "active",
        required_skills: ["protected-skill"],
        skill_trigger_tasks: ["protected task"],
      },
      projectRoot,
      { sourceBytes: Buffer.from("routing memory evidence", "utf8") },
    );
    const now = new Date().toISOString();
    const preferencePath = await savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "preferred-skill",
        preference: "prefer",
        reason: "Prefer for protected task",
        confidence: 1,
        source: "manual",
        created_at: now,
        updated_at: now,
        status: "active",
        task_hints: ["protected task"],
      },
      projectRoot,
      { sourceBytes: Buffer.from("routing preference evidence", "utf8") },
    );
    await writeFile(memoryPath, (await readFile(memoryPath, "utf8")).replace("protected skill", "changed skill"));
    await writeFile(
      preferencePath,
      (await readFile(preferencePath, "utf8")).replace("Prefer for protected task", "Changed reason"),
    );

    const result = await buildSkillShortlist(projectRoot, { task: "protected task", paths: [] });
    assert.equal(result.resolved_skills.length, 0);
  });
});

console.log("All routing-layer tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-routing-"));

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
