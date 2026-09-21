import { describe, expect, it } from "vitest";

import {
  REVIEW_READINESS_CONTRACT_VERSION,
  evaluateExactHeadReviewResult,
  evaluateReviewReadiness,
  evaluateReviewReadinessText,
} from "../dist/index.js";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function declaration(status, reviewSha) {
  return {
    contract_version: REVIEW_READINESS_CONTRACT_VERSION,
    status,
    ...(reviewSha === undefined ? {} : { review_sha: reviewSha }),
  };
}

function readinessBlock(status, reviewSha) {
  return [
    "<!-- repobrain-review-readiness",
    `CONTRACT_VERSION: ${REVIEW_READINESS_CONTRACT_VERSION}`,
    `STATUS: ${status}`,
    ...(reviewSha === undefined ? [] : [`REVIEW_SHA: ${reviewSha}`]),
    "-->",
  ].join("\n");
}

describe("exact-HEAD review readiness", () => {
  it("does not allow review while implementation is in progress", () => {
    expect(evaluateReviewReadiness(declaration("IN_PROGRESS"), SHA_A)).toMatchObject({
      state: "NOT_READY",
      current_head_sha: SHA_A,
    });
  });

  it("allows REVIEW_READY only when the declared SHA equals current HEAD", () => {
    expect(evaluateReviewReadiness(declaration("REVIEW_READY", SHA_A), SHA_A)).toEqual({
      state: "READY",
      current_head_sha: SHA_A,
      declared_review_sha: SHA_A,
      reason: "declared review SHA matches current HEAD",
    });
  });

  it("invalidates readiness deterministically when HEAD moves", () => {
    expect(evaluateReviewReadiness(declaration("REVIEW_READY", SHA_A), SHA_B)).toEqual({
      state: "STALE",
      current_head_sha: SHA_B,
      declared_review_sha: SHA_A,
      reason: "STALE — HEAD MOVED",
    });
  });

  it("restores readiness only after the new HEAD is explicitly re-declared", () => {
    expect(evaluateReviewReadiness(declaration("REVIEW_READY", SHA_A), SHA_B).state).toBe("STALE");
    expect(evaluateReviewReadiness(declaration("REVIEW_READY", SHA_B), SHA_B).state).toBe("READY");
  });

  it("fails closed for missing or malformed readiness data", () => {
    expect(evaluateReviewReadiness(undefined, SHA_A).state).toBe("INVALID");
    expect(evaluateReviewReadiness(declaration("REVIEW_READY"), SHA_A).state).toBe("INVALID");
    expect(evaluateReviewReadiness(declaration("IN_PROGRESS", SHA_A), SHA_A).state).toBe("INVALID");
    expect(evaluateReviewReadiness({ ...declaration("REVIEW_READY", SHA_A), extra: true }, SHA_A).state).toBe(
      "INVALID",
    );
  });

  it("parses one versioned provider-neutral readiness block and rejects ambiguous blocks", () => {
    expect(evaluateReviewReadinessText(readinessBlock("REVIEW_READY", SHA_A), SHA_A).state).toBe("READY");
    expect(evaluateReviewReadinessText("no readiness declaration", SHA_A).state).toBe("INVALID");
    expect(
      evaluateReviewReadinessText(
        readinessBlock("IN_PROGRESS") + "\n" + readinessBlock("REVIEW_READY", SHA_A),
        SHA_A,
      ).state,
    ).toBe("INVALID");
  });

  it("binds an exact-HEAD review result to only the SHA that was reviewed", () => {
    const result = {
      contract_version: REVIEW_READINESS_CONTRACT_VERSION,
      reviewed_sha: SHA_A,
      outcome: "PASS",
    };

    expect(evaluateExactHeadReviewResult(result, SHA_A)).toMatchObject({
      state: "CURRENT",
      reviewed_sha: SHA_A,
    });
    expect(evaluateExactHeadReviewResult(result, SHA_B)).toEqual({
      state: "STALE",
      current_head_sha: SHA_B,
      reviewed_sha: SHA_A,
      reason: "STALE — HEAD MOVED",
    });
  });

  it("fails closed for malformed exact-HEAD review results", () => {
    expect(evaluateExactHeadReviewResult({ reviewed_sha: SHA_A, outcome: "PASS" }, SHA_A).state).toBe(
      "INVALID",
    );
    expect(
      evaluateExactHeadReviewResult(
        {
          contract_version: REVIEW_READINESS_CONTRACT_VERSION,
          reviewed_sha: "short",
          outcome: "PASS",
        },
        SHA_A,
      ).state,
    ).toBe("INVALID");
  });
});
