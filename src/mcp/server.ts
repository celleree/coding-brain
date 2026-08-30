#!/usr/bin/env node

import { stdin as input, stdout as output, stderr } from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "../config.js";
import { buildConversationStart } from "../conversation-start.js";
import { evaluateExtractWorthiness } from "../extract-suggestion.js";
import { extractMemories } from "../extract.js";
import { buildInjection } from "../inject.js";
import { loadSchemaValidatedMemoryRecords } from "../memory-schema.js";
import { reviewCandidateMemory, reviewCandidateMemories } from "../reviewer.js";
import { renderSearchResultsJson, searchMemories } from "../search.js";
import { getSteeringRulesStatus } from "../steering-rules.js";
import { buildSkillShortlist, resolveSuggestedSkillPaths } from "../suggest-skills.js";
import { scanSweepCandidates } from "../sweep.js";
import { buildTaskRoutingBundle } from "../task-routing.js";
import {
  approveCandidateMemory,
  getMemoryStatus,
  initBrain,
  loadActivityState,
  loadAllMemories,
  loadStoredMemoryRecords,
  saveMemory,
  updateIndex,
} from "../store.js";
import type { Memory } from "../types.js";
import {
  applyExtractedMemoryDefaults,
  buildCaptureExtractionInput,
  buildWorkflowSnapshot,
  formatMemoryListLine,
  getCandidateRecords,
  resolveCandidateRecords,
  resolveSafeCandidateRecords,
} from "../commands/helpers.js";

const SERVER_INFO = {
  name: "repobrain",
  version: "0.1.0",
};

const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

const TOOLS: ToolDefinition[] = [
  {
    name: "brain_get_context",
    title: "Get Repo Context",
    description: "Build RepoBrain session context from .brain memories.",
    inputSchema: {
      type: "object",
      properties: {
        maxTokens: {
          type: "integer",
          minimum: 1,
          description: "Optional override for the injection token budget.",
        },
        task: {
          type: "string",
          description: "Optional task description for task-aware memory selection.",
        },
        paths: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional target paths for task-aware memory selection.",
        },
        modules: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional module or subsystem keywords for task-aware memory selection.",
        },
      },
    },
    annotations: {
      title: "Get Repo Context",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "brain_add_memory",
    title: "Add Repo Memory",
    description: "Save a new decision, gotcha, convention, pattern, working memory, or goal into .brain.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["decision", "gotcha", "convention", "pattern", "working", "goal"],
        },
        title: {
          type: "string",
          minLength: 1,
        },
        content: {
          type: "string",
          minLength: 1,
        },
        importance: {
          type: "string",
          enum: ["high", "medium", "low"],
        },
      },
      required: ["type", "title", "content"],
    },
    annotations: {
      title: "Add Repo Memory",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "brain_search",
    title: "Search Memories",
    description: "Search memories by keywords with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "Keywords to search with AND semantics.",
        },
        type: {
          type: "string",
          enum: ["decision", "gotcha", "convention", "pattern", "working", "goal"],
          description: "Optional memory type filter.",
        },
        tag: {
          type: "string",
          description: "Optional exact tag filter.",
        },
        status: {
          type: "string",
          enum: ["active", "candidate", "done", "stale", "superseded"],
          description: "Optional memory status filter.",
        },
        all: {
          type: "boolean",
          description: "Include memories of all statuses.",
        },
      },
      required: ["query"],
    },
    annotations: {
      title: "Search Memories",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "brain_suggest_skills",
    title: "Suggest Skills",
    description: "Build deterministic invocation plan from task and optional paths.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          minLength: 1,
          description: "Task description used for skill routing.",
        },
        paths: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional target paths. If omitted, MCP uses git diff when available.",
        },
      },
      required: ["task"],
    },
    annotations: {
      title: "Suggest Skills",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "brain_route",
    title: "Route Task",
    description: "Build combined context + skill plan bundle for a task.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          minLength: 1,
          description: "Task description to route.",
        },
        paths: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional target paths. If omitted, MCP uses git diff when available.",
        },
      },
      required: ["task"],
    },
    annotations: {
      title: "Route Task",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "brain_capture",
    title: "Capture Memories",
    description: "Run detect+extract flow and save candidate memories when recommended.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Optional current task description.",
        },
        summary: {
          type: "string",
          description: "Optional session summary text used for extraction.",
        },
        paths: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional target paths. If omitted, MCP uses git diff when available.",
        },
        forceCandidate: {
          type: "boolean",
          description: "Force save as candidate even when extraction signals are ambiguous.",
        },
        type: {
          type: "string",
          enum: ["decision", "gotcha", "convention", "pattern", "working", "goal"],
          description: "Optional forced memory type for extracted entries.",
        },
      },
    },
    annotations: {
      title: "Capture Memories",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "brain_sweep",
    title: "Sweep Preview",
    description: "Preview cleanup candidates (dry-run only, no writes).",
    inputSchema: {
      type: "object",
    },
    annotations: {
      title: "Sweep Preview",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "brain_review",
    title: "Review Candidates",
    description: "List candidate memories waiting for manual review.",
    inputSchema: {
      type: "object",
    },
    annotations: {
      title: "Review Candidates",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "brain_approve",
    title: "Approve Candidates",
    description: "Approve one, safe, or all candidate memories.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: {
          type: "string",
          description: "Candidate memory id/path/title query.",
        },
        safe: {
          type: "boolean",
          description: "Approve only low-risk novel candidates.",
        },
        all: {
          type: "boolean",
          description: "Approve all matching candidate memories.",
        },
      },
    },
    annotations: {
      title: "Approve Candidates",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "brain_list",
    title: "List Memories",
    description: "List memories with optional type filter.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["decision", "gotcha", "convention", "pattern", "working", "goal"],
          description: "Optional memory type filter.",
        },
      },
    },
    annotations: {
      title: "List Memories",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "brain_conversation_start",
    title: "Conversation Start",
    description: "Smart refresh decision for a new conversation in the same session.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Optional current task description.",
        },
        paths: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional target paths for task-aware refresh decisions.",
        },
        modules: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional module or subsystem keywords for task-aware refresh decisions.",
        },
        force: {
          type: "boolean",
          description: "Force a refresh instead of allowing a redundant skip.",
        },
        refreshMode: {
          type: "string",
          enum: ["always", "task-change", "smart"],
          description: 'Refresh mode: "always", "task-change", or "smart".',
        },
      },
    },
    annotations: {
      title: "Conversation Start",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "brain_status",
    title: "Repo Status",
    description: "Show workflow state, reminders, and recent activity snapshot.",
    inputSchema: {
      type: "object",
    },
    annotations: {
      title: "Repo Status",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

export async function runMcpServer(projectRoot: string = process.cwd()): Promise<void> {
  const parser = new StdioMessageParser(async (message) => {
    const request = safeParseRequest(message);
    if (!request) {
      return;
    }

    try {
      const result = await handleRequest(request, projectRoot);
      if (request.id !== undefined && request.id !== null && result !== undefined) {
        writeResponse({ jsonrpc: "2.0", id: request.id, result });
      }
    } catch (error) {
      if (request.id !== undefined && request.id !== null) {
        writeResponse({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } else {
        debugLog(error instanceof Error ? error.message : String(error));
      }
    }
  });

  for await (const chunk of input) {
    parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
}

async function handleRequest(
  request: JsonRpcRequest,
  projectRoot: string,
): Promise<Record<string, unknown> | undefined> {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
        instructions:
          "Use brain_get_context to load repo memory before coding. Use brain_add_memory to save durable decisions, gotchas, conventions, patterns, working memories, or goals back into .brain.",
      };
    case "notifications/initialized":
      return undefined;
    case "tools/list":
      return {
        tools: TOOLS,
      };
    case "tools/call":
      return callTool(request.params ?? {}, projectRoot);
    case "ping":
      return {};
    default:
      throw new Error(`Unsupported MCP method: ${request.method}`);
  }
}

async function callTool(params: Record<string, unknown>, projectRoot: string): Promise<Record<string, unknown>> {
  const name = typeof params.name === "string" ? params.name : "";
  const args = isPlainObject(params.arguments) ? params.arguments : {};

  switch (name) {
    case "brain_get_context":
      return handleGetContext(args, projectRoot);
    case "brain_add_memory":
      return handleAddMemory(args, projectRoot);
    case "brain_search":
      return handleSearch(args, projectRoot);
    case "brain_suggest_skills":
      return handleSuggestSkills(args, projectRoot);
    case "brain_route":
      return handleRoute(args, projectRoot);
    case "brain_capture":
      return handleCapture(args, projectRoot);
    case "brain_sweep":
      return handleSweep(projectRoot);
    case "brain_review":
      return handleReview(projectRoot);
    case "brain_approve":
      return handleApprove(args, projectRoot);
    case "brain_list":
      return handleList(args, projectRoot);
    case "brain_conversation_start":
      return handleConversationStart(args, projectRoot);
    case "brain_status":
      return handleStatus(projectRoot);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleGetContext(args: Record<string, unknown>, projectRoot: string): Promise<Record<string, unknown>> {
  const config = await loadConfig(projectRoot);
  const maxTokens = normalizePositiveInteger(args.maxTokens);
  const task = typeof args.task === "string" && args.task.trim() ? args.task.trim() : undefined;
  const paths = asOptionalStringArray(args.paths, "paths");
  const modules = asOptionalStringArray(args.modules, "modules");
  const injection = await buildInjection(
    projectRoot,
    {
      ...config,
      ...(maxTokens ? { maxInjectTokens: maxTokens } : {}),
    },
    {
      ...(task ? { task } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      ...(modules.length > 0 ? { modules } : {}),
    },
  );

  return {
    content: [
      {
        type: "text",
        text: injection,
      },
    ],
    structuredContent: {
      markdown: injection,
    },
  };
}

async function handleAddMemory(args: Record<string, unknown>, projectRoot: string): Promise<Record<string, unknown>> {
  const type = asRequiredEnum(args.type, ["decision", "gotcha", "convention", "pattern", "working", "goal"], "type");
  const title = asRequiredString(args.title, "title");
  const content = asRequiredString(args.content, "content");
  const importance = asEnum(args.importance, ["high", "medium", "low"]) ?? "medium";

  await initBrain(projectRoot);
  const now = new Date().toISOString();

  const memory: Memory = {
    type,
    title,
    summary: title,
    detail: `## ${type.toUpperCase()}\n\n${content}`,
    tags: deriveTagsFromText(`${title}\n${content}`),
    importance,
    date: now,
    score: 60,
    hit_count: 0,
    last_used: null,
    created_at: now,
    stale: false,
    source: "manual",
    status: "active",
  };

  const filePath = await saveMemory(memory, projectRoot, { sourceBytes: Buffer.from(content, "utf8") });
  await updateIndex(projectRoot);

  return {
    content: [
      {
        type: "text",
        text: `Saved ${type} memory to ${path.relative(projectRoot, filePath).replace(/\\/g, "/")}`,
      },
    ],
    structuredContent: {
      success: true,
      filePath,
    },
  };
}

async function handleSearch(args: Record<string, unknown>, projectRoot: string): Promise<Record<string, unknown>> {
  const query = asRequiredString(args.query, "query");
  const type = asEnum(args.type, ["decision", "gotcha", "convention", "pattern", "working", "goal"]);
  if (args.type !== undefined && !type) {
    throw new Error('Tool argument "type" must be one of: decision, gotcha, convention, pattern, working, goal.');
  }
  const status = asEnum(args.status, ["active", "candidate", "done", "stale", "superseded"]);
  if (args.status !== undefined && !status) {
    throw new Error('Tool argument "status" must be one of: active, candidate, done, stale, superseded.');
  }

  const tag = asOptionalString(args.tag, "tag");
  const all = asOptionalBoolean(args.all, "all");
  const records = await loadStoredMemoryRecords(projectRoot);
  const results = searchMemories(records, query, {
    ...(type ? { type } : {}),
    ...(tag ? { tag } : {}),
    ...(status ? { status } : {}),
    ...(all !== undefined ? { all } : {}),
  });

  return {
    content: [
      {
        type: "text",
        text: results.length === 0 ? "No matching memories found." : `Found ${results.length} matching memories.`,
      },
    ],
    structuredContent: {
      count: results.length,
      results: renderSearchResultsJson(results),
    },
  };
}

async function handleSuggestSkills(
  args: Record<string, unknown>,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const task = asRequiredString(args.task, "task");
  const explicitPaths = asOptionalStringArray(args.paths, "paths");
  const resolvedPaths = resolveSuggestedSkillPaths(projectRoot, explicitPaths);
  const result = await buildSkillShortlist(projectRoot, {
    task,
    paths: resolvedPaths.paths,
    path_source: resolvedPaths.path_source,
  });

  return {
    content: [
      {
        type: "text",
        text: `Built invocation plan (${result.invocation_plan.required.length} required, ${result.invocation_plan.prefer_first.length} prefer-first).`,
      },
    ],
    structuredContent: {
      ...result,
      warnings: resolvedPaths.warnings,
    },
  };
}

async function handleRoute(args: Record<string, unknown>, projectRoot: string): Promise<Record<string, unknown>> {
  const task = asRequiredString(args.task, "task");
  const explicitPaths = asOptionalStringArray(args.paths, "paths");
  const resolvedPaths = resolveSuggestedSkillPaths(projectRoot, explicitPaths);
  const config = await loadConfig(projectRoot);
  const bundle = await buildTaskRoutingBundle(projectRoot, config, {
    task,
    paths: resolvedPaths.paths,
    path_source: resolvedPaths.path_source,
    warnings: resolvedPaths.warnings,
  });

  return {
    content: [
      {
        type: "text",
        text: `Built routing bundle with display_mode=${bundle.display_mode}.`,
      },
    ],
    structuredContent: bundle,
  };
}

async function handleSweep(projectRoot: string): Promise<Record<string, unknown>> {
  const config = await loadConfig(projectRoot);
  const result = await scanSweepCandidates(projectRoot, config);

  return {
    content: [
      {
        type: "text",
        text:
          `Sweep preview: ${result.expiredWorking.length} expired working, ` +
          `${result.staleMemories.length} stale, ${result.duplicatePairs.length} duplicate pairs, ` +
          `${result.archiveGoals.length} archive-ready goals.`,
      },
    ],
    structuredContent: {
      dry_run: true,
      expired_working: result.expiredWorking.map((entry) => ({
        relative_path: entry.record.relativePath.replace(/\\/g, "/"),
        title: entry.record.memory.title,
        expires: entry.expires,
      })),
      stale_memories: result.staleMemories.map((entry) => ({
        relative_path: entry.record.relativePath.replace(/\\/g, "/"),
        title: entry.record.memory.title,
        importance: entry.record.memory.importance,
        days_since_updated: entry.daysSinceUpdated,
        stale_days: entry.staleDays,
        next_importance: entry.nextImportance,
      })),
      duplicate_pairs: result.duplicatePairs.map((entry) => ({
        left: {
          relative_path: entry.left.relativePath.replace(/\\/g, "/"),
          title: entry.left.memory.title,
        },
        right: {
          relative_path: entry.right.relativePath.replace(/\\/g, "/"),
          title: entry.right.memory.title,
        },
        similarity: entry.similarity,
      })),
      archive_goals: result.archiveGoals.map((entry) => ({
        relative_path: entry.record.relativePath.replace(/\\/g, "/"),
        title: entry.record.memory.title,
        updated: entry.updated,
        days_since_updated: entry.daysSinceUpdated,
      })),
    },
  };
}

async function handleCapture(args: Record<string, unknown>, projectRoot: string): Promise<Record<string, unknown>> {
  await initBrain(projectRoot);

  const task = asOptionalString(args.task, "task");
  const summary = asOptionalString(args.summary, "summary");
  const paths = resolveSuggestedSkillPaths(projectRoot, asOptionalStringArray(args.paths, "paths")).paths;
  const forceCandidate = asOptionalBoolean(args.forceCandidate, "forceCandidate") ?? false;
  const forcedType = asEnum(args.type, ["decision", "gotcha", "convention", "pattern", "working", "goal"]);
  if (args.type !== undefined && !forcedType) {
    throw new Error('Tool argument "type" must be one of: decision, gotcha, convention, pattern, working, goal.');
  }
  const suggestion = evaluateExtractWorthiness({
    ...(task ? { task } : {}),
    ...(summary ? { sessionSummary: summary } : {}),
    changedFiles: paths,
    source: "session",
  });
  const shouldProceed = suggestion.should_extract || forceCandidate;
  if (!shouldProceed) {
    return {
      content: [
        {
          type: "text",
          text: `Capture skipped: ${suggestion.summary}`,
        },
      ],
      structuredContent: {
        action: "skipped",
        reason: suggestion.summary,
        suggestion,
        saved_paths: [],
      },
    };
  }

  const config = await loadConfig(projectRoot);
  const rawInput = buildCaptureExtractionInput(task, summary, {}, paths, undefined);
  const extracted = await extractMemories(rawInput, config, projectRoot);
  const memories = extracted.map((memory) => applyExtractedMemoryDefaults(memory, forcedType ?? undefined));
  const existingRecords = await loadStoredMemoryRecords(projectRoot);
  const reviewedCandidates = reviewCandidateMemories(memories, existingRecords);
  const savedPaths: string[] = [];

  for (const entry of reviewedCandidates) {
    if (entry.review.decision === "reject") {
      continue;
    }
    const toSave: Memory = {
      ...entry.memory,
      status: "candidate",
      source: "session",
    };
    const savedPath = await saveMemory(toSave, projectRoot, { sourceBytes: Buffer.from(rawInput, "utf8") });
    savedPaths.push(savedPath);
  }

  await updateIndex(projectRoot);

  return {
    content: [
      {
        type: "text",
        text:
          savedPaths.length > 0
            ? `Saved ${savedPaths.length} candidate memor${savedPaths.length === 1 ? "y" : "ies"}.`
            : "Capture suggested extraction but no memories were saved.",
      },
    ],
    structuredContent: {
      action: savedPaths.length > 0 ? "saved_as_candidate" : "extraction_empty",
      reason: suggestion.summary,
      suggestion,
      force_candidate: forceCandidate,
      ...(forcedType ? { forced_type: forcedType } : {}),
      saved_paths: savedPaths,
      review: reviewedCandidates.map((entry) => ({
        title: entry.memory.title,
        decision: entry.review.decision,
        reason: entry.review.reason,
        target_memory_ids: entry.review.target_memory_ids,
      })),
    },
  };
}

async function handleConversationStart(
  args: Record<string, unknown>,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const task = asOptionalString(args.task, "task");
  const paths = asOptionalStringArray(args.paths, "paths");
  const modules = asOptionalStringArray(args.modules, "modules");
  const force = asOptionalBoolean(args.force, "force") ?? false;
  const refreshMode = asEnum(args.refreshMode, ["always", "task-change", "smart"]);
  if (args.refreshMode !== undefined && !refreshMode) {
    throw new Error('Tool argument "refreshMode" must be one of: always, task-change, smart.');
  }

  const config = await loadConfig(projectRoot);
  const result = await buildConversationStart(projectRoot, config, {
    ...(task ? { task } : {}),
    paths,
    modules,
    forceRefresh: force,
    ...(refreshMode ? { refreshMode } : {}),
  });

  return {
    content: [
      {
        type: "text",
        text: `Conversation start action=${result.action}: ${result.reason}`,
      },
    ],
    structuredContent:
      result.action === "skip"
        ? {
            contract_version: result.contract_version,
            action: result.action,
            reason: result.reason,
            refresh_mode: result.refresh_mode,
            decision_trace: result.decision_trace,
          }
        : result,
  };
}

async function handleReview(projectRoot: string): Promise<Record<string, unknown>> {
  const records = await loadStoredMemoryRecords(projectRoot);
  const candidates = getCandidateRecords(records);
  const items = candidates.map((entry) => {
    const review = reviewCandidateMemory(
      entry.memory,
      records.filter((record) => record.filePath !== entry.filePath),
    );
    return {
      id: path.basename(entry.filePath, path.extname(entry.filePath)),
      title: entry.memory.title,
      type: entry.memory.type,
      importance: entry.memory.importance,
      status: entry.memory.status ?? "candidate",
      safe: review.decision === "accept" && review.reason === "novel_memory",
      review,
    };
  });

  return {
    content: [
      {
        type: "text",
        text: items.length === 0 ? "No candidate memories waiting for review." : `Candidate memories: ${items.length}.`,
      },
    ],
    structuredContent: {
      candidates: items,
      count: items.length,
    },
  };
}

async function handleApprove(args: Record<string, unknown>, projectRoot: string): Promise<Record<string, unknown>> {
  const memoryId = asOptionalString(args.memoryId, "memoryId");
  const safe = asOptionalBoolean(args.safe, "safe") ?? false;
  const all = asOptionalBoolean(args.all, "all") ?? false;
  const records = await loadStoredMemoryRecords(projectRoot);
  const resolution = safe
    ? resolveSafeCandidateRecords(records, memoryId, all)
    : {
        matches: resolveCandidateRecords(records, memoryId, all),
        skipped: [],
      };

  for (const entry of resolution.matches) {
    await approveCandidateMemory(entry, projectRoot);
  }
  if (resolution.matches.length > 0) {
    await updateIndex(projectRoot);
  }

  return {
    content: [
      {
        type: "text",
        text: `Approved ${resolution.matches.length} ${safe ? "safe " : ""}candidate memor${resolution.matches.length === 1 ? "y" : "ies"}.`,
      },
    ],
    structuredContent: {
      approved_count: resolution.matches.length,
      approved: resolution.matches.map((entry) => ({
        id: path.basename(entry.filePath, path.extname(entry.filePath)),
        title: entry.memory.title,
      })),
      skipped_count: resolution.skipped.length,
      skipped: resolution.skipped.map((entry) => ({
        id: path.basename(entry.record.filePath, path.extname(entry.record.filePath)),
        title: entry.record.memory.title,
        reason: entry.review.reason,
      })),
    },
  };
}

async function handleList(args: Record<string, unknown>, projectRoot: string): Promise<Record<string, unknown>> {
  const memoryType = asEnum(args.type, ["decision", "gotcha", "convention", "pattern", "working", "goal"]);
  if (args.type !== undefined && !memoryType) {
    throw new Error('Tool argument "type" must be one of: decision, gotcha, convention, pattern, working, goal.');
  }
  const memories = await loadAllMemories(projectRoot);
  const filtered = memoryType ? memories.filter((memory) => memory.type === memoryType) : memories;
  return {
    content: [
      {
        type: "text",
        text:
          filtered.length === 0
            ? "No memories found."
            : `Listed ${filtered.length} memor${filtered.length === 1 ? "y" : "ies"}.`,
      },
    ],
    structuredContent: {
      memories: filtered.map((memory) => ({
        ...memory,
        status: getMemoryStatus(memory),
        line: formatMemoryListLine(memory),
      })),
      count: filtered.length,
    },
  };
}

async function handleStatus(projectRoot: string): Promise<Record<string, unknown>> {
  const [{ records, schema }, activity, steeringRules, config] = await Promise.all([
    loadSchemaValidatedMemoryRecords(projectRoot),
    loadActivityState(projectRoot),
    getSteeringRulesStatus(projectRoot),
    loadConfig(projectRoot),
  ]);
  const memories = records.map((entry) => entry.memory);
  const snapshot = await buildWorkflowSnapshot(projectRoot, config, memories);
  const recentCapturedMemories = memories.slice(0, 5);

  return {
    content: [
      {
        type: "text",
        text: `Workflow ${snapshot.workflow.mode}; ${snapshot.candidateCount} candidate memor${snapshot.candidateCount === 1 ? "y" : "ies"} pending review.`,
      },
    ],
    structuredContent: {
      project_root: projectRoot,
      workflow: snapshot.workflow,
      trigger_mode: config.triggerMode,
      capture_mode: config.captureMode,
      auto_approve_safe_candidates: config.autoApproveSafeCandidates,
      total_memories: memories.length,
      pending_review: snapshot.candidateCount,
      pending_reinforce: snapshot.pendingReinforceCount,
      pending_cleanup: snapshot.cleanupCount,
      last_updated: memories[0]?.date ?? null,
      last_injected: activity.lastInjectedAt ?? null,
      steering_rules: steeringRules,
      schema_summary: schema.summary,
      reminders: snapshot.reminders,
      next_steps: snapshot.nextSteps,
      recent_loaded_memories: activity.recentLoadedMemories,
      recent_captured_memories: recentCapturedMemories,
    },
  };
}

function deriveTagsFromText(text: string): string[] {
  const matches = text.match(/[A-Za-z][A-Za-z0-9/_-]{2,}/g) ?? [];
  return Array.from(new Set(matches.map((tag) => tag.toLowerCase()))).slice(0, 5);
}

function asRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tool argument "${fieldName}" must be a non-empty string.`);
  }

  return value.trim();
}

function asOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Tool argument "${fieldName}" must be a string.`);
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function asEnum<T extends string>(value: unknown, allowed: T[]): T | null {
  if (typeof value !== "string") {
    return null;
  }

  return allowed.includes(value as T) ? (value as T) : null;
}

function asRequiredEnum<T extends string>(value: unknown, allowed: T[], fieldName: string): T {
  const normalized = asEnum(value, allowed);
  if (!normalized) {
    throw new Error(`Tool argument "${fieldName}" must be one of: ${allowed.join(", ")}.`);
  }

  return normalized;
}

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }

  return value;
}

function asOptionalStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Tool argument "${fieldName}" must be an array of strings.`);
  }

  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  if (normalized.length !== value.length) {
    throw new Error(`Tool argument "${fieldName}" must be an array of strings.`);
  }

  return normalized;
}

function asOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Tool argument "${fieldName}" must be a boolean.`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeParseRequest(value: string): JsonRpcRequest | null {
  try {
    const parsed = JSON.parse(value) as JsonRpcRequest;
    if (!parsed || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
      debugLog(`Ignoring invalid MCP message: ${value.slice(0, 200)}`);
      return null;
    }

    return parsed;
  } catch (error) {
    debugLog(error instanceof Error ? error.message : String(error));
    return null;
  }
}

function writeResponse(payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  output.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function debugLog(message: string): void {
  if (process.env.PROJECT_BRAIN_VERBOSE === "1") {
    stderr.write(`[repobrain:mcp] ${message}\n`);
  }
}

class StdioMessageParser {
  private buffer = Buffer.alloc(0);

  constructor(private readonly onMessage: (message: string) => Promise<void>) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    void this.flush();
  }

  private async flush(): Promise<void> {
    while (true) {
      const separatorIndex = this.buffer.indexOf("\r\n\r\n");
      if (separatorIndex === -1) {
        return;
      }

      const headerText = this.buffer.slice(0, separatorIndex).toString("utf8");
      const contentLength = parseContentLength(headerText);
      if (contentLength === null) {
        this.buffer = Buffer.alloc(0);
        throw new Error("Missing Content-Length header.");
      }

      const messageStart = separatorIndex + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) {
        return;
      }

      const message = this.buffer.slice(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.slice(messageEnd);
      await this.onMessage(message);
    }
  }
}

function parseContentLength(headerText: string): number | null {
  const lines = headerText.split("\r\n");
  for (const line of lines) {
    const match = line.match(/^Content-Length:\s*(\d+)$/i);
    if (!match) {
      continue;
    }

    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  return null;
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryUrl && import.meta.url === entryUrl) {
  runMcpServer().catch((error: unknown) => {
    debugLog(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
