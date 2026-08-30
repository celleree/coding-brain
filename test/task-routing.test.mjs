import { expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildTaskRoutingBundle,
  initBrain,
  loadConfig,
  renderTaskRoutingBundleJson,
  resolveSuggestedSkillPaths,
  shouldEscalateRoutingPlan,
  summarizeRoutingEscalation,
} from "../dist/store-api.js";
import { saveMemory } from "./provenance-fixtures.mjs";

await runTest("task routing returns a combined bundle", async () => {
  await withTempRepo(async (projectRoot) => {
    await initBrain(projectRoot);
    await saveMemory(
      {
        type: "decision",
        title: "Refund fixes must use the refund handler",
        summary: "Refund tasks should route through the refund handler skill.",
        detail: "## DECISION\n\nUse the refund handler skill for refund bug work.",
        tags: ["refund"],
        importance: "high",
        date: "2026-04-03T09:00:00.000Z",
        status: "active",
        required_skills: ["refund-handler"],
        skill_trigger_tasks: ["fix refund bug"],
        skill_trigger_paths: ["src/payments/"],
        path_scope: ["src/payments/**"],
      },
      projectRoot,
    );

    const config = await loadConfig(projectRoot);
    const bundle = await buildTaskRoutingBundle(projectRoot, config, {
      task: "fix refund bug",
      paths: ["src/payments/refund.ts"],
      path_source: "explicit",
    });
    const parsed = JSON.parse(renderTaskRoutingBundleJson(bundle));

    assert.equal(parsed.contract_version, "repobrain.task-routing-bundle.v1");
    assert.equal(parsed.task, "fix refund bug");
    assert.deepEqual(parsed.paths, ["src/payments/refund.ts"]);
    assert.equal(parsed.path_source, "explicit");
    assert.match(parsed.context_markdown, /# Project Brain: Repo Knowledge Context/);
    assert.match(parsed.context_markdown, /Refund fixes must use the refund handler/);
    assert.deepEqual(parsed.skill_plan.required, ["refund-handler"]);
    assert.deepEqual(
      parsed.resolved_skills.map((entry) => entry.skill),
      ["refund-handler"],
    );
    assert.equal(parsed.display_mode, "silent-ok");
    assert.deepEqual(parsed.expansion_plan.suggested_summary_ids, [
      "decisions/2026-04-03-refund-fixes-must-use-the-refund-handler-090000000.md",
    ]);
    assert.deepEqual(parsed.expansion_plan.suggested_full_ids, []);
  });
});

await runTest("task routing JSON exposes a stable expansion plan for progressive retrieval", async () => {
  await withTempRepo(async (projectRoot) => {
    await initBrain(projectRoot);
    await saveMemory(
      {
        type: "gotcha",
        title: "Refund bugfixes must preserve transaction boundaries",
        summary: "High-risk refund fixes should expand to full memory first.",
        detail: "## GOTCHA\n\nKeep refund writes and ledger sync in one transaction.",
        tags: ["refund", "payments", "ledger"],
        importance: "high",
        date: "2026-04-03T09:00:00.000Z",
        status: "active",
        risk_level: "high",
        skill_trigger_tasks: ["fix refund bug"],
        skill_trigger_paths: ["src/payments/", "src/ledger/"],
        path_scope: ["src/payments/**", "src/ledger/**"],
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Refund UI copy stays consistent with payment state",
        summary: "Strong task match but lower-risk, so summary is enough first.",
        detail: "## DECISION\n\nKeep refund UI copy aligned with payment state transitions.",
        tags: ["refund", "ui"],
        importance: "medium",
        date: "2026-04-03T10:00:00.000Z",
        status: "active",
        risk_level: "low",
        skill_trigger_tasks: ["fix refund bug"],
      },
      projectRoot,
    );

    const config = await loadConfig(projectRoot);
    const bundle = await buildTaskRoutingBundle(projectRoot, config, {
      task: "fix refund bug",
      paths: ["src/payments/refund.ts", "src/ledger/sync.ts"],
      path_source: "explicit",
    });
    const parsed = JSON.parse(renderTaskRoutingBundleJson(bundle));

    assert.ok(parsed.expansion_plan);
    assert.deepEqual(Object.keys(parsed.expansion_plan).sort(), ["suggested_full_ids", "suggested_summary_ids"]);
    assert.ok(parsed.expansion_plan.suggested_summary_ids.length >= 1);
    assert.equal(parsed.expansion_plan.suggested_full_ids.length, 1);
    assert.match(
      parsed.expansion_plan.suggested_full_ids[0],
      /^gotchas\/2026-04-03-refund-bugfixes-must-preserve-transaction-bound.*-090000000\.md$/,
    );
    assert.match(renderTaskRoutingBundleJson(bundle), /"expansion_plan": \{/);
  });
});

await runTest("explicit path override wins over auto collection helper output", async () => {
  await withTempRepo(async (projectRoot) => {
    const resolved = resolveSuggestedSkillPaths(projectRoot, ["src/api/refund.ts"]);
    assert.equal(resolved.path_source, "explicit");
    assert.deepEqual(resolved.paths, ["src/api/refund.ts"]);
    assert.deepEqual(resolved.warnings, []);
  });
});

await runTest("no-git fallback keeps task-only routing available", async () => {
  await withTempRepo(async (projectRoot) => {
    await initBrain(projectRoot);
    await saveMemory(
      {
        type: "decision",
        title: "Refund bug work should still route without git context",
        summary: "Task-only routing should stay available.",
        detail: "## DECISION\n\nKeep task-only routing working when git context is unavailable.",
        tags: ["refund"],
        importance: "high",
        date: "2026-04-03T11:00:00.000Z",
        status: "active",
        required_skills: ["refund-handler"],
        skill_trigger_tasks: ["fix refund bug"],
      },
      projectRoot,
    );

    const resolved = resolveSuggestedSkillPaths(projectRoot, []);
    assert.equal(resolved.path_source, "none");
    assert.deepEqual(resolved.paths, []);
    assert.match(resolved.warnings.join("\n"), /Git diff paths were unavailable/);

    const config = await loadConfig(projectRoot);
    const bundle = await buildTaskRoutingBundle(projectRoot, config, {
      task: "fix refund bug",
      paths: resolved.paths,
      path_source: resolved.path_source,
      warnings: resolved.warnings,
    });

    assert.deepEqual(bundle.skill_plan.required, ["refund-handler"]);
    assert.equal(bundle.display_mode, "silent-ok");
    assert.match(bundle.warnings.join("\n"), /Git diff paths were unavailable/);
  });
});

await runTest("conflict-free routing stays silent", async () => {
  const plan = {
    required: ["refund-handler"],
    prefer_first: ["lint-fix"],
    optional_fallback: ["notes-updater"],
    suppress: [],
    blocked: [],
    human_review: [],
  };

  assert.equal(shouldEscalateRoutingPlan(plan, []), false);
  assert.deepEqual(summarizeRoutingEscalation(plan, []), []);
});

await runTest("blocked routing escalates with a concise warning", async () => {
  const plan = {
    required: [],
    prefer_first: [],
    optional_fallback: [],
    suppress: [],
    blocked: ["prod-deploy"],
    human_review: [],
  };

  assert.equal(shouldEscalateRoutingPlan(plan, []), true);
  assert.deepEqual(summarizeRoutingEscalation(plan, []), ["Routing blocked: prod-deploy."]);
});

await runTest("human-review routing escalates with a concise warning", async () => {
  const plan = {
    required: [],
    prefer_first: [],
    optional_fallback: [],
    suppress: [],
    blocked: [],
    human_review: ["migration-runner"],
  };

  assert.equal(shouldEscalateRoutingPlan(plan, []), true);
  assert.deepEqual(summarizeRoutingEscalation(plan, []), ["Human review required: migration-runner."]);
});

await runTest("required and suppress conflicts escalate even when the plan keeps the required skill", async () => {
  const plan = {
    required: ["playwright"],
    prefer_first: [],
    optional_fallback: [],
    suppress: [],
    blocked: [],
    human_review: [],
  };
  const conflicts = [
    {
      skill: "playwright",
      kind: "required_vs_suppressed",
      strategy_result: "choose-required",
      reason: "Required evidence outweighs suppression, but the conflict should still be surfaced.",
      required_score: 10,
      recommended_score: 0,
      suppressed_score: 4,
      sources: [],
    },
  ];

  assert.equal(shouldEscalateRoutingPlan(plan, conflicts), true);
  assert.deepEqual(summarizeRoutingEscalation(plan, conflicts), [
    "Required/suppress conflict: playwright (required kept).",
  ]);
});

console.log("All task routing tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-route-"));

  try {
    await mkdir(path.join(projectRoot, "src", "payments"), { recursive: true });
    await mkdir(path.join(projectRoot, "src", "api"), { recursive: true });
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
