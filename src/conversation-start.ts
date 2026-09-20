import {
  buildAgentNavigationPlan,
  renderAgentNavigationPlan,
  type AgentNavigationPlan,
} from "./agent-navigation.js";
import { buildInjection } from "./inject.js";
import { loadSessionProfile, sessionProfileHasVisibleContent } from "./session-profile.js";
import { loadActivityState } from "./store.js";
import {
  buildTaskRoutingBundle,
  renderTaskRoutingBundle,
  renderTaskRoutingBundleJson,
  type BuildTaskRoutingBundleOptions,
  type TaskRoutingBundle,
} from "./task-routing.js";
import type {
  BrainActivityState,
  BrainConfig,
  ConversationRefreshMode,
  ConversationStartAction,
  InjectLayer,
} from "./types.js";

export const CONVERSATION_START_CONTRACT_VERSION = "repobrain.conversation-start.v1";
export const DEFAULT_CONTEXT_REDUNDANCY_WINDOW_MINUTES = 15;
export const DEFAULT_SESSION_BOUNDARY_MINUTES = 240;

export interface BuildConversationStartOptions extends Omit<BuildTaskRoutingBundleOptions, "task"> {
  task?: string;
  /** When false, skip `.brain/runtime/session-profile.json` for inject + routing. Default: true. */
  includeSessionProfile?: boolean;
  refreshMode?: ConversationRefreshMode;
  redundancyWindowMinutes?: number;
  sessionBoundaryMinutes?: number;
  forceRefresh?: boolean;
  injectLayer?: InjectLayer;
}

export interface ConversationStartDecisionTrace {
  first_conversation: boolean;
  inferred_new_session: boolean;
  task_changed: boolean;
  path_changed: boolean;
  module_changed: boolean;
  session_profile_changed: boolean;
  force_refresh: boolean;
  context_age_minutes: number | null;
  redundancy_window_minutes: number;
  session_boundary_minutes: number;
  previous_task?: string;
}

export interface ConversationStartResult {
  contract_version: typeof CONVERSATION_START_CONTRACT_VERSION;
  action: ConversationStartAction;
  reason: string;
  refresh_mode: ConversationRefreshMode;
  task?: string;
  paths: string[];
  path_source: BuildTaskRoutingBundleOptions["path_source"];
  warnings: string[];
  decision_trace: ConversationStartDecisionTrace;
  context_markdown?: string;
  skill_plan?: TaskRoutingBundle["skill_plan"];
  task_routing_bundle?: TaskRoutingBundle;
  navigation_plan?: AgentNavigationPlan;
}

export async function buildConversationStart(
  projectRoot: string,
  config: BrainConfig,
  options: BuildConversationStartOptions,
): Promise<ConversationStartResult> {
  const task = options.task?.trim() || undefined;
  const paths = normalizeValues(options.paths ?? []);
  const modules = normalizeValues(options.modules ?? []);
  const path_source = options.path_source ?? (paths.length > 0 ? "explicit" : "none");
  const refreshMode = options.refreshMode ?? "smart";
  const redundancyWindowMinutes = normalizePositiveInteger(
    options.redundancyWindowMinutes,
    DEFAULT_CONTEXT_REDUNDANCY_WINDOW_MINUTES,
  );
  const sessionBoundaryMinutes = normalizePositiveInteger(
    options.sessionBoundaryMinutes,
    DEFAULT_SESSION_BOUNDARY_MINUTES,
  );
  const includeSessionProfile = options.includeSessionProfile !== false;

  const [activity, sessionProfile] = await Promise.all([
    loadActivityState(projectRoot),
    includeSessionProfile ? loadSessionProfile(projectRoot) : Promise.resolve(null),
  ]);
  const decision = decideConversationStart({
    activity,
    ...(sessionProfile?.updated_at ? { sessionProfileUpdatedAt: sessionProfile.updated_at } : {}),
    sessionProfileVisible: Boolean(sessionProfile && sessionProfileHasVisibleContent(sessionProfile)),
    ...(task ? { task } : {}),
    paths,
    modules,
    includeSessionProfile,
    refreshMode,
    redundancyWindowMinutes,
    sessionBoundaryMinutes,
    forceRefresh: Boolean(options.forceRefresh),
  });

  if (decision.action === "start") {
    const taskForBundle = task;
    if (!taskForBundle) {
      throw new Error('Provide "--task" before RepoBrain can build the full session-start bundle.');
    }
    const bundle = await buildTaskRoutingBundle(projectRoot, config, {
      task: taskForBundle,
      paths,
      path_source,
      modules,
      ...(options.warnings ? { warnings: options.warnings } : {}),
      ...(includeSessionProfile ? {} : { includeSessionProfile: false }),
    });

    return {
      contract_version: CONVERSATION_START_CONTRACT_VERSION,
      action: "start",
      reason: decision.reason,
      refresh_mode: refreshMode,
      ...(taskForBundle ? { task: taskForBundle } : {}),
      paths,
      path_source,
      warnings: bundle.warnings,
      decision_trace: decision.trace,
      context_markdown: bundle.context_markdown,
      skill_plan: bundle.skill_plan,
      task_routing_bundle: bundle,
    };
  }

  if (decision.action === "inject") {
    const [context_markdown, navigation] = await Promise.all([
      buildInjection(projectRoot, config, {
        ...(task ? { task } : {}),
        paths,
        modules,
        layer: options.injectLayer ?? "summary",
        activitySource: "conversation-start",
        ...(includeSessionProfile ? {} : { includeSessionProfile: false }),
      }),
      task
        ? buildAgentNavigationPlan(projectRoot, task)
        : Promise.resolve({ warnings: [] }),
    ]);

    return {
      contract_version: CONVERSATION_START_CONTRACT_VERSION,
      action: "inject",
      reason: decision.reason,
      refresh_mode: refreshMode,
      ...(task ? { task } : {}),
      paths,
      path_source,
      warnings: [...(options.warnings ?? []), ...navigation.warnings],
      decision_trace: decision.trace,
      context_markdown,
      ...(navigation.plan ? { navigation_plan: navigation.plan } : {}),
    };
  }

  return {
    contract_version: CONVERSATION_START_CONTRACT_VERSION,
    action: "skip",
    reason: decision.reason,
    refresh_mode: refreshMode,
    ...(task ? { task } : {}),
    paths,
    path_source,
    warnings: [...(options.warnings ?? [])],
    decision_trace: decision.trace,
  };
}

export function renderConversationStart(result: ConversationStartResult): string {
  if (result.action === "start" && result.task_routing_bundle) {
    return renderTaskRoutingBundle(result.task_routing_bundle);
  }

  if (result.action === "inject" && result.context_markdown) {
    return result.navigation_plan
      ? `${result.context_markdown}\n\n${renderAgentNavigationPlan(result.navigation_plan)}`
      : result.context_markdown;
  }

  const lines = [
    "# RepoBrain Conversation Start",
    "",
    `Action: ${result.action}`,
    `Reason: ${result.reason}`,
    `Mode: ${result.refresh_mode}`,
  ];

  if (result.task) {
    lines.push(`Task: ${result.task}`);
  }

  if (result.paths.length > 0) {
    lines.push(`Paths: ${result.paths.join(", ")}`);
  }

  lines.push("");
  lines.push(
    "Context refresh was skipped because the most recent RepoBrain context load still looks reusable for this conversation. " +
      'Use "brain inject" or rerun with "--force" if the agent feels context-starved.',
  );

  return lines.join("\n");
}

export function renderConversationStartJson(result: ConversationStartResult): string {
  if (result.action === "start" && result.task_routing_bundle) {
    return JSON.stringify(
      {
        ...result,
        task_routing_bundle: {
          ...result.task_routing_bundle,
          ...(result.task_routing_bundle
            ? { rendered_markdown: renderTaskRoutingBundle(result.task_routing_bundle) }
            : {}),
        },
      },
      null,
      2,
    );
  }

  return JSON.stringify(result, null, 2);
}

function decideConversationStart(input: {
  activity: BrainActivityState;
  sessionProfileUpdatedAt?: string;
  sessionProfileVisible: boolean;
  task?: string;
  paths: string[];
  modules: string[];
  includeSessionProfile: boolean;
  refreshMode: ConversationRefreshMode;
  redundancyWindowMinutes: number;
  sessionBoundaryMinutes: number;
  forceRefresh: boolean;
}): {
  action: ConversationStartAction;
  reason: string;
  trace: ConversationStartDecisionTrace;
} {
  const now = new Date();
  const lastLoadedAt = parseDate(input.activity.lastContextLoadedAt);
  const ageMinutes = lastLoadedAt ? Math.floor((now.getTime() - lastLoadedAt.getTime()) / 60000) : null;
  const firstConversation = !lastLoadedAt;
  const inferredNewSession = ageMinutes !== null && ageMinutes >= input.sessionBoundaryMinutes;
  const previousTask = input.activity.lastSelectionContext?.task?.trim() || undefined;
  const taskChanged = hasTextChange(input.task, previousTask);
  const pathChanged = hasArrayChange(input.paths, input.activity.lastSelectionContext?.paths);
  const moduleChanged = hasArrayChange(input.modules, input.activity.lastSelectionContext?.modules);
  const sessionProfileChanged = hasSessionProfileChange({
    includeSessionProfile: input.includeSessionProfile,
    sessionProfileVisible: input.sessionProfileVisible,
    ...(input.sessionProfileUpdatedAt ? { sessionProfileUpdatedAt: input.sessionProfileUpdatedAt } : {}),
    activity: input.activity,
  });

  const trace: ConversationStartDecisionTrace = {
    first_conversation: firstConversation,
    inferred_new_session: inferredNewSession,
    task_changed: taskChanged,
    path_changed: pathChanged,
    module_changed: moduleChanged,
    session_profile_changed: sessionProfileChanged,
    force_refresh: input.forceRefresh,
    context_age_minutes: ageMinutes,
    redundancy_window_minutes: input.redundancyWindowMinutes,
    session_boundary_minutes: input.sessionBoundaryMinutes,
    ...(previousTask ? { previous_task: previousTask } : {}),
  };

  if (firstConversation || inferredNewSession) {
    if (input.task?.trim()) {
      return {
        action: "start",
        reason: firstConversation
          ? "No prior RepoBrain context load was found, so bootstrapping with the full session bundle."
          : `The last RepoBrain context load is ${ageMinutes} minutes old, so this looks like a new session. Bootstrapping with the full session bundle.`,
        trace,
      };
    }

    return {
      action: "inject",
      reason: firstConversation
        ? "No prior RepoBrain context load was found and no task was supplied, so loading compact repo context."
        : `The last RepoBrain context load is ${ageMinutes} minutes old and no task was supplied, so loading compact repo context.`,
      trace,
    };
  }

  if (input.forceRefresh) {
    return {
      action: "inject",
      reason: "Forced RepoBrain context refresh requested.",
      trace,
    };
  }

  const structuralChangeDetected = taskChanged || pathChanged || moduleChanged || sessionProfileChanged;
  if (structuralChangeDetected) {
    const reasons = [
      ...(taskChanged ? ["task changed"] : []),
      ...(pathChanged ? ["changed paths differ"] : []),
      ...(moduleChanged ? ["module focus differs"] : []),
      ...(sessionProfileChanged ? ["session profile changed"] : []),
    ];
    return {
      action: "inject",
      reason: `RepoBrain context changed for this conversation: ${reasons.join(", ")}.`,
      trace,
    };
  }

  if (input.refreshMode === "always") {
    return {
      action: "inject",
      reason: 'Conversation refresh mode is "always", so RepoBrain reloads compact context for each new conversation.',
      trace,
    };
  }

  if (input.refreshMode === "task-change") {
    return {
      action: "skip",
      reason: 'Conversation refresh mode is "task-change" and RepoBrain did not detect a meaningful context change.',
      trace,
    };
  }

  if (ageMinutes === null || ageMinutes > input.redundancyWindowMinutes) {
    return {
      action: "inject",
      reason:
        ageMinutes === null
          ? "RepoBrain could not measure the age of the current context load, so it is refreshing compact context."
          : `The last RepoBrain context load is ${ageMinutes} minutes old, which is outside the ${input.redundancyWindowMinutes}-minute reuse window.`,
      trace,
    };
  }

  return {
    action: "skip",
    reason: `The latest RepoBrain context load is only ${ageMinutes} minutes old and the task context still matches, so a refresh would likely be redundant.`,
    trace,
  };
}

function hasSessionProfileChange(input: {
  includeSessionProfile: boolean;
  sessionProfileVisible: boolean;
  sessionProfileUpdatedAt?: string;
  activity: BrainActivityState;
}): boolean {
  if (!input.includeSessionProfile || !input.sessionProfileVisible) {
    return false;
  }

  if (input.activity.lastSelectionContext?.includeSessionProfile === false) {
    return true;
  }

  const profileUpdatedAt = parseDate(input.sessionProfileUpdatedAt);
  const lastLoadedAt = parseDate(input.activity.lastContextLoadedAt);
  if (!profileUpdatedAt || !lastLoadedAt) {
    return false;
  }

  return profileUpdatedAt.getTime() > lastLoadedAt.getTime();
}

function hasTextChange(current?: string, previous?: string): boolean {
  const normalizedCurrent = normalizeText(current);
  const normalizedPrevious = normalizeText(previous);

  if (!normalizedCurrent) {
    return false;
  }

  if (!normalizedPrevious) {
    return true;
  }

  return normalizedCurrent !== normalizedPrevious;
}

function hasArrayChange(current: string[], previous?: string[]): boolean {
  if (current.length === 0) {
    return false;
  }

  const normalizedCurrent = normalizeValues(current);
  const normalizedPrevious = normalizeValues(previous ?? []);

  if (normalizedPrevious.length === 0) {
    return true;
  }

  return (
    normalizedCurrent.length !== normalizedPrevious.length ||
    normalizedCurrent.some((value, index) => value !== normalizedPrevious[index])
  );
}

function normalizeValues(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim().replace(/\\/g, "/"))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right)),
    ),
  );
}

function normalizeText(value?: string): string {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function parseDate(value?: string): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function renderConversationStartPayloadJson(result: ConversationStartResult): string {
  if (result.action === "start" && result.task_routing_bundle) {
    return renderTaskRoutingBundleJson(result.task_routing_bundle);
  }

  return JSON.stringify(
    result.context_markdown
      ? {
          context_markdown: result.context_markdown,
          action: result.action,
          reason: result.reason,
          decision_trace: result.decision_trace,
          ...(result.navigation_plan ? { navigation_plan: result.navigation_plan } : {}),
        }
      : {
          action: result.action,
          reason: result.reason,
          decision_trace: result.decision_trace,
          ...(result.navigation_plan ? { navigation_plan: result.navigation_plan } : {}),
        },
    null,
    2,
  );
}
