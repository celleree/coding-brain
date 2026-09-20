import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export const AGENT_NAVIGATION_MANIFEST_PATH = path.join("docs", "brain", "ROUTES.yaml");

export interface AgentNavigationPlan {
  manifest_path: string;
  route_id: string;
  match_kind: "matched" | "fallback";
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

type Route = {
  priority?: unknown;
  match?: unknown;
  context_match?: unknown;
  load?: unknown;
  live_checks?: unknown;
  then?: unknown;
};

type Candidate = {
  id: string;
  route: Route;
  priority: number;
  terms: string[];
  contextTerms: string[];
  start: number;
  contextStart: number;
  specificity: number;
  contextSpecificity: number;
};

export async function buildAgentNavigationPlan(projectRoot: string, task: string): Promise<AgentNavigationResult> {
  const file = path.join(projectRoot, AGENT_NAVIGATION_MANIFEST_PATH);
  let raw: string;

  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return { warnings: [] };
    return { warnings: [`Agent navigation manifest could not be read: ${formatError(error)}`] };
  }

  let manifest: unknown;
  try {
    manifest = parse(raw);
  } catch (error) {
    return { warnings: [`Agent navigation manifest is invalid YAML: ${formatError(error)}`] };
  }

  if (!isRecord(manifest) || !isRecord(manifest.sources) || !isRecord(manifest.routes)) {
    return { warnings: ["Agent navigation manifest must define object-valued sources and routes."] };
  }

  const warnings: string[] = [];
  const selected = selectRoute(manifest.routes, task, warnings);
  if (!selected) return { warnings: [...warnings, "Agent navigation manifest has no usable routes."] };

  const issues = validateSelectedRoute(selected.route, selected.id);
  warnings.push(...issues);
  if (selected.matchKind === "fallback") {
    warnings.push(`No navigation route matched task intent; using "${selected.id}" as the fallback route.`);
  }
  if (issues.length > 0) {
    warnings.push(`Selected navigation route "${selected.id}" is invalid; navigation plan withheld.`);
    return { warnings };
  }

  const sourcePaths: string[] = [];
  const unavailableOptionalSources: string[] = [];
  let invalidSource = false;

  for (const sourceId of strings(selected.route.load)) {
    const source = manifest.sources[sourceId];
    if (!isRecord(source) || typeof source.path !== "string" || source.path.trim() === "") {
      warnings.push(`Agent navigation route "${selected.id}" references invalid source "${sourceId}".`);
      invalidSource = true;
      continue;
    }
    if (source.optional !== undefined && typeof source.optional !== "boolean") {
      warnings.push(`Agent navigation source "${sourceId}" optional must be a boolean when present.`);
      invalidSource = true;
      continue;
    }

    const sourcePath = normalizePath(source.path);
    try {
      await access(path.join(projectRoot, sourcePath));
      sourcePaths.push(sourcePath);
    } catch {
      if (source.optional === true) unavailableOptionalSources.push(sourcePath);
      else {
        warnings.push(`Agent navigation source "${sourceId}" is missing at "${sourcePath}".`);
        invalidSource = true;
      }
    }
  }

  if (invalidSource) {
    warnings.push(`Selected navigation route "${selected.id}" has invalid required sources; navigation plan withheld.`);
    return { warnings };
  }

  return {
    plan: {
      manifest_path: AGENT_NAVIGATION_MANIFEST_PATH.replace(/\\/g, "/"),
      route_id: selected.id,
      match_kind: selected.matchKind,
      matched_terms: selected.terms,
      source_paths: [...new Set(sourcePaths)],
      unavailable_optional_sources: [...new Set(unavailableOptionalSources)],
      live_checks: strings(selected.route.live_checks),
      next_steps: strings(selected.route.then),
    },
    warnings,
  };
}

function selectRoute(routes: Record<string, unknown>, task: string, warnings: string[]) {
  const taskTokens = tokens(task);
  const candidates: Candidate[] = [];

  for (const [id, value] of Object.entries(routes)) {
    if (!isRecord(value)) {
      warnings.push(`Agent navigation route "${id}" must be a YAML object.`);
      continue;
    }

    const route = value as Route;
    const priority = readPriority(route.priority, id, warnings);
    const actionMatches = matches(
      stringsWithWarnings(route.match, `route "${id}" match`, warnings, true),
      taskTokens,
      true,
    );
    const contextMatches = matches(
      stringsWithWarnings(route.context_match, `route "${id}" context_match`, warnings),
      taskTokens,
      false,
    );

    candidates.push({
      id,
      route,
      priority,
      terms: actionMatches.map((match) => match.term),
      contextTerms: contextMatches.map((match) => match.term),
      start: minStart(actionMatches),
      contextStart: minStart(contextMatches),
      specificity: maxSpecificity(actionMatches),
      contextSpecificity: maxSpecificity(contextMatches),
    });
  }

  const rank = (left: Candidate, right: Candidate, context = false) =>
    (context ? left.contextStart - right.contextStart : left.start - right.start) ||
    (context ? right.contextSpecificity - left.contextSpecificity : right.specificity - left.specificity) ||
    right.priority - left.priority ||
    left.id.localeCompare(right.id);

  const action = candidates.filter((candidate) => candidate.terms.length > 0).sort((a, b) => rank(a, b))[0];
  if (action) return { ...action, matchKind: "matched" as const };

  const contextual = candidates
    .filter((candidate) => candidate.contextTerms.length > 0)
    .sort((a, b) => rank(a, b, true))[0];
  if (contextual) return { ...contextual, terms: contextual.contextTerms, matchKind: "matched" as const };

  const fallback = candidates.find((candidate) => candidate.id === "continue_project") ?? candidates[0];
  return fallback ? { ...fallback, terms: [], matchKind: "fallback" as const } : null;
}

type Match = { term: string; start: number; specificity: number };

function matches(terms: string[], taskTokens: string[], rejectNegated: boolean): Match[] {
  return terms.flatMap((term) => {
    const match = findMatch(term, taskTokens);
    return match && (!rejectNegated || !isNegated(taskTokens, match.start)) ? [match] : [];
  });
}

function findMatch(term: string, taskTokens: string[]): Match | null {
  const wanted = tokens(term);
  if (wanted.length === 0) return null;

  let cursor = 0;
  let start = -1;
  for (const token of wanted) {
    const index = taskTokens.indexOf(token, cursor);
    if (index < 0) return null;
    if (start < 0) start = index;
    cursor = index + 1;
  }
  return { term, start, specificity: wanted.length };
}

function isNegated(taskTokens: string[], start: number): boolean {
  const preceding = taskTokens.slice(Math.max(0, start - 3), start);
  return preceding.includes("not") || preceding.includes("never") || preceding.includes("without");
}

function tokens(value: string): string[] {
  const normalized = value
    .toLowerCase()
    .replace(/\bdon't\b/g, "do not")
    .replace(/\bcan't\b/g, "can not");
  const aliases: Record<string, string> = {
    failed: "fail",
    fails: "fail",
    failing: "fail",
    reviewed: "review",
    reviewing: "review",
    reviews: "review",
    findings: "finding",
  };
  return (normalized.match(/[a-z0-9]+/g) ?? []).map((token) => aliases[token] ?? token);
}

function validateSelectedRoute(route: Route, id: string): string[] {
  const issues: string[] = [];
  if (route.priority !== undefined && (typeof route.priority !== "number" || !Number.isFinite(route.priority))) {
    issues.push(`Agent navigation route "${id}" priority must be a finite number when present.`);
  }
  if (route.context_match !== undefined && !validStringArray(route.context_match)) {
    issues.push(`Agent navigation route "${id}" context_match must be a non-empty string array when present.`);
  }
  for (const [name, value] of [
    ["match", route.match],
    ["load", route.load],
    ["live_checks", route.live_checks],
    ["then", route.then],
  ] as const) {
    if (!validStringArray(value))
      issues.push(`Agent navigation route "${id}" ${name} must be a non-empty string array.`);
  }
  return issues;
}

function stringsWithWarnings(value: unknown, label: string, warnings: string[], required = false): string[] {
  if (value === undefined) {
    if (required) warnings.push(`Agent navigation ${label} must be a non-empty string array.`);
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`Agent navigation ${label} must be a string array.`);
    return [];
  }
  return strings(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function validStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.trim() !== "")
  );
}

function readPriority(value: unknown, id: string, warnings: string[]): number {
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  warnings.push(`Agent navigation route "${id}" priority must be a finite number when present.`);
  return 0;
}

function minStart(matches: Match[]): number {
  return matches.reduce((value, match) => Math.min(value, match.start), Number.POSITIVE_INFINITY);
}

function maxSpecificity(matches: Match[]): number {
  return matches.reduce((value, match) => Math.max(value, match.specificity), 0);
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT",
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
