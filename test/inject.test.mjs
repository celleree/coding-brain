import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildInjection } from "../dist/inject.js";
import { initBrain, loadStoredMemoryRecords, saveMemory as saveMemoryRecord, updateIndex } from "../dist/store-api.js";

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

await runTest("inject sorts memories by computed injection priority", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Lower priority decision",
        summary: "This entry has lower computed priority.",
        detail: "## DECISION\n\nThis entry should appear after the higher-priority gotcha.",
        tags: ["priority"],
        importance: "high",
        date: "2026-04-01T08:00:00.000Z",
        score: 55,
        hit_count: 0,
        last_used: null,
        created_at: "2026-04-01",
        status: "active",
        stale: false,
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "gotcha",
        title: "Higher priority gotcha",
        summary: "This entry should win because its computed priority is higher.",
        detail: "## GOTCHA\n\nThis entry should appear first after sorting by injection priority.",
        tags: ["priority"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        score: 80,
        hit_count: 4,
        last_used: null,
        created_at: "2026-04-01",
        status: "active",
        stale: false,
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG);
    assert.ok(
      injection.indexOf("Higher priority gotcha") < injection.indexOf("Lower priority decision"),
      "expected inject to follow computeInjectPriority ordering",
    );
    assert.match(injection, /\[RepoBrain\] injected 2\/2 eligible memories\./);
  });
});

await runTest("inject keeps task-aware rationale in the rendered output", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "General release checklist",
        summary: "A generic release checklist that is newer and high importance.",
        detail: "## DECISION\n\nUse the release checklist for normal cutover work.",
        tags: ["release"],
        importance: "high",
        date: "2026-04-01T10:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Payments writes must stay inside the transaction wrapper",
        summary: "Refund work breaks if writes escape the transaction boundary.",
        detail:
          "## DECISION\n\nPayments and refunds must stay in the transaction wrapper before calling the ledger sync.",
        tags: ["payments", "refund"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        path_scope: ["src/payments/"],
        required_skills: ["github:gh-fix-ci"],
        skill_trigger_paths: ["src/payments/refund.ts"],
        skill_trigger_tasks: ["fix refund transaction bug"],
        invocation_mode: "required",
        risk_level: "high",
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, {
      task: "fix refund transaction bug in payments flow",
      paths: ["src/payments/refund.ts"],
      modules: ["payments"],
    });

    assert.match(injection, /Selection mode: task-aware/);
    assert.match(injection, /Why now: Task Phrase Match: fix refund transaction bug/);
    assert.match(injection, /Task Phrase Match: fix refund transaction bug/);
  });
});

await runTest("inject still excludes superseded memories during task-aware selection", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Use the new auth retry wrapper",
        summary: "The newer auth retry wrapper should supersede the old guidance.",
        detail: "## DECISION\n\nNew guidance for auth retry handling.",
        tags: ["auth"],
        importance: "high",
        date: "2026-04-01T11:00:00.000Z",
        status: "active",
        path_scope: ["src/auth/"],
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Use the new auth retry wrapper",
        summary: "A later save with the same normalized title should supersede the old one.",
        detail: "## DECISION\n\nLatest guidance for auth retry handling.",
        tags: ["auth", "retry"],
        importance: "high",
        date: "2026-04-01T12:00:00.000Z",
        status: "active",
        path_scope: ["src/auth/"],
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, {
      paths: ["src/auth/retry.ts"],
      modules: ["auth"],
    });

    assert.match(injection, /Latest guidance for auth retry handling/);
    assert.doesNotMatch(injection, /The newer auth retry wrapper should supersede the old guidance/);
  });
});

await runTest("inject skips stale memories, reports them, and updates usage metadata atomically", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "gotcha",
        title: "Skip stale memory",
        summary: "This should not be injected.",
        detail: "## GOTCHA\n\nStale memory should be skipped.",
        tags: ["stale"],
        importance: "high",
        date: "2026-04-01T08:00:00.000Z",
        score: 95,
        hit_count: 7,
        last_used: "2026-04-01",
        created_at: "2026-04-01",
        status: "active",
        stale: true,
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Inject active memory",
        summary: "This should be injected and updated.",
        detail: "## DECISION\n\nActive memory should be injected and usage metadata should update.",
        tags: ["active"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        score: 65,
        hit_count: 1,
        last_used: null,
        created_at: "2026-04-01",
        status: "active",
        stale: false,
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG);
    assert.doesNotMatch(injection, /Skip stale memory/);
    assert.match(injection, /Inject active memory/);
    assert.match(injection, /\[RepoBrain\] injected 1\/1 eligible memories\./);
    assert.match(injection, /Note: 1 stale memory is currently excluded\. Run "brain score" to review them\./);

    const records = await loadStoredMemoryRecords(projectRoot);
    const staleRecord = records.find((entry) => entry.memory.title === "Skip stale memory");
    const activeRecord = records.find((entry) => entry.memory.title === "Inject active memory");

    assert.ok(staleRecord);
    assert.ok(activeRecord);
    assert.equal(staleRecord.memory.hit_count, 7);
    assert.equal(staleRecord.memory.last_used, "2026-04-01");
    assert.equal(activeRecord.memory.hit_count, 2);
    assert.match(activeRecord.memory.last_used ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(activeRecord.memory.stale, false);
  });
});

await runTest("inject filters superseded lineage entries and prefixes newer versions", async () => {
  await withTempRepo(async (projectRoot) => {
    const oldDate = "2026-04-01T08:00:00.000Z";
    const newDate = "2026-04-01T09:00:00.000Z";
    const newRelativePath = buildExpectedBrainRelativePath("decision", "Use the new deploy gate", newDate);

    await saveMemory(
      {
        type: "decision",
        title: "Use the old deploy gate",
        summary: "Legacy guidance that should be hidden once replaced.",
        detail: "## DECISION\n\nThe old deploy gate is kept only for history.",
        tags: ["deploy"],
        importance: "medium",
        date: oldDate,
        status: "active",
        superseded_by: newRelativePath,
      },
      projectRoot,
    );

    const oldRelativePath = buildExpectedBrainRelativePath("decision", "Use the old deploy gate", oldDate);

    await saveMemory(
      {
        type: "decision",
        title: "Use the new deploy gate",
        summary: "Current guidance that replaces the old gate.",
        detail: "## DECISION\n\nOnly the new deploy gate should be injected.",
        tags: ["deploy"],
        importance: "high",
        date: newDate,
        status: "active",
        supersedes: oldRelativePath,
        version: 2,
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG);
    assert.match(injection, /\[Updated v2\] Use the new deploy gate/);
    assert.match(injection, /Only the new deploy gate should be injected/);
    assert.doesNotMatch(injection, /Use the old deploy gate/);
    assert.match(injection, /\[RepoBrain\].*1\/1/);
  });
});

await runTest("inject warns when supersedes lineage is not fully linked back", async () => {
  await withTempRepo(async (projectRoot) => {
    const oldDate = "2026-04-01T08:00:00.000Z";
    const oldRelativePath = buildExpectedBrainRelativePath("decision", "Old cache guidance", oldDate);

    await saveMemory(
      {
        type: "decision",
        title: "Old cache guidance",
        summary: "Older guidance still missing the backlink.",
        detail: "## DECISION\n\nOld cache guidance.",
        tags: ["cache"],
        importance: "medium",
        date: oldDate,
        status: "active",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "New cache guidance",
        summary: "Newer guidance points back to the old file.",
        detail: "## DECISION\n\nNew cache guidance.",
        tags: ["cache"],
        importance: "high",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        supersedes: oldRelativePath,
        version: 2,
      },
      projectRoot,
    );

    const { stderr, result } = await captureStderr(() => buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG));
    assert.match(
      stderr,
      /\[brain\] lineage warning: decisions\/2026-04-01-old-cache-guidance-080000000\.md should set superseded_by: decisions\//,
    );
    assert.match(result, /\[Updated v2\] New cache guidance/);
  });
});

await runTest("inject reminds the user when candidate memories are waiting for review", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Inject active memory",
        summary: "This active memory should be injected.",
        detail: "## DECISION\n\nInject this memory as usual.",
        tags: ["active"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "gotcha",
        title: "Review this candidate",
        summary: "This candidate should stay out of inject.",
        detail: "## GOTCHA\n\nKeep this candidate pending review.",
        tags: ["candidate"],
        importance: "medium",
        date: "2026-04-01T10:00:00.000Z",
        status: "candidate",
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG);
    assert.match(injection, /Pending review: 1 candidate memory\. Run "brain review" to inspect them\./);
    assert.doesNotMatch(injection, /Review this candidate/);
  });
});

await runTest("inject boosts memories that match changed git files and explains the score", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "JWT auth changes must update the shared guard",
        summary: "Auth JWT edits should revisit the shared guard path.",
        detail: "## DECISION\n\nJWT auth edits must update the shared guard path.",
        tags: ["auth", "jwt"],
        importance: "low",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        files: ["src/auth/*.ts"],
        area: "auth",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "gotcha",
        title: "General release checklist",
        summary: "A high-priority generic memory that should lose to the auth-specific one.",
        detail: "## GOTCHA\n\nGeneric release checklist.",
        tags: ["release"],
        importance: "high",
        date: "2026-04-01T10:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, {
      explain: true,
      gitContext: {
        changedFiles: ["src/auth/jwt.ts"],
        branchName: "feature/auth-jwt",
      },
    });

    assert.ok(
      injection.indexOf("JWT auth changes must update the shared guard") <
        injection.indexOf("General release checklist"),
      "expected the git-matched memory to rank ahead of the generic one",
    );
    assert.match(
      injection,
      /<!-- brain-inject-report[\s\S]*decisions\/2026-04-01-jwt-auth-changes-must-update-the-shared-guard-090000000\.md \| total=.*git_changed_files_match=.*branch_tag_hint=.*[\s\S]*gotchas\/2026-04-01-general-release-checklist-100000000\.md \| total=.*/m,
    );
  });
});

await runTest("inject can disable git-context scoring with --no-context", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "JWT auth changes must update the shared guard",
        summary: "This would normally win from file and area matching.",
        detail: "## DECISION\n\nJWT auth edits must update the shared guard path.",
        tags: ["auth", "jwt"],
        importance: "low",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        files: ["src/auth/*.ts"],
        area: "auth",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "gotcha",
        title: "General release checklist",
        summary: "Higher computed priority should win when Git context is disabled.",
        detail: "## GOTCHA\n\nGeneric release checklist.",
        tags: ["release"],
        importance: "high",
        date: "2026-04-01T10:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    const result = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, {
      noContext: true,
      gitContext: {
        changedFiles: ["src/auth/jwt.ts"],
        branchName: "feature/auth-jwt",
      },
    });
    assert.ok(
      result.indexOf("General release checklist") < result.indexOf("JWT auth changes must update the shared guard"),
      "expected legacy ordering when --no-context is used",
    );
    assert.doesNotMatch(result, /brain-inject-scores/);
    assert.doesNotMatch(result, /brain-inject-report/);
  });
});

await runTest("inject skips working memories unless --include-working is set", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "working",
        title: "Temporary migration notes",
        summary: "This should stay out of default inject output.",
        detail: "## WORKING\n\nTemporary migration notes.",
        tags: ["migration"],
        importance: "high",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    const defaultInjection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG);
    assert.doesNotMatch(defaultInjection, /Temporary migration notes/);

    const includedInjection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, {
      includeWorking: true,
    });
    assert.match(includedInjection, /Temporary migration notes/);
  });
});

await runTest("inject silently skips expired working memories during injection", async () => {
  await withTempRepo(async (projectRoot) => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    await saveMemory(
      {
        type: "working",
        title: "Expired temporary working note",
        summary: "This should not appear in injection output.",
        detail: "## WORKING\n\nExpired working memory should be skipped automatically.",
        tags: ["working", "expired"],
        importance: "high",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        expires: yesterday,
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, {
      includeWorking: true,
    });

    assert.doesNotMatch(injection, /Expired temporary working note/);
    assert.match(injection, /\[RepoBrain\] injected 0\/0 eligible memories\./);
  });
});

await runTest("inject always includes active goals even when the token budget is tiny", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "goal",
        title: "Finish auth rollout",
        summary: "This active goal must always appear.",
        detail: "## GOAL\n\nFinish the auth rollout before the release cut.",
        tags: ["auth"],
        importance: "low",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Secondary decision",
        summary: "A normal memory that can be dropped by the token budget.",
        detail: "## DECISION\n\nA normal memory that may not fit.",
        tags: ["secondary"],
        importance: "high",
        date: "2026-04-01T10:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, {
      ...DEFAULT_BRAIN_CONFIG,
      maxInjectTokens: 30,
    });

    assert.match(injection, /Finish auth rollout/);
    assert.doesNotMatch(injection, /Secondary decision/);
    assert.match(injection, /\[RepoBrain\] injected 1\/2 eligible memories\./);
  });
});

await runTest("inject renders the index layer with compact retrieval metadata", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Refund transaction boundary",
        summary: "Keep refund writes inside the transaction wrapper.",
        detail: "## DECISION\n\nKeep refund writes inside the transaction wrapper before syncing the ledger.",
        tags: ["payments", "refund"],
        importance: "high",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        skill_trigger_tasks: ["fix refund flow"],
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, {
      layer: "index",
      task: "fix refund flow before release",
    });

    assert.match(injection, /## Injected Memories \(Priority Order\)/);
    assert.match(injection, /- id: decisions\/2026-04-01-refund-transaction-boundary-090000000\.md/);
    assert.match(injection, /  title: Refund transaction boundary/);
    assert.match(injection, /  tags: payments, refund/);
    assert.match(injection, /  score: 60 \| totalScore: /);
    assert.match(injection, /  why_now: Task Phrase Match: fix refund flow/);
    assert.doesNotMatch(injection, /Scope:/);
  });
});

await runTest("inject keeps summary as the default compatible rendering layer", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Config branching must normalize env booleans first",
        summary: "Normalize environment booleans before any config branching.",
        detail: "## DECISION\n\nNormalize environment booleans before any config branching.",
        tags: ["config"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    const defaultInjection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG);
    const summaryInjection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, { layer: "summary" });

    assert.equal(summaryInjection, defaultInjection);
    assert.match(summaryInjection, /- \[decision \| medium\] Config branching must normalize env booleans first/);
    assert.match(summaryInjection, /  Scope: Normalize environment booleans before any config branching\./);
  });
});

await runTest("inject expands requested ids in summary layer", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "pattern",
        title: "First expanded memory",
        summary: "This memory should be expanded by file stem.",
        detail: "## PATTERN\n\nFirst expanded memory detail.",
        tags: ["retrieval", "first"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Second expanded memory",
        summary: "This memory should be expanded by relative path.",
        detail: "## DECISION\n\nSecond expanded memory detail.",
        tags: ["retrieval", "second"],
        importance: "high",
        date: "2026-04-01T10:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, {
      layer: "summary",
      ids: ["2026-04-01-first-expanded-memory-090000000", "decisions/2026-04-01-second-expanded-memory-100000000.md"],
    });

    assert.match(injection, /First expanded memory/);
    assert.match(injection, /Second expanded memory/);
    assert.ok(
      injection.indexOf("First expanded memory") < injection.indexOf("Second expanded memory"),
      "expected requested ids to preserve caller order",
    );
    assert.doesNotMatch(injection, /Why now:/);
  });
});

await runTest("inject expands requested ids in full layer with serialized memory markdown", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "pattern",
        title: "Full memory render",
        summary: "Render the entire memory body for follow-up retrieval.",
        detail: "## PATTERN\n\nRender the full body so a later agent can rehydrate it exactly.",
        tags: ["retrieval"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, {
      layer: "full",
      ids: ["patterns/2026-04-01-full-memory-render-090000000.md"],
    });

    assert.match(injection, /### 1\. Full memory render/);
    assert.match(injection, /- id: patterns\/2026-04-01-full-memory-render-090000000\.md/);
    assert.match(injection, /```md/);
    assert.match(injection, /---\ntype: "pattern"/);
    assert.match(injection, /title: "Full memory render"/);
    assert.match(injection, /## PATTERN\n\nRender the full body so a later agent can rehydrate it exactly\./);
  });
});

await runTest("inject with ids falls back to markdown scan when memory-index cache is missing", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "pattern",
        title: "Missing cache fallback",
        summary: "Inject should still resolve ids from markdown when the cache is absent.",
        detail: "## PATTERN\n\nFallback should read the markdown source of truth.",
        tags: ["cache", "fallback"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, {
      layer: "summary",
      ids: ["2026-04-01-missing-cache-fallback-090000000"],
    });

    assert.match(injection, /Missing cache fallback/);
    assert.match(injection, /\[RepoBrain\] injected 1\/1 eligible memories\./);
  });
});

await runTest("inject with ids falls back to markdown scan when memory-index cache is corrupted", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "pattern",
        title: "Corrupt cache fallback",
        summary: "Inject should ignore a broken cache file.",
        detail: "## PATTERN\n\nBroken cache content should not block inject.",
        tags: ["cache", "fallback"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    await updateIndex(projectRoot);
    const cachePath = path.join(projectRoot, ".brain", "memory-index.json");
    const original = await readFile(cachePath, "utf8");

    await writeFile(cachePath, "{not valid json", "utf8");

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, {
      layer: "full",
      ids: ["patterns/2026-04-01-corrupt-cache-fallback-090000000.md"],
    });

    assert.match(injection, /Corrupt cache fallback/);
    assert.match(injection, /```md/);

    await writeFile(cachePath, original, "utf8");
  });
});

await runTest("inject full layer requires explicit ids", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "pattern",
        title: "Full memory render",
        summary: "Render the entire memory body for follow-up retrieval.",
        detail: "## PATTERN\n\nRender the full body so a later agent can rehydrate it exactly.",
        tags: ["retrieval"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    await assert.rejects(
      () => buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, { layer: "full" }),
      /The "full" inject layer requires "--ids" so RepoBrain does not dump every selected memory body by default\./,
    );
  });
});

await runTest("inject rejects unsupported layer values with a clear error", async () => {
  await withTempRepo(async (projectRoot) => {
    await assert.rejects(
      () => buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, { layer: "compact" }),
      /Unsupported inject layer "compact"\. Expected one of: index, summary, full\./,
    );
  });
});

await runTest("inject rejects unknown and duplicate ids with clear errors", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Known memory",
        summary: "A memory used for id validation.",
        detail: "## DECISION\n\nKnown memory detail.",
        tags: ["known"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    await assert.rejects(
      () => buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, { layer: "summary", ids: ["missing-id"] }),
      /Unknown memory id "missing-id"\./,
    );

    await assert.rejects(
      () =>
        buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, {
          layer: "summary",
          ids: ["2026-04-01-known-memory-090000000", "2026-04-01-known-memory-090000000"],
        }),
      /Duplicate id "2026-04-01-known-memory-090000000" in "--ids"\./,
    );
  });
});

await runTest("inject rejects ids for memories that are not currently injectable", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Pending review memory",
        summary: "This should not be injectable while pending review.",
        detail: "## DECISION\n\nPending review detail.",
        tags: ["review"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        review_state: "pending_review",
      },
      projectRoot,
    );

    await assert.rejects(
      () =>
        buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, {
          layer: "summary",
          ids: ["2026-04-01-pending-review-memory-090000000"],
        }),
      /is not injectable because it is pending review\./,
    );
  });
});

await runTest("inject prefers refactor memories that understand task phrases, modules, and scoped paths", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "pattern",
        title: "Refactor CLI config loading through shared parse helpers",
        summary: "CLI refactors should preserve parse helpers before touching command wiring.",
        detail: "## PATTERN\n\nWhen refactoring config loading, keep parsing and command wiring decoupled.",
        tags: ["cli", "config", "refactor"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        path_scope: ["src/config/**", "src/cli.ts"],
        skill_trigger_tasks: ["refactor config loading"],
        skill_trigger_paths: ["src/config/**"],
        risk_level: "medium",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Release checklist for ordinary cutovers",
        summary: "Generic release guidance.",
        detail: "## DECISION\n\nGeneric release guidance.",
        tags: ["release"],
        importance: "high",
        date: "2026-04-01T10:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, {
      task: "refactor config loading for the CLI",
      paths: ["src/config/loader.ts", "src/cli.ts"],
      modules: ["cli", "config"],
    });

    assert.ok(
      injection.indexOf("Refactor CLI config loading through shared parse helpers") <
        injection.indexOf("Release checklist for ordinary cutovers"),
      "expected the refactor-specific memory to rank first",
    );
    assert.match(injection, /Task Phrase Match: refactor config loading/);
    assert.match(injection, /Module Overlap: cli, config/);
  });
});

await runTest("inject uses diversity-aware selection to keep cross-module coverage under tight budget", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Auth refactor must preserve token refresh boundary",
        summary: "Auth refactors should keep token refresh isolated.",
        detail: "## DECISION\n\nAuth refactors should keep token refresh isolated.",
        tags: ["auth", "refactor"],
        importance: "high",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["src/auth/**"],
        skill_trigger_tasks: ["refactor shared service"],
        risk_level: "high",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Auth refactor must preserve login fallback",
        summary: "Nearby auth rule that should not crowd out another module.",
        detail: "## DECISION\n\nAuth refactors should preserve the login fallback path.",
        tags: ["auth", "login", "refactor"],
        importance: "high",
        date: "2026-04-01T08:30:00.000Z",
        status: "active",
        path_scope: ["src/auth/login/**"],
        skill_trigger_tasks: ["refactor shared service"],
        risk_level: "medium",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "gotcha",
        title: "DB refactor must preserve transaction envelope",
        summary: "Database refactors need their own warning surface.",
        detail: "## GOTCHA\n\nDatabase refactors must preserve transaction boundaries.",
        tags: ["db", "refactor", "transaction"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        path_scope: ["src/db/**"],
        skill_trigger_tasks: ["refactor shared service"],
        risk_level: "high",
      },
      projectRoot,
    );

    const injection = await buildInjection(
      projectRoot,
      {
        ...DEFAULT_BRAIN_CONFIG,
        maxInjectTokens: 320,
      },
      {
        task: "refactor shared service across auth and db",
        paths: ["src/auth/token.ts", "src/db/ledger.ts"],
        modules: ["auth", "db"],
        explain: true,
      },
    );

    assert.match(injection, /Auth refactor must preserve token refresh boundary/);
    assert.match(injection, /DB refactor must preserve transaction envelope/);
    assert.ok(
      injection.indexOf("DB refactor must preserve transaction envelope") <
        injection.indexOf("Auth refactor must preserve login fallback"),
      "expected the diversity-aware selector to choose the db memory before the second auth memory",
    );
    assert.match(injection, /diversity=\+/);
  });
});

await runTest("inject elevates high-risk fix memories across modules and shows the risk contribution", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "gotcha",
        title: "Refund fixes must stay inside payments and ledger transaction boundaries",
        summary: "Risky refund bugfixes span two modules and must keep transaction boundaries intact.",
        detail: "## GOTCHA\n\nRefund bugfixes must keep payments writes and ledger sync inside one transaction.",
        tags: ["payments", "ledger", "refund"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "active",
        path_scope: ["src/payments/**", "src/ledger/**"],
        skill_trigger_tasks: ["fix refund transaction bug"],
        risk_level: "high",
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "pattern",
        title: "General bugfix checklist",
        summary: "Generic debugging guidance.",
        detail: "## PATTERN\n\nGeneric debugging guidance.",
        tags: ["bugfix"],
        importance: "high",
        date: "2026-04-01T10:00:00.000Z",
        status: "active",
      },
      projectRoot,
    );

    const injection = await buildInjection(
      projectRoot,
      {
        ...DEFAULT_BRAIN_CONFIG,
        injectExplainMaxItems: 8,
      },
      {
        task: "fix refund transaction bug before release",
        paths: ["src/payments/refund.ts", "src/ledger/sync.ts"],
        modules: ["payments", "ledger"],
        explain: true,
      },
    );

    assert.ok(
      injection.indexOf("Refund fixes must stay inside payments and ledger transaction boundaries") <
        injection.indexOf("General bugfix checklist"),
      "expected the high-risk multi-module fix memory to rank first",
    );
    assert.match(injection, /risk_adjustment=8 \(risk=high\)/);
    assert.match(injection, /Task Phrase Match: fix refund transaction bug/);
  });
});

await runTest("inject excludes active memories whose record attestation no longer verifies", async () => {
  await withTempRepo(async (projectRoot) => {
    const filePath = await saveMemory(
      {
        type: "decision",
        title: "Attested injection rule",
        summary: "This should disappear after manual tampering.",
        detail: "## DECISION\n\nOnly verified records may be injected.",
        tags: ["provenance"],
        importance: "high",
        date: "2026-08-29T12:00:00.000Z",
        score: 90,
        hit_count: 0,
        last_used: null,
        created_at: "2026-08-29T12:00:00.000Z",
        stale: false,
        source: "manual",
        status: "active",
      },
      projectRoot,
      { sourceBytes: Buffer.from("verified source", "utf8") },
    );
    const raw = await readFile(filePath, "utf8");
    await writeFile(filePath, raw.replace("Only verified records", "Tampered records"), "utf8");

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, { noContext: true });
    assert.doesNotMatch(injection, /Attested injection rule/);
  });
});

console.log("All inject tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-inject-"));

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

async function captureStderr(callback) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";

  process.stderr.write = (chunk, encoding, next) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString(typeof encoding === "string" ? encoding : "utf8");
    if (typeof encoding === "function") {
      encoding();
    } else if (typeof next === "function") {
      next();
    }
    return true;
  };

  try {
    const result = await callback();
    return { stderr, result };
  } finally {
    process.stderr.write = originalWrite;
  }
}

function buildExpectedBrainRelativePath(type, title, date) {
  return `${directoryByType(type)}/${date.slice(0, 10)}-${slugifyTitle(title)}-${date.replace(/[^\d]/g, "").slice(8, 17)}.md`;
}

function directoryByType(type) {
  switch (type) {
    case "decision":
      return "decisions";
    case "gotcha":
      return "gotchas";
    case "convention":
      return "conventions";
    case "pattern":
      return "patterns";
    case "working":
      return "working";
    case "goal":
      return "goals";
    default:
      throw new Error(`Unsupported memory type: ${type}`);
  }
}

function slugifyTitle(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
