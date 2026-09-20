# RepoBrain Codex Contract

Use RepoBrain as the shared repo-memory layer for Codex sessions. Codex may already have its own task or action selection behavior; RepoBrain does not replace that. It adds repo-local, deterministic, auditable routing policy on top.

## Command Resolution (Dev Fallback)

All `brain <args>` invocations in this document follow this priority:

1. `brain <args>` — use directly when globally installed
2. `npx brain <args>` — use when the global binary is unavailable
3. `node dist/cli.js <args>` — only when working inside the RepoBrain development repo itself and `dist/cli.js` exists

Resolution: try `brain --version` first; on failure try `npx brain --version`; if both fail, check whether the repo root `package.json` has `"name": "brain"` and `dist/cli.js` exists, then use path 3. Published user repos will almost always hit path 1.

## Session Start

Prefer the session-start bundle:

`brain start --format json --task "<current task>"`

Contract:

- Use this in the first conversation of a coding session.
- Read `context_markdown` before planning or editing. Consume `navigation_plan` whenever present: load its canonical source paths, perform its live checks, and follow its next steps.
- Use `skill_plan` as RepoBrain's routing policy input, not as a replacement for Codex-native workflow choices.
- Treat the payload as Core-owned context and routing, not a Codex-owned schema.

If a fresh conversation opens later in the same session, Codex should run and consume:

`brain conversation-start --format json --task "<current task>" --path <changed-path>`

Contract:

- Prefer this for later fresh conversations in the same session so RepoBrain can decide whether to rerun the full bundle, load compact context, or skip a redundant refresh.
- Input shape is JSON with `action`, `reason`, and either `context_markdown` or a full routing bundle.
- When `action` is `inject`, use `context_markdown` to load durable repo context before planning or editing.
- When `action` is `start`, consume the returned bundle exactly like `brain start`.
- When `action` is `skip`, continue with the current conversation state unless you explicitly need `brain inject`.

Reference example:

- `integrations/contracts/session-start.inject.md`

## Task Known

Run and consume:

`brain suggest-skills --format json --task "<current task>" --path <changed-path>`

Contract:

- Use `invocation_plan` for workflow routing.
- Use `checks` to keep verification visible.
- Treat this as the canonical task-known routing payload, not as the default everyday manual entrypoint.
- Do not convert the plan into Codex-only memory.

Reference example:

- `integrations/contracts/task-known.invocation-plan.json`

## Phase-Completion Detection

When one of the following triggers fires, **run the local detection command** instead of relying on subjective judgment:

**Strong signals (run detection immediately):**
- User signals phase completion ("done / ship it / looks good / move on / ready for review")
- Agent just output a completion summary ("fixed / implemented / completed / all tests passing")
- Tests went from failing to passing
- Diff scope exceeds threshold: 30+ lines changed or 4+ files modified

**Signals that require content-value context:**
- Fixed a recurring bug
- Completed a submodule implementation
- Refactored across multiple files

**Weak signals that should NOT trigger detection:**
- User only said "ok / thanks / sure / got it" without substantive context
- No meaningful changes or learnings accompany the acknowledgment

### Composing Extraction Input

`brain capture` reads a session summary from stdin. **You must pipe structured content** — without it, the local heuristic extractor cannot detect meaningful signals.

Each insight must start with a **type prefix** in the format `<type>: <content>`, where type is one of `decision` / `gotcha` / `convention` / `pattern` / `working` / `goal`. Content should include **rationale or constraints** (e.g. "because…", "to avoid…", "otherwise…"), not just describe what was done.

**Template:**

```bash
echo "<session_summary>" | brain capture --task "<task description>" --path <changed-path>
```

Compose `<session_summary>` from insights that actually emerged during the session:

1. Review the phase for key decisions, pitfalls, conventions, patterns, or temporary context
2. Start each insight with the matching type prefix, one per line
3. Separate multiple insights with newlines
4. **Do not fabricate insights** — only extract knowledge that actually occurred and would help future sessions
5. If no insights are worth preserving after review, do not call capture

**Example (assuming these topics were actually discussed):**

```bash
echo "decision: chose pnpm workspaces for the monorepo because npm hoisting causes phantom dependencies
gotcha: tsconfig paths must align with package.json exports, otherwise runtime resolution fails
convention: new modules go under packages/ with index.ts as the entry point" | brain capture --task "set up monorepo structure" --path packages/
```

Rules:

- `brain capture` uses phase-completion signals as a confidence booster, not a direct trigger. Even when phase completion is detected, `should_extract` stays `false` if the content lacks durable value (e.g. typo fix, debug log).
- When `should_extract=true`, the result is saved as a **candidate** by default, not active.
- When `should_extract=false`, do not prompt the user.
- Do not repeat the same capture suggestion in the same conversation turn unless the change scope or task state changed significantly.

## Failure Reinforcement

When the session violated a known memory or repeated a failure pattern:

- emit the JSON event from `integrations/contracts/failure.reinforce-event.json`
- then hand it to `brain reinforce`
- if JSON is awkward, summarize the failure in markdown and pipe it to `brain reinforce`

## Routing Feedback (local policy loop)

Contract: `integrations/contracts/routing-feedback.event.json`. Pipe JSON (array or NDJSON) to `brain routing-feedback`; add `--json` for machine-readable output. RepoBrain does **not** orchestrate execution—it learns from outcomes.

- User calls the flow too heavy / do not repeat → `workflow_too_heavy` or `skill_rejected_by_user` with `notes`.
- Plan suggested a skill but the agent ignored it → `skill_ignored` with `skill` + `notes` (and `invocation_plan_id` when available).
- User confirms success aligned with routing → `skill_followed` or `workflow_success`.

Use `brain routing-feedback --explain <skill>` to see preference + log impact. Queued reminders appear when running `brain reinforce --pending`; clear with `brain routing-feedback --ack-reminders`.

## Guardrails

- `.brain/` is the only durable knowledge store. Do not create a second memory store.
- RepoBrain is the routing/memory layer; it does not replace Codex-native action selection.
- `brain start` / `brain inject` gives context; `brain suggest-skills` gives routing.
- `brain capture` and `brain extract` are the extraction paths; `brain reinforce` is the failure path.
- Default candidate-first: extracted memories are saved as candidates for user review and approval.
- Never write directly into `.brain/`.
- Keep existing CLI behavior compatible unless the task explicitly changes it.
- Prefer thin contract translation over deep Codex-specific integration logic.
