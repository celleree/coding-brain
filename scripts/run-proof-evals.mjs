import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const storeApiPath = path.join(projectRoot, "dist", "store-api.js");
const extractPath = path.join(projectRoot, "dist", "extract.js");
const injectPath = path.join(projectRoot, "dist", "inject.js");

await assertBuilt();

const storeApi = withSourcedWrites(await import(pathToFileURL(storeApiPath).href));
const { extractMemories } = await import(pathToFileURL(extractPath).href);
const { buildInjection } = await import(pathToFileURL(injectPath).href);

function withSourcedWrites(api) {
  return {
    ...api,
    saveMemory(memory, projectRoot, provenance) {
      return api.saveMemory(memory, projectRoot, provenance ?? { sourceBytes: Buffer.from(memory.detail, "utf8") });
    },
    savePreference(preference, projectRoot, provenance) {
      return api.savePreference(
        preference,
        projectRoot,
        provenance ?? {
          sourceBytes: Buffer.from(preference.reason, "utf8"),
        },
      );
    },
    applyRoutingFeedback(projectRoot, events, options) {
      return api.applyRoutingFeedback(
        projectRoot,
        events,
        options ?? { sourceBytes: Buffer.from(JSON.stringify(events), "utf8") },
      );
    },
  };
}

const config = {
  maxInjectTokens: 1200,
  extractMode: "suggest",
  language: "en",
  staleDays: 30,
  sweepOnInject: false,
  injectDiversity: true,
  injectExplainMaxItems: 4,
};

const results = [];
/** @type {Record<string, unknown>} */
const metrics = {
  extraction_accept_reject: { durable_lesson_accepted: false, chatter_rejected: false },
  preference_phrase_hits: { passed: 0, total: 0, phrases: [] },
  route_traceability: { routing_explanation_layers: false, skill_evidence_keys: false },
  stale_superseded_filter: { superseded_preference_skipped: false },
  session_pollution: { memory_unchanged_after_session_write: false },
};

await runCase("extract_quality", "accepts a durable repo-specific lesson", async () => {
  const memories = await extractMemories(
    [
      "Keep release notes and install smoke validation in docs/release-guide.md because the first npm publish should prove installability, not just packaging.",
      "When package.json changes, use docs/release-guide.md and docs/release-checklist.md together so release validation stays repeatable.",
    ].join("\n\n"),
    config,
  );

  assert.ok(memories.length >= 1);
  assert.ok(memories.some((entry) => entry.type === "decision"));
  assert.ok(memories.some((entry) => entry.files?.includes("docs/release-guide.md")));
  metrics.extraction_accept_reject.durable_lesson_accepted = true;
});

await runCase("extract_quality", "rejects low-information status chatter", async () => {
  const memories = await extractMemories(
    ["ran tests", "updated one comment", "looked at package.json"].join("\n"),
    config,
  );

  assert.equal(memories.length, 0);
  metrics.extraction_accept_reject.chatter_rejected = true;
});

await runCase("inject_hit", "prioritizes the task-matched memory over generic guidance", async () => {
  await withTempRepo(async (repoRoot) => {
    await storeApi.saveMemory(
      {
        type: "decision",
        title: "Use package smoke validation before npm publish",
        summary: "Package changes should run the packaged install smoke flow before publish.",
        detail: "## DECISION\n\nPackage changes should run the packaged install smoke flow before publish.",
        tags: ["release", "npm"],
        importance: "high",
        date: "2026-04-03T10:00:00.000Z",
        status: "active",
        path_scope: ["package.json", "docs/release-guide.md"],
        skill_trigger_tasks: ["prepare npm release"],
        skill_trigger_paths: ["package.json"],
        invocation_mode: "required",
        risk_level: "high",
      },
      repoRoot,
    );

    await storeApi.saveMemory(
      {
        type: "gotcha",
        title: "General release reminder",
        summary: "Generic release guidance should not outrank the package-specific memory.",
        detail: "## GOTCHA\n\nGeneric release guidance should not outrank the package-specific memory.",
        tags: ["release"],
        importance: "medium",
        date: "2026-04-03T09:00:00.000Z",
        status: "active",
      },
      repoRoot,
    );

    const injection = await buildInjection(repoRoot, config, {
      task: "prepare npm release smoke validation",
      paths: ["package.json"],
      modules: ["release"],
    });

    assert.ok(
      injection.indexOf("Use package smoke validation before npm publish") <
        injection.indexOf("General release reminder"),
    );
    assert.match(injection, /Selection mode: task-aware/);
    assert.match(injection, /Task Phrase Match: prepare npm release/);
  });
});

await runCase("review_supersede", "marks a replacement memory as supersede", async () => {
  await withTempRepo(async (repoRoot) => {
    const existingPath = await storeApi.saveMemory(
      {
        type: "convention",
        title: "Use npm test for release validation",
        summary: "Release validation currently runs through npm test.",
        detail: "## CONVENTION\n\nRelease validation currently runs through npm test.",
        tags: ["release"],
        importance: "medium",
        date: "2026-04-03T08:00:00.000Z",
        status: "active",
        path_scope: ["package.json"],
      },
      repoRoot,
    );

    const records = await storeApi.loadStoredMemoryRecords(repoRoot);
    const review = storeApi.reviewCandidateMemory(
      {
        type: "convention",
        title: "Use npm test for release validation",
        summary: "Release validation now needs npm run smoke:package instead of npm test before publish.",
        detail:
          "## CONVENTION\n\nReplace npm test with npm run smoke:package for release validation before publish. The npm-test-only guidance is obsolete for packaged release validation.",
        tags: ["release", "smoke"],
        importance: "high",
        date: "2026-04-03T09:00:00.000Z",
        path_scope: ["package.json"],
      },
      records,
    );

    assert.equal(review.decision, "supersede");
    assert.deepEqual(review.target_memory_ids, [path.basename(existingPath, ".md")]);
  });
});

await runCase("review_supersede", "keeps novel routing guidance as accept", async () => {
  await withTempRepo(async (repoRoot) => {
    const records = await storeApi.loadStoredMemoryRecords(repoRoot);
    const review = storeApi.reviewCandidateMemory(
      {
        type: "pattern",
        title: "Use focused fixtures for release smoke demos",
        summary: "Focused fixtures keep release smoke demos easier to debug than full demo repos.",
        detail: "## PATTERN\n\nFocused fixtures keep release smoke demos easier to debug than full demo repos.",
        tags: ["release", "demo"],
        importance: "medium",
        date: "2026-04-03T09:30:00.000Z",
        path_scope: ["test/fixtures/**"],
      },
      records,
    );

    assert.equal(review.decision, "accept");
    assert.equal(review.reason, "novel_memory");
  });
});

// --- New proof-layer cases (preference, feedback, session, temporal) ---

await runCase(
  "feedback_negative_workflow",
  "workflow_failure with workflow + notes saves avoid preference candidate",
  async () => {
    await withTempRepo(async (repoRoot) => {
      const events = [
        {
          type: "workflow_failure",
          workflow: "heavy-migration",
          notes: "This migration workflow broke prod twice; stop auto-suggesting it until reviewed.",
          signal_strength: 0.9,
        },
      ];
      const result = await storeApi.applyRoutingFeedback(repoRoot, events);
      const saved = result.applied.filter((a) => a.kind === "preference_candidate_saved");
      assert.ok(saved.length >= 1, "expected preference_candidate_saved");
      const prefs = await storeApi.loadStoredPreferenceRecords(repoRoot);
      const wf = prefs.find((p) => p.preference.target === "heavy-migration");
      assert.ok(wf, "expected saved preference file");
      assert.equal(wf.preference.preference, "avoid");
      assert.equal(wf.preference.status, "candidate");
    });
  },
);

await runCase(
  "preference_routing",
  "avoid preference moves a recommended skill into suppress in invocation_plan",
  async () => {
    await withTempRepo(async (repoRoot) => {
      await storeApi.saveMemory(
        {
          type: "decision",
          title: "Bundler choice",
          summary: "Rollup for library builds.",
          detail: "## DECISION\n\nUse rollup.",
          tags: ["build"],
          importance: "medium",
          date: "2026-04-03T10:00:00.000Z",
          status: "active",
          recommended_skills: ["rollup"],
          skill_trigger_tasks: ["library build", "bundle package"],
          skill_trigger_paths: ["rollup.config.mjs"],
          invocation_mode: "optional",
          risk_level: "low",
        },
        repoRoot,
      );

      const before = await storeApi.buildSkillShortlist(repoRoot, {
        task: "library build for npm",
        paths: ["rollup.config.mjs"],
        path_source: "explicit",
      });
      assert.ok(
        !before.invocation_plan.suppress.includes("rollup"),
        "rollup should not start in suppress without avoid preference",
      );

      await storeApi.savePreference(
        {
          kind: "routing_preference",
          target_type: "skill",
          target: "rollup",
          preference: "avoid",
          reason: "CI uses a different bundler pipeline; avoid rollup locally.",
          confidence: 0.85,
          source: "manual",
          created_at: "2026-04-03T11:00:00.000Z",
          updated_at: "2026-04-03T11:00:00.000Z",
          status: "active",
        },
        repoRoot,
      );

      const after = await storeApi.buildSkillShortlist(repoRoot, {
        task: "library build for npm",
        paths: ["rollup.config.mjs"],
        path_source: "explicit",
      });
      assert.ok(after.invocation_plan.suppress.includes("rollup"));
      assert.ok(after.routing_explanation?.notes.some((n) => n.includes("Policy layers")));
      assert.ok(Object.keys(after.routing_explanation?.skill_evidence ?? {}).includes("rollup"));
      metrics.route_traceability.routing_explanation_layers = true;
      metrics.route_traceability.skill_evidence_keys = true;
    });
  },
);

await runCase("superseded_preference", "preference with superseded_by does not participate in routing", async () => {
  await withTempRepo(async (repoRoot) => {
    await storeApi.saveMemory(
      {
        type: "decision",
        title: "Lint tooling",
        summary: "ESLint and Prettier both mentioned.",
        detail: "## DECISION\n\nLint.",
        tags: ["lint"],
        importance: "medium",
        date: "2026-04-03T10:00:00.000Z",
        status: "active",
        recommended_skills: ["eslint", "prettier"],
        skill_trigger_tasks: ["fix lint"],
        skill_trigger_paths: [".eslintrc.cjs"],
        invocation_mode: "optional",
        risk_level: "low",
      },
      repoRoot,
    );

    const eslintPath = await storeApi.savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "eslint",
        preference: "prefer",
        reason: "legacy: prefer eslint",
        confidence: 0.9,
        source: "manual",
        created_at: "2026-04-03T10:00:00.000Z",
        updated_at: "2026-04-03T10:00:00.000Z",
        status: "active",
      },
      repoRoot,
    );

    const prettierPath = await storeApi.savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "prettier",
        preference: "prefer",
        reason: "team switched to prettier-first formatting",
        confidence: 0.88,
        source: "manual",
        created_at: "2026-04-03T11:00:00.000Z",
        updated_at: "2026-04-03T11:00:00.000Z",
        status: "active",
      },
      repoRoot,
    );

    const records = await storeApi.loadStoredPreferenceRecords(repoRoot);
    const eslintRecord = records.find((r) => r.filePath === eslintPath);
    const prettierRel = eslintRecord ? records.find((r) => r.filePath === prettierPath)?.relativePath : null;
    assert.ok(eslintRecord && prettierRel);

    await storeApi.overwriteStoredPreference({
      ...eslintRecord,
      preference: {
        ...eslintRecord.preference,
        status: "active",
        superseded_by: prettierRel,
        updated_at: new Date().toISOString(),
      },
    });

    const routed = await storeApi.buildSkillShortlist(repoRoot, {
      task: "fix lint in config",
      paths: [".eslintrc.cjs"],
      path_source: "explicit",
    });

    const skipped = routed.routing_explanation?.notes.filter((n) => n.includes("eslint")) ?? [];
    assert.ok(
      skipped.some((n) => n.includes("superseded") || n.toLowerCase().includes("skipped preference")),
      "expected skipped superseded eslint preference in routing notes",
    );
    assert.ok(
      !routed.resolved_skills
        .find((s) => s.skill === "eslint")
        ?.sources.some((s) => s.relation === "preference_prefer"),
      "superseded eslint prefer should not apply",
    );
    metrics.stale_superseded_filter.superseded_preference_skipped = true;
  });
});

await runCase(
  "session_profile_routing",
  "session skill_routing beats stored ordinary preference on the same skill",
  async () => {
    await withTempRepo(async (repoRoot) => {
      await storeApi.savePreference(
        {
          kind: "routing_preference",
          target_type: "skill",
          target: "jest",
          preference: "prefer",
          reason: "stored default",
          confidence: 0.9,
          source: "manual",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: "active",
        },
        repoRoot,
      );

      await writeSessionProfile(repoRoot, {
        skill_routing: [{ skill: "jest", preference: "avoid", reason: "this session: skip jest" }],
      });

      const withSession = await storeApi.buildSkillShortlist(repoRoot, {
        task: "run unit tests",
        paths: [],
        path_source: "none",
      });
      const jestSkill = withSession.resolved_skills.find((s) => s.skill === "jest");
      assert.ok(jestSkill?.sources.some((s) => s.relation === "preference_prefer"));
      assert.ok(jestSkill?.sources.some((s) => s.relation === "session_avoid"));
      assert.equal(jestSkill?.plan_slot, "suppress");
    });
  },
);

await runCase("session_pollution", "writing session profile does not add durable memory files", async () => {
  await withTempRepo(async (repoRoot) => {
    await storeApi.saveMemory(
      {
        type: "decision",
        title: "Durable only",
        summary: "x",
        detail: "## DECISION\n\nx",
        tags: [],
        importance: "low",
        date: "2026-04-03T10:00:00.000Z",
        status: "active",
      },
      repoRoot,
    );

    const before = await storeApi.loadStoredMemoryRecords(repoRoot);
    await writeSessionProfile(repoRoot, {
      hints: ["ephemeral scratch note that must not become a memory"],
      skill_routing: [{ skill: "vitest", preference: "prefer" }],
    });
    const after = await storeApi.loadStoredMemoryRecords(repoRoot);
    assert.equal(after.length, before.length);
    metrics.session_pollution.memory_unchanged_after_session_write = true;
  });
});

await runCase(
  "routing_feedback_loop",
  "positive routing feedback bumps prefer confidence; skill_ignored queues reinforcement",
  async () => {
    await withTempRepo(async (repoRoot) => {
      await storeApi.savePreference(
        {
          kind: "routing_preference",
          target_type: "skill",
          target: "release-checklist",
          preference: "prefer",
          reason: "baseline",
          confidence: 0.7,
          source: "manual",
          created_at: "2026-04-03T09:00:00.000Z",
          updated_at: "2026-04-03T09:00:00.000Z",
          status: "active",
        },
        repoRoot,
      );

      const bumpResult = await storeApi.applyRoutingFeedback(repoRoot, [
        {
          type: "skill_followed",
          skill: "release-checklist",
          notes: "Followed the checklist exactly; signal for reinforcement loop.",
          signal_strength: 0.95,
        },
      ]);
      assert.ok(
        bumpResult.applied.some((a) => a.kind === "preference_confidence_bumped"),
        "expected confidence bump from positive feedback",
      );

      const reinforce = await storeApi.applyRoutingFeedback(repoRoot, [
        {
          type: "skill_ignored",
          skill: "eslint",
          notes: "Agent ignored eslint suggestion from invocation plan; track for later review.",
          signal_strength: 0.9,
        },
      ]);
      assert.ok(
        reinforce.applied.some((a) => a.kind === "reinforcement_reminder_queued"),
        "expected reinforcement reminder",
      );
    });
  },
);

await runCase("preference_phrase_precision", "representative NL phrases extract intended targets", async () => {
  const table = [
    { input: "I prefer playwright for our browser tests", expectTarget: "playwright", expectPref: "prefer" },
    { input: "Please avoid jest for unit tests in this package", expectTarget: "jest", expectPref: "avoid" },
  ];
  for (const row of table) {
    metrics.preference_phrase_hits.total += 1;
    const p = storeApi.extractPreferenceFromNaturalLanguage(row.input, "eval");
    assert.ok(p, `expected extraction for: ${row.input}`);
    assert.equal(p.target.toLowerCase(), row.expectTarget);
    assert.equal(p.preference, row.expectPref);
    metrics.preference_phrase_hits.passed += 1;
    metrics.preference_phrase_hits.phrases.push({ sample: row.input.slice(0, 48), ok: true });
  }
  const vague = storeApi.extractPreferenceFromNaturalLanguage("maybe prefer eslint later");
  assert.equal(vague, null);
});

renderResults(results);
renderMetrics(metrics);

async function assertBuilt() {
  const candidates = [storeApiPath, extractPath, injectPath];
  try {
    await Promise.all(candidates.map((candidate) => import(pathToFileURL(candidate).href)));
  } catch {
    throw new Error('Build output missing. Run "npm run build" before running proof evaluations.');
  }
}

async function runCase(category, name, callback) {
  try {
    await callback();
    results.push({ category, name, status: "PASS" });
  } catch (error) {
    results.push({
      category,
      name,
      status: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function withTempRepo(callback) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-proof-eval-"));
  try {
    await storeApi.initBrain(repoRoot);
    await callback(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function writeSessionProfile(repoRoot, data) {
  const runtimeDir = path.join(repoRoot, ".brain", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  const profile = {
    version: 1,
    updated_at: new Date().toISOString(),
    hints: [],
    ...data,
  };
  await writeFile(path.join(runtimeDir, "session-profile.json"), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

function renderResults(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const bucket = grouped.get(entry.category) ?? [];
    bucket.push(entry);
    grouped.set(entry.category, bucket);
  }

  process.stdout.write("# RepoBrain Proof Evaluations\n\n");
  for (const [category, bucket] of grouped.entries()) {
    process.stdout.write(`## ${category}\n\n`);
    for (const entry of bucket) {
      process.stdout.write(`- ${entry.status}: ${entry.name}\n`);
      if (entry.detail) {
        process.stdout.write(`  ${entry.detail}\n`);
      }
    }
    process.stdout.write("\n");
  }
}

function renderMetrics(m) {
  process.stdout.write("## Metrics (deterministic checks)\n\n");
  process.stdout.write("| Metric | Result |\n");
  process.stdout.write("| --- | --- |\n");
  process.stdout.write(
    "| Extraction accept / reject | " +
      `lesson=${m.extraction_accept_reject.durable_lesson_accepted}, chatter_rejected=${m.extraction_accept_reject.chatter_rejected} |\n`,
  );
  process.stdout.write(
    "| Preference phrase precision (sampled) | " +
      `${m.preference_phrase_hits.passed}/${m.preference_phrase_hits.total} phrases matched expected target+value |\n`,
  );
  process.stdout.write(
    "| Route traceability | routing_explanation layers + per-skill evidence: " +
      `layers=${m.route_traceability.routing_explanation_layers}, evidence=${m.route_traceability.skill_evidence_keys} |\n`,
  );
  process.stdout.write(
    `| Stale / superseded filtering | superseded preference skipped in routing: ${m.stale_superseded_filter.superseded_preference_skipped} |\n`,
  );
  process.stdout.write(
    `| Session pollution prevention | memory file count unchanged after session write: ${m.session_pollution.memory_unchanged_after_session_write} |\n`,
  );
  process.stdout.write("\n");
}
