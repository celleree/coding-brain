import { expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildAgentNavigationPlan } from "../dist/store-api.js";

it("selects the closest task route and resolves canonical source paths", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-nav-"));

  try {
    await mkdir(path.join(projectRoot, "docs", "brain"), { recursive: true });
    await mkdir(path.join(projectRoot, "docs"), { recursive: true });
    await writeFile(path.join(projectRoot, "docs", "architecture.md"), "# Architecture\n", "utf8");
    await writeFile(path.join(projectRoot, "package.json"), "{}\n", "utf8");
    await writeFile(
      path.join(projectRoot, "docs", "brain", "ROUTES.yaml"),
      [
        "version: 1",
        "sources:",
        "  architecture:",
        "    path: docs/architecture.md",
        "  package_manifest:",
        "    path: package.json",
        "routes:",
        "  continue_project:",
        "    match: [continue]",
        "    load: [architecture]",
        "    live_checks: [current main SHA]",
        "    then: [narrow task]",
        "  ci_failure:",
        "    match: [CI failed, build failed]",
        "    load: [package_manifest]",
        "    live_checks: [exact failing run]",
        "    then: [start from logs]",
      ].join("\n"),
      "utf8",
    );

    const result = await buildAgentNavigationPlan(projectRoot, "CI failed on the latest PR");

    expect(result.warnings).toEqual([]);
    expect(result.plan?.route_id).toBe("ci_failure");
    expect(result.plan?.matched_terms).toEqual(["CI failed"]);
    expect(result.plan?.source_paths).toEqual(["package.json"]);
    expect(result.plan?.live_checks).toEqual(["exact failing run"]);
    expect(result.plan?.next_steps).toEqual(["start from logs"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

it("falls back to continue_project for unknown intent", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-nav-"));

  try {
    await mkdir(path.join(projectRoot, "docs", "brain"), { recursive: true });
    await writeFile(path.join(projectRoot, "README.md"), "# Repo\n", "utf8");
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

    const result = await buildAgentNavigationPlan(projectRoot, "investigate a strange new concern");

    expect(result.plan?.route_id).toBe("continue_project");
    expect(result.plan?.matched_terms).toEqual([]);
    expect(result.plan?.source_paths).toEqual(["README.md"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

it("is backward compatible when no navigation manifest exists", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-nav-"));

  try {
    const result = await buildAgentNavigationPlan(projectRoot, "fix bug");
    expect(result).toEqual({ warnings: [] });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
