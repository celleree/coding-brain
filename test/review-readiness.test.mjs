import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  REVIEW_READINESS_CONTRACT_VERSION,
  evaluateExactHeadReviewResult,
  evaluateReviewReadiness,
  evaluateReviewReadinessText,
} from "../dist/index.js";

const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const declaration = (status, review_sha) => ({
  contract_version: REVIEW_READINESS_CONTRACT_VERSION,
  status,
  ...(review_sha ? { review_sha } : {}),
});
const block = (status, sha) =>
  [
    "<!-- repobrain-review-readiness",
    `CONTRACT_VERSION: ${REVIEW_READINESS_CONTRACT_VERSION}`,
    `STATUS: ${status}`,
    ...(sha ? [`REVIEW_SHA: ${sha}`] : []),
    "-->",
  ].join("\n");

describe("exact-HEAD review safety", () => {
  it("enforces readiness against the current exact HEAD", () => {
    expect(evaluateReviewReadiness(declaration("IN_PROGRESS"), A).state).toBe("NOT_READY");
    expect(evaluateReviewReadiness(declaration("REVIEW_READY", A), A).state).toBe("READY");
    expect(evaluateReviewReadiness(declaration("REVIEW_READY", A), B)).toMatchObject({
      state: "STALE",
      reason: "STALE — HEAD MOVED",
    });
    expect(evaluateReviewReadiness(declaration("REVIEW_READY", B), B).state).toBe("READY");
  });

  it("fails closed for malformed or ambiguous readiness data", () => {
    expect(evaluateReviewReadiness(undefined, A).state).toBe("INVALID");
    expect(evaluateReviewReadiness(declaration("REVIEW_READY"), A).state).toBe("INVALID");
    expect(evaluateReviewReadiness(declaration("IN_PROGRESS", A), A).state).toBe("INVALID");
    expect(evaluateReviewReadinessText(block("IN_PROGRESS") + "\n" + block("REVIEW_READY", A), A).state).toBe(
      "INVALID",
    );
  });

  it("binds review completion to one exact SHA", () => {
    const review = {
      contract_version: REVIEW_READINESS_CONTRACT_VERSION,
      reviewed_sha: A,
      outcome: "PASS",
    };
    expect(evaluateExactHeadReviewResult(review, A).state).toBe("CURRENT");
    expect(evaluateExactHeadReviewResult(review, B)).toMatchObject({
      state: "STALE",
      reason: "STALE — HEAD MOVED",
    });
    expect(evaluateExactHeadReviewResult({ reviewed_sha: A, outcome: "PASS" }, A).state).toBe("INVALID");
  });

  it("keeps readiness and completion as distinct GitHub check contexts", async () => {
    const workflow = await readFile(".github/workflows/review-readiness.yml", "utf8");
    expect(workflow).toContain("readiness:");
    expect(workflow).toContain("review-completion:");
    expect(workflow).toContain("group: review-safety-${{ github.event.pull_request.number }}");
    expect(workflow).toContain("cancel-in-progress: true");
  });

  it("uses live PR state instead of event body/head snapshots", async () => {
    const workflow = await readFile(".github/workflows/review-readiness.yml", "utf8");
    expect(workflow).toContain("$GH_API_URL/repos/$REPOSITORY/pulls/$PR_NUMBER");
    expect(workflow).not.toContain("github.event.pull_request.body");
    expect(workflow).not.toContain("github.event.pull_request.head.sha");
  });

  it("requires an explicit current-HEAD approval for completion", async () => {
    const workflow = await readFile(".github/workflows/review-readiness.yml", "utf8");
    expect(workflow).toContain("/reviews?per_page=100");
    expect(workflow).toContain('.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "DISMISSED"');
    expect(workflow).toContain("group_by(.user.id) | map(max_by(.id))");
    expect(workflow).toContain("/collaborators/$reviewer/permission");
    expect(workflow).toContain('permission" == "write" || "$permission" == "admin"');
    expect(workflow).toContain('[[ "$state" == "CHANGES_REQUESTED" ]] && export CURRENT_CHANGES_REQUESTED=true');
    expect(workflow).toContain('throw new Error("exact-HEAD review approval is missing")');
    expect(workflow).toContain("evaluateExactHeadReviewResult");
  });

  it("keeps unresolved change requests blocking until approval or dismissal", async () => {
    const workflow = await readFile(".github/workflows/review-readiness.yml", "utf8");
    expect(workflow).toContain('.state == "CHANGES_REQUESTED"');
    expect(workflow).toContain('throw new Error("review changes requested")');
    expect(workflow).toContain("types: [submitted, dismissed]");
  });
});
