import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { expect, it } from "vitest";

import { initBrain, loadStoredMemoryRecords } from "../dist/store-api.js";
import { saveMemory } from "./provenance-fixtures.mjs";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "cli.js");

await runTest("tools/list includes search, sweep, and conversation_start tools", async () => {
  await withTempRepo(async (projectRoot) => {
    const client = createMcpClient(projectRoot);
    try {
      await initializeClient(client);
      const listed = await client.call("tools/list", {});
      const toolNames = listed.tools.map((tool) => tool.name);

      for (const name of ["brain_search", "brain_sweep", "brain_conversation_start"]) {
        assert.ok(toolNames.includes(name), `Expected tool ${name} in tools/list`);
      }
    } finally {
      await client.close();
    }
  });
});

await runTest("brain_search returns matching memories", async () => {
  await withTempRepo(async (projectRoot) => {
    const now = new Date().toISOString();
    await saveMemory(
      {
        type: "decision",
        title: "Keep validation at the controller boundary",
        summary: "Validation memory for MCP search.",
        detail: "## DECISION\n\nValidation should happen before business logic.",
        tags: ["validation", "controller"],
        importance: "medium",
        date: now,
        score: 60,
        hit_count: 0,
        last_used: null,
        created_at: now,
        stale: false,
        status: "active",
        source: "manual",
      },
      projectRoot,
    );

    const client = createMcpClient(projectRoot);
    try {
      await initializeClient(client);
      const search = await client.callTool("brain_search", { query: "validation" });

      assert.ok(search.structuredContent.count >= 1);
      assert.ok(search.structuredContent.results.some((entry) => entry.title.includes("validation")));
    } finally {
      await client.close();
    }
  });
});

await runTest("brain_search with empty query returns error or empty", async () => {
  await withTempRepo(async (projectRoot) => {
    const client = createMcpClient(projectRoot);
    try {
      await initializeClient(client);

      let behavior = "empty";
      try {
        const search = await client.callTool("brain_search", { query: "" });
        assert.equal(search.structuredContent.count ?? 0, 0);
      } catch (error) {
        behavior = "error";
        assert.match(String(error), /query|non-empty string/i);
      }

      assert.ok(behavior === "error" || behavior === "empty");
    } finally {
      await client.close();
    }
  });
});

await runTest("brain_sweep returns dry-run cleanup preview", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "working",
        title: "Expired validation checklist",
        summary: "Expired working memory for MCP sweep preview.",
        detail: "## WORKING\n\nCleanup after validation migration.",
        tags: ["validation", "cleanup"],
        importance: "medium",
        date: "2026-01-01T09:00:00.000Z",
        score: 50,
        hit_count: 0,
        last_used: null,
        created_at: "2026-01-01",
        updated: "2026-01-01",
        stale: false,
        status: "active",
        source: "manual",
        expires: "2026-01-02",
      },
      projectRoot,
    );

    const client = createMcpClient(projectRoot);
    try {
      await initializeClient(client);
      const sweep = await client.callTool("brain_sweep", {});

      assert.equal(sweep.structuredContent.dry_run, true);
      assert.ok(sweep.structuredContent.expired_working.length > 0);
    } finally {
      await client.close();
    }
  });
});

await runTest("brain_conversation_start returns start action for first conversation", async () => {
  await withTempRepo(async (projectRoot) => {
    const client = createMcpClient(projectRoot);
    try {
      await initializeClient(client);
      const result = await client.callTool("brain_conversation_start", { task: "test task" });

      assert.ok(result.structuredContent.action === "start" || result.structuredContent.action === "inject");
    } finally {
      await client.close();
    }
  });
});

await runTest("brain_conversation_start returns skip when context is fresh", async () => {
  await withTempRepo(async (projectRoot) => {
    const client = createMcpClient(projectRoot);
    try {
      await initializeClient(client);
      await client.callTool("brain_get_context", { task: "same task" });
      const result = await client.callTool("brain_conversation_start", { task: "same task" });

      assert.equal(result.structuredContent.action, "skip");
    } finally {
      await client.close();
    }
  });
});

await runTest("mcp server exposes and serves the expanded toolset", async () => {
  await withTempRepo(async (projectRoot) => {
    await initBrain(projectRoot);
    const now = new Date().toISOString();
    await saveMemory(
      {
        type: "decision",
        title: "Route browser testing through Playwright",
        summary: "Prefer Playwright tooling for browser test debugging.",
        detail: "## DECISION\n\nUse Playwright guidance first for browser test related tasks.",
        tags: ["playwright", "testing"],
        importance: "medium",
        date: now,
        score: 60,
        hit_count: 0,
        last_used: null,
        created_at: now,
        stale: false,
        status: "active",
        source: "manual",
        skill_trigger_tasks: ["debug flaky browser tests"],
        recommended_skills: ["playwright"],
      },
      projectRoot,
    );
    await saveMemory(
      {
        type: "gotcha",
        title: "Candidate memory pending review",
        summary: "A pending candidate should show in review output.",
        detail: "## GOTCHA\n\nPending candidate detail.",
        tags: ["candidate"],
        importance: "medium",
        date: now,
        score: 60,
        hit_count: 0,
        last_used: null,
        created_at: now,
        stale: false,
        status: "candidate",
        source: "session",
      },
      projectRoot,
    );
    const client = createMcpClient(projectRoot);
    try {
      const initialize = await client.call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "repobrain-test", version: "0.0.0" },
      });
      assert.equal(initialize.protocolVersion, "2025-06-18");

      const listed = await client.call("tools/list", {});
      const toolNames = listed.tools.map((tool) => tool.name);
      for (const name of [
        "brain_get_context",
        "brain_add_memory",
        "brain_search",
        "brain_suggest_skills",
        "brain_route",
        "brain_capture",
        "brain_sweep",
        "brain_review",
        "brain_approve",
        "brain_list",
        "brain_conversation_start",
        "brain_status",
      ]) {
        assert.ok(toolNames.includes(name), `Expected tool ${name} in tools/list`);
      }

      const search = await client.callTool("brain_search", {
        query: "playwright browser",
        type: "decision",
      });
      assert.equal(search.structuredContent.count, 1);
      assert.equal(search.structuredContent.results[0].title, "Route browser testing through Playwright");

      const conversationStart = await client.callTool("brain_conversation_start", {
        task: "debug flaky browser tests",
        paths: ["tests/e2e/login.spec.ts"],
        refreshMode: "smart",
      });
      assert.equal(conversationStart.structuredContent.action, "start");
      assert.ok(typeof conversationStart.structuredContent.context_markdown === "string");

      const conversationSkip = await client.callTool("brain_conversation_start", {
        task: "debug flaky browser tests",
        paths: ["tests/e2e/login.spec.ts"],
        refreshMode: "smart",
      });
      assert.equal(conversationSkip.structuredContent.action, "skip");
      assert.ok(!("context_markdown" in conversationSkip.structuredContent));
      assert.ok(typeof conversationSkip.structuredContent.reason === "string");
      assert.ok(conversationSkip.structuredContent.decision_trace);

      const shortlist = await client.callTool("brain_suggest_skills", {
        task: "debug flaky browser tests",
        paths: ["tests/e2e/login.spec.ts"],
      });
      assert.ok(shortlist.structuredContent?.invocation_plan);

      const route = await client.callTool("brain_route", {
        task: "debug flaky browser tests",
        paths: ["tests/e2e/login.spec.ts"],
      });
      assert.ok(route.structuredContent?.context_markdown);
      assert.ok(route.structuredContent?.skill_plan);

      const reviewBefore = await client.callTool("brain_review", {});
      assert.equal(reviewBefore.structuredContent.count, 1);

      const firstCandidate = reviewBefore.structuredContent.candidates[0];
      assert.ok(firstCandidate?.id);
      await client.callTool("brain_approve", { memoryId: firstCandidate.id });

      const reviewAfter = await client.callTool("brain_review", {});
      assert.equal(reviewAfter.structuredContent.count, 0);

      const list = await client.callTool("brain_list", { type: "decision" });
      assert.ok(list.structuredContent.count >= 1);

      await saveMemory(
        {
          type: "working",
          title: "Temporary request cleanup checklist",
          summary: "Working memory that should expire in sweep preview.",
          detail: "## WORKING\n\nTemporary checklist.",
          tags: ["cleanup"],
          importance: "medium",
          date: "2026-01-01T09:00:00.000Z",
          score: 50,
          hit_count: 0,
          last_used: null,
          created_at: "2026-01-01",
          updated: "2026-01-01",
          stale: false,
          status: "active",
          source: "manual",
          expires: "2026-01-02",
        },
        projectRoot,
      );
      await saveMemory(
        {
          type: "goal",
          title: "Finish legacy migration",
          summary: "A completed goal old enough to archive.",
          detail: "## GOAL\n\nFinished migration.",
          tags: ["migration"],
          importance: "medium",
          date: "2026-01-15T09:00:00.000Z",
          score: 60,
          hit_count: 0,
          last_used: null,
          created_at: "2026-01-15",
          updated: "2026-01-15",
          stale: false,
          status: "done",
          source: "manual",
        },
        projectRoot,
      );
      const indexBeforeSweep = await readFile(path.join(projectRoot, ".brain", "index.md"), "utf8");
      const sweep = await client.callTool("brain_sweep", {});
      assert.equal(sweep.structuredContent.dry_run, true);
      assert.ok(sweep.structuredContent.expired_working.length >= 1);
      assert.ok(sweep.structuredContent.archive_goals.length >= 1);
      const indexAfterSweep = await readFile(path.join(projectRoot, ".brain", "index.md"), "utf8");
      assert.equal(indexAfterSweep, indexBeforeSweep);

      const status = await client.callTool("brain_status", {});
      assert.ok(typeof status.structuredContent.total_memories === "number");

      const capture = await client.callTool("brain_capture", {
        task: "decided to route browser tests through playwright because flaky tests keep failing",
        summary:
          "decision: route browser tests through playwright because it reduces flaky retries and keeps CI behavior consistent",
        paths: ["tests/e2e/login.spec.ts"],
      });
      assert.ok(capture.structuredContent?.suggestion);
      assert.equal(capture.structuredContent?.force_candidate, false);

      const forcedCapture = await client.callTool("brain_capture", {
        task: "update notes",
        summary: "small update with helper wording",
        paths: ["src/notes.ts"],
        forceCandidate: true,
        type: "working",
      });
      assert.equal(forcedCapture.structuredContent?.force_candidate, true);
      assert.equal(forcedCapture.structuredContent?.forced_type, "working");

      const records = await loadStoredMemoryRecords(projectRoot);
      assert.ok(records.length >= 2);
      assert.ok(records.some((entry) => entry.memory.type === "working" && entry.memory.status === "candidate"));
    } finally {
      await client.close();
    }
  });
});

function createMcpClient(cwd) {
  // Run through CLI command so stdio server is started reliably.
  // Direct dist/mcp/server.js is currently a module-style entrypoint export.
  const viaCli = spawn(process.execPath, [cliPath, "mcp"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();

  viaCli.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (true) {
      const sep = buffer.indexOf("\r\n\r\n");
      if (sep === -1) {
        break;
      }
      const headerText = buffer.slice(0, sep).toString("utf8");
      const contentLengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        break;
      }
      const contentLength = Number(contentLengthMatch[1]);
      const bodyStart = sep + 4;
      const bodyEnd = bodyStart + contentLength;
      if (buffer.length < bodyEnd) {
        break;
      }
      const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
      buffer = buffer.slice(bodyEnd);
      const message = JSON.parse(body);
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
    }
  });

  function send(payload) {
    const body = JSON.stringify(payload);
    viaCli.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  async function call(method, params) {
    const id = nextId++;
    const response = await new Promise((resolve, reject) => {
      pending.set(id, resolve);
      send({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`MCP request timeout for method: ${method}`));
        }
      }, 10000);
    });

    if (response.error) {
      throw new Error(response.error.message || `MCP error for ${method}`);
    }
    return response.result;
  }

  return {
    call,
    callTool(name, args) {
      return call("tools/call", { name, arguments: args });
    },
    async close() {
      viaCli.kill();
    },
  };
}

async function initializeClient(client) {
  const initialize = await client.call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "repobrain-test", version: "0.0.0" },
  });
  assert.equal(initialize.protocolVersion, "2025-06-18");
}

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-mcp-"));
  try {
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function runTest(name, callback) {
  it(name, callback);
}

const assert = {
  equal(actual, expected, message) {
    expect(actual, message).toBe(expected);
  },
  ok(value, message) {
    expect(value, message).toBeTruthy();
  },
  match(value, pattern, message) {
    expect(value, message).toMatch(pattern);
  },
};
