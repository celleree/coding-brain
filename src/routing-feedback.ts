import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getBrainDir } from "./config.js";
import type { Preference } from "./types.js";
import {
  initBrain,
  loadStoredPreferenceRecords,
  persistSourceBytes,
  savePreference,
  savePreferenceWithSupersessions,
} from "./store.js";
import { appendRoutingFeedbackReminders, type RoutingFeedbackReminder } from "./reinforce-pending.js";

export const ROUTING_FEEDBACK_EVENT_TYPES = [
  "skill_followed",
  "skill_ignored",
  "skill_rejected_by_user",
  "workflow_too_heavy",
  "workflow_success",
  "workflow_failure",
  "routing_conflict_escalated",
] as const;

export type RoutingFeedbackEventType = (typeof ROUTING_FEEDBACK_EVENT_TYPES)[number];

export interface RoutingFeedbackEvent {
  type: RoutingFeedbackEventType;
  /** Optional contract marker for adapters */
  contract_version?: string;
  skill?: string;
  workflow?: string;
  invocation_plan_id?: string;
  notes?: string;
  /** 0–1; weaker signals are dropped or deferred */
  signal_strength?: number;
  session?: { agent?: string; task?: string };
}

export interface RoutingFeedbackApplyResult {
  applied: RoutingFeedbackAppliedAction[];
  skipped: Array<{ event: RoutingFeedbackEvent; reason: string }>;
  pending_review: RoutingFeedbackPendingReview[];
}

export interface RoutingFeedbackAppliedAction {
  kind: "preference_candidate_saved" | "preference_confidence_bumped" | "reinforcement_reminder_queued" | "log_only";
  detail: string;
  event_type: RoutingFeedbackEventType;
}

export interface RoutingFeedbackPendingReview {
  reason: string;
  event_type: RoutingFeedbackEventType;
  skill?: string;
  workflow?: string;
}

export interface RoutingFeedbackLogEntry {
  at: string;
  event_type: RoutingFeedbackEventType;
  action: string;
  detail: string;
  skill?: string;
  workflow?: string;
}

interface RoutingFeedbackLogFile {
  version: 1;
  updatedAt: string;
  entries: RoutingFeedbackLogEntry[];
}

const LOG_CAP = 150;
const CONFIDENCE_BUMP = 0.06;
const MAX_AUTO_CONFIDENCE = 0.99;
const NEGATIVE_CANDIDATE_BASE_CONFIDENCE = 0.62;

export function parseRoutingFeedbackStdin(raw: string): RoutingFeedbackEvent[] {
  const text = raw.trim();
  if (!text) {
    throw new Error("Provide JSON array or NDJSON routing feedback events on stdin.");
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => normalizeEvent(entry)).filter((e): e is RoutingFeedbackEvent => e !== null);
    }
  } catch {
    // NDJSON or invalid — try line-wise
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const fromLines: RoutingFeedbackEvent[] = [];
  for (const line of lines) {
    try {
      const parsedLine = JSON.parse(line) as unknown;
      const ev = normalizeEvent(parsedLine);
      if (ev) {
        fromLines.push(ev);
      }
    } catch {
      throw new Error(`Invalid JSON line in routing feedback stdin: ${line.slice(0, 80)}`);
    }
  }

  if (fromLines.length === 0) {
    throw new Error("No valid routing feedback events found (expected JSON array or NDJSON).");
  }

  return fromLines;
}

function normalizeEvent(value: unknown): RoutingFeedbackEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const o = value as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== "string" || !ROUTING_FEEDBACK_EVENT_TYPES.includes(type as RoutingFeedbackEventType)) {
    return null;
  }

  const event: RoutingFeedbackEvent = {
    type: type as RoutingFeedbackEventType,
  };

  if (typeof o.contract_version === "string") {
    event.contract_version = o.contract_version;
  }
  if (typeof o.skill === "string" && o.skill.trim()) {
    event.skill = o.skill.trim();
  }
  if (typeof o.workflow === "string" && o.workflow.trim()) {
    event.workflow = o.workflow.trim();
  }
  if (typeof o.invocation_plan_id === "string" && o.invocation_plan_id.trim()) {
    event.invocation_plan_id = o.invocation_plan_id.trim();
  }
  if (typeof o.notes === "string") {
    event.notes = o.notes.trim();
  }
  if (typeof o.signal_strength === "number" && Number.isFinite(o.signal_strength)) {
    event.signal_strength = clamp01(o.signal_strength);
  }
  if (o.session && typeof o.session === "object") {
    const s = o.session as Record<string, unknown>;
    event.session = {};
    if (typeof s.agent === "string") {
      event.session.agent = s.agent;
    }
    if (typeof s.task === "string") {
      event.session.task = s.task;
    }
  }

  return event;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Drop weak or chat-like events so casual text does not become policy. */
export function shouldProcessRoutingFeedbackEvent(event: RoutingFeedbackEvent): { ok: boolean; reason?: string } {
  const strength = event.signal_strength ?? 1;
  if (strength < 0.35) {
    return { ok: false, reason: "signal_strength below threshold (0.35)" };
  }

  const needsTarget =
    event.type === "skill_followed" ||
    event.type === "skill_ignored" ||
    event.type === "skill_rejected_by_user" ||
    event.type === "routing_conflict_escalated";

  const hasSkill = Boolean(event.skill?.trim());
  const hasWorkflow = Boolean(event.workflow?.trim());
  const hasPlan = Boolean(event.invocation_plan_id?.trim());
  const notes = event.notes?.trim() ?? "";
  const notesOk = notes.length >= 12 && /[\w\u4e00-\u9fff]/.test(notes);

  if (needsTarget && !hasSkill && !hasWorkflow && !hasPlan && !notesOk) {
    return { ok: false, reason: "missing skill/workflow/plan and notes too weak for this event type" };
  }

  if (
    (event.type === "workflow_too_heavy" || event.type === "workflow_failure") &&
    !hasWorkflow &&
    !hasSkill &&
    notes.length < 16
  ) {
    return { ok: false, reason: "workflow/skill context or longer notes required" };
  }

  return { ok: true };
}

export async function applyRoutingFeedback(
  projectRoot: string,
  events: RoutingFeedbackEvent[],
  options: { sourceEpisode?: string; sourceBytes?: Uint8Array } = {},
): Promise<RoutingFeedbackApplyResult> {
  const applied: RoutingFeedbackAppliedAction[] = [];
  const skipped: Array<{ event: RoutingFeedbackEvent; reason: string }> = [];
  const pending_review: RoutingFeedbackPendingReview[] = [];
  const sourceEpisode =
    options.sourceEpisode ??
    (options.sourceBytes ? await persistSourceBytes(projectRoot, options.sourceBytes) : undefined);
  if (!sourceEpisode) {
    throw new Error("Routing feedback requires source bytes or a valid source_episode.");
  }

  for (const event of events) {
    const gate = shouldProcessRoutingFeedbackEvent(event);
    if (!gate.ok) {
      skipped.push({ event, reason: gate.reason ?? "filtered" });
      continue;
    }

    const strength = event.signal_strength ?? 1;
    switch (event.type) {
      case "skill_followed":
      case "workflow_success":
        await handlePositive(projectRoot, event, strength, sourceEpisode, applied, pending_review);
        break;
      case "skill_rejected_by_user":
      case "workflow_too_heavy":
      case "workflow_failure":
        await handleNegative(projectRoot, event, strength, sourceEpisode, applied, pending_review);
        break;
      case "skill_ignored":
      case "routing_conflict_escalated":
        await handleReinforcementOnly(projectRoot, event, applied);
        break;
      default:
        skipped.push({ event, reason: "unhandled event type" });
    }
  }

  return { applied, skipped, pending_review };
}

async function handlePositive(
  projectRoot: string,
  event: RoutingFeedbackEvent,
  strength: number,
  sourceEpisode: string,
  applied: RoutingFeedbackAppliedAction[],
  pending_review: RoutingFeedbackPendingReview[],
): Promise<void> {
  const skill = event.skill?.trim();
  const workflow = event.workflow?.trim();

  if (workflow && event.type === "workflow_success" && !skill) {
    await appendLog(projectRoot, {
      at: new Date().toISOString(),
      event_type: event.type,
      action: "positive_ack",
      detail: event.notes?.trim() || `workflow success: ${workflow}`,
      workflow,
    });
    applied.push({
      kind: "log_only",
      detail: `Recorded workflow success for "${workflow}" (skill routing uses target_type=skill; workflow stored in log).`,
      event_type: event.type,
    });
    return;
  }

  if (!skill) {
    const pr: RoutingFeedbackPendingReview = {
      reason: "positive feedback needs a skill (or workflow-only workflow_success)",
      event_type: event.type,
    };
    if (workflow) {
      pr.workflow = workflow;
    }
    pending_review.push(pr);
    return;
  }

  const bump = await tryBumpPreferConfidence(projectRoot, skill, strength, sourceEpisode);
  if (bump) {
    applied.push({
      kind: "preference_confidence_bumped",
      detail: bump.detail,
      event_type: event.type,
    });
    await appendLog(projectRoot, {
      at: new Date().toISOString(),
      event_type: event.type,
      action: "confidence_bump",
      detail: bump.detail,
      skill,
    });
    return;
  }

  pending_review.push({
    reason: "no safe auto-bump (need single active prefer without avoid, sufficient signal, room below cap)",
    event_type: event.type,
    skill,
  });
}

async function tryBumpPreferConfidence(
  projectRoot: string,
  skill: string,
  strength: number,
  sourceEpisode: string,
): Promise<{ detail: string } | null> {
  const records = await loadStoredPreferenceRecords(projectRoot);
  const matches = records.filter(
    (r) =>
      r.preference.target_type === "skill" &&
      r.preference.target.trim().toLowerCase() === skill.toLowerCase() &&
      r.preference.status === "active",
  );

  const prefer = matches.filter((r) => r.preference.preference === "prefer");
  if (prefer.length === 0) {
    return null;
  }

  const avoid = matches.some((r) => r.preference.preference === "avoid");
  if (avoid) {
    return null;
  }

  const latest = prefer.sort((a, b) => b.preference.updated_at.localeCompare(a.preference.updated_at))[0];
  if (!latest) {
    return null;
  }

  const current = latest.preference.confidence ?? 0.5;
  if (current >= MAX_AUTO_CONFIDENCE - 1e-6) {
    return null;
  }

  /** Only auto-bump when risk is low: single clear prefer row, strong signal */
  if (prefer.length > 1 || strength < 0.55) {
    return null;
  }

  const delta = CONFIDENCE_BUMP * strength;
  const next = Math.min(MAX_AUTO_CONFIDENCE, current + delta);
  const now = new Date().toISOString();
  const {
    record_digest: _recordDigest,
    superseded_by: _supersededBy,
    valid_until: _validUntil,
    ...previousPreference
  } = latest.preference;
  const successor: Preference = {
    ...previousPreference,
    confidence: next,
    source: "routing_feedback",
    source_episode: sourceEpisode,
    created_at: now,
    updated_at: now,
    observed_at: now,
    status: "candidate",
    supersession_reason: null,
  };
  await savePreferenceWithSupersessions(successor, projectRoot, latest.preference.target);
  return { detail: `Bumped prefer confidence for skill "${skill}" from ${current.toFixed(3)} to ${next.toFixed(3)}.` };
}

async function handleNegative(
  projectRoot: string,
  event: RoutingFeedbackEvent,
  strength: number,
  sourceEpisode: string,
  applied: RoutingFeedbackAppliedAction[],
  pending_review: RoutingFeedbackPendingReview[],
): Promise<void> {
  const skill = event.skill?.trim();
  const workflow = event.workflow?.trim();
  const targetType = skill ? ("skill" as const) : workflow ? ("workflow" as const) : null;
  const target = skill ?? workflow ?? "";

  if (!targetType || !target) {
    pending_review.push({
      reason: "negative feedback needs skill or workflow",
      event_type: event.type,
    });
    return;
  }

  const records = await loadStoredPreferenceRecords(projectRoot);
  const conflict = records.some(
    (r) =>
      r.preference.target_type === targetType &&
      r.preference.target.trim().toLowerCase() === target.toLowerCase() &&
      r.preference.status === "active" &&
      r.preference.preference === "prefer",
  );

  if (conflict) {
    const pr: RoutingFeedbackPendingReview = {
      reason: `active prefer exists for ${targetType} "${target}"; user review required before avoid`,
      event_type: event.type,
    };
    if (skill) {
      pr.skill = skill;
    }
    if (workflow) {
      pr.workflow = workflow;
    }
    pending_review.push(pr);
    const logEntry: RoutingFeedbackLogEntry = {
      at: new Date().toISOString(),
      event_type: event.type,
      action: "pending_review",
      detail: `Negative feedback conflicts with prefer for ${targetType} "${target}".`,
    };
    if (skill) {
      logEntry.skill = skill;
    }
    if (workflow) {
      logEntry.workflow = workflow;
    }
    await appendLog(projectRoot, logEntry);
    return;
  }

  const now = new Date().toISOString();
  const pref: Preference = {
    kind: "routing_preference",
    target_type: targetType,
    target,
    preference: "avoid",
    reason: `[routing feedback: ${event.type}] ${event.notes?.trim() || "user or session negative signal"}`,
    confidence: Math.min(0.88, NEGATIVE_CANDIDATE_BASE_CONFIDENCE + strength * 0.22),
    source: "routing_feedback",
    created_at: now,
    updated_at: now,
    status: "candidate",
    source_episode: sourceEpisode,
  };

  const savedPath = await savePreference(pref, projectRoot);
  applied.push({
    kind: "preference_candidate_saved",
    detail: `Saved avoid preference candidate: ${path.basename(savedPath)}`,
    event_type: event.type,
  });

  const avoidLog: RoutingFeedbackLogEntry = {
    at: now,
    event_type: event.type,
    action: "avoid_candidate",
    detail: pref.reason,
  };
  if (skill) {
    avoidLog.skill = skill;
  }
  if (workflow) {
    avoidLog.workflow = workflow;
  }
  await appendLog(projectRoot, avoidLog);
}

async function handleReinforcementOnly(
  projectRoot: string,
  event: RoutingFeedbackEvent,
  applied: RoutingFeedbackAppliedAction[],
): Promise<void> {
  const summary = buildReminderSummary(event);
  const reminder: RoutingFeedbackReminder = {
    id: `rf-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    created_at: new Date().toISOString(),
    event_type: event.type,
    summary,
  };
  const sk = event.skill?.trim();
  const wf = event.workflow?.trim();
  const planId = event.invocation_plan_id?.trim();
  if (sk) {
    reminder.skill = sk;
  }
  if (wf) {
    reminder.workflow = wf;
  }
  if (planId) {
    reminder.invocation_plan_id = planId;
  }

  await appendRoutingFeedbackReminders(projectRoot, [reminder]);
  applied.push({
    kind: "reinforcement_reminder_queued",
    detail: summary,
    event_type: event.type,
  });

  const rLog: RoutingFeedbackLogEntry = {
    at: reminder.created_at,
    event_type: event.type,
    action: "reinforcement_reminder",
    detail: summary,
  };
  if (sk) {
    rLog.skill = sk;
  }
  if (wf) {
    rLog.workflow = wf;
  }
  await appendLog(projectRoot, rLog);
}

function buildReminderSummary(event: RoutingFeedbackEvent): string {
  const parts: string[] = [];
  if (event.type === "skill_ignored") {
    parts.push("Agent did not follow the suggested invocation plan for skills/routing.");
  } else {
    parts.push("Routing conflict was escalated for user awareness.");
  }
  if (event.skill) {
    parts.push(`Skill: ${event.skill}`);
  }
  if (event.workflow) {
    parts.push(`Workflow: ${event.workflow}`);
  }
  if (event.invocation_plan_id) {
    parts.push(`Plan: ${event.invocation_plan_id}`);
  }
  if (event.notes?.trim()) {
    parts.push(event.notes.trim());
  }
  return parts.join(" | ");
}

function getRoutingFeedbackLogPath(projectRoot: string): string {
  return path.join(getBrainDir(projectRoot), "routing-feedback-log.json");
}

async function appendLog(projectRoot: string, entry: RoutingFeedbackLogEntry): Promise<void> {
  await initBrain(projectRoot);
  const logPath = getRoutingFeedbackLogPath(projectRoot);
  let file: RoutingFeedbackLogFile = { version: 1, updatedAt: "", entries: [] };
  try {
    const raw = await readFile(logPath, "utf8");
    const parsed = JSON.parse(raw) as RoutingFeedbackLogFile;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
      file = parsed;
    }
  } catch {
    // new file
  }

  file.entries.push(entry);
  if (file.entries.length > LOG_CAP) {
    file.entries = file.entries.slice(-LOG_CAP);
  }
  file.updatedAt = new Date().toISOString();
  await writeFile(logPath, JSON.stringify(file, null, 2), "utf8");
}

export interface ExplainRoutingFeedbackResult {
  skill: string;
  preferences: Array<{
    relative_path: string;
    status: string;
    preference: string;
    confidence: number;
    reason_excerpt: string;
  }>;
  recent_feedback: RoutingFeedbackLogEntry[];
  notes: string[];
}

export async function explainRoutingFeedbackForSkill(
  projectRoot: string,
  skill: string,
): Promise<ExplainRoutingFeedbackResult> {
  const normalized = skill.trim().toLowerCase();
  const records = await loadStoredPreferenceRecords(projectRoot);
  const prefs = records.filter(
    (r) => r.preference.target_type === "skill" && r.preference.target.trim().toLowerCase() === normalized,
  );

  const log = await loadRoutingFeedbackLog(projectRoot);
  const recent_feedback = log.entries.filter(
    (e) => e.skill?.trim().toLowerCase() === normalized || e.detail.toLowerCase().includes(normalized),
  );

  const notes: string[] = [
    "Skill routing uses active preferences with target_type=skill (see routing engine).",
    "Workflow/task_class preferences are stored but may be skipped by automated routing until promoted.",
  ];

  return {
    skill: skill.trim(),
    preferences: prefs.map((r) => ({
      relative_path: r.relativePath,
      status: r.preference.status,
      preference: r.preference.preference,
      confidence: r.preference.confidence ?? 0.5,
      reason_excerpt: r.preference.reason.split("\n")[0]?.slice(0, 200) ?? "",
    })),
    recent_feedback: recent_feedback.slice(-20),
    notes,
  };
}

export async function loadRoutingFeedbackLog(projectRoot: string): Promise<RoutingFeedbackLogFile> {
  try {
    const raw = await readFile(getRoutingFeedbackLogPath(projectRoot), "utf8");
    const parsed = JSON.parse(raw) as RoutingFeedbackLogFile;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return { version: 1, updatedAt: "", entries: [] };
}

export function renderExplainRoutingFeedbackText(result: ExplainRoutingFeedbackResult): string {
  const lines: string[] = [];
  lines.push(`Routing feedback explainability: skill "${result.skill}"`);
  lines.push("");
  lines.push("Preferences affecting this skill:");
  if (result.preferences.length === 0) {
    lines.push("  (none)");
  } else {
    for (const p of result.preferences) {
      lines.push(`  - [${p.status}] ${p.preference} conf=${p.confidence.toFixed(3)} — ${p.relative_path}`);
      lines.push(`    ${p.reason_excerpt}`);
    }
  }
  lines.push("");
  lines.push("Recent routing feedback log entries:");
  if (result.recent_feedback.length === 0) {
    lines.push("  (none)");
  } else {
    for (const e of result.recent_feedback) {
      lines.push(`  - ${e.at} | ${e.event_type} | ${e.action} | ${e.detail}`);
    }
  }
  lines.push("");
  for (const n of result.notes) {
    lines.push(`Note: ${n}`);
  }
  return lines.join("\n");
}
