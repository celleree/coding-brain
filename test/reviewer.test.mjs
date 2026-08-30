import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildMemoryReviewContext,
  explainCandidateMemoryReview,
  initBrain,
  loadStoredMemoryRecords,
  reviewCandidateMemories,
  reviewCandidateMemory,
} from "../dist/store-api.js";
import { saveMemory } from "./provenance-fixtures.mjs";

await runTest("accepts a novel memory when no strong overlap exists", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Keep API writes inside a transaction helper",
        summary: "Mutation-heavy API flows should route writes through the transaction helper for consistency.",
        detail:
          "## DECISION\n\nMutation-heavy API flows should route writes through the transaction helper for consistency and rollback safety.",
        tags: ["api", "transactions"],
        importance: "high",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["src/api/**"],
      },
      projectRoot,
    );

    const records = await loadStoredMemoryRecords(projectRoot);
    const review = reviewCandidateMemory(
      {
        type: "pattern",
        title: "Use focused fixtures for CLI smoke tests",
        summary:
          "CLI smoke tests stay easier to debug when they rely on focused fixtures instead of the full demo repo.",
        detail:
          "## PATTERN\n\nCLI smoke tests stay easier to debug when they rely on focused fixtures instead of the full demo repo.",
        tags: ["cli", "tests"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        path_scope: ["test/**"],
      },
      records,
    );

    assert.equal(review.decision, "accept");
    assert.deepEqual(review.target_memory_ids, []);
    assert.equal(review.reason, "novel_memory");
    assert.equal(review.internal_relation, null);
    assert.ok(review.confidence >= 0.5);
  });
});

await runTest("marks additive updates in the same scope as merge", async () => {
  await withTempRepo(async (projectRoot) => {
    const existingPath = await saveMemory(
      {
        type: "decision",
        title: "Keep payment writes inside the transaction helper",
        summary:
          "Refund and chargeback writes should stay inside the transaction helper to preserve rollback behavior.",
        detail:
          "## DECISION\n\nRefund and chargeback writes should stay inside the transaction helper to preserve rollback behavior.",
        tags: ["payments", "transactions"],
        importance: "high",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["src/payments/**"],
      },
      projectRoot,
    );

    const records = await loadStoredMemoryRecords(projectRoot);
    const review = reviewCandidateMemory(
      {
        type: "decision",
        title: "Keep refund writes inside the transaction helper",
        summary:
          "Refund update flows should also use the transaction helper so the same rollback rule applies everywhere.",
        detail:
          "## DECISION\n\nRefund update flows should also use the transaction helper so the same rollback rule applies everywhere, extending the existing payments guidance.",
        tags: ["payments", "refunds"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        path_scope: ["src/payments/**"],
      },
      records,
    );

    assert.equal(review.decision, "merge");
    assert.deepEqual(review.target_memory_ids, [path.basename(existingPath, ".md")]);
    assert.equal(review.reason, "same_scope_summary_overlap");
    assert.equal(review.internal_relation, "additive_update");
  });
});

await runTest("prefers the active target over a candidate when both are merge matches", async () => {
  await withTempRepo(async (projectRoot) => {
    const activePath = await saveMemory(
      {
        type: "decision",
        title: "Keep billing writes inside the transaction helper",
        summary: "Billing mutations should use the transaction helper so rollback behavior stays consistent.",
        detail:
          "## DECISION\n\nBilling mutations should use the transaction helper so rollback behavior stays consistent across charge and refund flows.",
        tags: ["billing", "transactions"],
        importance: "high",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["src/billing/**"],
      },
      projectRoot,
    );

    await saveMemory(
      {
        type: "decision",
        title: "Keep billing writes inside the transaction helper",
        summary: "Billing writes should still use the transaction helper while a follow-up review is pending.",
        detail:
          "## DECISION\n\nBilling writes should still use the transaction helper while a follow-up review is pending, but this candidate has not been approved yet.",
        tags: ["billing", "candidate"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        status: "candidate",
        path_scope: ["src/billing/**"],
      },
      projectRoot,
    );

    const records = await loadStoredMemoryRecords(projectRoot);
    const review = reviewCandidateMemory(
      {
        type: "decision",
        title: "Keep billing writes inside the transaction helper",
        summary:
          "Billing reconciliation flows should also stay inside the transaction helper so the same rollback rule applies.",
        detail:
          "## DECISION\n\nBilling reconciliation flows should also stay inside the transaction helper so the same rollback rule applies to every billing mutation path.",
        tags: ["billing", "reconciliation"],
        importance: "medium",
        date: "2026-04-01T10:00:00.000Z",
        path_scope: ["src/billing/**"],
      },
      records,
    );

    assert.equal(review.decision, "merge");
    assert.deepEqual(review.target_memory_ids, [path.basename(activePath, ".md")]);
    assert.equal(review.reason, "same_scope_summary_overlap");
    assert.equal(review.internal_relation, "additive_update");
  });
});

await runTest("marks replacement updates in the same scope as supersede", async () => {
  await withTempRepo(async (projectRoot) => {
    const existingPath = await saveMemory(
      {
        type: "convention",
        title: "Run CI checks with npm test",
        summary: "CI should run npm test before merge so local and remote checks stay aligned.",
        detail: "## CONVENTION\n\nCI should run npm test before merge so local and remote checks stay aligned.",
        tags: ["ci", "npm"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["package.json", "scripts/**"],
      },
      projectRoot,
    );

    const records = await loadStoredMemoryRecords(projectRoot);
    const review = reviewCandidateMemory(
      {
        type: "convention",
        title: "Run CI checks with npm test",
        summary: "CI now needs pnpm test instead of npm test after the workspace migration.",
        detail:
          "## CONVENTION\n\nReplace npm test with pnpm test in CI after the workspace migration. The npm-based command is obsolete and should no longer be used.",
        tags: ["ci", "pnpm"],
        importance: "high",
        date: "2026-04-01T10:00:00.000Z",
        path_scope: ["package.json", "scripts/**"],
      },
      records,
    );

    assert.equal(review.decision, "supersede");
    assert.deepEqual(review.target_memory_ids, [path.basename(existingPath, ".md")]);
    assert.equal(review.reason, "newer_memory_replaces_older");
    assert.equal(review.internal_relation, "full_replacement");
  });
});

await runTest("merges an exact duplicate into the existing durable memory", async () => {
  await withTempRepo(async (projectRoot) => {
    const existingPath = await saveMemory(
      {
        type: "gotcha",
        title: "Do not commit generated demo data",
        summary: "Generated demo data goes stale quickly and should stay out of the repository history.",
        detail: "## GOTCHA\n\nGenerated demo data goes stale quickly and should stay out of the repository history.",
        tags: ["git", "demo-data"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["examples/**"],
      },
      projectRoot,
    );

    const records = await loadStoredMemoryRecords(projectRoot);
    const review = reviewCandidateMemory(
      {
        type: "gotcha",
        title: "Do not commit generated demo data",
        summary: "Generated demo data goes stale quickly and should stay out of the repository history.",
        detail: "## GOTCHA\n\nGenerated demo data goes stale quickly and should stay out of the repository history.",
        tags: ["git", "demo-data"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        path_scope: ["examples/**"],
      },
      records,
    );

    assert.equal(review.decision, "merge");
    assert.deepEqual(review.target_memory_ids, [path.basename(existingPath, ".md")]);
    assert.equal(review.reason, "duplicate_memory");
    assert.equal(review.internal_relation, "duplicate");
  });
});

await runTest("keeps same-title memories with different scopes separate", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Cache invalidation rules",
        summary: "API cache invalidation should happen after mutation commits.",
        detail:
          "## DECISION\n\nAPI cache invalidation should happen after mutation commits so readers do not observe partial state.",
        tags: ["cache", "api"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["src/api/**"],
      },
      projectRoot,
    );

    const records = await loadStoredMemoryRecords(projectRoot);
    const review = reviewCandidateMemory(
      {
        type: "decision",
        title: "Cache invalidation rules",
        summary: "Web cache invalidation should happen after optimistic updates settle.",
        detail:
          "## DECISION\n\nWeb cache invalidation should happen after optimistic updates settle so the UI does not discard newer local state.",
        tags: ["cache", "web"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        path_scope: ["src/web/**"],
      },
      records,
    );

    assert.equal(review.decision, "accept");
    assert.deepEqual(review.target_memory_ids, []);
    assert.equal(review.reason, "novel_memory");
    assert.equal(review.internal_relation, null);
  });
});

await runTest("builds comparable review context without treating different scopes as merge targets", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "decision",
        title: "Cache invalidation rules",
        summary: "API cache invalidation should happen after mutation commits.",
        detail:
          "## DECISION\n\nAPI cache invalidation should happen after mutation commits so readers do not observe partial state.",
        tags: ["cache", "api"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["src/api/**"],
      },
      projectRoot,
    );

    const context = buildMemoryReviewContext(
      {
        type: "decision",
        title: "Cache invalidation rules",
        summary: "Web cache invalidation should happen after optimistic updates settle.",
        detail:
          "## DECISION\n\nWeb cache invalidation should happen after optimistic updates settle so the UI does not discard newer local state.",
        tags: ["cache", "web"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        path_scope: ["src/web/**"],
      },
      await loadStoredMemoryRecords(projectRoot),
    );

    assert.deepEqual(context.comparable_matches, []);
  });
});

await runTest("rejects obviously temporary details", async () => {
  await withTempRepo(async (projectRoot) => {
    const review = reviewCandidateMemory(
      {
        type: "gotcha",
        title: "Temporary release workaround",
        summary: "This temporary workaround only exists until the next patch release.",
        detail:
          "## GOTCHA\n\nThis is a temporary workaround for today only and should be removed after the next patch release.",
        tags: ["release"],
        importance: "low",
        date: "2026-04-01T09:00:00.000Z",
      },
      await loadStoredMemoryRecords(projectRoot),
    );

    assert.equal(review.decision, "reject");
    assert.deepEqual(review.target_memory_ids, []);
    assert.equal(review.reason, "temporary_detail");
    assert.equal(review.internal_relation, null);
  });
});

await runTest("rejects one-off debug TODO details with a deterministic reason", async () => {
  await withTempRepo(async (projectRoot) => {
    const review = reviewCandidateMemory(
      {
        type: "gotcha",
        title: "TODO debug flag for today's release",
        summary: "One-off debug logging stays enabled for now while we inspect the current release issue.",
        detail:
          "## GOTCHA\n\nTODO: keep this debug-only flag enabled for today only while we inspect the release logs, then remove it after the incident.",
        tags: ["debug", "release"],
        importance: "low",
        date: "2026-04-01T09:15:00.000Z",
      },
      await loadStoredMemoryRecords(projectRoot),
    );

    assert.equal(review.decision, "reject");
    assert.deepEqual(review.target_memory_ids, []);
    assert.equal(review.reason, "temporary_detail");
    assert.equal(review.internal_relation, null);
  });
});

await runTest("rejects low-signal memories that are too thin to preserve", async () => {
  await withTempRepo(async (projectRoot) => {
    const review = reviewCandidateMemory(
      {
        type: "pattern",
        title: "Refactor note",
        summary: "Small refactor.",
        detail: "## PATTERN\n\nRefactor this later.",
        tags: [],
        importance: "low",
        date: "2026-04-01T09:00:00.000Z",
      },
      await loadStoredMemoryRecords(projectRoot),
    );

    assert.equal(review.decision, "reject");
    assert.deepEqual(review.target_memory_ids, []);
    assert.equal(review.reason, "insufficient_signal");
    assert.equal(review.internal_relation, null);
  });
});

await runTest(
  "keeps validated external review input in context but still makes the local rule-based decision",
  async () => {
    await withTempRepo(async (projectRoot) => {
      const existingPath = await saveMemory(
        {
          type: "decision",
          title: "Keep refund writes inside the transaction helper",
          summary: "Refund update flows should use the transaction helper so rollback behavior stays consistent.",
          detail:
            "## DECISION\n\nRefund update flows should use the transaction helper so rollback behavior stays consistent.",
          tags: ["payments", "transactions"],
          importance: "high",
          date: "2026-04-01T08:00:00.000Z",
          status: "active",
          path_scope: ["src/payments/**"],
        },
        projectRoot,
      );

      const records = await loadStoredMemoryRecords(projectRoot);
      const externalReviewInput = {
        source: "agent-adapter",
        suggestion: {
          decision: "accept",
          target_memory_ids: [],
          reason: "agent_thinks_this_is_new",
        },
      };

      const context = buildMemoryReviewContext(
        {
          type: "decision",
          title: "Keep refund writes inside the transaction helper",
          summary: "Refund update flows should use the transaction helper so rollback behavior stays consistent.",
          detail:
            "## DECISION\n\nRefund update flows should use the transaction helper so rollback behavior stays consistent.",
          tags: ["payments", "transactions"],
          importance: "medium",
          date: "2026-04-01T10:00:00.000Z",
          path_scope: ["src/payments/**"],
        },
        records,
        externalReviewInput,
      );

      assert.deepEqual(context.external_review_input, externalReviewInput);

      const review = reviewCandidateMemory(context.memory, records, externalReviewInput);
      assert.equal(review.decision, "merge");
      assert.deepEqual(review.target_memory_ids, [path.basename(existingPath, ".md")]);
      assert.equal(review.reason, "duplicate_memory");
      assert.equal(review.internal_relation, "duplicate");
    });
  },
);

await runTest("ignores invalid external review input instead of trusting it", async () => {
  await withTempRepo(async (projectRoot) => {
    const records = await loadStoredMemoryRecords(projectRoot);
    const context = buildMemoryReviewContext(
      {
        type: "pattern",
        title: "Keep CLI fixtures focused",
        summary: "CLI smoke tests stay easier to debug when they use focused fixtures instead of a full demo repo.",
        detail:
          "## PATTERN\n\nCLI smoke tests stay easier to debug when they use focused fixtures instead of a full demo repo.",
        tags: ["cli", "tests"],
        importance: "medium",
        date: "2026-04-01T10:30:00.000Z",
      },
      records,
      {
        source: "agent-adapter",
        suggestion: {
          decision: "invented",
          target_memory_ids: ["fake-id"],
        },
      },
    );

    assert.equal(context.external_review_input, undefined);

    const review = reviewCandidateMemory(context.memory, records, {
      source: "agent-adapter",
      suggestion: {
        decision: "invented",
        target_memory_ids: ["fake-id"],
      },
    });
    assert.equal(review.decision, "accept");
    assert.deepEqual(review.target_memory_ids, []);
    assert.equal(review.reason, "novel_memory");
    assert.equal(review.internal_relation, null);
  });
});

await runTest("legacy reviewer overrides are ignored so Core never delegates final decisions", async () => {
  await withTempRepo(async (projectRoot) => {
    let overrideCalled = false;
    const reviewed = reviewCandidateMemories(
      [
        {
          type: "pattern",
          title: "Use focused fixtures for CLI smoke tests",
          summary:
            "CLI smoke tests stay easier to debug when they rely on focused fixtures instead of the full demo repo.",
          detail:
            "## PATTERN\n\nCLI smoke tests stay easier to debug when they rely on focused fixtures instead of the full demo repo.",
          tags: ["cli", "tests"],
          importance: "medium",
          date: "2026-04-01T09:00:00.000Z",
        },
      ],
      await loadStoredMemoryRecords(projectRoot),
      {
        reviewCandidate() {
          overrideCalled = true;
          throw new Error("legacy reviewer should not be called");
        },
      },
    );

    assert.equal(reviewed[0]?.review.decision, "accept");
    assert.equal(overrideCalled, false);
  });
});

await runTest("superseded memories do not participate as active review baselines", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "convention",
        title: "Run CI checks with npm test",
        summary: "Older CI guidance that has already been replaced.",
        detail: "## CONVENTION\n\nThis older CI guidance has already been replaced and should not stay active.",
        tags: ["ci", "npm"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "superseded",
        path_scope: ["package.json", "scripts/**"],
      },
      projectRoot,
    );

    const review = reviewCandidateMemory(
      {
        type: "convention",
        title: "Run CI checks with npm test",
        summary: "Current CI still runs npm test before merge so local and remote checks stay aligned.",
        detail: "## CONVENTION\n\nCurrent CI still runs npm test before merge so local and remote checks stay aligned.",
        tags: ["ci", "npm"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        path_scope: ["package.json", "scripts/**"],
      },
      await loadStoredMemoryRecords(projectRoot),
    );

    assert.equal(review.decision, "accept");
    assert.deepEqual(review.target_memory_ids, []);
    assert.equal(review.reason, "novel_memory");
    assert.equal(review.internal_relation, null);
  });
});

await runTest("handles wording changes as additive updates when identity and scope evidence still align", async () => {
  await withTempRepo(async (projectRoot) => {
    const existingPath = await saveMemory(
      {
        type: "pattern",
        title: "Route billing writes through the transaction helper",
        summary: "Billing writes should go through the shared transaction helper so rollback stays consistent.",
        detail:
          "## PATTERN\n\nBilling writes should go through the shared transaction helper so rollback stays consistent across billing flows.",
        tags: ["billing", "transactions"],
        importance: "high",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["src/billing/**"],
      },
      projectRoot,
    );

    const review = reviewCandidateMemory(
      {
        type: "pattern",
        title: "Route billing writes through the transaction helper",
        summary:
          "Billing mutation routes should also use the shared transaction helper so the same rollback rule applies.",
        detail:
          "## PATTERN\n\nBilling mutation paths should also use the shared transaction helper so the same rollback rule applies across billing flows.",
        tags: ["billing", "transactions"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        path_scope: ["src/billing/**"],
      },
      await loadStoredMemoryRecords(projectRoot),
    );

    assert.equal(review.decision, "merge");
    assert.deepEqual(review.target_memory_ids, [path.basename(existingPath, ".md")]);
    assert.equal(review.internal_relation, "additive_update");
  });
});

await runTest("rejects partial updates that should stay split from a broader memory", async () => {
  await withTempRepo(async (projectRoot) => {
    const existingPath = await saveMemory(
      {
        type: "decision",
        title: "Keep auth writes inside the transaction helper",
        summary: "Auth writes should stay inside the transaction helper so rollback is consistent across auth flows.",
        detail:
          "## DECISION\n\nAuth writes should stay inside the transaction helper so rollback is consistent across auth flows.",
        tags: ["auth", "transactions"],
        importance: "high",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["src/auth/**"],
      },
      projectRoot,
    );

    const review = reviewCandidateMemory(
      {
        type: "decision",
        title: "Keep auth writes inside the transaction helper",
        summary:
          "This partial auth update only applies to token refresh and should stay split from the broader auth write rule.",
        detail:
          "## DECISION\n\nThis partial auth update only applies to token refresh, so keep it separate instead of merging it into the broader auth write rule.",
        tags: ["auth", "token-refresh"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        path_scope: ["src/auth/token-refresh/**"],
      },
      await loadStoredMemoryRecords(projectRoot),
    );

    assert.equal(review.decision, "reject");
    assert.deepEqual(review.target_memory_ids, [path.basename(existingPath, ".md")]);
    assert.equal(review.reason, "possible_scope_split");
    assert.equal(review.internal_relation, "possible_split");
  });
});

await runTest("rejects ambiguous overlap when multiple old memories compete as targets", async () => {
  await withTempRepo(async (projectRoot) => {
    const firstPath = await saveMemory(
      {
        type: "convention",
        title: "Run billing CI in the shared transaction test harness",
        summary: "Billing CI should use the shared transaction test harness so billing checks stay deterministic.",
        detail:
          "## CONVENTION\n\nBilling CI should use the shared transaction test harness so billing checks stay deterministic.",
        tags: ["billing", "ci"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["src/billing/**"],
      },
      projectRoot,
    );

    const secondPath = await saveMemory(
      {
        type: "convention",
        title: "Run invoices CI in the shared transaction test harness",
        summary: "Invoices CI should use the shared transaction test harness so invoice checks stay deterministic.",
        detail:
          "## CONVENTION\n\nInvoices CI should use the shared transaction test harness so invoice checks stay deterministic.",
        tags: ["invoices", "ci"],
        importance: "medium",
        date: "2026-04-01T08:30:00.000Z",
        status: "active",
        path_scope: ["src/invoices/**"],
      },
      projectRoot,
    );

    const review = reviewCandidateMemory(
      {
        type: "convention",
        title: "Run finance CI in the shared transaction test harness",
        summary:
          "Finance CI should use the shared transaction test harness across billing and invoices, but this overlaps both existing memories.",
        detail:
          "## CONVENTION\n\nFinance CI should use the shared transaction test harness across billing and invoices, but this candidate overlaps both existing memories and does not identify a single replacement target.",
        tags: ["finance", "ci"],
        importance: "medium",
        date: "2026-04-01T09:00:00.000Z",
        path_scope: ["src/**"],
      },
      await loadStoredMemoryRecords(projectRoot),
    );

    assert.equal(review.decision, "reject");
    assert.deepEqual(
      review.target_memory_ids.sort(),
      [path.basename(firstPath, ".md"), path.basename(secondPath, ".md")].sort(),
    );
    assert.equal(review.reason, "ambiguous_existing_overlap");
    assert.equal(review.internal_relation, "ambiguous_overlap");
  });
});

await runTest("explain API exposes structured evidence for developer debugging", async () => {
  await withTempRepo(async (projectRoot) => {
    await saveMemory(
      {
        type: "convention",
        title: "Run CI checks with npm test",
        summary: "CI should run npm test before merge so local and remote checks stay aligned.",
        detail: "## CONVENTION\n\nCI should run npm test before merge so local and remote checks stay aligned.",
        tags: ["ci", "npm"],
        importance: "medium",
        date: "2026-04-01T08:00:00.000Z",
        status: "active",
        path_scope: ["package.json", "scripts/**"],
      },
      projectRoot,
    );

    const explained = explainCandidateMemoryReview(
      {
        type: "convention",
        title: "Run CI checks with npm test",
        summary: "CI now needs pnpm test instead of npm test after the workspace migration.",
        detail:
          "## CONVENTION\n\nReplace npm test with pnpm test in CI after the workspace migration. The npm-based command is obsolete and should no longer be used.",
        tags: ["ci", "pnpm"],
        importance: "high",
        date: "2026-04-01T10:00:00.000Z",
        path_scope: ["package.json", "scripts/**"],
      },
      await loadStoredMemoryRecords(projectRoot),
    );

    assert.equal(explained.review.decision, "supersede");
    assert.match(explained.text, /decision=supersede/);
    assert.match(explained.text, /evidence identity=/);
    assert.match(explained.text, /evidence replacement=/);
    const firstMatch = explained.context.comparable_matches[0];
    assert.ok(firstMatch);
    assert.ok(firstMatch.evidence.identity.score > 0);
    assert.ok(firstMatch.evidence.replacement_wording.items.some((item) => item.code === "replacement_wording"));
  });
});

console.log("All reviewer tests passed.");

async function withTempRepo(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "repobrain-reviewer-"));

  try {
    await initBrain(projectRoot);
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
