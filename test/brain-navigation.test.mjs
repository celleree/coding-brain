import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import { parse } from "yaml";

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
    await expect(access(path.join(projectRoot, source.path))).resolves.toBeUndefined();
  }
});

it("keeps every route reference bound to a declared canonical source", async () => {
  const routes = parse(await readFile(routesPath, "utf8"));
  const sourceIds = new Set(Object.keys(routes.sources));

  for (const [routeId, route] of Object.entries(routes.routes)) {
    expect(Array.isArray(route.load), `route ${routeId} must define a load list`).toBe(true);
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
  expect(bootstrap).toContain("MIGRATION_AUDIT.md");
  expect(audit).toContain("Information discarded as unimportant");
  expect(audit).toContain("None.");
});
