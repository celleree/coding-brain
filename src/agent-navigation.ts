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
  priority?: unknown;
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
  priority: number;
  matchedTerms: string[];
  matchStart: number;
  specificity: number;
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
    return {
      warnings: [`Agent navigation manifest could not be read: ${formatError(error)}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    return {
      warnings: [`Agent navigation manifest is invalid YAML: ${formatError(error)}`],
    };
  }

  if (!isRecord(parsed)) {
    return { warnings: ["Agent navigation manifest must be a YAML object."] };
  }

  const manifest = parsed as NavigationManifest;
  if (!isRecord(manifest.sources) || !isRecord(manifest.routes)) {
    return {
      warnings: ["Agent navigation manifest must define object-valued sources and routes."],
    };
  }

  const warnings: string[] = [];
  const selected = selectRoute(manifest.routes as Record<string, unknown>, task, warnings);
  if (!selected) {
    return {
      warnings: [...warnings, "Agent navigation manifest has no usable routes."],
    };
  }

  const selectedRouteIssues = validateSelectedRoute(selected.route, selected.routeId);
  warnings.push(...selectedRouteIssues);

  if (selected.matchKind === "fallback") {
    warnings.push(`No navigation route matched task intent; using "${selected.routeId}" as the fallback route.`);
  }

  if (selectedRouteIssues.length > 0) {
    warnings.push(`Selected navigation route "${selected.routeId}" is invalid; navigation plan withheld.`);
    return { warnings };
  }

  const loadIds = stringList(selected.route.load);
  const liveChecks = stringList(selected.route.live_checks);
  const nextSteps = stringList(selected.route.then);
  const sourcePaths: string[] = [];
  const unavailableOptionalSources: string[] = [];
  let selectedSourceInvalid = false;

  for (const sourceId of loadIds) {
    const source = (manifest.sources as Record<string, unknown>)[sourceId];
    if (!isRecord(source) || typeof (source as NavigationSource).path !== "string") {
      warnings.push(`Agent navigation route "${selected.routeId}" references invalid source "${sourceId}".`);
      selectedSourceInvalid = true;
      continue;
    }

    const sourcePath = normalizeRepoPath((source as NavigationSource).path as string);
    if (!sourcePath) {
      warnings.push(`Agent navigation source "${sourceId}" has an empty path.`);
      selectedSourceInvalid = true;
      continue;
    }

    const optionalValue = (source as NavigationSource).optional;
    if (optionalValue !== undefined && typeof optionalValue !== "boolean") {
      warnings.push(`Agent navigation source "${sourceId}" optional must be a boolean when present.`);
      selectedSourceInvalid = true;
      continue;
    }
    const optional = optionalValue === true;

    try {
      await access(path.join(projectRoot, sourcePath));
      sourcePaths.push(sourcePath);
    } catch {
      if (optional) {
        unavailableOptionalSources.push(sourcePath);
      } else {
        warnings.push(`Agent navigation source "${sourceId}" is missing at "${sourcePath}".`);
        selectedSourceInvalid = true;
      }
    }
  }

  if (selectedSourceInvalid) {
    warnings.push(
      `Selected navigation route "${selected.routeId}" has invalid required sources; navigation plan withheld.`,
    );
    return { warnings };
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
    lines.push(`- unavailable optional sources: ${plan.unavailable_optional_sources.join(", ")}`);
  }

  return lines.join("\n");
}

function selectRoute(
  routes: Record<string, unknown>,
  task: string,
  warnings: string[],
): (RouteCandidate & { matchKind: AgentNavigationMatchKind }) | null {
  const taskTokens = normalizeIntentTokens(task);
  const candidates: RouteCandidate[] = [];

  for (const [routeId, rawRoute] of Object.entries(routes)) {
    if (!isRecord(rawRoute)) {
      warnings.push(`Agent navigation route "${routeId}" must be a YAML object.`);
      continue;
    }

    const route = rawRoute as NavigationRoute;
    const priority = readRoutePriority(route.priority, routeId, warnings);
    const matchTerms = readStringList(route.match, `route "${routeId}" match`, warnings, true);
    const phraseMatches = matchTerms
      .map((term) => findPhraseMatch(term, taskTokens))
      .filter((match): match is PhraseMatch => match !== null && !isNegatedMatch(taskTokens, match));
    const matchedTerms = phraseMatches.map((match) => match.term);
    const matchStart = phraseMatches.reduce(
      (earliest, match) => Math.min(earliest, match.start),
      Number.POSITIVE_INFINITY,
    );
    const specificity = phraseMatches.reduce((highest, match) => Math.max(highest, match.tokenCount), 0);
    const score = matchedTerms.reduce((highest, term) => Math.max(highest, scoreMatchedPhrase(term)), 0);

    candidates.push({
      routeId,
      route,
      priority,
      matchedTerms,
      matchStart,
      specificity,
      score,
    });
  }

  candidates.sort(
    (left, right) =>
      left.matchStart - right.matchStart ||
      right.specificity - left.specificity ||
      right.priority - left.priority ||
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

interface PhraseMatch {
  term: string;
  start: number;
  tokenCount: number;
}

function findPhraseMatch(term: string, taskTokens: string[]): PhraseMatch | null {
  const termTokens = normalizeIntentTokens(term);
  if (termTokens.length === 0) return null;

  let taskIndex = 0;
  let start = -1;

  for (const termToken of termTokens) {
    let found = -1;
    for (let index = taskIndex; index < taskTokens.length; index += 1) {
      if (taskTokens[index] === termToken) {
        found = index;
        break;
      }
    }

    if (found < 0) return null;
    if (start < 0) start = found;
    taskIndex = found + 1;
  }

  return {
    term,
    start,
    tokenCount: termTokens.length,
  };
}

function isNegatedMatch(taskTokens: string[], match: PhraseMatch): boolean {
  const windowStart = Math.max(0, match.start - 3);
  const preceding = taskTokens.slice(windowStart, match.start);

  if (preceding.includes("not") || preceding.includes("never") || preceding.includes("without")) {
    return true;
  }

  if (preceding.length >= 2) {
    const pair = preceding.slice(-2).join(" ");
    if (pair === "do not") return true;
  }

  return false;
}

function scoreMatchedPhrase(term: string): number {
  const tokens = normalizeIntentTokens(term);
  return tokens.length * 100 + term.trim().length;
}

function normalizeIntentTokens(value: string): string[] {
  const normalizedValue = value
    .toLowerCase()
    .replace(/\bdon't\b/g, "do not")
    .replace(/\bcan't\b/g, "can not")
    .replace(/\bwon't\b/g, "will not");
  const rawTokens = normalizedValue.match(/[a-z0-9]+/g) ?? [];
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

function readStringList(value: unknown, label: string, warnings: string[], required = false): string[] {
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

function validateSelectedRoute(route: NavigationRoute, routeId: string): string[] {
  const issues: string[] = [];

  if (route.priority !== undefined && (typeof route.priority !== "number" || !Number.isFinite(route.priority))) {
    issues.push(`Agent navigation route "${routeId}" priority must be a finite number when present.`);
  }

  for (const [fieldName, value] of [
    ["match", route.match],
    ["load", route.load],
    ["live_checks", route.live_checks],
    ["then", route.then],
  ] as const) {
    if (!isNonEmptyStringArray(value)) {
      issues.push(`Agent navigation route "${routeId}" ${fieldName} must be a non-empty string array.`);
    }
  }

  return issues;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function readRoutePriority(value: unknown, routeId: string, warnings: string[]): number {
  if (value === undefined) {
    return 0;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`Agent navigation route "${routeId}" priority must be a finite number when present.`);
    return 0;
  }

  return value;
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
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT",
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
