import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "vitest";

test("launch receipt redacts config and does not write or claim readiness", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-receipt-"));
  try {
    const home = join(directory, "home");
    mkdirSync(home);
    const config =
      'model = "configured-model"\napi_key = "SENSITIVE-SENTINEL"\n[profiles.custom]\nmodel = "profile-model"\n';
    writeFileSync(join(home, "config.toml"), config);
    writeFileSync(join(home, "AGENTS.md"), "personal instructions");
    writeFileSync(join(home, "AGENTS.override.md"), "override instructions");
    execFileSync("git", ["init", "-q", directory]);
    execFileSync("git", [
      "-C",
      directory,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ]);
    const before = execFileSync("git", ["-C", directory, "status", "--porcelain=v1"], { encoding: "utf8" });
    const stdout = execFileSync(process.execPath, [resolve("scripts/codex-workflow-receipt.mjs")], {
      cwd: directory,
      env: { ...process.env, CODEX_HOME: home },
      encoding: "utf8",
    });
    const receipt = JSON.parse(stdout);
    expect(stdout).not.toContain("SENSITIVE-SENTINEL");
    expect(stdout).not.toContain("profile-model");
    expect(receipt.executor.selectedDefaults.model).toBe("configured-model");
    expect(receipt.executor.activeModelVerified).toBe(false);
    expect(receipt.guidance.global.path).toBe(join(home, "AGENTS.override.md"));
    expect(receipt.readiness.status).toBe("UNVERIFIED");
    expect(receipt.readiness.releaseAuthorized).toBe(false);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(config);
    expect(execFileSync("git", ["-C", directory, "status", "--porcelain=v1"], { encoding: "utf8" })).toBe(before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
