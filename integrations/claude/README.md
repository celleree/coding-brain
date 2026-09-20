# Claude Adapter

Claude Code is the richest thin adapter because it can combine a skill file with session hooks, but it still consumes and emits the same RepoBrain contract as every other adapter. Claude may already have its own task or action selection behavior; RepoBrain does not replace that. It adds repo-local, deterministic, auditable routing policy on top.

## Workflow

```text
session start hook
  -> brain start --format json
  -> Claude reads context_markdown, skill_plan, and navigation_plan when present
fresh conversation later in same session
  -> brain conversation-start --format json --task "<task>" --path <path>
  -> Claude follows RepoBrain's start / inject / skip decision
task becomes clear
  -> brain suggest-skills --format json (optional direct routing payload)
  -> Claude routes on invocation_plan when needed
phase completion detected (recurring bug fix / submodule done / multi-file refactor / tests pass / user signals done)
  -> brain capture --task "<task>" --path <path>
  -> should_extract=true  → candidate saved for review
  -> should_extract=false → no action, no prompt
failure detected
  -> emit reinforce event via brain reinforce
```

## Minimal Integration

1. Copy [`SKILL.md`](./SKILL.md) into your Claude skill location.
2. Prefer `brain start --format json --task "<task>"` in the first conversation of a session before non-trivial work.
3. If you open a fresh conversation later in the same session, run `brain conversation-start --format json --task "<task>" --path <path>` and follow the returned `action`.
4. Use `brain suggest-skills --task "<task>"` when you want to inspect the raw routing payload manually.
5. At phase boundaries, run `brain capture --task "<task>" --path <path>` to let local rules decide whether extraction is worthwhile.
6. Pipe a failure summary to `brain reinforce` when a known memory is violated.

## Recommended Integration

1. Keep the skill file as the human-readable contract adapter.
2. Use the existing RepoBrain session-start hook to fetch `brain start --format json` for the first conversation automatically.
3. If a fresh conversation opens later in the same session, let RepoBrain decide the lightest valid refresh with `brain conversation-start --format json --task "<task>" --path <path>`.
4. At phase boundaries, run `brain capture` and let the local detection decide. Default is candidate-first.
5. When only routing is needed after the task becomes clearer, consume `brain suggest-skills --format json` and route on `invocation_plan`.
6. When a failure violates an existing memory, send the failure event to `brain reinforce`.
7. Do not repeat the same capture suggestion in the same conversation turn.

## Limitations

- Claude-specific hooks can improve ergonomics, but they are optional wrappers around the same Core commands.
- Adapters should not treat Claude tool calls as a separate durable schema.
- Adapters must not write directly into `.brain/`; durable writes still go through `brain extract` or `brain reinforce`.
- If hooks are unavailable, Claude falls back cleanly to markdown summaries and manual CLI steps.
