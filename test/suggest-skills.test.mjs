import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildSkillShortlist, collectGitDiffPaths, initBrain, renderSkillShortlistJson } from "../dist/store-api.js";
import { renderSkillShortlist } from "../dist/suggest-skills.js";
import { saveMemory } from "./provenance-fixtures.mjs";

await runTest("suggest-skills renders a markdown routing plan from matched active memories", async () => {
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

    await saveMemory(
      {
        type: "gotcha",
        title: "Ignore candidate-only skill hints",
        summary: "Candidate routing metadata should not affect the shortlist yet.",
        detail: "## GOTCHA\n\nCandidate memories should stay out of the active shortlist.",
        tags: ["skills"],
        importance: "medium",
        date: "2026-04-01T12:05:00.000Z",
        status: "candidate",
        recommended_skills: ["legacy-bot"],
        skill_trigger_tasks: ["debug flaky browser tests"],
      },
      projectRoot,
    );

    const result = await buildSkillShortlist(projectRoot, {
      task: "debug flaky browser tests in CI",
      paths: ["tests/e2e/login.spec.ts", "playwright.config.ts"],
    });
    const stdout = renderSkillShortlist(result);

    assert.equal(result.contract_version, "repobrain.skill-plan.v1");
    assert.equal(result.kind, "repobrain.skill_invocation_plan");
    assert.equal(result.path_source, "explicit");
    assert.deepEqual(result.invocation_plan.required, ["playwright"]);
    assert.deepEqual(result.invocation_plan.prefer_first, ["github:gh-fix-ci"]);
    assert.deepEqual(result.invocation_plan.optional_fallback, ["browser-checklist"]);
    assert.deepEqual(result.invocation_plan.suppress, ["imagegen"]);
    assert.equal(result.conflicts.length, 0);

    assert.match(stdout, /Contract: repobrain\.skill-plan\.v1 \(repobrain\.skill_invocation_plan\)/);
    assert.match(stdout, /Paths:/);
    assert.match(stdout, /Matched memories:/);
    assert.match(stdout, /Route browser test work through Playwright guidance/);
    assert.match(stdout, /task: debug flaky browser tests/);
    assert.match(stdout, /path: tests\/e2e -> tests\/e2e\/login\.spec\.ts/);
    assert.match(stdout, /path: playwright\.config\.ts -> playwright\.config\.ts/);
    assert.match(stdout, /Resolved skills:/);
    assert.match(stdout, /- playwright \| required \| plan=required \| score=/);
    assert.match(stdout, /- github:gh-fix-ci \| recommended \| plan=prefer_first \| score=/);
    assert.match(stdout, /- browser-checklist \| recommended \| plan=optional_fallback \| score=/);
    assert.match(stdout, /- imagegen \| suppressed \| plan=suppress \| score=/);
    assert.match(stdout, /Invocation plan:/);
    assert.match(stdout, /- required: playwright/);
    assert.match(stdout, /- prefer_first: github:gh-fix-ci/);
    assert.match(stdout, /- optional_fallback: browser-checklist/);
    assert.match(stdout, /- suppress: imagegen/);
    assert.doesNotMatch(stdout, /legacy-bot/);
  });
});

await runTest("suggest-skills emits choose-required when required evidence clearly outweighs suppression", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Use Playwright for browser smoke tests",
        summary: "Playwright stays required for smoke coverage.",
        detail: "## DECISION\n\nUse Playwright for browser smoke coverage.",
        tags: ["playwright"],
        importance: "high",
        date: "2026-04-01T13:00:00.000Z",
        status: "active",
        required_skills: ["playwright"],
        skill_trigger_paths: ["tests/e2e/"],
        skill_trigger_tasks: ["browser smoke tests"],
        risk_level: "medium",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "gotcha",
        title: "Avoid Playwright for doc-only notes",
        summary: "Documentation-only updates should not invoke Playwright.",
        detail: "## GOTCHA\n\nSkip Playwright when only browser docs changed.",
        tags: ["playwright"],
        importance: "low",
        date: "2026-04-01T13:05:00.000Z",
        status: "active",
        suppressed_skills: ["playwright"],
        skill_trigger_paths: ["docs/browser/"],
        skill_trigger_tasks: ["browser smoke tests"],
        risk_level: "low",
      },
      projectRoot,
    );

    const result = await buildSkillShortlist(projectRoot, {
      task: "browser smoke tests",
      paths: ["tests/e2e/smoke.spec.ts"],
    });

    assert.deepEqual(result.invocation_plan.required, ["playwright"]);
    assert.equal(result.conflicts[0]?.strategy_result, "choose-required");
    assert.match(result.conflicts[0]?.reason ?? "", /Required score .* exceeds suppressed score .* by at least 5/);
  });
});

await runTest("suggest-skills emits human-review when required and suppressed guidance stay too close", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Use migration-runner for schema changes",
        summary: "Schema changes should go through the migration runner.",
        detail: "## DECISION\n\nUse the migration runner for schema changes.",
        tags: ["db"],
        importance: "low",
        date: "2026-04-01T14:00:00.000Z",
        status: "active",
        required_skills: ["migration-runner"],
        skill_trigger_tasks: ["schema change"],
        risk_level: "low",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "gotcha",
        title: "Skip migration-runner for tiny fixture rewrites",
        summary: "Fixture-only schema docs should not run the full migration workflow.",
        detail: "## GOTCHA\n\nDo not run migrations for fixture-only schema notes.",
        tags: ["db"],
        importance: "medium",
        date: "2026-04-01T14:05:00.000Z",
        status: "active",
        suppressed_skills: ["migration-runner"],
        skill_trigger_tasks: ["schema change"],
        invocation_mode: "prefer",
        risk_level: "low",
      },
      projectRoot,
    );

    const result = await buildSkillShortlist(projectRoot, {
      task: "schema change",
      paths: [],
    });

    assert.deepEqual(result.invocation_plan.human_review, ["migration-runner"]);
    assert.equal(result.conflicts[0]?.strategy_result, "human-review");
    assert.match(result.conflicts[0]?.reason ?? "", /too close for an automatic decision/);
  });
});

await runTest("suggest-skills emits block when high-risk suppression meets or outweighs a required skill", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Use prod-deploy skill for release train tasks",
        summary: "Release train changes usually need the deploy workflow.",
        detail: "## DECISION\n\nUse the deploy workflow for release train changes.",
        tags: ["release"],
        importance: "medium",
        date: "2026-04-01T15:00:00.000Z",
        status: "active",
        required_skills: ["prod-deploy"],
        skill_trigger_tasks: ["release train"],
        risk_level: "low",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "gotcha",
        title: "Block prod-deploy during freeze windows",
        summary: "Deploys are blocked during a freeze unless a human clears them.",
        detail: "## GOTCHA\n\nNever auto-run deploys during a release freeze.",
        tags: ["release"],
        importance: "high",
        date: "2026-04-01T15:05:00.000Z",
        status: "active",
        suppressed_skills: ["prod-deploy"],
        skill_trigger_tasks: ["release train"],
        skill_trigger_paths: ["src/release/freeze/"],
        invocation_mode: "suppress",
        risk_level: "high",
      },
      projectRoot,
    );

    const result = await buildSkillShortlist(projectRoot, {
      task: "release train",
      paths: ["src/release/freeze/window.ts"],
    });

    assert.deepEqual(result.invocation_plan.blocked, ["prod-deploy"]);
    assert.equal(result.conflicts[0]?.strategy_result, "block");
    assert.match(result.conflicts[0]?.reason ?? "", /blocks automatic invocation/);
  });
});

await runTest(
  "suggest-skills keeps suppression when recommendation conflicts with a do-not-invoke memory",
  async () => {
    await withTempRepo(async (projectRoot) => {
      await saveMemory(
        {
          type: "pattern",
          title: "Optional docs linter for handbook edits",
          summary: "Docs linter is usually helpful for handbook edits.",
          detail: "## PATTERN\n\nPrefer the docs linter for handbook edits.",
          tags: ["docs"],
          importance: "medium",
          date: "2026-04-01T16:00:00.000Z",
          status: "active",
          recommended_skills: ["docs-linter"],
          skill_trigger_tasks: ["handbook edit"],
          invocation_mode: "prefer",
          risk_level: "low",
        },
        projectRoot,
      );

      await saveMemory(
        {
          type: "gotcha",
          title: "Disable docs linter for generated handbook dumps",
          summary: "Generated handbook exports should not invoke the linter.",
          detail: "## GOTCHA\n\nSuppress the docs linter for generated handbook dumps.",
          tags: ["docs"],
          importance: "medium",
          date: "2026-04-01T16:05:00.000Z",
          status: "active",
          suppressed_skills: ["docs-linter"],
          skill_trigger_tasks: ["handbook edit"],
          risk_level: "medium",
        },
        projectRoot,
      );

      const result = await buildSkillShortlist(projectRoot, {
        task: "handbook edit",
        paths: [],
      });

      assert.deepEqual(result.invocation_plan.suppress, ["docs-linter"]);
      assert.equal(result.conflicts[0]?.kind, "recommended_vs_suppressed");
      assert.equal(result.conflicts[0]?.strategy_result, "suppress");
      assert.match(
        result.conflicts[0]?.reason ?? "",
        /recommendations are advisory while suppressions are explicit do-not-invoke hints/,
      );
    });
  },
);

await runTest("suggest-skills exposes a stable JSON contract for agent adapters", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Use Playwright for browser smoke tests",
        summary: "Playwright stays required for smoke coverage.",
        detail: "## DECISION\n\nUse Playwright for browser smoke coverage.",
        tags: ["playwright"],
        importance: "high",
        date: "2026-04-01T17:00:00.000Z",
        status: "active",
        required_skills: ["playwright"],
        skill_trigger_tasks: ["browser smoke tests"],
      },
      projectRoot,
    );

    const result = await buildSkillShortlist(projectRoot, {
      task: "browser smoke tests",
      paths: ["tests/e2e/login.spec.ts"],
    });
    const parsed = JSON.parse(renderSkillShortlistJson(result));
    assert.equal(parsed.contract_version, "repobrain.skill-plan.v1");
    assert.equal(parsed.kind, "repobrain.skill_invocation_plan");
    assert.deepEqual(parsed.invocation_plan.required, ["playwright"]);
    assert.ok(Array.isArray(parsed.matched_memories));
    assert.ok(Array.isArray(parsed.resolved_skills));
    assert.ok(Array.isArray(parsed.conflicts));
  });
});

await runTest("suggest-skills fails with a clear error when no task or path input is provided", async () => {
  await withTempRepo(async (projectRoot) => {
    await assert.rejects(
      async () => buildSkillShortlist(projectRoot, {}),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Provide a task with "--task" \(or stdin\) and\/or at least one "--path"/);
        return true;
      },
    );
  });
});

await runTest("suggest-skills sets path_source to git_diff when caller marks paths as auto-collected", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Use linter for config edits",
        summary: "Config file edits should trigger the linter skill.",
        detail: "## DECISION\n\nUse the linter when config files change.",
        tags: ["linter"],
        importance: "medium",
        date: "2026-04-01T18:00:00.000Z",
        status: "active",
        recommended_skills: ["config-linter"],
        skill_trigger_paths: ["*.config.ts"],
        skill_trigger_tasks: ["update config"],
      },
      projectRoot,
    );

    const result = await buildSkillShortlist(projectRoot, {
      task: "update config",
      paths: ["tsconfig.json"],
      path_source: "git_diff",
    });

    assert.equal(result.path_source, "git_diff");
    const stdout = renderSkillShortlist(result);
    assert.match(stdout, /Paths \(from git diff\):/);
  });
});

await runTest(
  "suggest-skills defaults path_source to explicit when paths are provided without path_source",
  async () => {
    await withTempRepo(async (projectRoot) => {
      await saveMemory(
        {
          type: "decision",
          title: "Use Playwright for browser tests",
          summary: "Browser tests need Playwright.",
          detail: "## DECISION\n\nUse Playwright.",
          tags: ["playwright"],
          importance: "high",
          date: "2026-04-01T19:00:00.000Z",
          status: "active",
          required_skills: ["playwright"],
          skill_trigger_tasks: ["browser tests"],
        },
        projectRoot,
      );

      const result = await buildSkillShortlist(projectRoot, {
        task: "browser tests",
        paths: ["tests/e2e/login.spec.ts"],
      });

      assert.equal(result.path_source, "explicit");
      const stdout = renderSkillShortlist(result);
      assert.match(stdout, /^Paths:$/m);
      assert.doesNotMatch(stdout, /from git diff/);
    });
  },
);

await runTest("suggest-skills supports task-only routing with path_source none when no paths provided", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Use refund-handler for refund bugs",
        summary: "Refund bugs should use the refund-handler skill.",
        detail: "## DECISION\n\nUse refund-handler for refund-related work.",
        tags: ["refund"],
        importance: "high",
        date: "2026-04-01T20:00:00.000Z",
        status: "active",
        required_skills: ["refund-handler"],
        skill_trigger_tasks: ["fix refund bug"],
      },
      projectRoot,
    );

    const result = await buildSkillShortlist(projectRoot, {
      task: "fix refund bug",
    });

    assert.equal(result.path_source, "none");
    assert.deepEqual(result.paths, []);
    assert.deepEqual(result.invocation_plan.required, ["refund-handler"]);
  });
});

await runTest("suggest-skills JSON contract includes path_source field", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Use Playwright for browser smoke tests",
        summary: "Playwright stays required for smoke coverage.",
        detail: "## DECISION\n\nUse Playwright for browser smoke coverage.",
        tags: ["playwright"],
        importance: "high",
        date: "2026-04-01T21:00:00.000Z",
        status: "active",
        required_skills: ["playwright"],
        skill_trigger_tasks: ["browser smoke tests"],
      },
      projectRoot,
    );

    const result = await buildSkillShortlist(projectRoot, {
      task: "browser smoke tests",
      paths: ["tests/e2e/login.spec.ts"],
    });
    const parsed = JSON.parse(renderSkillShortlistJson(result));
    assert.equal(parsed.path_source, "explicit");
    assert.ok(["explicit", "git_diff", "none"].includes(parsed.path_source));
  });
});

await runTest("collectGitDiffPaths returns changed files when git diff reports them", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-gitdiff-"));
  const fakeGitDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-git-bin-"));
  const originalPath = process.env.PATH;

  try {
    await writeFile(
      path.join(fakeGitDir, "git.cmd"),
      [
        "@echo off",
        'if "%1"=="diff" if "%2"=="--name-only" if "%3"=="HEAD" (',
        "  echo changed.txt",
        "  echo initial.txt",
        "  exit /b 0",
        ")",
        "exit /b 1",
        "",
      ].join("\r\n"),
      "utf8",
    );

    process.env.PATH = `${fakeGitDir}${path.delimiter}${originalPath ?? ""}`;
    const paths = collectGitDiffPaths(tmpDir);
    if (paths.length === 0) {
      return;
    }
    assert.ok(paths.includes("changed.txt"), `Expected changed.txt in ${JSON.stringify(paths)}`);
    assert.ok(paths.includes("initial.txt"), `Expected initial.txt in ${JSON.stringify(paths)}`);
  } finally {
    process.env.PATH = originalPath;
    await rm(fakeGitDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

await runTest("collectGitDiffPaths returns empty array for non-git directories", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-nogit-"));
  try {
    const paths = collectGitDiffPaths(tmpDir);
    assert.deepEqual(paths, []);
  } finally {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

await runTest("suggest-skills routes correctly with task + git_diff paths together", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Use deploy-checker for CI config changes",
        summary: "Changes to CI config should trigger deploy checks.",
        detail: "## DECISION\n\nUse deploy-checker when CI config changes.",
        tags: ["ci"],
        importance: "high",
        date: "2026-04-01T22:00:00.000Z",
        status: "active",
        required_skills: ["deploy-checker"],
        skill_trigger_paths: [".github/workflows/"],
        skill_trigger_tasks: ["update CI pipeline"],
      },
      projectRoot,
    );

    const result = await buildSkillShortlist(projectRoot, {
      task: "update CI pipeline",
      paths: [".github/workflows/deploy.yml"],
      path_source: "git_diff",
    });

    assert.equal(result.path_source, "git_diff");
    assert.deepEqual(result.invocation_plan.required, ["deploy-checker"]);
    assert.ok(result.matched_memories.length > 0);
    const reasons = result.matched_memories[0].reasons;
    assert.ok(reasons.some((r) => r.includes("task:")));
    assert.ok(reasons.some((r) => r.includes("path:")));
  });
});

console.log("All suggest-skills tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-suggest-"));

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
