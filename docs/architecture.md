# RepoBrain Architecture

This document contains the detailed architecture content moved from `README.md`: knowledge-layer design, routing engine, reviewer pipeline, integration contracts, and extractor extension points.

## 1. Knowledge Layers

RepoBrain separates durable memory from routing preferences and session-only hints:

| Layer | Location | Purpose |
| --- | --- | --- |
| Durable repo knowledge | `.brain/{decisions,gotchas,conventions,patterns,...}/` | Auditable, long-lived project knowledge shared through Git |
| Routing preference | `.brain/preferences/` | Reusable prefer/avoid policy for skills/workflows |
| Session profile | `.brain/runtime/session-profile.json` | Local, temporary constraints for the current session |

Raw capture evidence is stored once as content-addressed blobs under `.brain/sources/sha256/`. Durable memories and
preferences retain the existing `source` and `source_episode` provenance fields and add a separate `record_digest`
attestation. Evidence blobs are outside every memory index and retrieval path.

Trusted automatic usage, staleness, and lifecycle mutations retain `source_episode` and refresh `record_digest`.
Changes caused by new user, session, failure, or routing-feedback evidence create a newly sourced successor and use
the existing supersession lineage. Provenance-invalid active records fail closed before injection or routing.

Session profile is merged after stored preferences and can override ordinary preference weight, but does not override hard blocked/suppress outcomes or static required skill constraints.

## 2. Routing Engine

Routing is deterministic and local. Main composition:

`static_memory_policy_input` + `preference_policy_input` + optional `session_policy_input` + `task_context_input` -> `routing_engine` -> `invocation_plan`

Priority (high -> low):

1. blocked / explicit suppress
2. static `required_skills`
3. session profile routing
4. negative preference (`avoid`)
5. positive preference (`prefer`)
6. static recommended skills
7. optional/fallback signals

Routing output includes:

- `matched_memories`
- `resolved_skills`
- `conflicts`
- `invocation_plan` (`required`, `prefer_first`, `optional_fallback`, `suppress`, `blocked`, `human_review`)
- optional `routing_explanation`
- `path_source` (`explicit`, `git_diff`, or `none`)

## 3. Session Bundle (`brain route` / `brain start`)

`brain route` and `brain start` package:

- compact context from `brain inject`
- task-aware plan from `brain suggest-skills --format json`
- adapter-safe JSON contract with `display_mode` and `warnings`

`display_mode`:

- `silent-ok`: no escalation
- `needs-review`: blocked/human review/required-vs-suppress conflict present

## 4. Integration Architecture

RepoBrain keeps a stable core with thin adapters.

Core responsibilities:

- schema and storage
- deterministic review/dedupe/supersede decisions
- context injection and routing computation

Adapter responsibilities:

- translate RepoBrain output to agent-specific instructions
- invoke `brain capture` on phase-completion triggers
- keep candidate-first write behavior
- never write directly into `.brain/` bypassing core checks

Shared lifecycle contract:

1. first conversation in session (`brain start` or fallback `brain inject`)
2. fresh conversation later in same session (`brain conversation-start`, which can choose `start`, `inject`, or `skip`)
3. task-known routing (`brain suggest-skills`)
4. phase-completion detection (`brain capture`)
5. session-end extraction suggestion/candidate
6. failure reinforcement path

## 5. Phase-Completion Signals

Signal tiers:

- Strong: explicit done/move-on semantics, pass-after-fail test changes, large diff scope
- Context-dependent: submodule completion, recurring bug fix, multi-file refactor with enough content-value evidence
- Weak (excluded): short acknowledgements without substantive change context

Signals boost capture confidence; they are not a direct forced `should_extract=true`.

## 6. Reviewer Pipeline

`brain extract` and candidate decisions use a layered deterministic reviewer:

1. comparability filtering (`type`, status, scope)
2. evidence vector construction (identity/scope/text overlap/replacement/recency/lineage)
3. internal relation classification:
   - `duplicate`
   - `additive_update`
   - `full_replacement`
   - `possible_split`
   - `ambiguous_overlap`
4. public decision mapping:
   - `accept`
   - `merge`
   - `supersede`
   - `reject`

This prevents unsafe automatic merges in ambiguous multi-target overlaps.

## 7. Safe Auto-Approve Path

When enabled (`autoApproveSafeCandidates: true`), auto-promotion requires all checks:

- reviewer decision `accept` with `novel_memory`
- memory type is not `working`
- no temporary-only signals
- no merge/supersede/reject conflict signals

Everything else stays for manual `brain review` and `brain approve`.

## 8. Local Extractor and External Contract

Built-in local extractor stages:

`preprocess -> chunk -> candidate detection -> type classification -> field completion -> quality scoring -> prescreen dedupe -> deterministic review`

External extractor extension:

- set `BRAIN_EXTRACTOR_COMMAND`
- RepoBrain sends prompt over `stdin`
- extractor returns strict JSON over `stdout` in `{ "memories": [...] }`
- invalid output/failure falls back to local heuristic pipeline

Failure detector contract (`detectFailures`) follows the same local process style and expects structured JSON events.

## 9. Routing Feedback Loop

RepoBrain can ingest local routing events:

- `skill_followed`
- `skill_ignored`
- `skill_rejected_by_user`
- `workflow_too_heavy`
- `workflow_success`
- `workflow_failure`
- `routing_conflict_escalated`

Design is conservative:

- negative signals default to candidate `avoid` preferences
- strong conflicts surface as `pending_review`
- reminders are queued via reinforce pending queue

## 10. Related Docs

- CLI reference: [`docs/cli-reference.md`](./cli-reference.md)
- Schema details: [`docs/schema.md`](./schema.md)
- Workflow modes: [`docs/workflow-modes.md`](./workflow-modes.md)
- Temporal semantics: [`docs/temporal-semantics.md`](./temporal-semantics.md)
