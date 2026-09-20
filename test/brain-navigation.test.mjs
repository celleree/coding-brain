import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";
import { parse } from "yaml";

import { buildAgentNavigationPlan } from "../dist/store-api.js";

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");
const routesPath = path.join(projectRoot, "docs", "brain", "ROUTES.yaml");

it("keeps every navigation source pointed at a real repository file", async () => {
  const routes = parse(await readFile(routesPath, "utf8"));

  expect(routes.version).toBe(1);
  expect(routes.durable_memory_store).toBe(".brain/");
  expect(routes.sources).toBeTruthy();

  for (const [sourceId, source] of Object.entries(routes.sources)) {
    expect(source.path, `source ${sourceId} must define a path`).toBeTruthy();
    if (source.optional === true) {
      continue;
    }
    await expect(access(path.join(projectRoot, source.path))).resolves.toBeUndefined();
  }
});

it("keeps every route reference bound to a declared canonical source", async () => {
  const routes = parse(await readFile(routesPath, "utf8"));
  const sourceIds = new Set(Object.keys(routes.sources));

  for (const [routeId, route] of Object.entries(routes.routes)) {
    expect(Array.isArray(route.load), `route ${routeId} must define a load list`).toBe(true);
    expect(Array.isArray(route.live_checks), `route ${routeId} must define live checks`).toBe(true);
    expect(Array.isArray(route.then), `route ${routeId} must define next steps`).toBe(true);

    for (const sourceId of route.load) {
      expect(sourceIds.has(sourceId), `route ${routeId} references unknown source ${sourceId}`).toBe(true);
    }
  }
});

it("keeps the cross-agent entrypoint connected to the route map and migration audit", async () => {
  const entrypoint = await readFile(path.join(projectRoot, "AI_START_HERE.md"), "utf8");
  const bootstrap = await readFile(path.join(projectRoot, "docs", "brain", "START_HERE.md"), "utf8");
  const audit = await readFile(path.join(projectRoot, "docs", "brain", "MIGRATION_AUDIT.md"), "utf8");

  expect(entrypoint).toContain("docs/brain/START_HERE.md");
  expect(entrypoint).toContain("docs/brain/ROUTES.yaml");
  expect(entrypoint).toContain(".brain/shared/index.md");
  expect(bootstrap).toContain("MIGRATION_AUDIT.md");
  expect(audit).toContain("Information discarded as unimportant");
  expect(audit).toContain("None.");
});

it("keeps critical existing RepoBrain guidance represented in the navigation source inventory", async () => {
  const routes = parse(await readFile(routesPath, "utf8"));
  const representedPaths = new Set(Object.values(routes.sources).map((source) => source.path));

  for (const requiredPath of [
    "README.md",
    "docs/workflow-modes.md",
    "docs/team-workflow.md",
    ".codex/INSTALL.md",
    ".codex/session-start-prompt.md",
  ]) {
    expect(representedPaths.has(requiredPath), `missing navigation source: ${requiredPath}`).toBe(true);
  }
});

it("routes realistic production intents to the operational route instead of incidental feature words", async () => {
  const cases = [
    ["Fix the failing build on this feature branch.", "ci_failure"],
    ["Review PR #12: add feature for agent navigation. Do not edit.", "exact_head_review"],
    ["Set up RepoBrain.", "setup_onboarding"],
    ["Review this memory.", "memory_review"],
    ["Approve this memory.", "memory_review"],
  ];

  for (const [task, expectedRoute] of cases) {
    const result = await buildAgentNavigationPlan(projectRoot, task);
    expect(result.plan?.route_id, task).toBe(expectedRoute);
    expect(result.plan?.match_kind, task).toBe("matched");
  }
});

it("keeps RepoBrain private by default and requires force-add for explicitly shared memory", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-git-share-"));

  try {
    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: tempRoot });
    await execFileAsync("git", ["config", "user.name", "RepoBrain Test"], { cwd: tempRoot });

    await writeFile(path.join(tempRoot, ".gitignore"), ".brain\n", "utf8");
    await mkdir(path.join(tempRoot, ".brain", "decisions"), { recursive: true });
    await mkdir(path.join(tempRoot, ".brain", "sources", "sha256", "aa"), { recursive: true });
    await mkdir(path.join(tempRoot, ".brain", "shared"), { recursive: true });

    await writeFile(path.join(tempRoot, ".brain", "decisions", "selected.md"), "selected\n", "utf8");
    await writeFile(path.join(tempRoot, ".brain", "decisions", "candidate.md"), "candidate\n", "utf8");
    await writeFile(path.join(tempRoot, ".brain", "sources", "sha256", "aa", "raw.blob"), "raw private input\n", "utf8");
    await writeFile(path.join(tempRoot, ".brain", "routing-feedback-log.json"), "{}\n", "utf8");
    await writeFile(path.join(tempRoot, ".brain", "shared", "index.md"), "# shared\n", "utf8");

    await execFileAsync("git", ["add", ".gitignore"], { cwd: tempRoot });
    await execFileAsync("git", ["add", "."], { cwd: tempRoot });

    const defaultStage = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: tempRoot });
    expect(defaultStage.stdout).toContain(".gitignore");
    expect(defaultStage.stdout).not.toContain(".brain/");

    await execFileAsync(
      "git",
      ["add", "-f", ".brain/decisions/selected.md", ".brain/shared/index.md"],
      { cwd: tempRoot },
    );

    const explicitStage = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: tempRoot });
    expect(explicitStage.stdout).toContain(".brain/decisions/selected.md");
    expect(explicitStage.stdout).toContain(".brain/shared/index.md");
    expect(explicitStage.stdout).not.toContain(".brain/decisions/candidate.md");
    expect(explicitStage.stdout).not.toContain(".brain/sources/");
    expect(explicitStage.stdout).not.toContain("routing-feedback-log.json");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
