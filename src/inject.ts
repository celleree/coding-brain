import { execSync } from "node:child_process";

import {
  getMemoryStatus,
  loadMemoryIndexCache,
  loadStoredMemoryRecords,
  loadStoredMemoryRecordsByBrainRelativePaths,
  recordInjectedMemories,
  serializeMemory,
  verifyMemoryProvenance,
} from "./store.js";
import { isMemoryCurrentlyValid } from "./temporal.js";
import {
  buildInjectScoreReport,
  explainSelectionDecision,
  formatCompactReasons,
  hasSelectionContext,
  normalizeSelectionOptions,
} from "./inject-ranking.js";
import type { DiversitySelectionDecision, MemorySelectionOptions, RankedMemoryCandidate } from "./inject-ranking.js";
import type { BrainConfig, DerivedMemoryIndexEntry, InjectLayer, Memory, StoredMemoryRecord } from "./types.js";
import {
  loadSessionProfile,
  renderSessionProfileInjectSection,
  sessionProfileHasVisibleContent,
} from "./session-profile.js";

export interface GitContext {
  changedFiles: string[];
  branchName: string;
}

export interface BuildInjectionOptions extends MemorySelectionOptions {
  noContext?: boolean;
  explain?: boolean;
  includeWorking?: boolean;
  gitContext?: GitContext;
  layer?: InjectLayer;
  ids?: string[];
  /** When false, skip `.brain/runtime/session-profile.json`. Default: true. */
  includeSessionProfile?: boolean;
  activitySource?: "inject" | "route" | "conversation-start";
}

interface RankedMemory {
  relativePath: string;
  memory: Memory;
  report: RankedMemoryCandidate["report"];
  selectionDecision?: DiversitySelectionDecision;
  tokenCost: number;
}

interface SelectionResult {
  selected: RankedMemory[];
  staleCount: number;
  eligibleCount: number;
}

interface ResolveRequestedIdsOptions {
  includeWorking: boolean;
}

interface InjectionDataSet {
  allRecords: StoredMemoryRecord[];
  allMemories: Memory[];
  staleCount: number;
  candidateCount: number;
  lastUpdated: string;
  selectedFromIds: RankedMemory[] | null;
  eligibleCountOverride?: number;
}

export async function buildInjection(
  projectRoot: string,
  config: BrainConfig,
  rawOptions: BuildInjectionOptions = {},
): Promise<string> {
  const options = normalizeSelectionOptions(rawOptions);
  const layer = resolveInjectLayer(rawOptions.layer);
  const requestedIds = normalizeRequestedIds(rawOptions.ids ?? []);

  if (layer === "full" && requestedIds.length === 0) {
    throw new Error(
      'The "full" inject layer requires "--ids" so RepoBrain does not dump every selected memory body by default.',
    );
  }

  const taskAware = hasSelectionContext(options);
  const gitContext = rawOptions.noContext
    ? { changedFiles: [], branchName: "" }
    : (rawOptions.gitContext ?? getGitContext(projectRoot));
  const loadedInjectionData = await loadInjectionData(projectRoot, options, gitContext, {
    includeWorking: Boolean(rawOptions.includeWorking),
    noContext: Boolean(rawOptions.noContext),
    requestedIds,
  });
  const provenanceGate = await gateInjectionData(projectRoot, loadedInjectionData);
  if (requestedIds.length > 0 && provenanceGate.rejectedPaths.length > 0) {
    throw new Error(
      `Requested memory is not injectable because provenance verification failed: ${provenanceGate.rejectedPaths.join(", ")}`,
    );
  }
  const injectionData = provenanceGate.data;

  const activeRecords = buildInjectablePool(injectionData.allRecords, Boolean(rawOptions.includeWorking));
  emitLineageWarnings(activeRecords);
  const ranked = rankMemories(activeRecords, options, {
    gitContext,
    gitContextEnabled: !rawOptions.noContext && shouldUseGitContext(activeRecords, gitContext),
  });
  const selection = selectWithinTokenBudget(
    ranked,
    {
      ...config,
      injectDiversity: config.injectDiversity ?? true,
      injectExplainMaxItems: config.injectExplainMaxItems ?? 4,
    },
    injectionData.staleCount,
  );

  const selected = injectionData.selectedFromIds ?? selection.selected;

  await recordInjectedMemories(
    projectRoot,
    selected.map((entry) => entry.memory),
    {
      ...(options.task?.trim() ? { task: options.task.trim() } : {}),
      paths: options.paths ?? [],
      modules: options.modules ?? [],
      includeSessionProfile: rawOptions.includeSessionProfile !== false,
      source: rawOptions.activitySource ?? "inject",
    },
  );

  const lastUpdated = injectionData.lastUpdated;

  const sessionProfile = rawOptions.includeSessionProfile === false ? null : await loadSessionProfile(projectRoot);
  const sessionVisible = Boolean(sessionProfile && sessionProfileHasVisibleContent(sessionProfile));

  return [
    "# Project Brain: Repo Knowledge Context",
    "",
    "Before starting the current task, review the project knowledge below. It captures repo decisions, limits, and conventions that should be followed unless you have a clear reason to deviate.",
    ...(hasSelectionContext(options) || ranked.some((entry) => entry.report.contextScore > 0)
      ? [
          "",
          renderSelectionSummary(
            options,
            gitContext,
            ranked.some((entry) => hasGitContextComponent(entry)),
          ),
        ]
      : []),
    ...(sessionVisible && sessionProfile ? ["", renderSessionProfileInjectSection(sessionProfile), ""] : []),
    "## Injected Memories (Priority Order)",
    renderGroup(selected, taskAware, layer),
    "",
    "---",
    `Source: .brain/ (${injectionData.allMemories.length} durable records, last updated: ${lastUpdated})`,
    ...(sessionVisible
      ? [
          "Session overlay: `.brain/runtime/session-profile.json` (ephemeral; local-only; not promoted to durable knowledge unless you run `brain session-promote`).",
        ]
      : []),
    `[RepoBrain] injected ${selected.length}/${injectionData.eligibleCountOverride ?? selection.eligibleCount} eligible memories.`,
    ...(injectionData.candidateCount > 0
      ? [
          `Pending review: ${injectionData.candidateCount} candidate memor${injectionData.candidateCount === 1 ? "y" : "ies"}. Run "brain review" to inspect them.`,
        ]
      : []),
    "Requirements:",
    "- Understand these memories before choosing an implementation plan",
    "- If you need to conflict with a high-priority memory, explain why first",
    "- Do not suggest approaches that have already been ruled out",
    ...(injectionData.staleCount > 0
      ? [
          `Note: ${injectionData.staleCount} stale memor${injectionData.staleCount === 1 ? "y is" : "ies are"} currently excluded. Run "brain score" to review them.`,
        ]
      : []),
    ...(shouldRenderExplain(rawOptions.explain)
      ? [renderExplainComment(selected, config.injectExplainMaxItems ?? 4)]
      : []),
  ].join("\n");
}

async function gateInjectionData(
  projectRoot: string,
  data: InjectionDataSet,
): Promise<{ data: InjectionDataSet; rejectedPaths: string[] }> {
  const rejectedPaths: string[] = [];
  const verifiedRecords: StoredMemoryRecord[] = [];
  for (const record of data.allRecords) {
    if (getMemoryStatus(record.memory) !== "active") {
      verifiedRecords.push(record);
      continue;
    }
    const verification = await verifyMemoryProvenance(projectRoot, record.memory, record.relativePath);
    if (verification.ok) verifiedRecords.push(record);
    else rejectedPaths.push(record.relativePath.replace(/\\/g, "/"));
  }

  const selectedFromIds = data.selectedFromIds
    ? (
        await Promise.all(
          data.selectedFromIds.map(async (entry) => {
            const verification = await verifyMemoryProvenance(projectRoot, entry.memory, entry.relativePath);
            if (!verification.ok) {
              rejectedPaths.push(entry.relativePath.replace(/\\/g, "/"));
              return null;
            }
            return entry;
          }),
        )
      ).filter((entry): entry is RankedMemory => entry !== null)
    : null;

  return {
    data: { ...data, allRecords: verifiedRecords, selectedFromIds },
    rejectedPaths: Array.from(new Set(rejectedPaths)),
  };
}

async function loadInjectionData(
  projectRoot: string,
  options: MemorySelectionOptions,
  gitContext: GitContext,
  request: {
    includeWorking: boolean;
    noContext: boolean;
    requestedIds: string[];
  },
): Promise<InjectionDataSet> {
  if (request.requestedIds.length === 0) {
    return loadInjectionDataFromStore(projectRoot);
  }

  const cached = await loadInjectionDataFromCache(projectRoot, options, gitContext, request);
  if (cached) {
    return cached;
  }

  const fallback = await loadInjectionDataFromStore(projectRoot);
  const injectablePool = buildInjectablePool(fallback.allRecords, request.includeWorking);
  const selectedFromIds = resolveRequestedRankedMemories(
    fallback.allRecords,
    rankMemories(injectablePool, options, {
      gitContext,
      gitContextEnabled: !request.noContext && shouldUseGitContext(injectablePool, gitContext),
    }),
    request.requestedIds,
    { includeWorking: request.includeWorking },
  );

  return {
    ...fallback,
    selectedFromIds,
  };
}

async function loadInjectionDataFromStore(projectRoot: string): Promise<InjectionDataSet> {
  const allRecords = await loadStoredMemoryRecords(projectRoot);
  const allMemories = allRecords.map((entry) => entry.memory);
  const statusActivePool = allRecords.filter((entry) => getMemoryStatus(entry.memory) === "active");

  return {
    allRecords,
    allMemories,
    staleCount: statusActivePool.filter((entry) => entry.memory.stale).length,
    candidateCount: allRecords.filter((entry) => getMemoryStatus(entry.memory) === "candidate").length,
    lastUpdated: allMemories[0]?.date ?? "N/A",
    selectedFromIds: null,
  };
}

async function loadInjectionDataFromCache(
  projectRoot: string,
  options: MemorySelectionOptions,
  gitContext: GitContext,
  request: {
    includeWorking: boolean;
    noContext: boolean;
    requestedIds: string[];
  },
): Promise<InjectionDataSet | null> {
  const cacheResult = await loadMemoryIndexCache(projectRoot);
  if (!cacheResult.cache || cacheResult.status !== "ready") {
    return null;
  }

  const cache = cacheResult.cache;
  let selectedEntries: DerivedMemoryIndexEntry[];
  try {
    selectedEntries = resolveRequestedCacheEntries(cache.entries, request.requestedIds, {
      includeWorking: request.includeWorking,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown memory id")) {
      return null;
    }

    throw error;
  }
  const selectedRelativePaths = selectedEntries.map((entry) => entry.relativePath);
  const selectedRecords = await loadStoredMemoryRecordsByBrainRelativePaths(projectRoot, selectedRelativePaths);
  const selectedRecordsByRelativePath = new Map(
    selectedRecords.map((entry) => [toBrainRelativePath(entry.relativePath), entry]),
  );
  const orderedSelectedRecords = selectedRelativePaths.map((relativePath) => {
    const record = selectedRecordsByRelativePath.get(relativePath);
    if (!record) {
      throw new Error(
        `Cached memory "${relativePath}" could not be loaded from disk. Re-run "brain inject" to refresh the cache.`,
      );
    }

    return record;
  });
  const selectedFromIds = scoreMemories(orderedSelectedRecords, options, {
    gitContext,
    gitContextEnabled: !request.noContext && shouldUseGitContext(orderedSelectedRecords, gitContext),
  });

  return {
    allRecords: orderedSelectedRecords,
    allMemories: cache.entries.map((entry) => toCachedMemorySummary(entry)),
    staleCount: cache.entries.filter((entry) => entry.status === "active" && entry.stale).length,
    candidateCount: cache.entries.filter((entry) => entry.status === "candidate").length,
    lastUpdated: cache.entries[0]?.date ?? "N/A",
    selectedFromIds,
    eligibleCountOverride: cache.entries.filter((entry) => isCacheEntryInjectable(entry, request.includeWorking))
      .length,
  };
}

function buildInjectablePool(allRecords: StoredMemoryRecord[], includeWorking: boolean): StoredMemoryRecord[] {
  const now = new Date();
  return allRecords.filter((entry) => {
    if (getMemoryStatus(entry.memory) !== "active") {
      return false;
    }

    if (!includeWorking && entry.memory.type === "working") {
      return false;
    }

    if (isExpiredWorkingMemory(entry.memory, now)) {
      return false;
    }

    return isMemoryCurrentlyValid(entry.memory, now);
  });
}

function isExpiredWorkingMemory(memory: Memory, now: Date): boolean {
  if (memory.type !== "working" || !memory.expires) {
    return false;
  }

  const expiresAt = Date.parse(memory.expires);
  if (Number.isNaN(expiresAt)) {
    return false;
  }

  return expiresAt < now.getTime();
}

function toCachedMemorySummary(entry: DerivedMemoryIndexEntry): Memory {
  return {
    type: entry.type,
    title: entry.title,
    summary: entry.summary,
    detail: "",
    tags: entry.tags,
    importance: "medium",
    date: entry.date,
    score: 60,
    hit_count: 0,
    last_used: null,
    created_at: entry.updated_at,
    stale: entry.stale,
    status: entry.status,
    review_state: entry.review_state,
    risk_level: entry.risk_level,
    path_scope: entry.path_scope,
    files: entry.files,
    superseded_by: entry.superseded_by,
    ...(entry.valid_from ? { valid_from: entry.valid_from } : {}),
    ...(entry.valid_until ? { valid_until: entry.valid_until } : {}),
    ...(entry.expires ? { expires: entry.expires } : {}),
  };
}

function isCacheEntryInjectable(entry: DerivedMemoryIndexEntry, includeWorking: boolean): boolean {
  if (entry.status !== "active") {
    return false;
  }

  if (!includeWorking && entry.type === "working") {
    return false;
  }

  if (entry.stale || entry.superseded_by || entry.review_state === "pending_review") {
    return false;
  }

  return isDerivedEntryCurrentlyValid(entry, new Date());
}

function isDerivedEntryCurrentlyValid(entry: DerivedMemoryIndexEntry, now: Date): boolean {
  const currentTime = now.getTime();
  const start = parseDateLike(entry.valid_from);
  const end = parseDateLike(entry.valid_until ?? entry.expires);

  if (start !== null && currentTime < start) {
    return false;
  }

  if (end !== null && currentTime > end) {
    return false;
  }

  return true;
}

function parseDateLike(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const isoValue = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
  const parsed = Date.parse(isoValue);
  return Number.isNaN(parsed) ? null : parsed;
}

function rankMemories(
  records: StoredMemoryRecord[],
  options: MemorySelectionOptions,
  context: {
    gitContext: GitContext;
    gitContextEnabled: boolean;
  },
): RankedMemory[] {
  return scoreMemories(records, options, context).sort(compareRankedMemories);
}

function scoreMemories(
  records: StoredMemoryRecord[],
  options: MemorySelectionOptions,
  context: {
    gitContext: GitContext;
    gitContextEnabled: boolean;
  },
): RankedMemory[] {
  return records
    .filter((entry) => entry.memory.superseded_by === null && !entry.memory.stale)
    .map((entry) => {
      const memory = entry.memory;
      const report = buildInjectScoreReport(
        memory,
        options,
        context.gitContextEnabled ? context.gitContext : { changedFiles: [], branchName: "" },
      );
      const rendered = renderRankedMemory(
        {
          relativePath: toBrainRelativePath(entry.relativePath),
          memory,
          report,
          tokenCost: 0,
        },
        report.reasons.length > 0,
      );
      return {
        relativePath: toBrainRelativePath(entry.relativePath),
        memory,
        report,
        tokenCost: approximateTokens(rendered),
      };
    });
}

function compareRankedMemories(left: RankedMemory, right: RankedMemory): number {
  const goalDiff = Number(isAlwaysIncludedGoal(right.memory)) - Number(isAlwaysIncludedGoal(left.memory));
  if (goalDiff !== 0) {
    return goalDiff;
  }

  const scoreDiff = right.report.totalScore - left.report.totalScore;
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  const priorityDiff = right.report.priorityScore - left.report.priorityScore;
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  return right.memory.date.localeCompare(left.memory.date);
}

function selectWithinTokenBudget(
  rankedMemories: RankedMemory[],
  config: BrainConfig,
  staleCount: number,
): SelectionResult {
  const selected: RankedMemory[] = [];
  const requiredMemories = rankedMemories.filter((entry) => isAlwaysIncludedGoal(entry.memory));
  const optionalMemories = rankedMemories.filter((entry) => !isAlwaysIncludedGoal(entry.memory));
  const eligibleMemories = rankedMemories;
  let usedTokens = approximateTokens(
    [
      "# Project Brain: Repo Knowledge Context",
      "## Injected Memories (Priority Order)",
      "Selection mode:",
      "---",
      "[RepoBrain] injected 0/0 eligible memories.",
    ].join("\n"),
  );

  for (const entry of requiredMemories) {
    selected.push(entry);
    usedTokens += entry.tokenCost;
  }

  const remaining = [...optionalMemories];
  while (remaining.length > 0) {
    const fitCandidates = remaining.filter(
      (entry) => !(selected.length > 0 && usedTokens + entry.tokenCost > config.maxInjectTokens),
    );
    if (fitCandidates.length === 0) {
      break;
    }

    const chosen = fitCandidates
      .map((entry) => ({
        entry,
        decision: config.injectDiversity
          ? explainSelectionDecision(entry, selected)
          : createPlainSelectionDecision(entry),
      }))
      .sort((left, right) => {
        const utilityDiff = right.decision.utilityScore - left.decision.utilityScore;
        if (utilityDiff !== 0) {
          return utilityDiff;
        }

        return compareRankedMemories(left.entry, right.entry);
      })[0];

    if (!chosen) {
      break;
    }

    chosen.entry.selectionDecision = chosen.decision;
    selected.push(chosen.entry);
    usedTokens += chosen.entry.tokenCost;
    remaining.splice(
      remaining.findIndex((entry) => entry.relativePath === chosen.entry.relativePath),
      1,
    );
  }

  return {
    selected,
    staleCount,
    eligibleCount: eligibleMemories.length,
  };
}

function renderSelectionSummary(
  options: MemorySelectionOptions,
  gitContext: GitContext,
  gitContextEnabled: boolean,
): string {
  const parts: string[] = [];
  const modes: string[] = [];

  if (gitContextEnabled) {
    modes.push("git-context");
    parts.push(`changed=${gitContext.changedFiles.length}`);
    if (gitContext.branchName) {
      parts.push(`branch="${gitContext.branchName}"`);
    }
  }

  if (hasSelectionContext(options)) {
    modes.push("task-aware");
  }

  if (options.task) {
    parts.push(`task="${options.task}"`);
  }

  if ((options.paths ?? []).length > 0) {
    parts.push(`paths=${options.paths?.join(", ")}`);
  }

  if ((options.modules ?? []).length > 0) {
    parts.push(`modules=${options.modules?.join(", ")}`);
  }

  return `Selection mode: ${modes.join(" + ")} (${parts.join(" | ")}). Memories are ranked by contextual score, then injection priority.`;
}

function renderGroup(memories: RankedMemory[], taskAware: boolean, layer: InjectLayer): string {
  if (memories.length === 0) {
    return "_None._";
  }

  switch (layer) {
    case "index":
      return memories.map((memory) => renderIndexMemory(memory, taskAware)).join("\n");
    case "full":
      return memories.map((memory, index) => renderFullMemory(memory, taskAware, index)).join("\n\n");
    case "summary":
    default:
      return memories.map((memory) => renderRankedMemory(memory, taskAware)).join("\n");
  }
}

function renderRankedMemory(entry: RankedMemory, taskAware: boolean): string {
  const tags = entry.memory.tags.length > 0 ? ` | tags: ${entry.memory.tags.join(", ")}` : "";
  const titlePrefix = entry.memory.version && entry.memory.version >= 2 ? `[Updated v${entry.memory.version}] ` : "";
  const lines = [
    `- [${entry.memory.type} | ${entry.memory.importance}] ${titlePrefix}${entry.memory.title}`,
    `  ${entry.memory.summary}`,
    `  Scope: ${extractScope(entry.memory.detail)}${tags}`,
  ];

  if (taskAware && entry.report.reasons.length > 0) {
    lines.push(`  Why now: ${formatCompactReasons(entry.report.reasons).join("; ")}`);
  }

  return lines.join("\n");
}

function renderIndexMemory(entry: RankedMemory, taskAware: boolean): string {
  const lines = [
    `- id: ${entry.relativePath}`,
    `  title: ${entry.memory.title}`,
    `  tags: ${entry.memory.tags.length > 0 ? entry.memory.tags.join(", ") : "-"}`,
    `  score: ${entry.memory.score} | totalScore: ${entry.report.totalScore}`,
  ];

  if (taskAware && entry.report.reasons.length > 0) {
    lines.push(`  why_now: ${formatCompactReasons(entry.report.reasons, 3).join("; ")}`);
  }

  return lines.join("\n");
}

function renderFullMemory(entry: RankedMemory, taskAware: boolean, index: number): string {
  const titlePrefix = entry.memory.version && entry.memory.version >= 2 ? `[Updated v${entry.memory.version}] ` : "";
  const lines = [
    `### ${index + 1}. ${titlePrefix}${entry.memory.title}`,
    `- id: ${entry.relativePath}`,
    `- type: ${entry.memory.type}`,
    `- importance: ${entry.memory.importance}`,
    `- score: ${entry.memory.score} | totalScore: ${entry.report.totalScore}`,
  ];

  if (taskAware && entry.report.reasons.length > 0) {
    lines.push(`- why_now: ${formatCompactReasons(entry.report.reasons, 3).join("; ")}`);
  }

  lines.push("", "```md", serializeMemory(entry.memory), "```");
  return lines.join("\n");
}

function extractScope(detail: string): string {
  const singleLine = detail
    .replace(/^##\s+\w+\s*/m, "")
    .replace(/\s+/g, " ")
    .trim();

  return singleLine.slice(0, 180) || "See memory detail.";
}

function approximateTokens(text: string): number {
  let asciiChars = 0;
  let nonAsciiTokens = 0;

  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) {
      asciiChars += 1;
      continue;
    }

    nonAsciiTokens += 1;
  }

  return Math.ceil(asciiChars / 4) + nonAsciiTokens;
}

function emitLineageWarnings(activeRecords: StoredMemoryRecord[]): void {
  const byBrainRelativePath = new Map<string, StoredMemoryRecord>();

  for (const entry of activeRecords) {
    byBrainRelativePath.set(toBrainRelativePath(entry.relativePath), entry);
  }

  for (const entry of activeRecords) {
    const supersededPath = entry.memory.supersedes;
    if (!supersededPath) {
      continue;
    }

    const supersededRecord = byBrainRelativePath.get(supersededPath);
    if (!supersededRecord || supersededRecord.memory.superseded_by !== null) {
      continue;
    }

    process.stderr.write(
      `[brain] lineage warning: ${supersededPath} should set superseded_by: ${toBrainRelativePath(entry.relativePath)}\n`,
    );
  }
}

function toBrainRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.brain\//, "");
}

function shouldUseGitContext(records: StoredMemoryRecord[], gitContext: GitContext): boolean {
  if (gitContext.changedFiles.length === 0 && !gitContext.branchName) {
    return false;
  }

  return records.some(
    (entry) =>
      (entry.memory.files ?? []).length > 0 ||
      (entry.memory.path_scope ?? []).length > 0 ||
      Boolean(entry.memory.area) ||
      (entry.memory.tags ?? []).length > 0,
  );
}

function getGitContext(projectRoot: string): GitContext {
  try {
    const changedFiles = execSync("git diff --name-only HEAD", {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((value) => normalizeGitPath(value))
      .filter(Boolean);
    const branchName = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { changedFiles, branchName };
  } catch {
    return { changedFiles: [], branchName: "" };
  }
}

function normalizeGitPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
}

function isAlwaysIncludedGoal(memory: Memory): boolean {
  return memory.type === "goal" && getMemoryStatus(memory) === "active";
}

function renderExplainComment(memories: RankedMemory[], maxItems: number): string {
  const lines = memories.map((entry) => {
    const topComponents = entry.report.components
      .slice()
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, maxItems))
      .map((component) => `${component.key}=${component.score} (${component.detail})`);
    const selectionPart = entry.selectionDecision
      ? ` | utility=${entry.selectionDecision.utilityScore} | diversity=+${entry.selectionDecision.diversityBonus} | redundancy=-${entry.selectionDecision.redundancyPenalty}`
      : "";
    return `${entry.relativePath} | total=${entry.report.totalScore} | context=${entry.report.contextScore} | priority=${entry.report.priorityScore}${selectionPart} | ${topComponents.join(" ; ")}`;
  });

  return ["<!-- brain-inject-report", ...lines.map((line) => line.replace(/-->/g, "--&gt;")), "-->"].join("\n");
}

function shouldRenderExplain(explain: boolean | undefined): boolean {
  if (explain) {
    return true;
  }

  return process.env.REPOBRAIN_DEBUG === "1" || process.env.DEBUG?.includes("repobrain:inject") === true;
}

function resolveInjectLayer(layer: InjectLayer | undefined): InjectLayer {
  if (!layer) {
    return "summary";
  }

  if (layer === "index" || layer === "summary" || layer === "full") {
    return layer;
  }

  throw new Error(`Unsupported inject layer "${layer}". Expected one of: index, summary, full.`);
}

function normalizeRequestedIds(values: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of values) {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      continue;
    }

    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate id "${trimmed}" in "--ids". Remove repeated values before retrying.`);
    }

    seen.add(key);
    normalized.push(trimmed);
  }

  return normalized;
}

function resolveRequestedRankedMemories(
  allRecords: StoredMemoryRecord[],
  ranked: RankedMemory[],
  requestedIds: string[],
  options: ResolveRequestedIdsOptions,
): RankedMemory[] {
  const allByRelativePath = new Map(allRecords.map((entry) => [toBrainRelativePath(entry.relativePath), entry]));
  const allByStem = new Map(allRecords.map((entry) => [memoryFileStem(entry), entry]));
  const rankedByRelativePath = new Map(ranked.map((entry) => [entry.relativePath, entry]));
  const resolved: RankedMemory[] = [];
  const seenTargets = new Set<string>();

  for (const requestedId of requestedIds) {
    const record = resolveRequestedMemoryRecord(requestedId, allByRelativePath, allByStem);
    const relativePath = toBrainRelativePath(record.relativePath);

    if (seenTargets.has(relativePath)) {
      throw new Error(`Duplicate id "${requestedId}" resolves to the same memory "${relativePath}".`);
    }

    const requestedRanked = rankedByRelativePath.get(relativePath);
    if (!requestedRanked) {
      throw new Error(buildNonInjectableMemoryMessage(record, options.includeWorking));
    }

    resolved.push(requestedRanked);
    seenTargets.add(relativePath);
  }

  return resolved;
}

function resolveRequestedCacheEntries(
  entries: DerivedMemoryIndexEntry[],
  requestedIds: string[],
  options: ResolveRequestedIdsOptions,
): DerivedMemoryIndexEntry[] {
  const byRelativePath = new Map(entries.map((entry) => [entry.relativePath, entry]));
  const byStem = new Map(entries.map((entry) => [memoryFileStem(entry.relativePath), entry]));
  const resolved: DerivedMemoryIndexEntry[] = [];
  const seenTargets = new Set<string>();

  for (const requestedId of requestedIds) {
    const entry = resolveRequestedMemoryTarget(requestedId, byRelativePath, byStem);
    if (seenTargets.has(entry.relativePath)) {
      throw new Error(`Duplicate id "${requestedId}" resolves to the same memory "${entry.relativePath}".`);
    }

    if (!isCacheEntryInjectable(entry, options.includeWorking)) {
      throw new Error(buildNonInjectableCacheEntryMessage(entry, options.includeWorking));
    }

    resolved.push(entry);
    seenTargets.add(entry.relativePath);
  }

  return resolved;
}

function resolveRequestedMemoryRecord(
  requestedId: string,
  byRelativePath: Map<string, StoredMemoryRecord>,
  byStem: Map<string, StoredMemoryRecord>,
): StoredMemoryRecord {
  return resolveRequestedMemoryTarget(requestedId, byRelativePath, byStem);
}

function resolveRequestedMemoryTarget<T>(
  requestedId: string,
  byRelativePath: Map<string, T>,
  byStem: Map<string, T>,
): T {
  const direct = byRelativePath.get(requestedId);
  if (direct) {
    return direct;
  }

  const normalizedId = requestedId.replace(/\\/g, "/").replace(/^\.brain\//, "");
  const normalizedDirect = byRelativePath.get(normalizedId);
  if (normalizedDirect) {
    return normalizedDirect;
  }

  const stem = byStem.get(requestedId);
  if (stem) {
    return stem;
  }

  throw new Error(
    `Unknown memory id "${requestedId}". Use a memory relative path like "decisions/..." or a file stem like "2026-04-01-my-memory-090000000".`,
  );
}

function buildNonInjectableMemoryMessage(record: StoredMemoryRecord, includeWorking: boolean): string {
  const relativePath = toBrainRelativePath(record.relativePath);
  const memory = record.memory;
  const status = getMemoryStatus(memory);

  if (memory.type === "working" && !includeWorking) {
    return `Memory "${relativePath}" is not injectable by default because it is a working memory. Re-run with "--include-working" if you really want it.`;
  }

  if (status !== "active") {
    return `Memory "${relativePath}" is not injectable because its status is "${status}".`;
  }

  if (memory.stale) {
    return `Memory "${relativePath}" is not injectable because it is marked stale.`;
  }

  if (memory.superseded_by) {
    return `Memory "${relativePath}" is not injectable because it has been superseded by "${memory.superseded_by}".`;
  }

  if (memory.review_state === "pending_review") {
    return `Memory "${relativePath}" is not injectable because it is pending review.`;
  }

  const now = new Date();
  if (!isMemoryCurrentlyValid(memory, now)) {
    return `Memory "${relativePath}" is not injectable because it is outside its validity window.`;
  }

  return `Memory "${relativePath}" is not currently injectable.`;
}

function buildNonInjectableCacheEntryMessage(entry: DerivedMemoryIndexEntry, includeWorking: boolean): string {
  const relativePath = entry.relativePath;

  if (entry.type === "working" && !includeWorking) {
    return `Memory "${relativePath}" is not injectable by default because it is a working memory. Re-run with "--include-working" if you really want it.`;
  }

  if (entry.status !== "active") {
    return `Memory "${relativePath}" is not injectable because its status is "${entry.status}".`;
  }

  if (entry.stale) {
    return `Memory "${relativePath}" is not injectable because it is marked stale.`;
  }

  if (entry.superseded_by) {
    return `Memory "${relativePath}" is not injectable because it has been superseded by "${entry.superseded_by}".`;
  }

  if (entry.review_state === "pending_review") {
    return `Memory "${relativePath}" is not injectable because it is pending review.`;
  }

  if (!isDerivedEntryCurrentlyValid(entry, new Date())) {
    return `Memory "${relativePath}" is not injectable because it is outside its validity window.`;
  }

  return `Memory "${relativePath}" is not currently injectable.`;
}

function memoryFileStem(value: StoredMemoryRecord | string): string {
  const relativePath = typeof value === "string" ? value : toBrainRelativePath(value.relativePath);
  const segments = relativePath.split("/");
  const fileName = segments.at(-1) ?? "";
  return fileName.replace(/\.md$/i, "");
}

function hasGitContextComponent(entry: RankedMemory): boolean {
  return entry.report.components.some(
    (component) => component.key === "git_changed_files_match" || component.key === "branch_tag_hint",
  );
}

function createPlainSelectionDecision(entry: RankedMemory): DiversitySelectionDecision {
  return {
    diversityBonus: 0,
    redundancyPenalty: 0,
    novelty: [],
    redundancy: [],
    utilityScore: entry.report.totalScore,
  };
}
