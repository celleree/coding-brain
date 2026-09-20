import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { buildAgentNavigationPlan } from "../dist/index.js";
it("routes explicit actions ahead of context and ignores negated actions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nav-a2-"));
  try {
    await mkdir(path.join(root, "docs", "brain"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# repo\n");
    await writeFile(
      path.join(root, "docs", "brain", "ROUTES.yaml"),
      ["sources:", "  readme: { path: README.md }", "routes:",
        "  implement_feature:",
        "    priority: 40",
        "    match: [implement feature, implement]",
        "    load: [readme]",
        "    live_checks: [base SHA]",
        "    then: [implement]",
        "  exact_head_review:",
        "    priority: 100",
        "    match: [review PR]",
        "    load: [readme]",
        "    live_checks: [exact HEAD]",
        "    then: [do not edit]",
        "  codex_workflow:",
        "    priority: 70",
        "    match: [Codex workflow]",
        "    context_match: [Codex]",
        "    load: [readme]",
        "    live_checks: [capability]",
        "    then: [route model]"].join("\n"),
    );

    for (const task of ["In Codex, review PR #12. Do not edit.", "Do not implement a feature. Review PR #12 without editing."]) {
      const result = await buildAgentNavigationPlan(root, task);
      expect(result.plan?.route_id, task).toBe("exact_head_review");
    }
    expect((await buildAgentNavigationPlan(root, "Codex")).plan?.route_id).toBe("codex_workflow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("withholds a plan when selected safeguards are malformed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nav-a2-"));
  try {
    await mkdir(path.join(root, "docs", "brain"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# repo\n");
    await writeFile(
      path.join(root, "docs", "brain", "ROUTES.yaml"),
      ["sources:", "  readme: { path: README.md }", "routes:",
        "  exact_head_review:",
        "    match: [review PR]",
        "    load: [readme]"].join("\n"),
    );
    const result = await buildAgentNavigationPlan(root, "review PR #12");
    expect(result.plan).toBeUndefined();
    expect(result.warnings.join("\n")).toMatch(/plan withheld/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
