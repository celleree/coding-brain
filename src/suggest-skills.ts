import { execSync } from "node:child_process";
import {
  getMemoryStatus,
  loadStoredMemoryRecords,
  loadStoredPreferenceRecords,
  verifyMemoryProvenance,
  verifyPreferenceProvenance,
} from "./store.js";
import { isMemoryCurrentlyValid } from "./temporal.js";
import { matchPathPatterns, matchTaskTriggers, normalizePaths } from "./memory-relevance.js";
import { buildInvocationPlan } from "./invocation-plan-renderer.js";
import { buildPreferencePolicyInput, buildStaticMemoryPolicyInput, buildTaskContextInput } from "./routing-inputs.js";
import { runRoutingEngine } from "./routing-engine.js";
import { buildApplicableSessionPreferences, loadSessionProfile } from "./session-profile.js";
import type { Importance, InvocationMode, Preference, RiskLevel, StoredMemoryRecord } from "./types.js";

export type {
  InvocationPlan,
  MatchedMemory,
  PathSource,
  ResolvedSkill,
  RoutingExplanation,
  SkillConflict,
  SkillSuggestionResult,
  SkillSuggestionSource,
  SuggestSkillsOptions,
} from "./skill-routing-types.js";
export { SUGGEST_SKILLS_CONTRACT_KIND, SUGGEST_SKILLS_CONTRACT_VERSION } from "./skill-routing-types.js";

import type {
  MatchedMemory,
  PathSource,
  SkillSuggestionSource,
  SkillSuggestionResult,
  SuggestSkillsOptions,
} from "./skill-routing-types.js";
import { SUGGEST_SKILLS_CONTRACT_KIND, SUGGEST_SKILLS_CONTRACT_VERSION } from "./skill-routing-types.js";

export type SuggestSkillsOutputFormat = "markdown" | "json";

const IMPORTANCE_WEIGHT: Record<Importance, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const RISK_WEIGHT: Record<RiskLevel, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const INVOCATION_WEIGHT: Record<InvocationMode, number> = {
  required: 3,
  prefer: 2,
  optional: 1,
  suppress: 0,
};

export async function buildSkillShortlist(
  projectRoot: string,
  options: SuggestSkillsOptions,
): Promise<SkillSuggestionResult> {
  const task = options.task?.trim();
  const paths = normalizePaths(options.paths ?? []);
  const path_source: PathSource = options.path_source ?? (paths.length > 0 ? "explicit" : "none");

  if (!task && paths.length === 0) {
    throw new Error(
      'Provide a task with "--task" (or stdin) and/or at least one "--path". ' +
        "When --path is omitted, the CLI auto-collects paths from git diff; " +
        "pass --task alone if no git context is available.",
    );
  }

  const loadedRecords = await loadStoredMemoryRecords(projectRoot);
  const records = (
    await Promise.all(
      loadedRecords.map(async (record) => {
        if (getMemoryStatus(record.memory) !== "active") return record;
        const verification = await verifyMemoryProvenance(projectRoot, record.memory, record.relativePath);
        return verification.ok ? record : null;
      }),
    )
  ).filter((record): record is StoredMemoryRecord => record !== null);
  const now = new Date();
  const matched_memories = records
    .filter((entry) => getMemoryStatus(entry.memory) === "active" && isMemoryCurrentlyValid(entry.memory, now))
    .map((entry) => matchMemory(entry, task, paths))
    .filter((entry): entry is MatchedMemory => entry !== null)
    .sort((left, right) => {
      const scoreDifference = right.score - left.score;
      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      return right.record.memory.date.localeCompare(left.record.memory.date);
    });

  const preferenceRecords = await loadStoredPreferenceRecords(projectRoot);
  const allPreferences = (
    await Promise.all(
      preferenceRecords.map(async (record) => {
        if (record.preference.status !== "active") return record.preference;
        const verification = await verifyPreferenceProvenance(projectRoot, record.preference, record.relativePath);
        return verification.ok ? record.preference : null;
      }),
    )
  ).filter((preference): preference is Preference => preference !== null);
  const staticInput = buildStaticMemoryPolicyInput(matched_memories);
  const preferenceInput = buildPreferencePolicyInput(allPreferences, task, paths, new Date());
  const taskContext = buildTaskContextInput(projectRoot, {
    ...(task ? { task } : {}),
    paths,
    ...(options.modules !== undefined ? { modules: options.modules } : {}),
  });

  const sessionProfile = options.includeSessionProfile === false ? null : await loadSessionProfile(projectRoot);
  const sessionApplicable = sessionProfile ? buildApplicableSessionPreferences(sessionProfile, task, paths) : [];

  const routing = runRoutingEngine(
    staticInput,
    preferenceInput,
    sessionApplicable.length > 0 ? { applicable: sessionApplicable } : undefined,
    taskContext,
  );
  const invocation_plan = buildInvocationPlan(routing.resolved_skills);

  return {
    contract_version: SUGGEST_SKILLS_CONTRACT_VERSION,
    kind: SUGGEST_SKILLS_CONTRACT_KIND,
    ...(task ? { task } : {}),
    paths,
    path_source,
    matched_memories,
    resolved_skills: routing.resolved_skills,
    conflicts: routing.conflicts,
    invocation_plan,
    matchedMemories: matched_memories,
    skills: routing.resolved_skills,
    routing_explanation: routing.routing_explanation,
  };
}

export function renderSkillShortlist(result: SkillSuggestionResult): string {
  const lines: string[] = [];

  if (result.task) {
    lines.push(`Task: ${result.task}`);
  }

  lines.push(`Contract: ${result.contract_version} (${result.kind})`);
  const pathLabel = result.path_source === "git_diff" ? "Paths (from git diff):" : "Paths:";
  lines.push(pathLabel);
  if (result.paths.length === 0) {
    lines.push("- None.");
  } else {
    for (const item of result.paths) {
      lines.push(`- ${item}`);
    }
  }

  lines.push("");
  lines.push("Matched memories:");
  if (result.matched_memories.length === 0) {
    lines.push("- None.");
  } else {
    for (const entry of result.matched_memories) {
      lines.push(
        `- ${entry.record.memory.type} | ${entry.record.memory.importance} | score=${entry.score} | ${entry.record.memory.title}`,
      );
      lines.push(`  File: ${toDisplayPath(entry.record.relativePath)}`);
      lines.push(`  Why: ${entry.reasons.join("; ")}`);
    }
  }

  lines.push("");
  lines.push("Resolved skills:");
  if (result.resolved_skills.length === 0) {
    lines.push("- None.");
  } else {
    for (const skill of result.resolved_skills) {
      lines.push(`- ${skill.skill} | ${skill.disposition} | plan=${skill.plan_slot} | score=${skill.score}`);
      lines.push(`  From: ${formatSources(skill.sources)}`);
    }
  }

  lines.push("");
  lines.push("Conflicts:");
  if (result.conflicts.length === 0) {
    lines.push("- None.");
  } else {
    for (const conflict of result.conflicts) {
      lines.push(`- ${conflict.skill} | ${conflict.kind} | strategy=${conflict.strategy_result}`);
      lines.push(`  Reason: ${conflict.reason}`);
      lines.push(`  From: ${formatSources(conflict.sources)}`);
    }
  }

  lines.push("");
  lines.push("Invocation plan:");
  lines.push(renderPlanLine("required", result.invocation_plan.required));
  lines.push(renderPlanLine("prefer_first", result.invocation_plan.prefer_first));
  lines.push(renderPlanLine("optional_fallback", result.invocation_plan.optional_fallback));
  lines.push(renderPlanLine("suppress", result.invocation_plan.suppress));
  lines.push(renderPlanLine("blocked", result.invocation_plan.blocked));
  lines.push(renderPlanLine("human_review", result.invocation_plan.human_review));

  if (result.routing_explanation) {
    lines.push("");
    lines.push("Routing evidence:");
    for (const note of result.routing_explanation.notes) {
      lines.push(`- ${note}`);
    }
    const keys = Object.keys(result.routing_explanation.skill_evidence).sort();
    for (const skill of keys) {
      lines.push(`- ${skill}:`);
      for (const ev of result.routing_explanation.skill_evidence[skill] ?? []) {
        lines.push(`  - ${ev}`);
      }
    }
  }

  return lines.join("\n");
}

export function renderSkillShortlistJson(result: SkillSuggestionResult): string {
  return JSON.stringify(result, null, 2);
}

function matchMemory(record: StoredMemoryRecord, task: string | undefined, paths: string[]): MatchedMemory | null {
  const taskReasons = task ? matchTaskTriggers(task, record.memory.skill_trigger_tasks ?? [], "task") : [];
  const pathReasons = matchPathPatterns(paths, record.memory.skill_trigger_paths ?? [], "path");
  const reasons = [...taskReasons, ...pathReasons];

  if (reasons.length === 0) {
    return null;
  }

  const memory = record.memory;
  const score =
    reasons.length * 4 +
    IMPORTANCE_WEIGHT[memory.importance] +
    RISK_WEIGHT[memory.risk_level ?? "low"] +
    INVOCATION_WEIGHT[memory.invocation_mode ?? "optional"];

  return {
    record,
    reasons,
    score,
  };
}

function formatSources(sources: SkillSuggestionSource[]): string {
  return sources
    .map(
      (source) =>
        `${source.relation} via ${source.memory_title} (${source.relative_path}; mode=${source.invocation_mode}; risk=${source.risk_level}; score=${source.match_score})`,
    )
    .join("; ");
}

function renderPlanLine(label: string, values: string[]): string {
  return `- ${label}: ${values.length > 0 ? values.join(", ") : "None."}`;
}

export function collectGitDiffPaths(projectRoot: string): string[] {
  try {
    return execSync("git diff --name-only HEAD", {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((value) =>
        value
          .trim()
          .replace(/\\/g, "/")
          .replace(/^\.\/+/, ""),
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function resolveSuggestedSkillPaths(
  projectRoot: string,
  explicitPaths: string[],
): {
  paths: string[];
  path_source: PathSource;
  warnings: string[];
} {
  const normalizedExplicitPaths = normalizePaths(explicitPaths);
  if (normalizedExplicitPaths.length > 0) {
    return {
      paths: normalizedExplicitPaths,
      path_source: "explicit",
      warnings: [],
    };
  }

  const gitPaths = collectGitDiffPaths(projectRoot);
  if (gitPaths.length > 0) {
    return {
      paths: gitPaths,
      path_source: "git_diff",
      warnings: [],
    };
  }

  return {
    paths: [],
    path_source: "none",
    warnings: ["Git diff paths were unavailable, so RepoBrain continued with task-only routing."],
  };
}

function toDisplayPath(value: string): string {
  return value.replace(/\\/g, "/");
}
