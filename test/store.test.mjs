import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  initBrain,
  loadMemoryIndexCache,
  loadAllMemories,
  loadConfig,
  loadStoredMemoryRecords,
  renderConfigWarnings,
  updateIndex,
} from "../dist/store-api.js";
import { saveMemory } from "./provenance-fixtures.mjs";

const repoRoot = process.cwd();

await runTest("legacy .brain entries load with safe skill routing defaults", async () => {
  await withTempRepo(async (projectRoot) => {
    const legacyPath = path.join(projectRoot, ".brain", "decisions", "2026-03-31-legacy.md");
    await writeFile(
      legacyPath,
      [
        "---",
        'type: "decision"',
        'title: "Keep legacy entries compatible"',
        'summary: "Old entries should still load without new routing metadata."',
        "tags:",
        '  - "compatibility"',
        'importance: "medium"',
        'date: "2026-03-31T08:00:00.000Z"',
        'source: "manual"',
        "---",
        "",
        "## DECISION",
        "",
        "Legacy entries should continue to load after the schema expands.",
        "",
      ].join("\n"),
      "utf8",
    );

    const memories = await loadAllMemories(projectRoot);
    assert.equal(memories.length, 1);

    const memory = memories[0];
    assert.ok(memory);
    assert.deepEqual(memory.path_scope, []);
    assert.deepEqual(memory.recommended_skills, []);
    assert.deepEqual(memory.required_skills, []);
    assert.deepEqual(memory.suppressed_skills, []);
    assert.deepEqual(memory.skill_trigger_paths, []);
    assert.deepEqual(memory.skill_trigger_tasks, []);
    assert.equal(memory.score, 60);
    assert.equal(memory.hit_count, 0);
    assert.equal(memory.last_used, null);
    assert.equal(memory.created_at, "2026-03-31T08:00:00.000Z");
    assert.equal(memory.stale, false);
    assert.equal(memory.supersedes, null);
    assert.equal(memory.superseded_by, null);
    assert.equal(memory.version, 1);
    assert.deepEqual(memory.related, []);
    assert.equal(memory.invocation_mode, "optional");
    assert.equal(memory.risk_level, "low");
    assert.equal(memory.origin, undefined);
  });
});

await runTest("new skill routing fields round-trip through save and load", async () => {
  await withTempRepo(async (projectRoot) => {
    const memory = {
      type: "decision",
      title: "Route E2E work to the Playwright skill",
      summary: "Prefer the Playwright skill when browser test files or tasks are involved.",
      detail: [
        "## DECISION",
        "",
        "Route Playwright-heavy work to the Playwright skill when the task touches browser tests.",
      ].join("\n"),
      tags: ["skills", "routing"],
      importance: "high",
      date: "2026-04-01T10:00:00.000Z",
      source: "manual",
      status: "active",
      path_scope: ["src/browser/", "src/web/**"],
      recommended_skills: ["github:gh-fix-ci"],
      required_skills: ["playwright"],
      suppressed_skills: ["imagegen"],
      skill_trigger_paths: ["tests/e2e/", "playwright.config.ts"],
      skill_trigger_tasks: ["debug flaky browser tests"],
      score: 82,
      hit_count: 4,
      last_used: "2026-04-01T18:30:00.000Z",
      created_at: "2026-04-01T10:00:00.000Z",
      stale: true,
      supersedes: "decisions/2026-03-30-old-browser-guidance.md",
      superseded_by: null,
      version: 2,
      related: ["patterns/2026-04-01-browser-pattern.md"],
      invocation_mode: "prefer",
      risk_level: "medium",
      origin: "failure",
    };

    const filePath = await saveMemory(memory, projectRoot);
    const raw = await readFile(filePath, "utf8");

    assert.match(raw, /path_scope:/);
    assert.match(raw, /recommended_skills:/);
    assert.match(raw, /required_skills:/);
    assert.match(raw, /suppressed_skills:/);
    assert.match(raw, /skill_trigger_paths:/);
    assert.match(raw, /skill_trigger_tasks:/);
    assert.match(raw, /score: 82/);
    assert.match(raw, /hit_count: 4/);
    assert.match(raw, /last_used: "?2026-04-01T18:30:00.000Z"?/);
    assert.match(raw, /created_at: "?2026-04-01T10:00:00.000Z"?/);
    assert.match(raw, /stale: true/);
    assert.match(raw, /supersedes: "?decisions\/2026-03-30-old-browser-guidance.md"?/);
    assert.match(raw, /superseded_by: null/);
    assert.match(raw, /version: 2/);
    assert.match(raw, /related:/);
    assert.match(raw, /invocation_mode: "?prefer"?/);
    assert.match(raw, /risk_level: "?medium"?/);
    assert.match(raw, /origin: "?failure"?/);

    const records = await loadStoredMemoryRecords(projectRoot);
    assert.equal(records.length, 1);

    const stored = records[0]?.memory;
    assert.ok(stored);
    assert.deepEqual(stored.path_scope, ["src/browser", "src/web/**"]);
    assert.deepEqual(stored.recommended_skills, ["github:gh-fix-ci"]);
    assert.deepEqual(stored.required_skills, ["playwright"]);
    assert.deepEqual(stored.suppressed_skills, ["imagegen"]);
    assert.deepEqual(stored.skill_trigger_paths, ["playwright.config.ts", "tests/e2e"]);
    assert.deepEqual(stored.skill_trigger_tasks, ["debug flaky browser tests"]);
    assert.equal(stored.score, 82);
    assert.equal(stored.hit_count, 4);
    assert.equal(stored.last_used, "2026-04-01T18:30:00.000Z");
    assert.equal(stored.created_at, "2026-04-01T10:00:00.000Z");
    assert.equal(stored.stale, true);
    assert.equal(stored.supersedes, "decisions/2026-03-30-old-browser-guidance.md");
    assert.equal(stored.superseded_by, null);
    assert.equal(stored.version, 2);
    assert.deepEqual(stored.related, ["patterns/2026-04-01-browser-pattern.md"]);
    assert.equal(stored.invocation_mode, "prefer");
    assert.equal(stored.risk_level, "medium");
    assert.equal(stored.origin, "failure");
  });
});

await runTest("updateIndex writes a derived memory-index cache without changing markdown source-of-truth", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Cache metadata mirrors markdown memories",
        summary: "The derived cache should be regenerated from markdown files.",
        detail: "## DECISION\n\nThe markdown memory remains the source of truth.",
        tags: ["cache", "index"],
        importance: "medium",
        date: "2026-04-08T09:00:00.000Z",
        status: "active",
        risk_level: "high",
        path_scope: ["src/cache/**"],
        files: ["src/cache/index.ts"],
      },
      projectRoot,
    );

    await updateIndex(projectRoot);

    const cachePath = path.join(projectRoot, ".brain", "memory-index.json");
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw);

    assert.equal(parsed.version, 1);
    assert.equal(parsed.entry_count, 1);
    assert.equal(
      parsed.entries[0]?.relativePath,
      "decisions/2026-04-08-cache-metadata-mirrors-markdown-memories-090000000.md",
    );
    assert.equal(parsed.entries[0]?.risk_level, "high");
    assert.deepEqual(parsed.entries[0]?.path_scope, ["src/cache/**"]);
    assert.deepEqual(parsed.entries[0]?.files, ["src/cache/index.ts"]);
    assert.equal(typeof parsed.entries[0]?.token_size, "number");

    const loaded = await loadMemoryIndexCache(projectRoot);
    assert.equal(loaded.status, "ready");
    assert.equal(loaded.cache?.entry_count, 1);
  });
});

await runTest("inject updates usage metadata on selected memories", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Track injection usage metadata",
        summary: "Injected memories should update hit_count and last_used.",
        detail: "## DECISION\n\nTrack usage metadata when a memory is injected.",
        tags: ["metrics"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        score: 60,
        hit_count: 1,
        last_used: null,
        created_at: "2026-04-01T08:00:00.000Z",
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    const result = await runNodeProcess([path.join(repoRoot, "dist", "cli.js"), "inject"], projectRoot);

    assert.equal(result.code, 0);

    const memories = await loadAllMemories(projectRoot);
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.hit_count, 2);
    assert.equal(memories[0]?.stale, false);
    assert.ok(memories[0]?.last_used);
  });
});

await runTest("same-title active memories with different scopes do not supersede each other", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Cache invalidation rules",
        summary: "API cache invalidation should happen after mutation commits.",
        detail:
          "## DECISION\n\nAPI cache invalidation should happen after mutation commits so readers do not observe partial state.",
        tags: ["cache", "api"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["src/api/**"],
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Cache invalidation rules",
        summary: "Web cache invalidation should happen after optimistic updates settle.",
        detail:
          "## DECISION\n\nWeb cache invalidation should happen after optimistic updates settle so the UI does not discard newer local state.",
        tags: ["cache", "web"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        path_scope: ["src/web/**"],
      },
      projectRoot,
    );

    const memories = await loadAllMemories(projectRoot);
    const activeMemories = memories.filter((memory) => memory.status === "active");

    assert.equal(activeMemories.length, 2);
    assert.deepEqual(
      activeMemories.map((memory) => memory.path_scope),
      [["src/web/**"], ["src/api/**"]],
    );
  });
});

await runTest("brain supersede links two memories and bumps the new version from the old one", async () => {
  await withTempRepo(async (projectRoot) => {
    const oldDate = "2026-04-01T08:00:00.000Z";
    const newDate = "2026-04-01T09:00:00.000Z";

    await saveMemory(
      {
        type: "decision",
        title: "Use tsc",
        summary: "Older build guidance.",
        detail: "## DECISION\n\nUse tsc for builds.",
        tags: ["build"],
        importance: "medium",
        date: oldDate,
        status: "active",
        version: 1,
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Use tsup",
        summary: "Newer build guidance.",
        detail: "## DECISION\n\nUse tsup for builds.",
        tags: ["build"],
        importance: "high",
        date: newDate,
        status: "active",
        version: 1,
      },
      projectRoot,
    );

    const result = await runNodeProcess(
      [path.join(repoRoot, "dist", "cli.js"), "supersede", "decisions/use-tsup.md", "decisions/use-tsc.md"],
      projectRoot,
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /✓ \[brain\] (已建立取代关系|Supersede relationship linked)/);
    assert.match(result.stdout, /(新记忆|New memory): decisions\/2026-04-01-use-tsup-090000000\.md  \(v2\)/);
    assert.match(
      result.stdout,
      /(旧记忆: decisions\/2026-04-01-use-tsc-080000000\.md  → 已标记为 stale|Old memory: decisions\/2026-04-01-use-tsc-080000000\.md  -> marked as stale)/,
    );

    const records = await loadStoredMemoryRecords(projectRoot);
    const oldRecord = records.find((entry) => entry.memory.title === "Use tsc");
    const newRecord = records.find((entry) => entry.memory.title === "Use tsup");

    assert.ok(oldRecord);
    assert.ok(newRecord);
    assert.equal(newRecord.memory.supersedes, "decisions/2026-04-01-use-tsc-080000000.md");
    assert.equal(newRecord.memory.version, 2);
    assert.equal(oldRecord.memory.superseded_by, "decisions/2026-04-01-use-tsup-090000000.md");
    assert.equal(oldRecord.memory.stale, true);
  });
});

await runTest("brain supersede prints a friendly error when a memory file is missing", async () => {
  await withTempRepo(async (projectRoot) => {
    const result = await runNodeProcess(
      [path.join(repoRoot, "dist", "cli.js"), "supersede", "decisions/use-tsup.md", "decisions/use-tsc.md"],
      projectRoot,
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Memory file "decisions\/use-tsup\.md" was not found/);
    assert.match(result.stderr, /Run "brain list" to inspect available memories/);
  });
});

await runTest("brain supersede can overwrite an existing relationship with --yes", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Use tsc",
        summary: "Older build guidance.",
        detail: "## DECISION\n\nUse tsc for builds.",
        tags: ["build"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        version: 1,
        superseded_by: "decisions/2026-04-01-use-esbuild-100000000.md",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Use tsup",
        summary: "Newer build guidance.",
        detail: "## DECISION\n\nUse tsup for builds.",
        tags: ["build"],
        importance: "high",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        version: 1,
        supersedes: "decisions/2026-04-01-use-webpack-070000000.md",
      },
      projectRoot,
    );

    const result = await runNodeProcess(
      [path.join(repoRoot, "dist", "cli.js"), "supersede", "--yes", "decisions/use-tsup.md", "decisions/use-tsc.md"],
      projectRoot,
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /\[brain\] (当前已存在取代关系|Existing supersede relationships):/);
    assert.match(result.stdout, /新记忆当前 supersedes: decisions\/2026-04-01-use-webpack-070000000\.md/);
    assert.match(result.stdout, /旧记忆当前 superseded_by: decisions\/2026-04-01-use-esbuild-100000000\.md/);
    assert.match(result.stdout, /✓ \[brain\] (已建立取代关系|Supersede relationship linked)/);

    const records = await loadStoredMemoryRecords(projectRoot);
    const oldRecord = records.find((entry) => entry.memory.title === "Use tsc");
    const newRecord = records.find((entry) => entry.memory.title === "Use tsup");

    assert.ok(oldRecord);
    assert.ok(newRecord);
    assert.equal(newRecord.memory.supersedes, "decisions/2026-04-01-use-tsc-080000000.md");
    assert.equal(newRecord.memory.version, 2);
    assert.equal(oldRecord.memory.superseded_by, "decisions/2026-04-01-use-tsup-090000000.md");
    assert.equal(oldRecord.memory.stale, true);
  });
});

await runTest("brain lineage prints all latest roots and their superseded chains", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Use tsc",
        summary: "Old build guidance.",
        detail: "## DECISION\n\nUse tsc.",
        tags: ["build"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        version: 1,
        score: 45,
        stale: true,
        superseded_by: "decisions/2026-04-01-use-tsup-090000000.md",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Use tsup",
        summary: "New build guidance.",
        detail: "## DECISION\n\nUse tsup.",
        tags: ["build"],
        importance: "high",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        version: 2,
        score: 90,
        supersedes: "decisions/2026-04-01-use-tsc-080000000.md",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "gotcha",
        title: "dist generated",
        summary: "Oldest dist warning.",
        detail: "## GOTCHA\n\nDist is generated.",
        tags: ["dist"],
        importance: "low",
        date: "2026-04-01T07:00:00.000Z",
        status: "active",
        version: 1,
        score: 30,
        stale: true,
        superseded_by: "gotchas/2026-04-01-check-dist-080000000.md",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "gotcha",
        title: "check dist",
        summary: "Middle dist warning.",
        detail: "## GOTCHA\n\nCheck dist before editing.",
        tags: ["dist"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        version: 2,
        score: 70,
        stale: true,
        supersedes: "gotchas/2026-04-01-dist-generated-070000000.md",
        superseded_by: "gotchas/2026-04-01-no-direct-dist-edit-090000000.md",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "gotcha",
        title: "no direct dist edit",
        summary: "Latest dist warning.",
        detail: "## GOTCHA\n\nDo not edit dist directly.",
        tags: ["dist"],
        importance: "high",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        version: 3,
        score: 95,
        supersedes: "gotchas/2026-04-01-check-dist-080000000.md",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "pattern",
        title: "Standalone pattern",
        summary: "No lineage.",
        detail: "## PATTERN\n\nStandalone.",
        tags: ["solo"],
        importance: "low",
        date: "2026-04-01T10:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    const result = await runNodeProcess([path.join(repoRoot, "dist", "cli.js"), "lineage"], projectRoot);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /\[decision\] decisions\/use-tsup\.md  v2 · score:90 · ✓ 有效/);
    assert.match(result.stdout, /└── supersedes: \[decision\] decisions\/use-tsc\.md  v1 · score:45 · ✗ 已过期/);
    assert.match(result.stdout, /\[gotcha\] gotchas\/no-direct-dist-edit\.md  v3 · score:95 · ✓ 有效/);
    assert.match(result.stdout, /└── supersedes: \[gotcha\] gotchas\/check-dist\.md  v2 · score:70 · ✗ 已过期/);
    assert.match(result.stdout, /└── supersedes: \[gotcha\] gotchas\/dist-generated\.md  v1 · score:30 · ✗ 已过期/);
    assert.doesNotMatch(result.stdout, /Standalone pattern/);
  });
});

await runTest("brain lineage shows the full chain for a specified memory file", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "gotcha",
        title: "dist generated",
        summary: "Oldest dist warning.",
        detail: "## GOTCHA\n\nDist is generated.",
        tags: ["dist"],
        importance: "low",
        date: "2026-04-01T07:00:00.000Z",
        status: "active",
        version: 1,
        score: 30,
        stale: true,
        superseded_by: "gotchas/2026-04-01-check-dist-080000000.md",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "gotcha",
        title: "check dist",
        summary: "Middle dist warning.",
        detail: "## GOTCHA\n\nCheck dist before editing.",
        tags: ["dist"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        version: 2,
        score: 70,
        stale: true,
        supersedes: "gotchas/2026-04-01-dist-generated-070000000.md",
        superseded_by: "gotchas/2026-04-01-no-direct-dist-edit-090000000.md",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "gotcha",
        title: "no direct dist edit",
        summary: "Latest dist warning.",
        detail: "## GOTCHA\n\nDo not edit dist directly.",
        tags: ["dist"],
        importance: "high",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        version: 3,
        score: 95,
        supersedes: "gotchas/2026-04-01-check-dist-080000000.md",
      },
      projectRoot,
    );

    const result = await runNodeProcess(
      [path.join(repoRoot, "dist", "cli.js"), "lineage", "gotchas/check-dist.md"],
      projectRoot,
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /\[gotcha\] gotchas\/no-direct-dist-edit\.md  v3 · score:95 · ✓ 有效/);
    assert.match(result.stdout, /└── supersedes: \[gotcha\] gotchas\/check-dist\.md  v2 · score:70 · ✗ 已过期/);
    assert.match(result.stdout, /└── supersedes: \[gotcha\] gotchas\/dist-generated\.md  v1 · score:30 · ✗ 已过期/);
  });
});

await runTest("brain lineage reports when a specified memory has no lineage relationships", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "pattern",
        title: "Standalone pattern",
        summary: "No lineage.",
        detail: "## PATTERN\n\nStandalone.",
        tags: ["solo"],
        importance: "low",
        date: "2026-04-01T10:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    const result = await runNodeProcess(
      [path.join(repoRoot, "dist", "cli.js"), "lineage", "patterns/standalone-pattern.md"],
      projectRoot,
    );

    assert.equal(result.code, 0);
    assert.match(
      result.stdout,
      /Memory "patterns\/2026-04-01-standalone-pattern-100000000\.md" has no lineage relationships\./,
    );
  });
});

await runTest("brain lineage detects cycles and exits with an error", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "A",
        summary: "A.",
        detail: "## DECISION\n\nA.",
        tags: ["cycle"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        version: 1,
        score: 50,
        supersedes: "decisions/2026-04-01-b-090000000.md",
        superseded_by: "decisions/2026-04-01-b-090000000.md",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "B",
        summary: "B.",
        detail: "## DECISION\n\nB.",
        tags: ["cycle"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        version: 2,
        score: 60,
        supersedes: "decisions/2026-04-01-a-080000000.md",
        superseded_by: "decisions/2026-04-01-a-080000000.md",
      },
      projectRoot,
    );

    const result = await runNodeProcess([path.join(repoRoot, "dist", "cli.js"), "lineage"], projectRoot);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Memory lineage contains a cycle involving/);
  });
});

await runTest("invalid invocation_mode in stored memory fails with a clear parse error", async () => {
  await withTempRepo(async (projectRoot) => {
    const invalidPath = path.join(projectRoot, ".brain", "decisions", "2026-04-01-invalid-mode.md");
    await writeFile(
      invalidPath,
      [
        "---",
        'type: "decision"',
        'title: "Broken routing mode"',
        'summary: "This entry should fail validation."',
        "tags:",
        'importance: "medium"',
        'date: "2026-04-01T09:00:00.000Z"',
        'invocation_mode: "sometimes"',
        "---",
        "",
        "## DECISION",
        "",
        "This file intentionally uses an invalid invocation mode.",
        "",
      ].join("\n"),
      "utf8",
    );

    await assert.rejects(
      async () => loadAllMemories(projectRoot),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /invalid-mode\.md/);
        assert.match(error.message, /unsupported invocation_mode "sometimes"/);
        assert.match(error.message, /required, prefer, optional, suppress/);
        return true;
      },
    );
  });
});

await runTest("invalid risk_level is rejected during save with a clear validation error", async () => {
  await withTempRepo(async (projectRoot) => {
    const invalidMemory = {
      type: "decision",
      title: "Broken risk metadata",
      summary: "This entry should fail validation before it is written.",
      detail: "## DECISION\n\nThis file intentionally uses an invalid risk level.",
      tags: ["skills"],
      importance: "medium",
      date: "2026-04-01T11:00:00.000Z",
      risk_level: "urgent",
    };

    await assert.rejects(
      async () => saveMemory(invalidMemory, projectRoot),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /unsupported risk_level "urgent"/);
        assert.match(error.message, /high, medium, low/);
        return true;
      },
    );
  });
});

await runTest("corrupted placeholder title/summary are rejected during save", async () => {
  await withTempRepo(async (projectRoot) => {
    const invalidMemory = {
      type: "gotcha",
      title: "??????????",
      summary: "？？？？？？",
      detail: "## GOTCHA\n\nThis should fail because title/summary were corrupted before write.",
      tags: ["encoding"],
      importance: "medium",
      date: "2026-04-07T03:02:33.223Z",
    };

    await assert.rejects(
      async () => saveMemory(invalidMemory, projectRoot),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /corrupted placeholder text/);
        assert.match(error.message, /UTF-8/);
        return true;
      },
    );
  });
});

await runTest("mixed text with long placeholder question mark runs is rejected during save", async () => {
  await withTempRepo(async (projectRoot) => {
    const invalidMemory = {
      type: "gotcha",
      title: "success/error/finally ????????????????。",
      summary: "Node stream decode fallback ?????????",
      detail: "## GOTCHA\n\nThis should fail because mixed text still shows corrupted placeholders.",
      tags: ["encoding"],
      importance: "medium",
      date: "2026-04-07T08:39:07.224Z",
    };

    await assert.rejects(
      async () => saveMemory(invalidMemory, projectRoot),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /corrupted placeholder text/);
        return true;
      },
    );
  });
});

await runTest("invalid score in stored memory fails with a clear parse error", async () => {
  await withTempRepo(async (projectRoot) => {
    const invalidPath = path.join(projectRoot, ".brain", "decisions", "2026-04-01-invalid-score.md");
    await writeFile(
      invalidPath,
      [
        "---",
        'type: "decision"',
        'title: "Broken score metadata"',
        'summary: "This entry should fail validation."',
        "tags:",
        'importance: "medium"',
        'date: "2026-04-01T09:00:00.000Z"',
        'score: "very-good"',
        "---",
        "",
        "## DECISION",
        "",
        "This file intentionally uses an invalid score.",
        "",
      ].join("\n"),
      "utf8",
    );

    await assert.rejects(
      async () => loadAllMemories(projectRoot),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /invalid-score\.md/);
        assert.match(error.message, /invalid score/);
        assert.match(error.message, /0 and 100/);
        return true;
      },
    );
  });
});

await runTest("legacy remote review config fields are ignored with a deprecation warning", async () => {
  await withTempRepo(async (projectRoot) => {
    await writeFile(
      path.join(projectRoot, ".brain", "config.yaml"),
      [
        "maxInjectTokens: 1200",
        "extractMode: suggest",
        "language: zh-CN",
        "reviewProvider: openai",
        "reviewModel: gpt-5",
        "reviewApiKey: should-not-be-used",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = await loadConfig(projectRoot);
    const warnings = renderConfigWarnings(config);

    assert.equal(config.extractMode, "suggest");
    assert.equal(config.triggerMode, "detect");
    assert.equal(config.captureMode, "candidate");
    assert.equal(config.maxInjectTokens, 1200);
    assert.equal(config.language, "zh-CN");
    assert.equal(warnings.length, 2);
    const remoteWarning = warnings.find((w) => w.includes("Ignoring deprecated remote review"));
    const extractWarning = warnings.find((w) => w.includes("extractMode"));
    assert.ok(remoteWarning, "should have a remote review deprecation warning");
    assert.match(remoteWarning, /reviewApiKey/);
    assert.match(remoteWarning, /reviewModel/);
    assert.match(remoteWarning, /reviewProvider/);
    assert.ok(extractWarning, "should have an extractMode deprecation warning");
    assert.match(extractWarning, /triggerMode: detect/);
  });
});

await runTest(
  "cli extract does not crash or call any remote path when legacy review config fields remain",
  async () => {
    await withTempRepo(async (projectRoot) => {
      await writeFile(
        path.join(projectRoot, ".brain", "config.yaml"),
        [
          "maxInjectTokens: 1200",
          "extractMode: suggest",
          "language: zh-CN",
          "provider: anthropic",
          "model: claude-sonnet",
          "apiKey: should-not-be-used",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runNodeProcess(
        [path.join(repoRoot, "dist", "cli.js"), "extract", "--source", "session"],
        projectRoot,
        [
          "decision: Keep API writes inside a transaction helper",
          "",
          "Mutation-heavy API flows should route writes through the transaction helper for consistency and rollback safety.",
        ].join("\n"),
      );

      assert.equal(result.code, 0);
      assert.match(result.stderr, /Ignoring deprecated remote review config fields/);
      assert.match(result.stdout, /decision=accept|accept \|/i);

      const memories = await loadAllMemories(projectRoot);
      assert.equal(memories.length, 1);
      assert.equal(memories[0]?.title, "Keep API writes inside a transaction helper");
    });
  },
);

await runTest("cli extract writes initial memory metadata with legal frontmatter ordering", async () => {
  await withTempRepo(async (projectRoot) => {
    const result = await runNodeProcess(
      [path.join(repoRoot, "dist", "cli.js"), "extract", "--source", "session"],
      projectRoot,
      [
        "gotcha: Never write payments outside the transaction helper",
        "",
        "Critical payments updates must stay inside the transaction helper or partial writes can leak into ledger sync.",
      ].join("\n"),
    );

    assert.equal(result.code, 0);

    const records = await loadStoredMemoryRecords(projectRoot);
    assert.equal(records.length, 1);

    const stored = records[0];
    assert.ok(stored);
    assert.equal(stored.memory.type, "gotcha");
    assert.equal(stored.memory.importance, "high");
    assert.equal(stored.memory.score, 75);
    assert.equal(stored.memory.hit_count, 0);
    assert.equal(stored.memory.last_used, null);
    assert.equal(stored.memory.created_at?.length, 24);
    assert.equal(stored.memory.stale, false);

    const raw = await readFile(stored.filePath, "utf8");
    const scoreIndex = raw.indexOf("score: 75");
    const hitCountIndex = raw.indexOf("hit_count: 0");
    const lastUsedIndex = raw.indexOf("last_used: null");
    const createdAtIndex = raw.indexOf("created_at:");
    const staleIndex = raw.indexOf("stale: false");
    const dateIndex = raw.indexOf("date:");

    assert.ok(scoreIndex > raw.indexOf('importance: "high"'));
    assert.ok(hitCountIndex > scoreIndex);
    assert.ok(lastUsedIndex > hitCountIndex);
    assert.ok(createdAtIndex > lastUsedIndex);
    assert.ok(staleIndex > createdAtIndex);
    assert.ok(dateIndex > staleIndex);
    assert.match(raw, /created_at:\s*"?\d{4}-\d{2}-\d{2}T00:00:00.000Z"?/);
  });
});

await runTest("working and goal frontmatter fields round-trip with backward-compatible defaults", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "working",
        title: "Temporary auth migration checklist",
        summary: "Keep a short-lived migration checklist for the auth rollout.",
        detail: "## WORKING\n\nTrack the auth migration checklist until the rollout is complete.",
        tags: ["auth", "migration"],
        importance: "medium",
        date: "2026-04-02T09:00:00.000Z",
        created: "2026-04-02",
        updated: "2026-04-03",
        area: "auth",
        files: ["src/auth/**"],
        expires: "2026-04-09",
        status: "active",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "goal",
        title: "Finish DB connection pooling cleanup",
        summary: "Track the durable cleanup goal across sessions.",
        detail: "## GOAL\n\nFinish the DB connection pooling cleanup and remove the legacy path.",
        tags: ["db"],
        importance: "high",
        date: "2026-04-02T10:00:00.000Z",
        created: "2026-04-02",
        updated: "2026-04-02",
        area: "db",
        files: ["src/db/**"],
      },
      projectRoot,
    );

    const records = await loadStoredMemoryRecords(projectRoot);
    const working = records.find((entry) => entry.memory.type === "working")?.memory;
    const goal = records.find((entry) => entry.memory.type === "goal")?.memory;

    assert.ok(working);
    assert.equal(working.created, "2026-04-02");
    assert.equal(working.updated, "2026-04-03");
    assert.equal(working.area, "auth");
    assert.deepEqual(working.files, ["src/auth/**"]);
    assert.equal(working.expires, "2026-04-09");

    assert.ok(goal);
    assert.equal(goal.created, "2026-04-02");
    assert.equal(goal.updated, "2026-04-02");
    assert.equal(goal.area, "db");
    assert.deepEqual(goal.files, ["src/db/**"]);
    assert.equal(goal.status, "active");
  });
});

await runTest("cli extract --type working fills created updated and default expires", async () => {
  await withTempRepo(async (projectRoot) => {
    const result = await runNodeProcess(
      [path.join(repoRoot, "dist", "cli.js"), "extract", "--source", "session", "--type", "working"],
      projectRoot,
      [
        "decision: Keep the auth rollout checklist in RepoBrain while the migration is active",
        "",
        "Always track the remaining auth rollout checklist in RepoBrain until every entrypoint has moved to the new middleware.",
      ].join("\n"),
    );

    assert.equal(result.code, 0);

    const records = await loadStoredMemoryRecords(projectRoot);
    assert.equal(records.length, 1);
    const stored = records[0]?.memory;
    assert.ok(stored);
    assert.equal(stored.type, "working");
    assert.match(stored.created ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.match(stored.updated ?? "", /^\d{4}-\d{2}-\d{2}$/);
    const expectedExpires = formatUtcDateOnly(new Date(Date.parse(`${stored.updated}T00:00:00.000Z`) + 7 * 86400000));
    assert.equal(stored.expires, expectedExpires);

    const raw = await readFile(records[0].filePath, "utf8");
    assert.match(raw, new RegExp(`created:\\s*"?${stored.created}"?`));
    assert.match(raw, new RegExp(`updated:\\s*"?${stored.updated}"?`));
    assert.match(raw, new RegExp(`expires:\\s*"?${expectedExpires}"?`));
  });
});

await runTest("frontmatter parser handles multiline and escaped YAML values", async () => {
  await withTempRepo(async (projectRoot) => {
    const memoryPath = path.join(projectRoot, ".brain", "decisions", "2026-04-03-yaml-edge.md");
    await writeFile(
      memoryPath,
      [
        "---",
        'type: "decision"',
        'title: "Quoted \\"Title\\" with : colon"',
        "summary: |",
        "  First line",
        "  Second line with colon: value",
        "tags:",
        "  - yaml",
        "importance: medium",
        'date: "2026-04-03T09:00:00.000Z"',
        "---",
        "",
        "## DECISION",
        "",
        "YAML parser should preserve multiline summary values.",
        "",
      ].join("\n"),
      "utf8",
    );

    const memories = await loadAllMemories(projectRoot);
    const memory = memories.find((entry) => entry.title.includes('Quoted "Title"'));
    assert.ok(memory);
    assert.equal(memory.summary, "First line\nSecond line with colon: value\n");
  });
});

await runTest(
  "brain list supports type filters, goal grouping, and stats include working and goal counts",
  async () => {
    await withTempRepo(async (projectRoot) => {
      await saveMemory(
        {
          type: "working",
          title: "Short-lived UI cleanup",
          summary: "Track the UI cleanup while the refactor is in flight.",
          detail: "## WORKING\n\nTrack the UI cleanup while the refactor is in flight.",
          tags: ["ui"],
          importance: "medium",
          date: "2026-04-02T09:00:00.000Z",
          expires: "2026-04-09",
        },
        projectRoot,
      );

      await saveMemory(
        {
          type: "goal",
          title: "Retire legacy auth middleware",
          summary: "Finish retiring the legacy auth middleware.",
          detail: "## GOAL\n\nRetire the legacy auth middleware.",
          tags: ["auth"],
          importance: "high",
          date: "2026-04-02T10:00:00.000Z",
          status: "active",
        },
        projectRoot,
      );

      await saveMemory(
        {
          type: "goal",
          title: "Document the DB migration",
          summary: "Wrap up the DB migration documentation.",
          detail: "## GOAL\n\nDocument the DB migration.",
          tags: ["db"],
          importance: "medium",
          date: "2026-04-02T11:00:00.000Z",
          status: "done",
        },
        projectRoot,
      );

      const listByType = await runNodeProcess(
        [path.join(repoRoot, "dist", "cli.js"), "list", "--type", "working"],
        projectRoot,
      );
      assert.equal(listByType.code, 0);
      assert.match(listByType.stdout, /\| working \|/);
      assert.doesNotMatch(listByType.stdout, /\| goal \|/);

      const goalsResult = await runNodeProcess([path.join(repoRoot, "dist", "cli.js"), "list", "--goals"], projectRoot);
      assert.equal(goalsResult.code, 0);
      assert.match(goalsResult.stdout, /\[active\][\s\S]*Retire legacy auth middleware/);
      assert.match(goalsResult.stdout, /\[done\][\s\S]*Document the DB migration/);
      assert.ok(goalsResult.stdout.indexOf("[active]") < goalsResult.stdout.indexOf("[done]"));

      const statsResult = await runNodeProcess([path.join(repoRoot, "dist", "cli.js"), "stats"], projectRoot);
      assert.equal(statsResult.code, 0);
      assert.match(statsResult.stdout, /By type: .*goal=2.*working=1/);
    });
  },
);

await runTest("brain goal done updates matching goal status and updated date", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "goal",
        title: "Retire legacy auth middleware",
        summary: "Finish the migration away from the legacy auth middleware.",
        detail: "## GOAL\n\nFinish the migration away from the legacy auth middleware.",
        tags: ["auth"],
        importance: "high",
        date: "2026-04-02T10:00:00.000Z",
        status: "active",
        updated: "2026-04-02",
      },
      projectRoot,
    );

    const result = await runNodeProcess(
      [path.join(repoRoot, "dist", "cli.js"), "goal", "done", "legacy auth"],
      projectRoot,
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Marked goal as done: Retire legacy auth middleware/);

    const records = await loadStoredMemoryRecords(projectRoot);
    const goal = records.find((entry) => entry.memory.type === "goal")?.memory;
    assert.ok(goal);
    assert.equal(goal.status, "done");
    assert.equal(goal.updated, formatDateOnly(new Date()));
  });
});

console.log("All store schema tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-store-"));

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

async function runNodeProcess(args, cwd, stdinText = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
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

    child.stdin.end(stdinText);
  });
}

function formatDateOnly(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatUtcDateOnly(value) {
  return value.toISOString().slice(0, 10);
}
