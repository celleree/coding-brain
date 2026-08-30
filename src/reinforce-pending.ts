import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FailureEvent } from "./failure-detector.js";
import { getBrainDir } from "./config.js";

/** Queued human-review lines for routing feedback (ignored plan, escalations). */
export interface RoutingFeedbackReminder {
  id: string;
  created_at: string;
  event_type: string;
  summary: string;
  skill?: string;
  workflow?: string;
  invocation_plan_id?: string;
}

export interface PendingReinforcementState {
  updatedAt: string;
  events: FailureEvent[];
  routing_feedback_reminders?: RoutingFeedbackReminder[];
}

export async function loadPendingReinforcementState(projectRoot: string): Promise<PendingReinforcementState> {
  try {
    const raw = await readFile(getPendingReinforcementPath(projectRoot), "utf8");
    return parsePendingReinforcementState(raw);
  } catch {
    return {
      updatedAt: "",
      events: [],
    };
  }
}

export async function savePendingReinforcementEvents(projectRoot: string, events: FailureEvent[]): Promise<void> {
  const pendingPath = getPendingReinforcementPath(projectRoot);
  const current = await loadPendingReinforcementState(projectRoot);
  const merged = dedupeFailureEvents([...current.events, ...events]);

  await mkdir(path.dirname(pendingPath), { recursive: true });
  await writeFile(
    pendingPath,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        events: merged,
        routing_feedback_reminders: current.routing_feedback_reminders ?? [],
      },
      null,
      2,
    ),
    "utf8",
  );
}

export async function appendRoutingFeedbackReminders(
  projectRoot: string,
  reminders: RoutingFeedbackReminder[],
): Promise<void> {
  const pendingPath = getPendingReinforcementPath(projectRoot);
  const current = await loadPendingReinforcementState(projectRoot);
  const merged = dedupeReminders([...(current.routing_feedback_reminders ?? []), ...reminders]);

  await mkdir(path.dirname(pendingPath), { recursive: true });
  await writeFile(
    pendingPath,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        events: current.events,
        routing_feedback_reminders: merged,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export async function clearRoutingFeedbackReminders(projectRoot: string): Promise<void> {
  const pendingPath = getPendingReinforcementPath(projectRoot);
  const current = await loadPendingReinforcementState(projectRoot);
  if (!current.routing_feedback_reminders || current.routing_feedback_reminders.length === 0) {
    return;
  }
  await mkdir(path.dirname(pendingPath), { recursive: true });
  await writeFile(
    pendingPath,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        events: current.events,
        routing_feedback_reminders: [],
      },
      null,
      2,
    ),
    "utf8",
  );
}

export async function clearPendingReinforcementEvents(projectRoot: string): Promise<void> {
  const current = await loadPendingReinforcementState(projectRoot);
  const reminders = current.routing_feedback_reminders ?? [];
  if (reminders.length === 0) {
    await rm(getPendingReinforcementPath(projectRoot), { force: true });
    return;
  }

  await mkdir(path.dirname(getPendingReinforcementPath(projectRoot)), { recursive: true });
  await writeFile(
    getPendingReinforcementPath(projectRoot),
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        events: [],
        routing_feedback_reminders: reminders,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function getPendingReinforcementPath(projectRoot: string): string {
  return path.join(getBrainDir(projectRoot), "reinforce-pending.json");
}

function parsePendingReinforcementState(raw: string): PendingReinforcementState {
  try {
    const parsed = JSON.parse(raw) as {
      updatedAt?: unknown;
      events?: unknown;
      routing_feedback_reminders?: unknown;
    };

    const events = Array.isArray(parsed.events)
      ? parsed.events.map(parseFailureEvent).filter((event): event is FailureEvent => event !== null)
      : [];

    const routing_feedback_reminders = Array.isArray(parsed.routing_feedback_reminders)
      ? parsed.routing_feedback_reminders
          .map(parseRoutingFeedbackReminder)
          .filter((r): r is RoutingFeedbackReminder => r !== null)
      : undefined;

    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      events,
      ...(routing_feedback_reminders && routing_feedback_reminders.length > 0 ? { routing_feedback_reminders } : {}),
    };
  } catch {
    return {
      updatedAt: "",
      events: [],
    };
  }
}

function parseRoutingFeedbackReminder(value: unknown): RoutingFeedbackReminder | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const o = value as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id.trim()) {
    return null;
  }
  if (typeof o.created_at !== "string" || !o.created_at.trim()) {
    return null;
  }
  if (typeof o.event_type !== "string" || !o.event_type.trim()) {
    return null;
  }
  if (typeof o.summary !== "string" || !o.summary.trim()) {
    return null;
  }
  const r: RoutingFeedbackReminder = {
    id: o.id.trim(),
    created_at: o.created_at.trim(),
    event_type: o.event_type.trim(),
    summary: o.summary.trim(),
  };
  if (typeof o.skill === "string" && o.skill.trim()) {
    r.skill = o.skill.trim();
  }
  if (typeof o.workflow === "string" && o.workflow.trim()) {
    r.workflow = o.workflow.trim();
  }
  if (typeof o.invocation_plan_id === "string" && o.invocation_plan_id.trim()) {
    r.invocation_plan_id = o.invocation_plan_id.trim();
  }
  return r;
}

function dedupeReminders(reminders: RoutingFeedbackReminder[]): RoutingFeedbackReminder[] {
  const seen = new Set<string>();
  const result: RoutingFeedbackReminder[] = [];
  for (const r of reminders) {
    const key = `${r.event_type}|${r.summary}|${r.skill ?? ""}|${r.invocation_plan_id ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(r);
  }
  return result;
}

function parseFailureEvent(value: unknown): FailureEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind;
  const description = candidate.description;
  const suggestedAction = candidate.suggestedAction;

  if (
    (kind !== "violated_memory" && kind !== "new_failure") ||
    typeof description !== "string" ||
    !description.trim() ||
    (suggestedAction !== "boost_score" && suggestedAction !== "rewrite_memory" && suggestedAction !== "extract_new")
  ) {
    return null;
  }

  if (kind === "violated_memory") {
    if (typeof candidate.relatedMemoryFile === "string" && candidate.relatedMemoryFile.trim()) {
      const event: FailureEvent = {
        kind,
        description: description.trim(),
        suggestedAction,
        relatedMemoryFile: candidate.relatedMemoryFile.trim(),
      };
      if (typeof candidate.source_episode === "string") event.source_episode = candidate.source_episode;
      return event;
    }
    return null;
  }

  if (typeof candidate.draftContent === "string" && candidate.draftContent.trim()) {
    const event: FailureEvent = {
      kind,
      description: description.trim(),
      suggestedAction,
      draftContent: candidate.draftContent.trim(),
    };
    if (typeof candidate.source_episode === "string") event.source_episode = candidate.source_episode;
    return event;
  }
  return null;
}

function dedupeFailureEvents(events: FailureEvent[]): FailureEvent[] {
  const seen = new Set<string>();
  const result: FailureEvent[] = [];

  for (const event of events) {
    const key = JSON.stringify(event);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(event);
  }

  return result;
}
