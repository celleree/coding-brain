import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  approveCandidateMemory,
  commitAtomicWriteOperations,
  createAtomicWriteOperation,
  initBrain,
  loadStoredMemoryRecords,
  loadStoredPreferenceRecords,
  overwriteStoredMemory,
  parseMemory,
  persistSourceBytes,
  prepareSourceBlobWrite,
  saveMemory,
  savePreference,
  savePreferenceWithSupersessions,
  supersedePreferencePair,
  verifyMemoryProvenance,
  verifyPreferenceProvenance,
} from "../dist/store-api.js";
import { archiveGoalMemory } from "../dist/sweep.js";

await it("requires actual source bytes or an existing valid source episode", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-provenance-required-"));
  try {
    await initBrain(projectRoot);
    await expect(saveMemory(memory("Unsourced memory"), projectRoot)).rejects.toThrow(
      /without source bytes or a valid source_episode/u,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("preserves shared raw source bytes and separately attests each record", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-provenance-"));
  try {
    await initBrain(projectRoot);
    const sourceBytes = Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x0d, 0x00, 0x0a, 0x00]);
    await saveMemory(memory("First sourced memory"), projectRoot, { sourceBytes });
    await saveMemory(memory("Second sourced memory"), projectRoot, { sourceBytes });

    const records = await loadStoredMemoryRecords(projectRoot);
    expect(records).toHaveLength(2);
    expect(records[0].memory.source_episode).toBe(records[1].memory.source_episode);
    expect(records[0].memory.record_digest).not.toBe(records[1].memory.record_digest);

    const digest = records[0].memory.source_episode.replace(/^sha256:/u, "");
    const blob = await readFile(
      path.join(projectRoot, ".brain", "sources", "sha256", digest.slice(0, 2), `${digest}.blob`),
    );
    expect(blob.equals(sourceBytes)).toBe(true);
    for (const record of records) {
      await expect(verifyMemoryProvenance(projectRoot, record.memory, record.relativePath)).resolves.toEqual({
        ok: true,
      });
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("re-attests trusted metadata changes but rejects in-place semantic changes", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-provenance-mutation-"));
  try {
    await initBrain(projectRoot);
    const filePath = await saveMemory(memory("Mutable attested memory"), projectRoot, {
      sourceBytes: Buffer.from("original evidence", "utf8"),
    });
    let record = (await loadStoredMemoryRecords(projectRoot)).find((entry) => entry.filePath === filePath);
    expect(record).toBeTruthy();
    const sourceEpisode = record.memory.source_episode;
    const originalDigest = record.memory.record_digest;

    await overwriteStoredMemory({ ...record, memory: { ...record.memory, score: 91 } });
    record = (await loadStoredMemoryRecords(projectRoot)).find((entry) => entry.filePath === filePath);
    expect(record.memory.source_episode).toBe(sourceEpisode);
    expect(record.memory.record_digest).not.toBe(originalDigest);
    await expect(verifyMemoryProvenance(projectRoot, record.memory, record.relativePath)).resolves.toEqual({
      ok: true,
    });

    await expect(
      overwriteStoredMemory({ ...record, memory: { ...record.memory, summary: "Manual semantic rewrite" } }),
    ).rejects.toThrow(/newly sourced successor/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("blocks promotion when the record attestation was manually changed", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-provenance-promotion-"));
  try {
    await initBrain(projectRoot);
    const filePath = await saveMemory({ ...memory("Candidate provenance"), status: "candidate" }, projectRoot, {
      sourceBytes: Buffer.from("candidate evidence", "utf8"),
    });
    const raw = await readFile(filePath, "utf8");
    await writeFile(
      filePath,
      raw.replace(/record_digest: "sha256:[a-f0-9]{64}"/u, `record_digest: "sha256:${"0".repeat(64)}"`),
    );
    const record = (await loadStoredMemoryRecords(projectRoot)).find((entry) => entry.filePath === filePath);
    await expect(approveCandidateMemory(record, projectRoot)).rejects.toThrow(/invalid provenance/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("verifies the current candidate before atomically superseding an active memory", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-provenance-promotion-atomic-"));
  try {
    await initBrain(projectRoot);
    const activePath = await saveMemory(memory("Atomic promotion memory"), projectRoot, {
      sourceBytes: Buffer.from("active evidence", "utf8"),
    });
    const candidatePath = await saveMemory(
      {
        ...memory("Atomic promotion memory"),
        date: "2026-08-30T12:00:00.000Z",
        status: "candidate",
      },
      projectRoot,
      { sourceBytes: Buffer.from("candidate evidence", "utf8") },
    );
    const candidate = (await loadStoredMemoryRecords(projectRoot)).find((entry) => entry.filePath === candidatePath);
    const activeBefore = await readFile(activePath, "utf8");
    await writeFile(
      candidatePath,
      (await readFile(candidatePath, "utf8")).replace("Atomic promotion memory summary", "Tampered summary"),
    );

    await expect(approveCandidateMemory(candidate, projectRoot)).rejects.toThrow(/invalid provenance/u);
    expect(await readFile(activePath, "utf8")).toBe(activeBefore);
    const active = (await loadStoredMemoryRecords(projectRoot)).find((entry) => entry.filePath === activePath);
    expect(active.memory.status).toBe("active");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("active-memory save leaves every trusted match unchanged when a later match is tampered", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-provenance-save-atomic-"));
  try {
    await initBrain(projectRoot);
    const activePath = await saveMemory(
      { ...memory("Atomic active-memory save"), date: "2026-08-27T12:00:00.000Z" },
      projectRoot,
      { sourceBytes: Buffer.from("old active evidence", "utf8") },
    );
    const candidatePaths = await Promise.all(
      ["2026-08-28T12:00:00.000Z", "2026-08-29T12:00:00.000Z"].map((date, index) =>
        saveMemory({ ...memory("Atomic active-memory save"), date, status: "candidate" }, projectRoot, {
          sourceBytes: Buffer.from(`candidate evidence ${index}`, "utf8"),
        }),
      ),
    );
    let records = await loadStoredMemoryRecords(projectRoot);
    for (const candidatePath of candidatePaths) {
      const candidate = records.find((entry) => entry.filePath === candidatePath);
      await overwriteStoredMemory({ ...candidate, memory: { ...candidate.memory, status: "active" } });
    }

    await writeFile(
      activePath,
      (await readFile(activePath, "utf8")).replace("Atomic active-memory save summary", "Tampered summary"),
    );
    records = (await loadStoredMemoryRecords(projectRoot)).filter(
      (entry) => entry.memory.title === "Atomic active-memory save",
    );
    const before = new Map(
      await Promise.all(records.map(async (entry) => [entry.filePath, await readFile(entry.filePath, "utf8")])),
    );
    const newSourceBytes = Buffer.from("new active evidence", "utf8");

    await expect(
      saveMemory({ ...memory("Atomic active-memory save"), date: "2026-08-30T12:00:00.000Z" }, projectRoot, {
        sourceBytes: newSourceBytes,
      }),
    ).rejects.toThrow(/matching active provenance is invalid/u);

    for (const [filePath, content] of before) {
      expect(await readFile(filePath, "utf8")).toBe(content);
    }
    expect(
      (await loadStoredMemoryRecords(projectRoot)).filter(
        (entry) => entry.memory.title === "Atomic active-memory save",
      ),
    ).toHaveLength(3);
    await expect(readFile(sourceBlobPath(projectRoot, newSourceBytes), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("memory commit boundary rolls back earlier writes when a later verified record changes", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-memory-boundary-"));
  try {
    await initBrain(projectRoot);
    const paths = await Promise.all(
      ["Boundary memory first", "Boundary memory late"].map((title) =>
        saveMemory({ ...memory(title), status: "candidate" }, projectRoot, {
          sourceBytes: Buffer.from(`${title} source`, "utf8"),
        }),
      ),
    );
    const records = await loadStoredMemoryRecords(projectRoot);
    const expectedContents = await Promise.all(paths.map((filePath) => readFile(filePath, "utf8")));
    for (const filePath of paths) {
      const record = records.find((entry) => entry.filePath === filePath);
      await expect(verifyMemoryProvenance(projectRoot, record.memory, record.relativePath)).resolves.toEqual({
        ok: true,
      });
    }
    const operations = paths.map((filePath, index) =>
      createAtomicWriteOperation(filePath, `${expectedContents[index]}\n`, {
        expectedContent: expectedContents[index],
      }),
    );
    const lateTamper = expectedContents[1].replace("Boundary memory late summary", "Late boundary tamper");
    await writeFile(paths[1], lateTamper, "utf8");

    await expect(commitAtomicWriteOperations(operations)).rejects.toThrow(/precondition failed/u);
    expect(await readFile(paths[0], "utf8")).toBe(expectedContents[0]);
    expect(await readFile(paths[1], "utf8")).toBe(lateTamper);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("preference supersession rereads and rejects a tampered new preference", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-preference-tamper-"));
  try {
    await initBrain(projectRoot);
    const { oldRecord, newRecord } = await preferencePair(projectRoot);
    await writeFile(
      newRecord.filePath,
      (await readFile(newRecord.filePath, "utf8")).replace("new preference evidence", "tampered preference"),
    );

    await expect(supersedePreferencePair(newRecord, oldRecord)).rejects.toThrow(/invalid provenance/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("preference supersession leaves the new preference unchanged when the old preference is tampered", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-preference-atomic-"));
  try {
    await initBrain(projectRoot);
    const { oldRecord, newRecord } = await preferencePair(projectRoot);
    const newBefore = await readFile(newRecord.filePath, "utf8");
    await writeFile(
      oldRecord.filePath,
      (await readFile(oldRecord.filePath, "utf8")).replace("old preference evidence", "tampered preference"),
    );

    await expect(supersedePreferencePair(newRecord, oldRecord)).rejects.toThrow(/invalid provenance/u);
    expect(await readFile(newRecord.filePath, "utf8")).toBe(newBefore);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("preference supersession leaves all trusted matches unchanged when a later match is tampered", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-preference-batch-atomic-"));
  try {
    await initBrain(projectRoot);
    const oldPaths = [
      await savePreference(
        activePreference("jest", "first trusted preference", "2026-08-30T12:00:00.000Z"),
        projectRoot,
        {
          sourceBytes: Buffer.from("first trusted source", "utf8"),
        },
      ),
      await savePreference(
        activePreference("jest", "late preference evidence", "2026-08-29T12:00:00.000Z"),
        projectRoot,
        { sourceBytes: Buffer.from("late preference source", "utf8") },
      ),
    ];
    await writeFile(
      oldPaths[1],
      (await readFile(oldPaths[1], "utf8")).replace("late preference evidence", "tampered preference evidence"),
    );
    const before = new Map(
      await Promise.all(oldPaths.map(async (filePath) => [filePath, await readFile(filePath, "utf8")])),
    );
    const newSourceBytes = Buffer.from("new preference source", "utf8");

    await expect(
      savePreferenceWithSupersessions(
        {
          ...activePreference("vitest", "new preference evidence", "2026-08-31T12:00:00.000Z"),
          status: "candidate",
        },
        projectRoot,
        "jest",
        { sourceBytes: newSourceBytes },
      ),
    ).rejects.toThrow(/invalid provenance/u);

    for (const [filePath, content] of before) {
      expect(await readFile(filePath, "utf8")).toBe(content);
    }
    expect(await loadStoredPreferenceRecords(projectRoot)).toHaveLength(2);
    await expect(readFile(sourceBlobPath(projectRoot, newSourceBytes), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("preference commit boundary rolls back earlier writes when a later verified record changes", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-preference-boundary-"));
  try {
    await initBrain(projectRoot);
    const paths = await Promise.all([
      savePreference(activePreference("jest", "Boundary preference first", "2026-08-30T12:00:00.000Z"), projectRoot, {
        sourceBytes: Buffer.from("boundary preference first source", "utf8"),
      }),
      savePreference(activePreference("vitest", "Boundary preference late", "2026-08-29T12:00:00.000Z"), projectRoot, {
        sourceBytes: Buffer.from("boundary preference late source", "utf8"),
      }),
    ]);
    const records = await loadStoredPreferenceRecords(projectRoot);
    const expectedContents = await Promise.all(paths.map((filePath) => readFile(filePath, "utf8")));
    for (const filePath of paths) {
      const record = records.find((entry) => entry.filePath === filePath);
      await expect(verifyPreferenceProvenance(projectRoot, record.preference, record.relativePath)).resolves.toEqual({
        ok: true,
      });
    }
    const operations = paths.map((filePath, index) =>
      createAtomicWriteOperation(filePath, `${expectedContents[index]}\n`, {
        expectedContent: expectedContents[index],
      }),
    );
    const lateTamper = expectedContents[1].replace("Boundary preference late", "Late boundary tamper");
    await writeFile(paths[1], lateTamper, "utf8");

    await expect(commitAtomicWriteOperations(operations)).rejects.toThrow(/precondition failed/u);
    expect(await readFile(paths[0], "utf8")).toBe(expectedContents[0]);
    expect(await readFile(paths[1], "utf8")).toBe(lateTamper);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("removes a newly persisted source blob when a later record creation fails", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-source-rollback-"));
  try {
    await initBrain(projectRoot);
    const sourceBytes = Buffer.from("rollback-only source blob", "utf8");
    const prepared = await prepareSourceBlobWrite(projectRoot, sourceBytes);
    expect(prepared.operation).toBeTruthy();
    const occupiedPath = path.join(projectRoot, ".brain", "decisions", "occupied.md");
    await writeFile(occupiedPath, "existing record", "utf8");

    await expect(
      commitAtomicWriteOperations([
        prepared.operation,
        createAtomicWriteOperation(occupiedPath, "new record", { targetMustNotExist: true }),
      ]),
    ).rejects.toMatchObject({ code: "EEXIST" });

    await expect(readFile(sourceBlobPath(projectRoot, sourceBytes))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(occupiedPath, "utf8")).toBe("existing record");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("never deletes an existing shared source blob when a record creation fails", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-source-shared-"));
  try {
    await initBrain(projectRoot);
    const sourceBytes = Buffer.from("shared source blob", "utf8");
    await persistSourceBytes(projectRoot, sourceBytes);
    const prepared = await prepareSourceBlobWrite(projectRoot, sourceBytes);
    expect(prepared.operation).toMatchObject({ verifyOnly: true });
    const occupiedPath = path.join(projectRoot, ".brain", "decisions", "occupied.md");
    await writeFile(occupiedPath, "existing record", "utf8");

    await expect(
      commitAtomicWriteOperations([
        prepared.operation,
        createAtomicWriteOperation(occupiedPath, "new record", { targetMustNotExist: true }),
      ]),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(await readFile(sourceBlobPath(projectRoot, sourceBytes))).toEqual(sourceBytes);
    expect(await readFile(occupiedPath, "utf8")).toBe("existing record");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

await it("re-attests an archived goal against its archive path", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-provenance-archive-"));
  try {
    await initBrain(projectRoot);
    const goalPath = await saveMemory(
      { ...memory("Archive attested goal"), type: "goal", status: "done" },
      projectRoot,
      { sourceBytes: Buffer.from("goal evidence", "utf8") },
    );
    const record = (await loadStoredMemoryRecords(projectRoot)).find((entry) => entry.filePath === goalPath);
    const originalDigest = record.memory.record_digest;
    const originalEpisode = record.memory.source_episode;

    const archivedPath = await archiveGoalMemory(projectRoot, {
      record,
      updated: "2026-08-29",
      daysSinceUpdated: 1,
    });
    const archived = parseMemory(await readFile(archivedPath, "utf8"), archivedPath);
    const archivedRelativePath = path.relative(projectRoot, archivedPath);
    expect(archived.source_episode).toBe(originalEpisode);
    expect(archived.record_digest).not.toBe(originalDigest);
    await expect(verifyMemoryProvenance(projectRoot, archived, archivedRelativePath)).resolves.toEqual({ ok: true });
    await expect(readFile(goalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function memory(title) {
  const now = "2026-08-29T12:00:00.000Z";
  return {
    type: "decision",
    title,
    summary: `${title} summary`,
    detail: `## DECISION\n\n${title} detail.`,
    tags: ["provenance"],
    importance: "high",
    date: now,
    score: 60,
    hit_count: 0,
    last_used: null,
    created_at: now,
    stale: false,
    source: "session",
    status: "active",
  };
}

function activePreference(target, reason, timestamp) {
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

async function preferencePair(projectRoot) {
  const now = "2026-08-29T12:00:00.000Z";
  const oldPath = await savePreference(
    {
      kind: "routing_preference",
      target_type: "skill",
      target: "jest",
      preference: "prefer",
      reason: "old preference evidence",
      confidence: 0.7,
      source: "manual",
      created_at: now,
      updated_at: now,
      status: "active",
    },
    projectRoot,
    { sourceBytes: Buffer.from("old preference source", "utf8") },
  );
  const newPath = await savePreference(
    {
      kind: "routing_preference",
      target_type: "skill",
      target: "jest",
      preference: "prefer",
      reason: "new preference evidence",
      confidence: 0.8,
      source: "routing_feedback",
      created_at: "2026-08-30T12:00:00.000Z",
      updated_at: "2026-08-30T12:00:00.000Z",
      status: "candidate",
    },
    projectRoot,
    { sourceBytes: Buffer.from("new preference source", "utf8") },
  );
  const records = await loadStoredPreferenceRecords(projectRoot);
  return {
    oldRecord: records.find((entry) => entry.filePath === oldPath),
    newRecord: records.find((entry) => entry.filePath === newPath),
  };
}
