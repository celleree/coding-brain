import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initBrain, loadStoredMemoryRecords, saveMemory as saveMemoryRecord } from "../dist/store-api.js";
import { reinforceMemories as reinforceMemoryRecords } from "../dist/reinforce.js";

const repoRoot = process.cwd();
const fixturePath = path.join(repoRoot, "test", "fixtures", "reinforce-llm-fixture.mjs");
const fixtureCommand = `"${process.execPath}" "${fixturePath}"`;

function saveMemory(memory, projectRoot, provenance) {
  return saveMemoryRecord(memory, projectRoot, provenance ?? { sourceBytes: Buffer.from(memory.detail, "utf8") });
}

function reinforceMemories(events, memoriesDir, provenance) {
  const sourceBytes = Buffer.from(events.map((event) => event.draftContent ?? event.description).join("\n"), "utf8");
  return reinforceMemoryRecords(events, memoriesDir, provenance ?? { sourceBytes });
}

await runTest("reinforceMemories creates a newly sourced score successor", async () => {
  await withTempRepo(async (projectRoot) => {
    const filePath = await saveMemory(
      {
        type: "decision",
        title: "Keep payment writes inside the transaction helper",
        summary: "Route payment writes through the helper.",
        detail: "## DECISION\n\nAlways route payment writes through the transaction helper.",
        tags: ["payments"],
        importance: "high",
        date: "2026-04-01T08:00:00.000Z",
        score: 90,
        hit_count: 0,
        last_used: null,
        created_at: "2026-04-01",
        stale: false,
        status: "active",
      },
      projectRoot,
    );

    const result = await reinforceMemories(
      [
        {
          kind: "violated_memory",
          description: "The session wrote directly to payments storage.",
          relatedMemoryFile: path.basename(filePath),
          suggestedAction: "boost_score",
        },
      ],
      path.join(projectRoot, ".brain"),
    );

    assert.equal(result.boosted.length, 1);
    assert.notEqual(result.boosted[0], path.basename(filePath));
    const records = await loadStoredMemoryRecords(projectRoot);
    const oldRecord = records.find((record) => record.filePath === filePath);
    const successor = records.find((record) => path.basename(record.filePath) === result.boosted[0]);
    assert.equal(oldRecord?.memory.status, "superseded");
    assert.equal(successor?.memory.status, "active");
    assert.equal(successor?.memory.score, 100);
    assert.notEqual(successor?.memory.source_episode, oldRecord?.memory.source_episode);
  });
});

await runTest("reinforceMemories rewrites a violated memory body and preserves frontmatter fields", async () => {
  await withEnv(
    {
      BRAIN_EXTRACTOR_COMMAND: fixtureCommand,
    },
    async () => {
      await withTempRepo(async (projectRoot) => {
        const filePath = await saveMemory(
          {
            type: "decision",
            title: "Keep payment writes inside the transaction helper",
            summary: "Route payment writes through the helper.",
            detail: "## DECISION\n\nAlways route payment writes through the transaction helper.",
            tags: ["payments"],
            importance: "high",
            date: "2026-04-01T08:00:00.000Z",
            score: 60,
            hit_count: 2,
            last_used: null,
            created_at: "2026-04-01",
            stale: false,
            status: "active",
          },
          projectRoot,
        );

        const result = await reinforceMemories(
          [
            {
              kind: "violated_memory",
              description: "The session skipped the transaction helper and wrote directly to payments storage.",
              relatedMemoryFile: path.basename(filePath),
              suggestedAction: "rewrite_memory",
            },
          ],
          path.join(projectRoot, ".brain"),
        );

        const successorPath = path.join(projectRoot, ".brain", "decisions", result.rewritten[0]);
        const raw = await readFile(successorPath, "utf8");
        const [, frontmatter, body] = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/) ?? [];

        assert.equal(result.rewritten.length, 1);
        assert.notEqual(result.rewritten[0], path.basename(filePath));
        assert.match(frontmatter ?? "", /type: "decision"/);
        assert.match(frontmatter ?? "", /hit_count: 2/);
        assert.match(frontmatter ?? "", /score: 75/);
        assert.match((body ?? "").trimStart(), /^⚠️/);
        assert.ok((body ?? "").trim().length <= 150);
      });
    },
  );
});

await runTest("reinforceMemories extracts a new failure memory with origin metadata", async () => {
  await withEnv(
    {
      BRAIN_EXTRACTOR_COMMAND: fixtureCommand,
    },
    async () => {
      await withTempRepo(async (projectRoot) => {
        const result = await reinforceMemories(
          [
            {
              kind: "new_failure",
              description: "The session repeated flaky browser test retries without opening the trace.",
              suggestedAction: "extract_new",
              draftContent:
                "gotcha: Check Playwright traces before retrying flaky browser tests\n\nOpen the saved trace first so debugging starts from captured evidence instead of repeated blind reruns.",
            },
          ],
          path.join(projectRoot, ".brain"),
        );

        assert.equal(result.extracted.length, 1);
        const createdPath = path.join(projectRoot, ".brain", "gotchas", result.extracted[0]);
        const raw = await readFile(createdPath, "utf8");

        assert.match(raw, /origin: "failure"/);
        assert.match(raw, /score: 70/);
        assert.match(raw, /type: "gotcha"/);
      });
    },
  );
});

await runTest("reinforceMemories isolates per-event failures", async () => {
  await withEnv(
    {
      BRAIN_EXTRACTOR_COMMAND: fixtureCommand,
    },
    async () => {
      await withTempRepo(async (projectRoot) => {
        const filePath = await saveMemory(
          {
            type: "decision",
            title: "Keep payment writes inside the transaction helper",
            summary: "Route payment writes through the helper.",
            detail: "## DECISION\n\nAlways route payment writes through the transaction helper.",
            tags: ["payments"],
            importance: "high",
            date: "2026-04-01T08:00:00.000Z",
            score: 60,
            hit_count: 0,
            last_used: null,
            created_at: "2026-04-01",
            stale: false,
            status: "active",
          },
          projectRoot,
        );

        const result = await reinforceMemories(
          [
            {
              kind: "violated_memory",
              description: "Missing target file should not stop later events.",
              relatedMemoryFile: "missing.md",
              suggestedAction: "boost_score",
            },
            {
              kind: "violated_memory",
              description: "The session wrote directly to payments storage.",
              relatedMemoryFile: path.basename(filePath),
              suggestedAction: "boost_score",
            },
          ],
          path.join(projectRoot, ".brain"),
        );

        assert.equal(result.boosted.length, 1);
        assert.notEqual(result.boosted[0], path.basename(filePath));
      });
    },
  );
});

console.log("All reinforce tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-reinforce-"));

  try {
    await initBrain(projectRoot);
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function withEnv(values, callback) {
  const previous = new Map();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function runTest(name, callback) {
  it(name, callback);
}

const assert = {
  equal(actual, expected, message) {
    expect(actual, message).toBe(expected);
  },
  strictEqual(actual, expected, message) {
    expect(actual, message).toBe(expected);
  },
  notEqual(actual, expected, message) {
    expect(actual, message).not.toBe(expected);
  },
  deepEqual(actual, expected, message) {
    expect(actual, message).toEqual(expected);
  },
  notDeepEqual(actual, expected, message) {
    expect(actual, message).not.toEqual(expected);
  },
  ok(value, message) {
    expect(value, message).toBeTruthy();
  },
  match(value, pattern, message) {
    expect(value, message).toMatch(pattern);
  },
  doesNotMatch(value, pattern, message) {
    expect(value, message).not.toMatch(pattern);
  },
  throws(action, matcher, message) {
    if (matcher === undefined) {
      expect(action, message).toThrow();
      return;
    }
    expect(action, message).toThrow(matcher);
  },
  async rejects(action, matcher, message) {
    let failure;
    try {
      await action();
    } catch (error) {
      failure = error;
    }
    expect(failure, message ?? "expected promise to reject").toBeTruthy();
    if (typeof matcher === "function") {
      const handled = matcher(failure);
      expect(handled, message ?? "reject matcher should confirm the error").toBe(true);
      return;
    }
    if (matcher instanceof RegExp) {
      expect(failure.message, message).toMatch(matcher);
      return;
    }
    if (matcher && typeof matcher === "object") {
      expect(failure, message).toMatchObject(matcher);
    }
  },
  fail(message) {
    throw new Error(message ?? "assert.fail was called");
  },
};
