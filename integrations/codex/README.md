# Codex Adapter

Codex is intentionally a thin workflow adapter. The goal is not to build a Codex SDK, but to give Codex a stable contract for consuming context and returning durable lessons. Codex may already have its own task or action selection behavior; RepoBrain does not replace that. It adds repo-local, deterministic, auditable routing policy on top.

## Workflow

```text
new session
  -> brain start --format json
  -> Codex reads context_markdown, skill_plan, and navigation_plan when present
fresh conversation later in same session
  -> brain conversation-start --format json --task "<task>" --path <path>
  -> Codex follows RepoBrain's start / inject / skip decision
task known
  -> brain suggest-skills --format json (optional direct routing payload)
  -> Codex follows invocation_plan when needed
phase completion detected (recurring bug fix / submodule done / multi-file refactor / tests pass / user signals done)
  -> brain capture --task "<task>" --path <path>
  -> should_extract=true  → candidate saved for review
  -> should_extract=false → no action, no prompt
task failed or repeated an old mistake
  -> Codex emits reinforce event via brain reinforce
```

## Minimal Integration

1. Copy [`SKILL.md`](./SKILL.md) into your Codex instructions area.
2. Prefer `brain start --format json --task "<task>"` in the first conversation of a session before non-trivial edits.
3. If you open a fresh conversation later in the same session, run `brain conversation-start --format json --task "<task>" --path <path>` and follow the returned `action`.
4. Use `brain suggest-skills --task "<task>"` when you want to inspect the raw routing payload manually.
5. At phase boundaries, run `brain capture --task "<task>" --path <path>` to let local rules decide.
6. Pipe a failure summary to `brain reinforce` when a known memory is violated.

## Recommended Integration

1. Keep the SKILL file as the adapter contract.
2. Use lightweight automation or shell aliases to fetch `brain start --format json` for the first conversation in a session.
3. When a fresh conversation starts later in that same session, let RepoBrain decide the lightest valid refresh with `brain conversation-start --format json --task "<task>" --path <path>`.
4. When only routing is needed later, consume `brain suggest-skills --format json` and route on `invocation_plan`.
5. At phase boundaries, run `brain capture` and let the local detection decide. Default is candidate-first.
6. Emit the reinforce event JSON envelope when the change violated an old memory or repeated a known failure.
7. Do not repeat the same capture suggestion in the same conversation turn.

## Limitations

- Codex instructions do not provide a first-class durable memory store, so RepoBrain remains the only durable source.
- Most Codex setups will use shell-driven extraction and reinforcement instead of deep UI-native hooks.
- Adapters must not write directly into `.brain/`; durable writes still go through RepoBrain Core.
- When structured JSON is awkward, the markdown fallback is the expected path rather than a degraded one.
