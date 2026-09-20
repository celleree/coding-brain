import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();

it("keeps the navigation source inventory bound to real canonical files", async () => {
  const routes = parse(await readFile(path.join(projectRoot, "docs", "brain", "ROUTES.yaml"), "utf8"));

  for (const [sourceId, source] of Object.entries(routes.sources)) {
    expect(source.path, sourceId).toBeTruthy();
    if (source.optional === true) continue;
    await expect(access(path.join(projectRoot, source.path))).resolves.toBeUndefined();
  }

  const entry = await readFile(path.join(projectRoot, "AI_START_HERE.md"), "utf8");
  expect(entry).toContain("docs/brain/START_HERE.md");
  expect(entry).toContain("docs/brain/ROUTES.yaml");
  expect(entry).toContain(".brain/shared/index.md");
});

it("keeps local RepoBrain state ignored while explicit shared artifacts require force-add", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repobrain-share-git-"));

  try {
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "RepoBrain Test"], { cwd: root });

    await writeFile(path.join(root, ".gitignore"), ".brain\n", "utf8");
    await mkdir(path.join(root, ".brain", "decisions"), { recursive: true });
    await mkdir(path.join(root, ".brain", "sources", "sha256", "aa"), { recursive: true });
    await mkdir(path.join(root, ".brain", "shared"), { recursive: true });

    await writeFile(path.join(root, ".brain", "decisions", "selected.md"), "selected\n");
    await writeFile(path.join(root, ".brain", "decisions", "candidate.md"), "candidate\n");
    await writeFile(path.join(root, ".brain", "sources", "sha256", "aa", "raw.blob"), "raw\n");
    await writeFile(path.join(root, ".brain", "routing-feedback-log.json"), "{}\n");
    await writeFile(path.join(root, ".brain", "shared", "index.md"), "# shared\n");

    await execFileAsync("git", ["add", ".gitignore"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });

    const ordinary = (await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: root })).stdout;
    expect(ordinary).toContain(".gitignore");
    expect(ordinary).not.toContain(".brain/");

    await execFileAsync("git", ["add", "-f", ".brain/decisions/selected.md", ".brain/shared/index.md"], { cwd: root });
    const explicit = (await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: root })).stdout;

    expect(explicit).toContain(".brain/decisions/selected.md");
    expect(explicit).toContain(".brain/shared/index.md");
    expect(explicit).not.toContain(".brain/decisions/candidate.md");
    expect(explicit).not.toContain(".brain/sources/");
    expect(explicit).not.toContain("routing-feedback-log.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
