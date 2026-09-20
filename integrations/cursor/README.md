# Cursor Adapter

Cursor stays rules-first. That means the adapter is mostly workflow guidance plus markdown and JSON contract references, not a deep programmable integration.

## Workflow

```text
session start
  -> brain start --format json (via alwaysApply rule)
  -> Cursor reads context_markdown, skill_plan, and navigation_plan when present
fresh conversation later in same session
  -> brain conversation-start --format json --task "<task>" --path <path>
  -> Cursor follows RepoBrain's start / inject / skip decision
task becomes clear
  -> brain suggest-skills --format json
  -> Cursor routes on invocation_plan
phase completion detected (recurring bug fix / submodule done / multi-file refactor / tests pass / user signals done)
  -> brain capture --task "<task>" --path <path>
  -> should_extract=true  → candidate saved for review
  -> should_extract=false → no action, no prompt
failure detected
  -> brain reinforce (markdown fallback plus manual CLI)
```

## Minimal Integration

1. Copy [`repobrain.mdc`](./repobrain.mdc) to `.cursor/rules/repobrain.mdc`.
2. The `alwaysApply: true` rule makes Cursor run `brain start` in the first conversation of a session automatically.
3. If you open a fresh conversation later in the same session, run `brain conversation-start --format json --task "<task>" --path <path>` and follow the returned `action`.
4. At phase boundaries, run `brain capture --task "<task>" --path <path>` to let local rules decide.
5. Pipe a markdown summary to `brain extract` or `brain reinforce` for manual flows.

## Recommended Integration

1. Keep the rules file small and point it at the shared contract examples.
2. Use a task runner, shell alias, or editor action to fetch `brain start` for the first conversation in a session.
3. If a fresh conversation starts later in that same session, let RepoBrain decide the lightest valid refresh with `brain conversation-start --format json --task "<task>" --path <path>`.
4. Prefer JSON envelopes when you have external automation around Cursor.
5. At phase boundaries, run `brain capture` and let the local detection decide. Default is candidate-first.
6. Do not repeat the same capture suggestion in the same conversation turn.

## Limitations

- Cursor rules do not guarantee structured output emission on their own.
- Most teams will rely on manual or shell-assisted extraction and reinforcement.
- The adapter should not become a Cursor-only memory layer or project-note system.
