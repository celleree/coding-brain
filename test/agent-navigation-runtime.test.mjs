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
    expect(result.plan?.match_kind).toBe("matched");
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
        "    live_checks: [current SHA]",
        "    then: [inspect]",
      ].join("\n"),
      "utf8",
    );

    const result = await buildAgentNavigationPlan(projectRoot, "investigate a strange new concern");

    expect(result.plan?.route_id).toBe("continue_project");
    expect(result.plan?.match_kind).toBe("fallback");
    expect(result.plan?.matched_terms).toEqual([]);
    expect(result.plan?.source_paths).toEqual(["README.md"]);
    expect(result.warnings.join("\n")).toMatch(/fallback route/i);
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


it("matches the intended user-facing phrases despite inserted words and simple inflection", async () => {
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
        "  repair_review_findings:",
        "    match: [fix review finding]",
        "    load: [readme]",
        "    live_checks: [review still applies]",
        "    then: [repair finding]",
        "  exact_head_review:",
        "    match: [review exact head]",
        "    load: [readme]",
        "    live_checks: [exact head]",
        "    then: [review only]",
        "  ci_failure:",
        "    match: [CI fail, build fail]",
        "    load: [readme]",
        "    live_checks: [failing run]",
        "    then: [inspect logs]",
      ].join("\n"),
      "utf8",
    );

    const cases = [
      ["Fix this review finding.", "repair_review_findings"],
      ["Review this exact HEAD.", "exact_head_review"],
      ["Why did CI fail?", "ci_failure"],
      ["Why did the build fail?", "ci_failure"],
    ];

    for (const [task, expectedRoute] of cases) {
      const result = await buildAgentNavigationPlan(projectRoot, task);
      expect(result.plan?.route_id).toBe(expectedRoute);
      expect(result.plan?.match_kind).toBe("matched");
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

it("reports malformed route fields instead of silently treating them as empty", async () => {
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
        "    match: continue",
        "    load: [readme]",
        "    live_checks: current SHA",
        "    then: [inspect]",
      ].join("\n"),
      "utf8",
    );

    const result = await buildAgentNavigationPlan(projectRoot, "unknown work");
    const warnings = result.warnings.join("\n");
    expect(warnings).toMatch(/match must be a string array/i);
    expect(warnings).toMatch(/live_checks must be a non-empty string array/i);
    expect(warnings).toMatch(/navigation plan withheld/i);
    expect(result.plan).toBeUndefined();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

it("tracks optional canonical sources separately when they are not shared on the current surface", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-nav-"));

  try {
    await mkdir(path.join(projectRoot, "docs", "brain"), { recursive: true });
    await writeFile(path.join(projectRoot, "README.md"), "# Repo\n", "utf8");
    await writeFile(
      path.join(projectRoot, "docs", "brain", "ROUTES.yaml"),
      [
        "sources:",
        "  memory_index:",
        "    path: .brain/shared/index.md",
        "    optional: true",
        "  readme:",
        "    path: README.md",
        "routes:",
        "  continue_project:",
        "    match: [continue]",
        "    load: [memory_index, readme]",
        "    live_checks: [current SHA]",
        "    then: [inspect]",
      ].join("\n"),
      "utf8",
    );

    const result = await buildAgentNavigationPlan(projectRoot, "continue");
    expect(result.warnings).toEqual([]);
    expect(result.plan?.source_paths).toEqual(["README.md"]);
    expect(result.plan?.unavailable_optional_sources).toEqual([".brain/shared/index.md"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});


it("withholds the navigation plan when a selected route omits required safeguards", async () => {
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
        "  exact_head_review:",
        "    priority: 100",
        "    match: [review PR]",
        "    load: [readme]",
      ].join("\n"),
      "utf8",
    );

    const result = await buildAgentNavigationPlan(projectRoot, "review PR #12");
    const warnings = result.warnings.join("\n");
    expect(result.plan).toBeUndefined();
    expect(warnings).toMatch(/live_checks must be a non-empty string array/i);
    expect(warnings).toMatch(/then must be a non-empty string array/i);
    expect(warnings).toMatch(/navigation plan withheld/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

it("uses route priority to keep operational intent ahead of incidental feature wording", async () => {
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
        "  implement_feature:",
        "    priority: 40",
        "    match: [add feature, build feature]",
        "    load: [readme]",
        "    live_checks: [base SHA]",
        "    then: [implement]",
        "  exact_head_review:",
        "    priority: 100",
        "    match: [review PR]",
        "    load: [readme]",
        "    live_checks: [exact head]",
        "    then: [do not edit]",
        "  ci_failure:",
        "    priority: 90",
        "    match: [build fail]",
        "    load: [readme]",
        "    live_checks: [failing run]",
        "    then: [inspect logs]",
      ].join("\n"),
      "utf8",
    );

    const review = await buildAgentNavigationPlan(
      projectRoot,
      "Review PR #12: add feature for navigation. Do not edit.",
    );
    expect(review.plan?.route_id).toBe("exact_head_review");

    const failure = await buildAgentNavigationPlan(
      projectRoot,
      "Fix the failing build on this feature branch.",
    );
    expect(failure.plan?.route_id).toBe("ci_failure");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});


it("keeps explicit implementation operations ahead of later memory-review subject words", async () => {
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
        "  implement_feature:",
        "    priority: 40",
        "    match: [implement feature, add feature, implement]",
        "    load: [readme]",
        "    live_checks: [base SHA]",
        "    then: [implement]",
        "  memory_review:",
        "    priority: 85",
        "    match: [review memory, approve memory, candidate memory]",
        "    load: [readme]",
        "    live_checks: [candidate queue]",
        "    then: [review candidate]",
      ].join("\n"),
      "utf8",
    );

    const cases = [
      "Add a feature to approve memory candidates automatically.",
      "Implement the memory review workflow change.",
      "Add a feature for memory review.",
    ];

    for (const task of cases) {
      const result = await buildAgentNavigationPlan(projectRoot, task);
      expect(result.plan?.route_id, task).toBe("implement_feature");
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});


it("withholds the plan when a selected required source definition is invalid", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-nav-"));

  try {
    await mkdir(path.join(projectRoot, "docs", "brain"), { recursive: true });
    await writeFile(
      path.join(projectRoot, "docs", "brain", "ROUTES.yaml"),
      [
        "sources:",
        "  broken:",
        "    path: 42",
        "routes:",
        "  continue_project:",
        "    match: [continue]",
        "    load: [broken]",
        "    live_checks: [current SHA]",
        "    then: [inspect]",
      ].join("\n"),
      "utf8",
    );

    const result = await buildAgentNavigationPlan(projectRoot, "continue");
    expect(result.plan).toBeUndefined();
    expect(result.warnings.join("\n")).toMatch(/invalid source/i);
    expect(result.warnings.join("\n")).toMatch(/plan withheld/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
