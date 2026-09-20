# RepoBrain Instructions For Copilot

Use RepoBrain as the repository's durable memory layer. This adapter consumes shared RepoBrain contracts and routes durable outputs back through Core.

## Command Resolution (Dev Fallback)

All `brain <args>` invocations in this document follow this priority:

1. `brain <args>` — use directly when globally installed
2. `npx brain <args>` — use when the global binary is unavailable
3. `node dist/cli.js <args>` — only when working inside the RepoBrain development repo itself and `dist/cli.js` exists

Resolution: try `brain --version` first; on failure try `npx brain --version`; if both fail, check whether the repo root `package.json` has `"name": "brain"` and `dist/cli.js` exists, then use path 3. Published user repos will almost always hit path 1.

## Session Start

- Prefer `brain start --format json --task "<current task>"` in the first conversation of a session.
- Read `context_markdown` as compact repo context; use `skill_plan` as routing reference; consume `navigation_plan` whenever present to load canonical sources, perform live checks, and follow next steps.
- Treat the payload as Core-owned context, not as Copilot-owned memory.
- If a fresh conversation opens later in the same session, run `brain conversation-start --format json --task "<current task>" --path <changed-path>` and follow the returned `action`.
- If `brain start` is unavailable, fall back to `brain inject --task "<current task>" --path <changed-path>`.
- When the result path is a direct `brain inject`, consume the markdown contract shown in `integrations/contracts/session-start.inject.md`.

## Task Known

- Read `brain suggest-skills --format json --task "<current task>" --path <changed-path>`.
- Use `invocation_plan` as the routing contract shown in `integrations/contracts/task-known.invocation-plan.json`.
- Follow the listed checks when planning and verifying the work.

## Phase-Completion Detection

When one of these triggers fires, **run the local detection command** instead of relying on subjective judgment:

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
- If Copilot cannot run shell commands directly, save a markdown summary and hand it to `brain extract` from the shell.

## Failure Reinforcement

- When the task violates a known memory or repeats an old failure, emit the event shape from `integrations/contracts/failure.reinforce-event.json`.
- Route the result through `brain reinforce`.
- If structured output is unavailable, save a markdown failure summary and hand it to `brain reinforce`.

## Routing Feedback

- Contract: `integrations/contracts/routing-feedback.event.json`. Pipe JSON to `brain routing-feedback` from a shell when possible (`--json` for structured output).
- Too heavy / user rejects a workflow or skill → `workflow_too_heavy` or `skill_rejected_by_user` with clear `notes`.
- Agent ignored `invocation_plan` guidance → `skill_ignored` with `skill` and evidence in `notes`.
- Success with user approval of the routing → `skill_followed` or `workflow_success`.
- Explain impact: `brain routing-feedback --explain <skill>`. Reminders show next to `brain reinforce --pending`; clear with `brain routing-feedback --ack-reminders`.

## Constraints

- `.brain/` is the source of truth for durable repo knowledge. Do not create a second memory store.
- `brain start` / `brain inject` gives context; `brain suggest-skills` gives routing.
- `brain capture` and `brain extract` are the extraction paths; `brain reinforce` is the failure path.
- Default candidate-first: extracted memories are saved as candidates for user review and approval.
- Do not create Copilot-only memory files that duplicate RepoBrain decisions, gotchas, conventions, or patterns.
- Never write directly into `.brain/`.
