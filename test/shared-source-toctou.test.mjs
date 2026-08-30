import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const commitControl = vi.hoisted(() => ({ beforeCommit: undefined }));

vi.mock("../src/store/atomic-write.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    commitAtomicWriteOperations: async (operations) => {
      const beforeCommit = commitControl.beforeCommit;
      commitControl.beforeCommit = undefined;
      if (beforeCommit) await beforeCommit();
      return actual.commitAtomicWriteOperations(operations);
    },
  };
});

const {
  initBrain,
  loadStoredMemoryRecords,
  loadStoredPreferenceRecords,
  saveMemory,
  savePreference,
  savePreferenceWithSupersessions,
} = await import("../src/store-api.ts");

await it("public memory save aborts without record mutations when a shared blob changes before commit", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-memory-shared-source-boundary-"));
  try {
    await initBrain(projectRoot);
    const sourceBytes = Buffer.from("shared memory source", "utf8");
    const blobPath = sourceBlobPath(projectRoot, sourceBytes);
    const existingPath = await saveMemory(memory("Shared source memory", "2026-08-29T12:00:00.000Z"), projectRoot, {
      sourceBytes,
    });
    const existingBefore = await readFile(existingPath, "utf8");
    const tamperedBytes = Buffer.from("late tampered memory source", "utf8");
    commitControl.beforeCommit = () => writeFile(blobPath, tamperedBytes);

    await expect(
      saveMemory(memory("Shared source memory", "2026-08-30T12:00:00.000Z"), projectRoot, { sourceBytes }),
    ).rejects.toThrow(/precondition failed/u);

    expect(await readFile(existingPath, "utf8")).toBe(existingBefore);
    expect(await loadStoredMemoryRecords(projectRoot)).toHaveLength(1);
    expect(await readFile(blobPath)).toEqual(tamperedBytes);
  } finally {
    commitControl.beforeCommit = undefined;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("public preference save aborts without record mutations when a shared blob changes before commit", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-preference-shared-source-boundary-"));
  try {
    await initBrain(projectRoot);
    const sourceBytes = Buffer.from("shared preference source", "utf8");
    const blobPath = sourceBlobPath(projectRoot, sourceBytes);
    const existingPath = await savePreference(
      preference("jest", "existing preference", "2026-08-29T12:00:00.000Z"),
      projectRoot,
      { sourceBytes },
    );
    const existingBefore = await readFile(existingPath, "utf8");
    const tamperedBytes = Buffer.from("late tampered preference source", "utf8");
    commitControl.beforeCommit = () => writeFile(blobPath, tamperedBytes);

    await expect(
      savePreferenceWithSupersessions(
        {
          ...preference("vitest", "replacement preference", "2026-08-30T12:00:00.000Z"),
          status: "candidate",
        },
        projectRoot,
        "jest",
        { sourceBytes },
      ),
    ).rejects.toThrow(/precondition failed/u);

    expect(await readFile(existingPath, "utf8")).toBe(existingBefore);
    expect(await loadStoredPreferenceRecords(projectRoot)).toHaveLength(1);
    expect(await readFile(blobPath)).toEqual(tamperedBytes);
  } finally {
    commitControl.beforeCommit = undefined;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("source_episode-only memory save aborts without record mutations when its shared blob changes", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-memory-source-reference-boundary-"));
  try {
    await initBrain(projectRoot);
    const sourceBytes = Buffer.from("referenced memory source", "utf8");
    const blobPath = sourceBlobPath(projectRoot, sourceBytes);
    const existingPath = await saveMemory(memory("Referenced source memory", "2026-08-29T12:00:00.000Z"), projectRoot, {
      sourceBytes,
    });
    const existingRecord = (await loadStoredMemoryRecords(projectRoot)).find(
      (record) => record.filePath === existingPath,
    );
    const existingBefore = await readFile(existingPath, "utf8");
    const tamperedBytes = Buffer.from("late tampered referenced memory source", "utf8");
    commitControl.beforeCommit = () => writeFile(blobPath, tamperedBytes);

    await expect(
      saveMemory(
        {
          ...memory("Referenced source memory", "2026-08-30T12:00:00.000Z"),
          source_episode: existingRecord.memory.source_episode,
        },
        projectRoot,
      ),
    ).rejects.toThrow(/precondition failed/u);

    expect(await readFile(existingPath, "utf8")).toBe(existingBefore);
    expect(await loadStoredMemoryRecords(projectRoot)).toHaveLength(1);
    expect(await readFile(blobPath)).toEqual(tamperedBytes);
  } finally {
    commitControl.beforeCommit = undefined;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("source_episode-only preference save aborts without record mutations when its shared blob changes", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-preference-source-reference-boundary-"));
  try {
    await initBrain(projectRoot);
    const sourceBytes = Buffer.from("referenced preference source", "utf8");
    const blobPath = sourceBlobPath(projectRoot, sourceBytes);
    const existingPath = await savePreference(
      preference("jest", "existing referenced preference", "2026-08-29T12:00:00.000Z"),
      projectRoot,
      { sourceBytes },
    );
    const existingRecord = (await loadStoredPreferenceRecords(projectRoot)).find(
      (record) => record.filePath === existingPath,
    );
    const existingBefore = await readFile(existingPath, "utf8");
    const tamperedBytes = Buffer.from("late tampered referenced preference source", "utf8");
    commitControl.beforeCommit = () => writeFile(blobPath, tamperedBytes);

    await expect(
      savePreferenceWithSupersessions(
        {
          ...preference("vitest", "replacement referenced preference", "2026-08-30T12:00:00.000Z"),
          status: "candidate",
          source_episode: existingRecord.preference.source_episode,
        },
        projectRoot,
        "jest",
      ),
    ).rejects.toThrow(/precondition failed/u);

    expect(await readFile(existingPath, "utf8")).toBe(existingBefore);
    expect(await loadStoredPreferenceRecords(projectRoot)).toHaveLength(1);
    expect(await readFile(blobPath)).toEqual(tamperedBytes);
  } finally {
    commitControl.beforeCommit = undefined;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function memory(title, date) {
  return {
    type: "decision",
    title,
    summary: `${title} summary`,
    detail: `## DECISION\n\n${title} detail.`,
    tags: ["provenance"],
    importance: "high",
    date,
    score: 60,
    hit_count: 0,
    last_used: null,
    created_at: date,
    stale: false,
    source: "session",
    status: "active",
  };
}

function preference(target, reason, timestamp) {
  return {
    kind: "routing_preference",
    target_type: "skill",
    target,
    preference: "prefer",
    reason,
    confidence: 0.7,
    source: "manual",
    created_at: timestamp,
    updated_at: timestamp,
    status: "active",
  };
}

function sourceBlobPath(projectRoot, sourceBytes) {
  const digest = createHash("sha256").update(sourceBytes).digest("hex");
  return path.join(projectRoot, ".brain", "sources", "sha256", digest.slice(0, 2), `${digest}.blob`);
}
