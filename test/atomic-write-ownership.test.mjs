import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const interleave = vi.hoisted(() => ({ afterLink: null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    link: async (...args) => {
      await actual.link(...args);
      const hook = interleave.afterLink;
      interleave.afterLink = null;
      if (hook) await hook();
    },
  };
});
const { commitAtomicWriteOperations, createAtomicWriteOperation, createAtomicContentPreconditionOperation } =
  await import("../src/store/atomic-write.ts");

it("rollback never undoes a fulfilled concurrent writer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-atomic-owner-"));
  const target = path.join(root, "counter.json");
  const guard = path.join(root, "checkpoint.json");
  try {
    await writeFile(target, "4");
    await writeFile(guard, "active");
    let concurrent;
    interleave.afterLink = async () => {
      // A has installed 5 but has not completed its final checkpoint verification.
      concurrent = await Promise.allSettled([
        commitAtomicWriteOperations([createAtomicWriteOperation(target, "6", { expectedContent: "5" })]),
      ]);
      await writeFile(guard, "changed");
    };
    await expect(
      commitAtomicWriteOperations([
        createAtomicWriteOperation(target, "5", { expectedContent: "4" }),
        createAtomicContentPreconditionOperation(guard, "active"),
      ]),
    ).rejects.toThrow(/precondition/);
    // If B fulfilled, its durable result must survive A's rollback.
    expect(await readFile(target, "utf8")).toBe(concurrent[0].status === "fulfilled" ? "6" : "4");
  } finally {
    interleave.afterLink = null;
    await rm(root, { recursive: true, force: true });
  }
});

it("conflicting same-base transactions preserve every fulfilled write and release their locks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-atomic-race-"));
  const target = path.join(root, "counter.json");
  try {
    for (let round = 0; round < 30; round++) {
      await writeFile(target, "4");
      const results = await Promise.allSettled(
        [0, 1].map(() =>
          commitAtomicWriteOperations([createAtomicWriteOperation(target, "5", { expectedContent: "4" })]),
        ),
      );
      expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
      expect(await readFile(target, "utf8")).toBe("5");
      expect(await readdir(root)).toEqual(["counter.json"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("fails closed on foreign/stale locks and releases only locks acquired by this transaction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-atomic-conflict-"));
  const first = path.join(root, "a.json");
  const guard = path.join(root, "z.json");
  const foreignLock = guard + ".atomic-lock";
  try {
    await writeFile(first, "original");
    await writeFile(guard, "active");
    await writeFile(foreignLock, "foreign-owner");
    await expect(
      commitAtomicWriteOperations([
        createAtomicWriteOperation(first, "replacement", { expectedContent: "original" }),
        createAtomicContentPreconditionOperation(guard, "active"),
      ]),
    ).rejects.toThrow(/ownership conflict/);
    expect(await readFile(first, "utf8")).toBe("original");
    expect(await readFile(foreignLock, "utf8")).toBe("foreign-owner");
    expect((await readdir(root)).sort()).toEqual(["a.json", "z.json", "z.json.atomic-lock"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
