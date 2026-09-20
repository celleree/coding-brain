import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export const AGENT_NAVIGATION_MANIFEST_PATH = path.join("docs", "brain", "ROUTES.yaml");

export type AgentNavigationMatchKind = "matched" | "fallback";

export interface AgentNavigationPlan {
  manifest_path: string;
  route_id: string;
  match_kind: AgentNavigationMatchKind;
  matched_terms: string[];
  source_paths: string[];
  unavailable_optional_sources: string[];
  live_checks: string[];
  next_steps: string[];
}

export interface AgentNavigationResult {
  plan?: AgentNavigationPlan;
  warnings: string[];
}

interface NavigationSource {
  path?: unknown;
  optional?: unknown;
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

interface RouteCandidate {
  routeId: string;
  route: NavigationRoute;
  matchedTerms: string[];
  score: number;
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

  const warnings: string[] = [];
  const selected = selectRoute(manifest.routes as Record<string, unknown>, task, warnings);
  if (!selected) {
    return { warnings: [...warnings, "Agent navigation manifest has no usable routes."] };
  }

  const loadIds = readStringList(
    selected.route.load,
    `route "${selected.routeId}" load`,
    warnings,
    true,
  );
  const liveChecks = readStringList(
    selected.route.live_checks,
    `route "${selected.routeId}" live_checks`,
    warnings,
  );
  const nextSteps = readStringList(
    selected.route.then,
    `route "${selected.routeId}" then`,
    warnings,
  );
  const sourcePaths: string[] = [];
  const unavailableOptionalSources: string[] = [];

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

    const optional = readOptionalBoolean((source as NavigationSource).optional, sourceId, warnings);

    try {
      await access(path.join(projectRoot, sourcePath));
      sourcePaths.push(sourcePath);
    } catch {
      if (optional) {
        unavailableOptionalSources.push(sourcePath);
      } else {
        warnings.push(`Agent navigation source "${sourceId}" is missing at "${sourcePath}".`);
      }
    }
  }

  if (selected.matchKind === "fallback") {
    warnings.push(
      `No navigation route matched task intent; using "${selected.routeId}" as the fallback route.`,
    );
  }

  return {
    plan: {
      manifest_path: AGENT_NAVIGATION_MANIFEST_PATH.replace(/\\/g, "/"),
      route_id: selected.routeId,
      match_kind: selected.matchKind,
      matched_terms: selected.matchedTerms,
      source_paths: dedupe(sourcePaths),
      unavailable_optional_sources: dedupe(unavailableOptionalSources),
      live_checks: liveChecks,
      next_steps: nextSteps,
    },
    warnings,
  };
}

export function renderAgentNavigationPlan(plan: AgentNavigationPlan): string {
  const lines = [
    "## Repository Navigation",
    "",
    `- route: ${plan.route_id}`,
    `- match: ${plan.match_kind}`,
    `- manifest: ${plan.manifest_path}`,
    `- sources: ${plan.source_paths.length > 0 ? plan.source_paths.join(", ") : "None."}`,
    `- live checks: ${plan.live_checks.length > 0 ? plan.live_checks.join("; ") : "None."}`,
    `- next steps: ${plan.next_steps.length > 0 ? plan.next_steps.join("; ") : "None."}`,
  ];

  if (plan.unavailable_optional_sources.length > 0) {
    lines.push(
      `- unavailable optional sources: ${plan.unavailable_optional_sources.join(", ")}`,
    );
  }

  return lines.join("\n");
}

function selectRoute(
  routes: Record<string, unknown>,
  task: string,
  warnings: string[],
): (RouteCandidate & { matchKind: AgentNavigationMatchKind }) | null {
  const taskTokens = new Set(normalizeIntentTokens(task));
  const candidates: RouteCandidate[] = [];

  for (const [routeId, rawRoute] of Object.entries(routes)) {
    if (!isRecord(rawRoute)) {
      warnings.push(`Agent navigation route "${routeId}" must be a YAML object.`);
      continue;
    }

    const route = rawRoute as NavigationRoute;
    const matchTerms = readStringList(route.match, `route "${routeId}" match`, warnings);
    const matchedTerms = matchTerms.filter((term) => phraseMatchesTask(term, taskTokens));
    const score = matchedTerms.reduce(
      (highest, term) => Math.max(highest, scoreMatchedPhrase(term)),
      0,
    );

    candidates.push({ routeId, route, matchedTerms, score });
  }

  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      right.matchedTerms.length - left.matchedTerms.length ||
      left.routeId.localeCompare(right.routeId),
  );

  const matched = candidates.find((candidate) => candidate.score > 0);
  if (matched) {
    return { ...matched, matchKind: "matched" };
  }

  const fallback = candidates.find((candidate) => candidate.routeId === "continue_project");
  const selected = fallback ?? candidates[0];
  return selected ? { ...selected, matchKind: "fallback" } : null;
}

function phraseMatchesTask(term: string, taskTokens: Set<string>): boolean {
  const termTokens = normalizeIntentTokens(term);
  return termTokens.length > 0 && termTokens.every((token) => taskTokens.has(token));
}

function scoreMatchedPhrase(term: string): number {
  const tokens = normalizeIntentTokens(term);
  return tokens.length * 100 + term.trim().length;
}

function normalizeIntentTokens(value: string): string[] {
  const rawTokens = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return rawTokens.map(normalizeIntentToken).filter(Boolean);
}

function normalizeIntentToken(token: string): string {
  const aliases: Record<string, string> = {
    failed: "fail",
    fails: "fail",
    failing: "fail",
    fixed: "fix",
    fixes: "fix",
    fixing: "fix",
    findings: "finding",
    reviewed: "review",
    reviewing: "review",
    reviews: "review",
    builds: "build",
    built: "build",
    tests: "test",
    runners: "runner",
    issues: "issue",
    tasks: "task",
  };

  return aliases[token] ?? token;
}

function readStringList(
  value: unknown,
  label: string,
  warnings: string[],
  required = false,
): string[] {
  if (value === undefined) {
    if (required) {
      warnings.push(`Agent navigation ${label} must be a non-empty string array.`);
    }
    return [];
  }

  if (!Array.isArray(value)) {
    warnings.push(`Agent navigation ${label} must be a string array.`);
    return [];
  }

  const invalid = value.some((entry) => typeof entry !== "string" || entry.trim().length === 0);
  if (invalid) {
    warnings.push(`Agent navigation ${label} contains a non-string or empty entry.`);
  }

  const values = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (required && values.length === 0) {
    warnings.push(`Agent navigation ${label} must contain at least one entry.`);
  }

  return values;
}

function readOptionalBoolean(value: unknown, sourceId: string, warnings: string[]): boolean {
  if (value === undefined) {
    return false;
  }

  if (typeof value !== "boolean") {
    warnings.push(`Agent navigation source "${sourceId}" optional must be a boolean when present.`);
    return false;
  }

  return value;
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
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
