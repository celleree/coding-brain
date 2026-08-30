/**
 * Generates representative proof bundles (TypeScript CLI + full-stack web) with
 * checkable artifacts: durable memory, preferences, session profile, route JSON,
 * feedback events, timeline, and NL preference capture — no remote APIs.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const defaultOut = path.join(projectRoot, "docs", "demo-assets", "proof-bundles");
const outputRoot = path.resolve(readFlagValue("--output-dir") ?? defaultOut);

const storeApiPath = path.join(projectRoot, "dist", "store-api.js");

await assertDistBuilt();
const storeApi = withSourcedWrites(await import(pathToFileURL(storeApiPath).href));

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

await rm(outputRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await mkdir(outputRoot, { recursive: true });

await buildTypeScriptCliBundle(path.join(outputRoot, "typescript-cli"));
await buildFullstackWebBundle(path.join(outputRoot, "fullstack-web"));

await writeFile(
  path.join(outputRoot, "README.md"),
  [
    "# Proof bundles (generated)",
    "",
    "These folders are produced by `npm run proof:bundles` (or `node scripts/generate-proof-bundles.mjs`).",
    "Each bundle includes durable memories, preferences, a session profile, routing JSON, feedback, timeline, and NL preference capture output.",
    "",
    "- `typescript-cli/` — library / CLI style paths (`src/`, `package.json`).",
    "- `fullstack-web/` — app + API + e2e style paths (`app/`, `server/`, `e2e/`).",
    "",
  ].join("\n"),
  "utf8",
);

process.stdout.write(`Proof bundles written to ${outputRoot}\n`);

async function buildTypeScriptCliBundle(outDir) {
  await mkdir(outDir, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "repobrain-proof-ts-"));
  try {
    await storeApi.initBrain(tmp);

    const memOldPath = await storeApi.saveMemory(
      {
        type: "convention",
        title: "Release validation used npm pack dry-run only",
        summary: "Older release flow.",
        detail: "## CONVENTION\n\nDry-run only.",
        tags: ["release"],
        importance: "medium",
        date: "2026-03-01T10:00:00.000Z",
        status: "active",
        path_scope: ["package.json"],
        skill_trigger_tasks: ["publish npm"],
        skill_trigger_paths: ["package.json"],
        recommended_skills: ["npm-install-smoke"],
        invocation_mode: "optional",
        risk_level: "low",
      },
      tmp,
    );

    const memNewPath = await storeApi.saveMemory(
      {
        type: "decision",
        title: "Release must run packaged install smoke before publish",
        summary: "Replaces dry-run-only guidance.",
        detail: "## DECISION\n\nSmoke required.",
        tags: ["release", "smoke"],
        importance: "high",
        date: "2026-04-01T10:00:00.000Z",
        status: "active",
        path_scope: ["package.json", "docs/release-checklist.md"],
        skill_trigger_tasks: ["publish npm", "prepare release"],
        skill_trigger_paths: ["package.json", "docs/release-checklist.md"],
        required_skills: ["release-checklist"],
        recommended_skills: ["npm-install-smoke"],
        suppressed_skills: ["imagegen"],
        invocation_mode: "prefer",
        risk_level: "medium",
      },
      tmp,
    );

    const records = await storeApi.loadStoredMemoryRecords(tmp);
    const oldRec = records.find((r) => r.filePath === memOldPath);
    const newRec = records.find((r) => r.filePath === memNewPath);
    assert.ok(oldRec && newRec);
    await storeApi.supersedeMemoryPair(newRec, oldRec);

    const memRecords = await storeApi.loadStoredMemoryRecords(tmp);
    const start = memRecords.find((r) => r.filePath === memNewPath);
    assert.ok(start);
    const chain = storeApi.buildMemoryEvolutionChain(memRecords, start);

    const routeBefore = await storeApi.buildSkillShortlist(tmp, {
      task: "prepare npm release with checklist",
      paths: ["package.json", "docs/release-checklist.md"],
      path_source: "explicit",
    });

    const prefPath = await storeApi.savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "npm-install-smoke",
        preference: "avoid",
        reason: "Local proof: CI already runs smoke; skip doubling work on dev machines.",
        confidence: 0.82,
        source: "manual",
        created_at: "2026-04-02T10:00:00.000Z",
        updated_at: "2026-04-02T10:00:00.000Z",
        status: "active",
      },
      tmp,
    );

    const routeAfter = await storeApi.buildSkillShortlist(tmp, {
      task: "prepare npm release with checklist",
      paths: ["package.json", "docs/release-checklist.md"],
      path_source: "explicit",
    });

    await writeSessionProfile(tmp, {
      hints: ["This session: prioritize checklist over extra smoke scripts."],
      skill_routing: [
        { skill: "npm-install-smoke", preference: "prefer", reason: "temporary: reproduce customer install bug" },
      ],
    });

    const routeWithSession = await storeApi.buildSkillShortlist(tmp, {
      task: "prepare npm release with checklist",
      paths: ["package.json", "docs/release-checklist.md"],
      path_source: "explicit",
    });

    const fb1 = await storeApi.applyRoutingFeedback(tmp, [
      {
        type: "workflow_failure",
        workflow: "adhoc-publish",
        notes: "Ad-hoc publish workflow failed twice; do not suggest it until reviewed.",
        signal_strength: 0.9,
      },
    ]);

    await storeApi.savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "release-checklist",
        preference: "prefer",
        reason: "baseline for feedback bump demo",
        confidence: 0.72,
        source: "manual",
        created_at: "2026-04-02T09:00:00.000Z",
        updated_at: "2026-04-02T09:00:00.000Z",
        status: "active",
      },
      tmp,
    );

    const fb2 = await storeApi.applyRoutingFeedback(tmp, [
      {
        type: "skill_followed",
        skill: "release-checklist",
        notes: "Operator followed release-checklist steps in order.",
        signal_strength: 0.95,
      },
    ]);

    const nlLines = [];
    for (const text of [
      "I prefer playwright for smoke tests in this CLI repo",
      "Please avoid imagegen for release automation tasks",
    ]) {
      const p = storeApi.extractPreferenceFromNaturalLanguage(text, "proof-bundle");
      nlLines.push(`Input: ${text}`);
      nlLines.push(p ? JSON.stringify(p, null, 2) : "(no extract — weak signal)");
      nlLines.push("");
    }

    await writeFile(path.join(outDir, "preference-capture-output.txt"), nlLines.join("\n").trim() + "\n", "utf8");
    await writeFile(
      path.join(outDir, "route-before.json"),
      JSON.stringify(slimRoute(routeBefore), null, 2) + "\n",
      "utf8",
    );
    await writeFile(
      path.join(outDir, "route-after.json"),
      JSON.stringify(slimRoute(routeAfter), null, 2) + "\n",
      "utf8",
    );
    await writeFile(
      path.join(outDir, "route-with-session.json"),
      JSON.stringify(slimRoute(routeWithSession), null, 2) + "\n",
      "utf8",
    );

    const timeline = [
      "Memory evolution chain (oldest → newest):",
      ...chain.map((r) => `- ${r.memory.title} | status=${r.memory.status} | file=${r.relativePath}`),
      "",
      "Note: superseded memory is filtered from inject / routing consumption but remains in Git history.",
    ].join("\n");
    await writeFile(path.join(outDir, "timeline-output.txt"), timeline + "\n", "utf8");

    await writeFile(
      path.join(outDir, "feedback-loop-output.txt"),
      [
        "=== workflow_failure → preference candidate ===",
        JSON.stringify(fb1, null, 2),
        "",
        "=== skill_followed → confidence bump or pending ===",
        JSON.stringify(fb2, null, 2),
      ].join("\n") + "\n",
      "utf8",
    );

    await writeFile(
      path.join(outDir, "bundle-manifest.json"),
      JSON.stringify(
        {
          kind: "repobrain.proof_bundle",
          flavor: "typescript-cli",
          durable_memories: memRecords.map((r) => r.relativePath),
          preferences: [".brain/preferences/*.md (see copied sample)"],
          session_profile: ".brain/runtime/session-profile.json",
          route_artifacts: ["route-before.json", "route-after.json", "route-with-session.json"],
          feedback_events: ["workflow_failure", "skill_followed"],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    await copyBrainSnippet(tmp, memNewPath, path.join(outDir, "durable-memory-sample.md"));
    await copyBrainSnippet(tmp, prefPath, path.join(outDir, "preference-sample.md"));
    await copyBrainSnippet(
      tmp,
      path.join(tmp, ".brain", "runtime", "session-profile.json"),
      path.join(outDir, "session-profile.json"),
    );

    assert.ok(routeBefore.invocation_plan.prefer_first.includes("npm-install-smoke"));
    assert.ok(!routeBefore.invocation_plan.suppress.includes("npm-install-smoke"));
    assert.ok(routeAfter.invocation_plan.suppress.includes("npm-install-smoke"));
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function buildFullstackWebBundle(outDir) {
  await mkdir(outDir, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "repobrain-proof-web-"));
  try {
    await storeApi.initBrain(tmp);

    await storeApi.saveMemory(
      {
        type: "decision",
        title: "E2E uses Playwright against staging API",
        summary: "Web stack smoke.",
        detail: "## DECISION\n\nPlaywright e2e.",
        tags: ["e2e", "web"],
        importance: "high",
        date: "2026-04-03T10:00:00.000Z",
        status: "active",
        path_scope: ["e2e/", "app/"],
        skill_trigger_tasks: ["fix checkout bug", "debug flaky e2e"],
        skill_trigger_paths: ["e2e/checkout.spec.ts", "app/checkout/page.tsx"],
        required_skills: ["playwright"],
        recommended_skills: ["eslint"],
        suppressed_skills: ["cypress"],
        invocation_mode: "prefer",
        risk_level: "medium",
      },
      tmp,
    );

    const routeBefore = await storeApi.buildSkillShortlist(tmp, {
      task: "debug flaky e2e checkout",
      paths: ["e2e/checkout.spec.ts"],
      path_source: "explicit",
      includeSessionProfile: false,
    });

    await storeApi.savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "eslint",
        preference: "avoid",
        reason: "Proof bundle: temporarily rely on Biome instead of ESLint for this repo.",
        confidence: 0.8,
        source: "manual",
        created_at: "2026-04-03T11:00:00.000Z",
        updated_at: "2026-04-03T11:00:00.000Z",
        status: "active",
      },
      tmp,
    );

    const routeAfter = await storeApi.buildSkillShortlist(tmp, {
      task: "debug flaky e2e checkout",
      paths: ["e2e/checkout.spec.ts"],
      path_source: "explicit",
      includeSessionProfile: false,
    });

    await writeSessionProfile(tmp, {
      skill_routing: [
        { skill: "eslint", preference: "prefer", reason: "hotfix session: must run eslint on touched files" },
      ],
    });

    const routeSession = await storeApi.buildSkillShortlist(tmp, {
      task: "debug flaky e2e checkout",
      paths: ["e2e/checkout.spec.ts"],
      path_source: "explicit",
    });

    const fb = await storeApi.applyRoutingFeedback(tmp, [
      {
        type: "skill_ignored",
        skill: "playwright",
        notes: "Agent ignored Playwright hint; queue reinforcement for later human review.",
        signal_strength: 0.92,
      },
    ]);

    const nlLines = [];
    for (const text of ["prefer playwright for e2e tests", "avoid cypress for new tests"]) {
      const p = storeApi.extractPreferenceFromNaturalLanguage(text, "proof-bundle");
      nlLines.push(`Input: ${text}`);
      nlLines.push(p ? JSON.stringify(p, null, 2) : "(no extract)");
      nlLines.push("");
    }

    await writeFile(path.join(outDir, "preference-capture-output.txt"), nlLines.join("\n").trim() + "\n", "utf8");
    await writeFile(
      path.join(outDir, "route-before.json"),
      JSON.stringify(slimRoute(routeBefore), null, 2) + "\n",
      "utf8",
    );
    await writeFile(
      path.join(outDir, "route-after.json"),
      JSON.stringify(slimRoute(routeAfter), null, 2) + "\n",
      "utf8",
    );
    await writeFile(
      path.join(outDir, "route-with-session.json"),
      JSON.stringify(slimRoute(routeSession), null, 2) + "\n",
      "utf8",
    );
    await writeFile(
      path.join(outDir, "timeline-output.txt"),
      "Single active memory (no supersedes chain in this bundle).\nSee route JSON for skill_evidence and routing_explanation.\n",
      "utf8",
    );
    await writeFile(path.join(outDir, "feedback-loop-output.txt"), JSON.stringify(fb, null, 2) + "\n", "utf8");

    await writeFile(
      path.join(outDir, "bundle-manifest.json"),
      JSON.stringify(
        {
          kind: "repobrain.proof_bundle",
          flavor: "fullstack-web",
          route_artifacts: ["route-before.json", "route-after.json", "route-with-session.json"],
          feedback_events: ["skill_ignored"],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const memFiles = await storeApi.loadStoredMemoryRecords(tmp);
    await copyBrainSnippet(tmp, memFiles[0].filePath, path.join(outDir, "durable-memory-sample.md"));
    const prefs = await storeApi.loadStoredPreferenceRecords(tmp);
    await copyBrainSnippet(tmp, prefs[0].filePath, path.join(outDir, "preference-sample.md"));
    await copyBrainSnippet(
      tmp,
      path.join(tmp, ".brain", "runtime", "session-profile.json"),
      path.join(outDir, "session-profile.json"),
    );

    assert.ok(routeBefore.invocation_plan.prefer_first.includes("eslint"));
    assert.ok(routeAfter.invocation_plan.suppress.includes("eslint"));
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function slimRoute(result) {
  return {
    task: result.task,
    paths: result.paths,
    invocation_plan: result.invocation_plan,
    routing_explanation: result.routing_explanation
      ? {
          notes: result.routing_explanation.notes.slice(0, 12),
          skill_evidence_keys: Object.keys(result.routing_explanation.skill_evidence ?? {}).sort(),
        }
      : undefined,
  };
}

async function copyBrainSnippet(repoRoot, sourceFile, dest) {
  const text = await readFile(sourceFile, "utf8");
  await writeFile(dest, text, "utf8");
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

async function assertDistBuilt() {
  try {
    await readFile(storeApiPath, "utf8");
  } catch {
    throw new Error('Build output missing. Run "npm run build" before generating proof bundles.');
  }
}

function readFlagValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return process.argv[idx + 1];
}
