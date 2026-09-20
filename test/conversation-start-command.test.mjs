import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initBrain } from "../dist/store-api.js";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "cli.js");

await runTest("conversation-start bootstraps with start on the first task-aware conversation", async () => {
  await withTempRepo(async (projectRoot) => {
    const result = await runCliProcess(
      ["conversation-start", "--task", "fix refund bug", "--format", "json"],
      projectRoot,
    );
    assert.equal(result.code, 0, result.stderr);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, "start");
    assert.equal(parsed.refresh_mode, "smart");
    assert.ok(typeof parsed.context_markdown === "string" && parsed.context_markdown.length > 0);
    assert.ok(parsed.skill_plan);
    assert.equal(parsed.navigation_plan.route_id, "continue_project");
    assert.equal(parsed.task_routing_bundle.navigation_plan.route_id, "continue_project");
    assert.equal(parsed.decision_trace.first_conversation, true);
  });
});

await runTest("conversation-start skips redundant refresh for the same task inside the reuse window", async () => {
  await withTempRepo(async (projectRoot) => {
    const first = await runCliProcess(
      ["conversation-start", "--task", "fix refund bug", "--format", "json"],
      projectRoot,
    );
    assert.equal(first.code, 0, first.stderr);

    const second = await runCliProcess(
      ["conversation-start", "--task", "fix refund bug", "--format", "json"],
      projectRoot,
    );
    assert.equal(second.code, 0, second.stderr);

    const parsed = JSON.parse(second.stdout);
    assert.equal(parsed.action, "skip");
    assert.equal(parsed.decision_trace.task_changed, false);
    assert.ok(/redundant|still matches/i.test(parsed.reason));
  });
});

await runTest(
  "conversation-start refreshes compact context when the task changes later in the same session",
  async () => {
    await withTempRepo(async (projectRoot) => {
      const first = await runCliProcess(
        ["conversation-start", "--task", "fix refund bug", "--format", "json"],
        projectRoot,
      );
      assert.equal(first.code, 0, first.stderr);

      const second = await runCliProcess(
        ["conversation-start", "--task", "audit payment webhook", "--format", "json"],
        projectRoot,
      );
      assert.equal(second.code, 0, second.stderr);

      const parsed = JSON.parse(second.stdout);
      assert.equal(parsed.action, "inject");
      assert.equal(parsed.decision_trace.task_changed, true);
      assert.ok(typeof parsed.context_markdown === "string" && parsed.context_markdown.length > 0);
      assert.equal(parsed.navigation_plan.route_id, "continue_project");
    });
  },
);

await runTest("conversation-start refreshes compact context when the session profile changed", async () => {
  await withTempRepo(async (projectRoot) => {
    const first = await runCliProcess(
      ["conversation-start", "--task", "fix refund bug", "--format", "json"],
      projectRoot,
    );
    assert.equal(first.code, 0, first.stderr);

    const runtimeDir = path.join(projectRoot, ".brain", "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      path.join(runtimeDir, "session-profile.json"),
      `${JSON.stringify(
        {
          version: 1,
          updated_at: new Date(Date.now() + 60_000).toISOString(),
          hints: ["Prefer minimal changes for this conversation."],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const second = await runCliProcess(
      ["conversation-start", "--task", "fix refund bug", "--format", "json"],
      projectRoot,
    );
    assert.equal(second.code, 0, second.stderr);

    const parsed = JSON.parse(second.stdout);
    assert.equal(parsed.action, "inject");
    assert.equal(parsed.decision_trace.session_profile_changed, true);
  });
});

console.log("All conversation-start command tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-conversation-start-"));
  try {
    await initBrain(projectRoot);
    await mkdir(path.join(projectRoot, "docs", "brain"), { recursive: true });
    await writeFile(path.join(projectRoot, "README.md"), "# Temp repo\n", "utf8");
    await writeFile(
      path.join(projectRoot, "docs", "brain", "ROUTES.yaml"),
      [
        "sources:",
        "  readme:",
        "    path: README.md",
        "routes:",
        "  continue_project:",
        "    match: [continue]",
        "    load: [readme]",
      ].join("\n"),
      "utf8",
    );
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function runCliProcess(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
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
  });
}

function runTest(name, callback) {
  it(name, callback);
}

const assert = {
  equal(actual, expected, message) {
    expect(actual, message).toBe(expected);
  },
  ok(value, message) {
    expect(value, message).toBeTruthy();
  },
};
