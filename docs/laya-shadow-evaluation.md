# Offline Laya shadow receipts

This opt-in harness records new operator tasks without changing Brain routing or invoking inference. It is independent of unmerged PR25. It does not import the draft semantic router, checkpoints, safety-floor code or sealed datasets. Runtime routing, replacement readiness and global activation remain disabled.

Run `node scripts/laya-shadow.mjs < PATH_TO_PRIVATE_RECEIPTS.json` from a source checkout. It reads a JSON array from stdin and prints only aggregate counts. It makes no filesystem writes or network/model calls. Existing CI runs `test/laya-shadow.test.mjs`; its synthetic fixtures establish schema behavior only. Keep actual receipts and supporting evidence outside the repository; never commit task text, customer information, usage exports or authentication state.

## Collection protocol

1. Use genuinely new, authorized operator tasks. No Challenge V1/V2, sealed final/challenge, rubric-validation holdout, paraphrases or derived scenario families. `source: new_operator_task` is an operator attestation; software cannot prove independence. Follow the [Laya research rules](https://github.com/celleree/laya-eval/blob/main/AGENTS.md).
2. Assign opaque task and labeler IDs. Before seeing proposed/existing routes, freeze independent eight-dimension labels under the [frozen V2.2 rubric](https://github.com/celleree/laya-eval/blob/cac2aac10c365baf584f32712a34f1eb1e6ef284/docs/SEMANTIC_ANNOTATION_RUBRIC_V2_2.md). Null means abstention; retain rationale, alternatives and missing facts in separate private evidence. Do not infer labels from a preferred model.
3. Record the existing selected canonical route (Luna/Terra/Sol/Astra), separately from any externally supplied shadow proposal. A proposal requires an opaque candidate ID and exact contract commit. Those fields record supplied provenance, not verified policy parity. This harness does not derive routes or validate frozen safety floors. Any null label prevents a proposed route. Record unavailable/timeout/invalid/abstained proposals with null route/provenance; execution always retains the existing route and its established safety controls.
4. Execute only the existing route. Record operator completion, rework count, wall time and actual observed tokens or credits with opaque evidence IDs. Unknown measurements stay null, not zero. Never estimate usage from a pricing table. Supply one latest receipt per task; private immutable revisions may be retained separately.
5. Review aggregates with linked private evidence. Agreement with the existing router is not classification accuracy; existing-route completion/time/usage cannot establish counterfactual shadow savings. No thresholds or activation recommendation are generated.

## Receipt fields

All fields are required; unknown optional measurements/provenance use null. Unknown fields are rejected to prevent accidental task-text inclusion.

| Field                      | Values                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`, `source` | `laya-shadow.v1`, `new_operator_task`                                                                                                       |
| `task_id`, `labeler_id`    | Opaque identifiers, no free text                                                                                                            |
| `labels`                   | Exactly complexity, risk, scope, uncertainty, prior_failures, root_cause_required, architecture_required, sensitivity; V2.2 strings or null |
| `existing_route`           | Luna, Terra, Sol, Astra; logical classes, not current executable model IDs                                                                  |
| `shadow`                   | status (proposed/abstained/unavailable/timeout/invalid), proposed_route, candidate_id, contract_commit (40-character SHA), latency_ms       |
| `outcome`                  | status (pending/completed/failed/cancelled), rework_count, wall_time_ms, observed_usage, evidence_id                                        |
| `outcome.observed_usage`   | null, or unit (tokens/credits), nonnegative value and evidence_id                                                                           |

## Readiness evidence and remaining gates

This PR provides an offline collection/validation harness, not a completed shadow evaluation. There are zero collected real tasks in this repository and no model accuracy, latency, cost or completion results. PR25's 2,592-state deterministic contract parity does not measure classification quality. Its readiness artifact remains unchanged.

Before any separately approved activation: verify merged contract provenance, authoritative safety context/frozen floor parity, classifier schema/option-order/calibration, actual inference failure/fallback and resource budgets, representative new-task independent labels, and completion/rework/observed-usage evidence. Define acceptance criteria before collecting a decision cohort. Demonstrate rollback and cutover separately. This harness neither trains/calibrates models nor changes freeze records; real-data collection and any model invocation remain separately authorized work.
