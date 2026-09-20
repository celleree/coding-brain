import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export const AGENT_NAVIGATION_MANIFEST_PATH = path.join("docs", "brain", "ROUTES.yaml");

export interface AgentNavigationPlan {
  manifest_path: string;
  route_id: string;
  matched_terms: string[];
  source_paths: string[];
  live_checks: string[];
  next_steps: string[];
}

export interface AgentNavigationResult {
  plan?: AgentNavigationPlan;
  warnings: string[];
}

interface NavigationSource {
  path?: unknown;
}

interface NavigationRoute {
  match?: unknown;
  load?: unknown;
  live_checks?: unknown;
  then?: unknown;
}

interface NavigationManifest {
  sources?: unknown;
  routes?: unknown;
}

export async function buildAgentNavigationPlan(projectRoot: string, task: string): Promise<AgentNavigationResult> {
  const manifestFile = path.join(projectRoot, AGENT_NAVIGATION_MANIFEST_PATH);
  let raw: string;

  try {
    raw = await readFile(manifestFile, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { warnings: [] };
    }
    return { warnings: [`Agent navigation manifest could not be read: ${formatError(error)}`] };
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    return { warnings: [`Agent navigation manifest is invalid YAML: ${formatError(error)}`] };
  }

  if (!isRecord(parsed)) {
    return { warnings: ["Agent navigation manifest must be a YAML object."] };
  }

  const manifest = parsed as NavigationManifest;
  if (!isRecord(manifest.sources) || !isRecord(manifest.routes)) {
    return { warnings: ["Agent navigation manifest must define object-valued sources and routes."] };
  }

  const selected = selectRoute(manifest.routes as Record<string, unknown>, task);
  if (!selected) {
    return { warnings: ["Agent navigation manifest has no usable routes."] };
  }

  const warnings: string[] = [];
  const route = selected.route;
  const loadIds = stringList(route.load);
  const sourcePaths: string[] = [];

  for (const sourceId of loadIds) {
    const source = (manifest.sources as Record<string, unknown>)[sourceId];
    if (!isRecord(source) || typeof (source as NavigationSource).path !== "string") {
      warnings.push(`Agent navigation route "${selected.routeId}" references unknown source "${sourceId}".`);
      continue;
    }

    const sourcePath = normalizeRepoPath((source as NavigationSource).path as string);
    if (!sourcePath) {
      warnings.push(`Agent navigation source "${sourceId}" has an empty path.`);
      continue;
    }

    try {
      await access(path.join(projectRoot, sourcePath));
      sourcePaths.push(sourcePath);
    } catch {
      warnings.push(`Agent navigation source "${sourceId}" is missing at "${sourcePath}".`);
    }
  }

  return {
    plan: {
      manifest_path: AGENT_NAVIGATION_MANIFEST_PATH.replace(/\\/g, "/"),
      route_id: selected.routeId,
      matched_terms: selected.matchedTerms,
      source_paths: dedupe(sourcePaths),
      live_checks: stringList(route.live_checks),
      next_steps: stringList(route.then),
    },
    warnings,
  };
}

function selectRoute(
  routes: Record<string, unknown>,
  task: string,
): { routeId: string; route: NavigationRoute; matchedTerms: string[] } | null {
  const normalizedTask = task.trim().toLowerCase();
  const candidates = Object.entries(routes)
    .filter((entry): entry is [string, NavigationRoute] => isRecord(entry[1]))
    .map(([routeId, route]) => {
      const matchedTerms = stringList(route.match).filter((term) => normalizedTask.includes(term.toLowerCase()));
      const score = matchedTerms.reduce((total, term) => total + term.length, 0);
      return { routeId, route, matchedTerms, score };
    })
    .sort((left, right) => right.score - left.score || right.matchedTerms.length - left.matchedTerms.length || left.routeId.localeCompare(right.routeId));

  const matched = candidates.find((candidate) => candidate.score > 0);
  if (matched) {
    return matched;
  }

  const fallback = candidates.find((candidate) => candidate.routeId === "continue_project");
  return fallback ?? candidates[0] ?? null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}

function normalizeRepoPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
