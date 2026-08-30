import { spawnSync } from "node:child_process";
import path from "node:path";

import { slugifyMemoryTitle } from "./memory-identity.js";
import type { Memory } from "./types.js";

const FAILURE_DETECTION_BUDGET = 2000;
const PROMPT_OVERHEAD_TOKENS = 220;
const DEFAULT_MEMORY_LIST_BUDGET = 320;
const MIN_SESSION_LOG_BUDGET = 320;

export type FailureEvent = {
  kind: "violated_memory" | "new_failure";
  description: string;
  relatedMemoryFile?: string;
  suggestedAction: "boost_score" | "rewrite_memory" | "extract_new";
  draftContent?: string;
  /** Raw source episode that caused this failure event. */
  source_episode?: string;
};

type ParsedFailureEvent = {
  kind?: unknown;
  description?: unknown;
  relatedMemoryFile?: unknown;
  suggestedAction?: unknown;
  draftContent?: unknown;
};

const SYSTEM_INSTRUCTION = `You are a repo failure detector.
Review the session log against the known project memories.
Find only concrete failure events where:
1. the agent violated an existing durable memory, or
2. the session repeated a mistake that should become a new gotcha memory.

Return strict JSON only as an array:
[
  {
    "kind": "violated_memory" | "new_failure",
    "description": "One sentence",
    "relatedMemoryFile": "filename.md",
    "suggestedAction": "boost_score" | "rewrite_memory" | "extract_new",
    "draftContent": "gotcha: ...\\n\\nWhy it failed and how to avoid it next time."
  }
]

Rules:
- Return [] when the session looks normal or has no clear failure pattern.
- Only use "violated_memory" when an existing memory was clearly ignored or contradicted.
- Only use "new_failure" when the session reveals a durable repeated mistake worth saving as a gotcha.
- For "violated_memory", include "relatedMemoryFile" and omit "draftContent".
- For "new_failure", include "draftContent" and omit "relatedMemoryFile".
- Keep descriptions concise and factual.
- Do not output markdown fences or extra text.`;

export function detectFailures(sessionLog: string, existingMemories: Memory[]): FailureEvent[] {
  const trimmedSessionLog = sessionLog.trim();
  const extractorCommand = process.env.BRAIN_EXTRACTOR_COMMAND?.trim();

  if (!trimmedSessionLog || !extractorCommand) {
    return [];
  }

  const prompt = buildFailureDetectionPrompt(trimmedSessionLog, existingMemories);

  try {
    const result = spawnSync(extractorCommand, {
      shell: true,
      input: prompt,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 1024 * 1024,
    });

    if (result.error || result.status !== 0) {
      return [];
    }

    return safeParseFailureEvents(result.stdout ?? "", existingMemories);
  } catch {
    return [];
  }
}

export function buildFailureDetectionPrompt(sessionLog: string, existingMemories: Memory[]): string {
  // Keep the prompt focused on the memory index plus the raw session so the model can
  // classify whether this was a memory violation or a new recurring failure, while
  // staying inside a single small-budget call.
  const memoryEntries = existingMemories.map((memory) => formatMemoryIndexEntry(memory));
  const memoryList = fitMemoryListToBudget(memoryEntries);
  const staticSections = [
    SYSTEM_INSTRUCTION,
    "",
    "Existing memory index (title | type | file):",
    memoryList || "(none)",
    "",
    "Session log:",
  ];
  const staticPrompt = staticSections.join("\n");
  const staticTokens = approximateTokens(staticPrompt);
  const sessionBudget = Math.max(
    MIN_SESSION_LOG_BUDGET,
    FAILURE_DETECTION_BUDGET - staticTokens - PROMPT_OVERHEAD_TOKENS,
  );
  const trimmedSession = trimTextToTokenBudget(sessionLog, sessionBudget);

  return [staticPrompt, trimmedSession].join("\n");
}

function safeParseFailureEvents(raw: string, existingMemories: Memory[]): FailureEvent[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) => normalizeFailureEvent(entry as ParsedFailureEvent, existingMemories))
      .filter((entry): entry is FailureEvent => entry !== null);
  } catch {
    return [];
  }
}

function normalizeFailureEvent(value: ParsedFailureEvent, existingMemories: Memory[]): FailureEvent | null {
  const kind = asFailureKind(value.kind);
  const description = asNonEmptyString(value.description);
  const suggestedAction = asSuggestedAction(value.suggestedAction);

  if (!kind || !description || !suggestedAction) {
    return null;
  }

  if (kind === "violated_memory") {
    const relatedMemoryFile = normalizeRelatedMemoryFile(value.relatedMemoryFile, existingMemories);
    if (!relatedMemoryFile) {
      return null;
    }

    return {
      kind,
      description,
      relatedMemoryFile,
      suggestedAction,
    };
  }

  const draftContent = asNonEmptyString(value.draftContent);
  if (!draftContent) {
    return null;
  }

  return {
    kind,
    description,
    suggestedAction,
    draftContent,
  };
}

function fitMemoryListToBudget(entries: string[]): string {
  let used = 0;
  const selected: string[] = [];

  for (const entry of entries) {
    const cost = approximateTokens(entry) + 1;
    if (selected.length > 0 && used + cost > DEFAULT_MEMORY_LIST_BUDGET) {
      break;
    }

    selected.push(entry);
    used += cost;
  }

  if (selected.length === entries.length) {
    return selected.join("\n");
  }

  const remaining = entries.length - selected.length;
  return [...selected, `... (${remaining} more memories omitted to stay within prompt budget)`].join("\n");
}

function formatMemoryIndexEntry(memory: Memory): string {
  return `- ${memory.title} | ${memory.type} | ${getMemoryFileName(memory)}`;
}

function normalizeRelatedMemoryFile(value: unknown, existingMemories: Memory[]): string | null {
  const requested = asNonEmptyString(value);
  if (!requested) {
    return null;
  }

  const normalizedRequested = normalizeComparableFileName(requested);
  for (const memory of existingMemories) {
    const fileName = getMemoryFileName(memory);
    if (normalizeComparableFileName(fileName) === normalizedRequested) {
      return fileName;
    }
  }

  return requested;
}

function getMemoryFileName(memory: Memory): string {
  const enrichedMemory = memory as Memory & { filePath?: unknown; relativePath?: unknown };
  const relativePath = asNonEmptyString(enrichedMemory.relativePath);
  if (relativePath) {
    return path.basename(relativePath.replace(/\\/g, "/"));
  }

  const filePath = asNonEmptyString(enrichedMemory.filePath);
  if (filePath) {
    return path.basename(filePath.replace(/\\/g, "/"));
  }

  const datePrefix = memory.date.slice(0, 10) || "memory";
  return `${datePrefix}-${slugifyMemoryTitle(memory.title)}.md`;
}

function trimTextToTokenBudget(text: string, budget: number): string {
  if (budget <= 0 || approximateTokens(text) <= budget) {
    return text;
  }

  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let used = 0;

  for (const line of lines) {
    const nextLine = kept.length === 0 ? line : `\n${line}`;
    const cost = approximateTokens(nextLine);
    if (kept.length > 0 && used + cost > budget) {
      break;
    }

    kept.push(line);
    used += cost;
  }

  const joined = kept.join("\n").trim();
  if (joined && approximateTokens(`${joined}\n\n[truncated]`) <= budget) {
    return `${joined}\n\n[truncated]`;
  }

  return joined || text.slice(0, Math.max(32, budget * 4)).trim();
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

function normalizeComparableFileName(value: string): string {
  return value.replace(/\\/g, "/").trim().toLowerCase();
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function asFailureKind(value: unknown): FailureEvent["kind"] | null {
  return value === "violated_memory" || value === "new_failure" ? value : null;
}

function asSuggestedAction(value: unknown): FailureEvent["suggestedAction"] | null {
  return value === "boost_score" || value === "rewrite_memory" || value === "extract_new" ? value : null;
}
