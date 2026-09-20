# RepoBrain Integrations

RepoBrain adapters stay thin on purpose, but they now share a stronger contract with explicit detection triggers instead of soft prompts.

- `.brain/` remains the only durable repo-memory store. No adapter may create a second store.
- `brain start --format json` is the preferred entrypoint for the first conversation in a session; `brain conversation-start --format json` is the preferred smart refresh entrypoint for a fresh conversation later in the same session; `brain inject` remains the explicit lightweight refresh path and the fallback when `brain start` is unavailable.
- `brain suggest-skills --format json` remains the canonical task-known routing payload.
- `brain capture` is the preferred phase-completion detection command. It runs local deterministic rules and defaults to candidate-first output.
- `brain extract`, `brain reinforce`, and `brain routing-feedback` remain the only durable write paths for memories and routing policy artifacts.
- Adapters may translate format, but they must not invent a second schema or local memory store.

## Thin Adapter Contract

The adapter contract is lifecycle-based rather than agent-specific:

1. **Session bootstrap**: consume `brain start --format json` in the first conversation of a session and read both `context_markdown` and `skill_plan`. Fall back to `brain inject` when `brain start` is unavailable.
2. **Fresh conversation in the same session**: consume `brain conversation-start --format json --task "<task>" --path <path>` so RepoBrain can decide whether to rerun the full bundle, refresh compact context, or skip a redundant reload.
3. **Task known**: consume `brain suggest-skills --format json`, especially `invocation_plan`.
4. **Phase completion**: run `brain capture --task "<task>" --path <path>` when a detection trigger fires. `should_extract=true` saves a candidate; `should_extract=false` means no action.
5. **Session end**: emit an extract candidate in the shared markdown or JSON envelope if detection was not already run.
6. **Failure path**: emit a reinforce event through `brain reinforce`.
7. **Routing feedback (optional)**: when users or the session surface plan adherence, rejection, or workflow load, emit structured routing feedback through `brain routing-feedback` using `contracts/routing-feedback.event.json`.

This keeps adapters lightweight while giving Core a stable input-output boundary.

## Phase-Completion Detection Triggers

All adapters share the same detection triggers. When any of these occur, the adapter should run `brain capture` instead of relying on subjective judgment:

- Fixed a recurring bug
- Completed a submodule implementation
- Refactored across multiple files
- Tests went from failing to passing
- User signals completion ("done / ship it / looks good / next task")
- Agent just output "fixed / implemented / completed"

### Why candidate-first

- `brain capture` defaults to saving extracted memories as **candidates**, not active.
- This keeps the human in the loop: candidates are reviewed with `brain review` and promoted with `brain approve`.
- Active writes happen only through explicit approval, `extractMode: auto`, or manual `brain extract`.
- This design prevents adapter-generated noise from polluting the durable knowledge store.

### Anti-repetition

- Do not repeat the same capture suggestion in the same conversation turn.
- Only re-run detection if the change scope or task state changed significantly since the last run.

## Responsibility Boundary

Core layer responsibilities:

- define and validate the `.brain/` Markdown plus frontmatter schema
- rank and render durable context for `brain inject`
- derive task-aware routing hints and `invocation_plan` through `brain suggest-skills`
- package context plus routing for session start through `brain start` / `brain route`
- run local detection rules through `brain suggest-extract` and `brain capture`
- review extraction results locally and make the final `accept` / `merge` / `supersede` / `reject` decision
- own compatibility rules, defaults, and error messages when schema or config fields expand

Adapter layer responsibilities:

- place RepoBrain payloads at the right point in the target agent workflow
- translate the same contract into the agent's native instruction format
- decide whether and how to apply RepoBrain routing inside the agent's native skill, subagent, or workflow system
- run `brain capture` at phase-completion triggers instead of subjective extraction proposals
- emit extract candidates or reinforce events without bypassing RepoBrain Core
- provide a markdown fallback when the agent cannot emit the preferred JSON envelope
- never write directly into `.brain/`

Claude Code, Codex, Cursor, and Copilot may already have their own task or action selection behavior. RepoBrain does not replace that native automation. It adds repo-local, deterministic, auditable routing policy on top.

## Canonical Inputs And Outputs

### 1. Session Bootstrap: `start` / `route`

- Input command: `brain start --format json --task "<task>"`
- Canonical shape: JSON bundle with `context_markdown`, `skill_plan`, optional `navigation_plan`, and the same task/path metadata used by `suggest-skills`
- Adapter rule: prefer this in the first conversation of a session so context and routing stay in one auditable payload; when `navigation_plan` is present, consume its source paths, live checks, and next steps rather than treating it as informational only
- Adapter example: `brain start --format json --task "debug flaky browser tests in CI"`

### 2. Fresh Conversation In The Same Session: `conversation-start`

- Input command: `brain conversation-start --format json --task "<task>" --path <path>`
- Canonical shape: JSON object with `action`, `reason`, `decision_trace`, and either a full task-routing bundle, compact `context_markdown` plus optional `navigation_plan`, or a skip result
- Adapter rule: use this when a fresh conversation starts later in the same session so RepoBrain can avoid redundant reloads while still refreshing when task scope, paths, modules, or session profile changed
- Fallback contract: when the adapter explicitly wants only compact context, it can still consume [`contracts/session-start.inject.md`](./contracts/session-start.inject.md) via `brain inject`

### 3. Task Known: `suggest-skills` + `invocation_plan`

- Input command: `brain suggest-skills --format json --task "<task>" --path <path>`
- Canonical shape: JSON object with `decision`, matched memories, and `invocation_plan`
- Contract example: [`contracts/task-known.invocation-plan.json`](./contracts/task-known.invocation-plan.json)
- Adapter rule: route on `invocation_plan`; do not reinterpret prose into agent-specific memory
- Manual inspection example: `brain suggest-skills --task "debug flaky browser tests in CI"`

### 4. Phase Completion: `capture`

- Input command: `brain capture --task "<task>" --path <path>`
- Canonical shape: local detection result with `should_extract`, `reason`, and optional candidate output
- Adapter rule: run at detection triggers; when `should_extract=true`, the candidate is saved automatically; when `should_extract=false`, take no action and do not prompt the user

### 5. Session End: extract candidate

- Preferred output: JSON envelope
- Markdown fallback: summary block that can be piped to `brain extract`
- Contract examples:
  - [`contracts/session-end.extract-candidate.json`](./contracts/session-end.extract-candidate.json)
  - [`contracts/session-end.extract-candidate.md`](./contracts/session-end.extract-candidate.md)

### 6. Failure Path: reinforce event

- Preferred output: JSON envelope for a violated memory or repeated failure
- Fallback: markdown incident summary piped to `brain reinforce`
- Contract example: [`contracts/failure.reinforce-event.json`](./contracts/failure.reinforce-event.json)

### 7. Routing feedback (local policy learning, not runtime control)

- Input command: `brain routing-feedback` with a JSON array or NDJSON on `stdin`
- Purpose: record whether routing guidance was followed, whether users rejected a skill/workflow, and whether a workflow felt too heavy—**without** RepoBrain becoming an execution orchestrator
- Contract example: [`contracts/routing-feedback.event.json`](./contracts/routing-feedback.event.json)
- Adapter rule: emit events from user-visible outcomes; weak or chat-only text should be omitted so Core can filter noise
- Explainability: `brain routing-feedback --explain <skill>` summarizes preference files plus the local routing feedback log

## Failure Fallback Strategy

Adapters should follow the same fallback ladder:

1. If structured JSON is supported, emit the canonical contract envelope.
2. If only markdown is practical, emit the markdown fallback with the same semantic fields.
3. If the agent cannot emit either automatically, save a raw session summary and run `brain extract` or `brain reinforce` from a shell or hook step.
4. Never write directly into `.brain/` from the adapter.

## Adapter Matrix

| Adapter | Session start | Task known | Phase completion | Failure handling |
| --- | --- | --- | --- | --- |
| Claude Code | Hook or operator starts the first conversation from `brain start --format json`; later fresh conversations can defer to `brain conversation-start --format json` | Skill or hook reads `invocation_plan` JSON | `brain capture` at detection triggers; candidate-first | Hook emits reinforce event or calls `brain reinforce` |
| Codex | Steering rule instructs the first conversation to run `brain start --format json`; later fresh conversations use `brain conversation-start --format json` | SKILL routes on `invocation_plan` JSON | `brain capture` at detection triggers; candidate-first | Agent calls `brain reinforce` on failure |
| Cursor | `alwaysApply: true` rule instructs the first conversation to run `brain start --format json`; later fresh conversations can use `brain conversation-start --format json` | Rule file instructs agent to route on `invocation_plan` JSON | `brain capture` at detection triggers; candidate-first | Markdown fallback plus manual CLI |
| Copilot | Custom instructions consume `brain start --format json` for session bootstrap and `brain conversation-start --format json` for later fresh conversations | Custom instructions point to `invocation_plan` JSON | `brain capture` at detection triggers; candidate-first; markdown fallback if shell unavailable | Shell or CI-driven reinforce |

## Included Adapters

- [`claude/`](./claude/): Claude Code workflow, template, and limits
- [`codex/`](./codex/): Codex workflow, template, and limits
- [`cursor/`](./cursor/): Cursor rule-based adapter
- [`copilot/`](./copilot/): GitHub Copilot custom instructions adapter

Start from the relevant adapter template, keep the wording local to your team, and preserve the shared contract files above as the source of truth.
