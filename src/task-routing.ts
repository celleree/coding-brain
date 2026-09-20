import { buildAgentNavigationPlan, type AgentNavigationPlan } from "./agent-navigation.js";
import { buildInjection } from "./inject.js";
import {
  buildSkillShortlist,
  renderSkillShortlist,
  type PathSource,
  type RoutingExplanation,
  type SkillConflict,
  type ResolvedSkill,
  type InvocationPlan,
  type MatchedMemory,
} from "./suggest-skills.js";
import type { BrainConfig } from "./types.js";

export const TASK_ROUTING_BUNDLE_CONTRACT_VERSION = "repobrain.task-routing-bundle.v1";

export type TaskRoutingDisplayMode = "silent-ok" | "needs-review";

export interface BuildTaskRoutingBundleOptions {
  task: string;
  paths?: string[];
  path_source?: PathSource;
  modules?: string[];
  warnings?: string[];
  /** When false, skip `.brain/runtime/session-profile.json` for inject + routing. Default: true. */
  includeSessionProfile?: boolean;
}

export interface TaskRoutingExpansionPlan {
  suggested_summary_ids: string[];
  suggested_full_ids: string[];
}

export interface TaskRoutingBundle {
  contract_version: typeof TASK_ROUTING_BUNDLE_CONTRACT_VERSION;
  task: string;
  paths: string[];
  path_source: PathSource;
  context_markdown: string;
  skill_plan: InvocationPlan;
  matched_memories: MatchedMemory[];
  resolved_skills: ResolvedSkill[];
  conflicts: SkillConflict[];
  warnings: string[];
  display_mode: TaskRoutingDisplayMode;
  /** Optional machine-readable routing trace (same as `brain suggest-skills` JSON when present). */
  routing_explanation?: RoutingExplanation;
  /** Optional progressive retrieval hints for expanding matched memories. */
  expansion_plan?: TaskRoutingExpansionPlan;
  /** Optional repository-navigation plan selected from docs/brain/ROUTES.yaml when present. */
  navigation_plan?: AgentNavigationPlan;
}

export function shouldEscalateRoutingPlan(plan: InvocationPlan, conflicts: SkillConflict[]): boolean {
  return plan.blocked.length > 0 || plan.human_review.length > 0 || hasStrongRoutingConflict(conflicts);
}

export function summarizeRoutingEscalation(plan: InvocationPlan, conflicts: SkillConflict[]): string[] {
  const warnings: string[] = [];

  if (plan.blocked.length > 0) {
    warnings.push(`Routing blocked: ${plan.blocked.join(", ")}.`);
  }

  if (plan.human_review.length > 0) {
    warnings.push(`Human review required: ${plan.human_review.join(", ")}.`);
  }

  const strongConflicts = conflicts.filter(isStrongRequiredSuppressionConflict);
  if (strongConflicts.length > 0) {
    warnings.push(
      `Required/suppress conflict: ${strongConflicts
        .map((entry) => `${entry.skill} (${describeConflictOutcome(entry)})`)
        .join(", ")}.`,
    );
  }

  return warnings;
}

export async function buildTaskRoutingBundle(
  projectRoot: string,
  config: BrainConfig,
  options: BuildTaskRoutingBundleOptions,
): Promise<TaskRoutingBundle> {
  const task = options.task.trim();
  if (!task) {
    throw new Error('Provide a task with "--task" or stdin before running "brain route".');
  }

  const paths = options.paths ?? [];
  const path_source = options.path_source ?? (paths.length > 0 ? "explicit" : "none");
  const warnings = [...(options.warnings ?? [])];

  const [context_markdown, shortlist, navigation] = await Promise.all([
    buildInjection(projectRoot, config, {
      task,
      paths,
      modules: options.modules ?? [],
      activitySource: "route",
      ...(options.includeSessionProfile === false ? { includeSessionProfile: false } : {}),
    }),
    buildSkillShortlist(projectRoot, {
      task,
      paths,
      path_source,
      modules: options.modules ?? [],
      ...(options.includeSessionProfile === false ? { includeSessionProfile: false } : {}),
    }),
    buildAgentNavigationPlan(projectRoot, task),
  ]);

  warnings.push(...navigation.warnings);
  warnings.push(...summarizeRoutingEscalation(shortlist.invocation_plan, shortlist.conflicts));

  const display_mode: TaskRoutingDisplayMode = shouldEscalateRoutingPlan(shortlist.invocation_plan, shortlist.conflicts)
    ? "needs-review"
    : "silent-ok";
  const expansionPlan = buildTaskRoutingExpansionPlan(shortlist.matched_memories);

  return {
    contract_version: TASK_ROUTING_BUNDLE_CONTRACT_VERSION,
    task,
    paths,
    path_source,
    context_markdown,
    skill_plan: shortlist.invocation_plan,
    matched_memories: shortlist.matched_memories,
    resolved_skills: shortlist.resolved_skills,
    conflicts: shortlist.conflicts,
    warnings,
    display_mode,
    ...(shortlist.routing_explanation ? { routing_explanation: shortlist.routing_explanation } : {}),
    ...(expansionPlan ? { expansion_plan: expansionPlan } : {}),
    ...(navigation.plan ? { navigation_plan: navigation.plan } : {}),
  };
}

export function renderTaskRoutingBundle(bundle: TaskRoutingBundle): string {
  const lines: string[] = [
    "# RepoBrain Task Routing",
    "",
    `Contract: ${bundle.contract_version}`,
    `Task: ${bundle.task}`,
    `Display mode: ${bundle.display_mode}`,
    `Path source: ${bundle.path_source}`,
    "Paths:",
    ...(bundle.paths.length > 0 ? bundle.paths.map((entry) => `- ${entry}`) : ["- None."]),
  ];

  if (bundle.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    bundle.warnings.forEach((warning) => lines.push(`- ${warning}`));
  }

  if (bundle.navigation_plan) {
    lines.push("");
    lines.push("## Repository Navigation");
    lines.push(`- route: ${bundle.navigation_plan.route_id}`);
    lines.push(`- manifest: ${bundle.navigation_plan.manifest_path}`);
    lines.push(
      `- sources: ${bundle.navigation_plan.source_paths.length > 0 ? bundle.navigation_plan.source_paths.join(", ") : "None."}`,
    );
    lines.push(
      `- live checks: ${bundle.navigation_plan.live_checks.length > 0 ? bundle.navigation_plan.live_checks.join("; ") : "None."}`,
    );
    lines.push(
      `- next steps: ${bundle.navigation_plan.next_steps.length > 0 ? bundle.navigation_plan.next_steps.join("; ") : "None."}`,
    );
  }

  lines.push("");
  lines.push("## Context");
  lines.push(bundle.context_markdown);
  lines.push("");
  lines.push("## Skill Routing");
  lines.push(
    renderSkillShortlist({
      contract_version: "repobrain.skill-plan.v1",
      kind: "repobrain.skill_invocation_plan",
      task: bundle.task,
      paths: bundle.paths,
      path_source: bundle.path_source,
      matched_memories: bundle.matched_memories,
      resolved_skills: bundle.resolved_skills,
      conflicts: bundle.conflicts,
      invocation_plan: bundle.skill_plan,
      matchedMemories: bundle.matched_memories,
      skills: bundle.resolved_skills,
      ...(bundle.routing_explanation ? { routing_explanation: bundle.routing_explanation } : {}),
    }),
  );

  if (bundle.expansion_plan) {
    lines.push("");
    lines.push("## Expansion Plan");
    lines.push(
      `- summary ids: ${
        bundle.expansion_plan.suggested_summary_ids.length > 0
          ? bundle.expansion_plan.suggested_summary_ids.join(", ")
          : "None."
      }`,
    );
    lines.push(
      `- full ids: ${
        bundle.expansion_plan.suggested_full_ids.length > 0
          ? bundle.expansion_plan.suggested_full_ids.join(", ")
          : "None."
      }`,
    );
  }

  return lines.join("\n");
}

export function renderTaskRoutingBundleJson(bundle: TaskRoutingBundle): string {
  return JSON.stringify(bundle, null, 2);
}

function hasStrongRoutingConflict(conflicts: SkillConflict[]): boolean {
  return conflicts.some(isStrongRequiredSuppressionConflict);
}

function isStrongRequiredSuppressionConflict(conflict: SkillConflict): boolean {
  return conflict.kind === "required_vs_suppressed";
}

function describeConflictOutcome(conflict: SkillConflict): string {
  switch (conflict.strategy_result) {
    case "block":
      return "blocked";
    case "human-review":
      return "needs review";
    case "choose-required":
      return "required kept";
    default:
      return conflict.strategy_result;
  }
}

function buildTaskRoutingExpansionPlan(matchedMemories: MatchedMemory[]): TaskRoutingExpansionPlan | undefined {
  if (matchedMemories.length === 0) {
    return undefined;
  }

  const summaryCandidates = matchedMemories
    .slice()
    .sort((left, right) => compareSummaryExpansionCandidates(left, right))
    .slice(0, 3)
    .map((entry) => toBrainRelativePath(entry.record.relativePath));

  const fullCandidates = matchedMemories
    .slice()
    .sort((left, right) => compareFullExpansionCandidates(left, right))
    .filter((entry) => isMeaningfulFullExpansion(entry))
    .slice(0, 2)
    .map((entry) => toBrainRelativePath(entry.record.relativePath));

  return {
    suggested_summary_ids: dedupeStrings(summaryCandidates),
    suggested_full_ids: dedupeStrings(fullCandidates),
  };
}

function compareSummaryExpansionCandidates(left: MatchedMemory, right: MatchedMemory): number {
  const taskStrengthDiff = matchReasonStrength(right, "task") - matchReasonStrength(left, "task");
  if (taskStrengthDiff !== 0) {
    return taskStrengthDiff;
  }

  const pathStrengthDiff = matchReasonStrength(right, "path") - matchReasonStrength(left, "path");
  if (pathStrengthDiff !== 0) {
    return pathStrengthDiff;
  }

  const scoreDiff = right.score - left.score;
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  return right.record.memory.date.localeCompare(left.record.memory.date);
}

function compareFullExpansionCandidates(left: MatchedMemory, right: MatchedMemory): number {
  const riskDiff = riskWeight(right.record.memory.risk_level) - riskWeight(left.record.memory.risk_level);
  if (riskDiff !== 0) {
    return riskDiff;
  }

  const taskStrengthDiff = matchReasonStrength(right, "task") - matchReasonStrength(left, "task");
  if (taskStrengthDiff !== 0) {
    return taskStrengthDiff;
  }

  const scoreDiff = right.score - left.score;
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  return right.record.memory.date.localeCompare(left.record.memory.date);
}

function matchReasonStrength(entry: MatchedMemory, prefix: "task" | "path"): number {
  return entry.reasons.filter((reason) => reason.startsWith(`${prefix}:`)).length;
}

function riskWeight(risk: MatchedMemory["record"]["memory"]["risk_level"]): number {
  switch (risk ?? "low") {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
    default:
      return 1;
  }
}

function isMeaningfulFullExpansion(entry: MatchedMemory): boolean {
  const risk = entry.record.memory.risk_level ?? "low";
  if (risk === "high") {
    return true;
  }

  if (risk === "medium") {
    return (matchReasonStrength(entry, "task") > 0 || matchReasonStrength(entry, "path") > 0) && entry.score >= 8;
  }

  return false;
}

function toBrainRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.brain\//, "");
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
