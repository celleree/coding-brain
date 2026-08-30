import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildInjection } from "../dist/inject.js";
import { buildSharePlan, buildSkillShortlist, initBrain, loadAllPreferences } from "../dist/store-api.js";
import { saveMemory, savePreference } from "./provenance-fixtures.mjs";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "cli.js");

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

await runTest("inject marks session hints separately from durable memories", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Example durable decision",
        summary: "Durable summary.",
        detail: "## DECISION\n\nBody.",
        tags: [],
        importance: "medium",
        date: "2026-04-01T10:00:00.000Z",
        score: 60,
        hit_count: 0,
        last_used: null,
        created_at: "2026-04-01",
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    await writeSessionProfile(projectRoot, {
      hints: ["这次先别跑全量测试"],
    });

    const injection = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, { noContext: true });
    assert.match(injection, /Session profile \(this session only\)/);
    assert.match(injection, /这次先别跑全量测试/);
    assert.match(injection, /durable records/);
    assert.match(injection, /session-profile\.json/);
  });
});

await runTest("inject omits session section after session file is removed", async () => {
  await withTempRepo(async (projectRoot) => {
    await writeSessionProfile(projectRoot, { hints: ["tmp"] });
    const withSession = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, { noContext: true });
    assert.match(withSession, /Session profile/);

    await rm(path.join(projectRoot, ".brain", "runtime", "session-profile.json"), { force: true });
    const cleared = await buildInjection(projectRoot, DEFAULT_BRAIN_CONFIG, { noContext: true });
    assert.doesNotMatch(cleared, /Session profile \(this session only\)/);
  });
});

await runTest("session routing beats ordinary preference but loses to static memory suppress", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "No jest in this repo",
        summary: "Suppress jest.",
        detail: "## DECISION\n\nUse vitest.",
        tags: [],
        importance: "high",
        date: "2026-04-01T12:00:00.000Z",
        status: "active",
        suppressed_skills: ["jest"],
        skill_trigger_tasks: ["unit tests"],
        invocation_mode: "optional",
        risk_level: "low",
      },
      projectRoot,
    );

    await writeSessionProfile(projectRoot, {
      skill_routing: [{ skill: "jest", preference: "prefer", reason: "session try jest" }],
    });

    const result = await buildSkillShortlist(projectRoot, {
      task: "unit tests for checkout",
      paths: [],
      path_source: "none",
    });

    const jestSkill = result.resolved_skills.find((s) => s.skill === "jest");
    assert.ok(jestSkill?.sources.some((s) => s.relation === "session_prefer"));
    assert.ok(jestSkill?.sources.some((s) => s.relation === "suppressed"));
    assert.equal(jestSkill?.plan_slot, "suppress");
  });
});

await runTest("session avoid outranks stored preference prefer for the same skill", async () => {
  await withTempRepo(async (projectRoot) => {
    await savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "jest",
        preference: "prefer",
        reason: "default",
        confidence: 0.9,
        source: "manual",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "active",
      },
      projectRoot,
    );

    await writeSessionProfile(projectRoot, {
      skill_routing: [{ skill: "jest", preference: "avoid" }],
    });

    const result = await buildSkillShortlist(projectRoot, {
      task: "run unit tests",
      paths: [],
      path_source: "none",
    });

    const jestSkill = result.resolved_skills.find((s) => s.skill === "jest");
    assert.ok(jestSkill?.sources.some((s) => s.relation === "preference_prefer"));
    assert.ok(jestSkill?.sources.some((s) => s.relation === "session_avoid"));
    assert.equal(jestSkill?.plan_slot, "suppress");
  });
});

await runTest("includeSessionProfile false skips session routing signals", async () => {
  await withTempRepo(async (projectRoot) => {
    await savePreference(
      {
        kind: "routing_preference",
        target_type: "skill",
        target: "jest",
        preference: "prefer",
        reason: "default",
        confidence: 0.9,
        source: "manual",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "active",
      },
      projectRoot,
    );

    await writeSessionProfile(projectRoot, {
      skill_routing: [{ skill: "jest", preference: "avoid" }],
    });

    const withSession = await buildSkillShortlist(projectRoot, {
      task: "run unit tests",
      paths: [],
      path_source: "none",
    });
    const withoutSession = await buildSkillShortlist(projectRoot, {
      task: "run unit tests",
      paths: [],
      path_source: "none",
      includeSessionProfile: false,
    });

    assert.ok(
      withSession.resolved_skills.some(
        (s) => s.skill === "jest" && s.sources.some((x) => x.relation === "session_avoid"),
      ),
    );
    assert.ok(
      withoutSession.resolved_skills.some(
        (s) => s.skill === "jest" && s.sources.every((x) => x.relation !== "session_avoid"),
      ),
    );
    assert.ok(withoutSession.invocation_plan.prefer_first.includes("jest"));
  });
});

await runTest("share plan never references runtime session files", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "working",
        title: "Shareable",
        summary: "x",
        detail: "## WORKING\n\ny",
        tags: [],
        importance: "low",
        date: "2026-04-01T10:00:00.000Z",
        score: 60,
        hit_count: 0,
        last_used: null,
        created_at: "2026-04-01",
        stale: false,
        status: "active",
      },
      projectRoot,
    );
    await writeSessionProfile(projectRoot, { hints: ["ephemeral"] });

    const plan = await buildSharePlan(projectRoot, { allActive: true });
    const joined = plan.addCommands.join("\n");
    assert.doesNotMatch(joined, /runtime/);
    assert.ok(plan.records.every((r) => !r.relativePath.includes("runtime")));
  });
});

await runTest("CLI session-promote writes a preference from session text", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-session-promote-"));
  try {
    await initBrain(tmpDir);
    await writeSessionProfile(tmpDir, {
      hints: [],
    });
    // Ensure extractable NL (same as preference tests)
    const set = await runCli(["session-set", "浏览器测试优先 Playwright 路线"], tmpDir, "");
    assert.equal(set.code, 0, set.stderr);

    const prom = await runCli(["session-promote", "--to", "preference"], tmpDir, "");
    assert.equal(prom.code, 0, prom.stderr);

    const prefs = await loadAllPreferences(tmpDir);
    assert.equal(prefs.length, 1);
    assert.equal(prefs[0]?.target, "playwright");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

await runTest("CLI session-clear removes session profile", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "repobrain-session-clear-"));
  try {
    await initBrain(tmpDir);
    await writeSessionProfile(tmpDir, { hints: ["x"] });
    const p = path.join(tmpDir, ".brain", "runtime", "session-profile.json");
    await readFile(p, "utf8");

    const clr = await runCli(["session-clear"], tmpDir, "");
    assert.equal(clr.code, 0, clr.stderr);

    await assert.rejects(() => readFile(p, "utf8"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

console.log("All session profile tests passed.");

async function writeSessionProfile(projectRoot, data) {
  const runtimeDir = path.join(projectRoot, ".brain", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  const profile = {
    version: 1,
    updated_at: new Date().toISOString(),
    hints: [],
    ...data,
  };
  await writeFile(path.join(runtimeDir, "session-profile.json"), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-session-"));
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

function runCli(args, cwd, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
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
      resolve({ code: code ?? 1, stdout, stderr });
    });

    child.stdin.end(stdinText);
  });
}
