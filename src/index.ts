import { loadConfig as loadConfigImpl } from "./config.js";
import { extractMemories as extractMemoriesImpl } from "./extract.js";
import { parseRuleFileToMemories as parseRuleFileToMemoriesImpl } from "./import.js";
import { buildInjection as buildInjectionImpl } from "./inject.js";
import { buildConversationStart as buildConversationStartImpl } from "./conversation-start.js";
import {
  buildMemoryDiff as buildMemoryDiffImpl,
  renderMemoryDiff as renderMemoryDiffImpl,
  renderMemoryDiffJson as renderMemoryDiffJsonImpl,
} from "./memory-diff.js";
import { reviewCandidateMemories as reviewCandidateMemoriesImpl } from "./reviewer.js";
import { reviewCandidateMemory as reviewCandidateMemoryImpl } from "./reviewer.js";
import { loadAllMemories as loadAllMemoriesImpl } from "./store/memory-store.js";
import { loadStoredMemoryRecords as loadStoredMemoryRecordsImpl } from "./store/memory-store.js";
import { saveMemory as saveMemoryImpl } from "./store/memory-store.js";
import { initBrain as initBrainImpl } from "./store/core.js";
import { loadAllPreferences as loadAllPreferencesImpl } from "./store/preference-store.js";
import { buildSkillShortlist as buildSkillShortlistImpl } from "./suggest-skills.js";
import { buildTaskRoutingBundle as buildTaskRoutingBundleImpl } from "./task-routing.js";

/**
 * Load and normalize RepoBrain config from `<projectRoot>/.brain/config.yaml`.
 */
export const loadConfig = loadConfigImpl;

/**
 * Load all durable memories from `.brain/` and return them sorted by date (newest first).
 */
export const loadAllMemories = loadAllMemoriesImpl;

/**
 * Load all stored memory records with file metadata and parsed memory payload.
 */
export const loadStoredMemoryRecords = loadStoredMemoryRecordsImpl;

/**
 * Load all routing preference records from `.brain/preferences`.
 */
export const loadAllPreferences = loadAllPreferencesImpl;

/**
 * Persist one memory into `.brain/` using RepoBrain normalization and validation rules.
 */
export const saveMemory = saveMemoryImpl;

/**
 * Initialize (or repair) the RepoBrain workspace structure under `.brain/`.
 */
export const initBrain = initBrainImpl;

/**
 * Build an inject-ready context markdown block from current durable memories.
 */
export const buildInjection = buildInjectionImpl;

/**
 * Decide whether a new conversation should bootstrap with the full session bundle,
 * reload compact context, or skip a redundant refresh.
 */
export const buildConversationStart = buildConversationStartImpl;

/**
 * Summarize memory changes since the last inject or a caller-provided time window.
 */
export const buildMemoryDiff = buildMemoryDiffImpl;

/**
 * Render a human-readable markdown diff of memory-store changes.
 */
export const renderMemoryDiff = renderMemoryDiffImpl;

/**
 * Render a JSON diff of memory-store changes.
 */
export const renderMemoryDiffJson = renderMemoryDiffJsonImpl;

/**
 * Build deterministic skill shortlist and invocation plan for a given task context.
 */
export const buildSkillShortlist = buildSkillShortlistImpl;

/**
 * Build a combined task-routing bundle: injection context + skill routing output.
 */
export const buildTaskRoutingBundle = buildTaskRoutingBundleImpl;

/**
 * Extract candidate durable memories from conversation/session text.
 */
export const extractMemories = extractMemoriesImpl;

/**
 * Parse rule-oriented Markdown files such as AGENTS.md or .cursorrules into candidate memories.
 */
export const parseRuleFileToMemories = parseRuleFileToMemoriesImpl;

/**
 * Review a single candidate memory against existing stored memories.
 */
export const reviewCandidateMemory = reviewCandidateMemoryImpl;

/**
 * Review a batch of candidate memories against existing stored memories.
 */
export const reviewCandidateMemories = reviewCandidateMemoriesImpl;

export * from "./orchestrator-lifecycle.js";
export * from "./orchestrator-rotation.js";
export * from "./orchestrator-checkpoint-api.js";
export * from "./orchestrator-runtime-health.js";
export * from "./orchestrator-status.js";
export * from "./types.js";
