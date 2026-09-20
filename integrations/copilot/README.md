# Copilot Adapter

GitHub Copilot works best as a contract-aware custom-instructions adapter. It can consume RepoBrain context well, but durable writes usually happen through a shell or CI step.

## Workflow

```text
session start
  -> brain start --format json (preferred); brain inject (fallback)
  -> Copilot reads context_markdown, skill_plan, and navigation_plan when present
fresh conversation later in same session
  -> brain conversation-start --format json --task "<task>" --path <path>
  -> Copilot follows RepoBrain's start / inject / skip decision
task becomes clear
  -> brain suggest-skills --format json
  -> Copilot routes on invocation_plan
phase completion detected (recurring bug fix / submodule done / multi-file refactor / tests pass / user signals done)
  -> brain capture --task "<task>" --path <path>
  -> should_extract=true  → candidate saved for review
  -> should_extract=false → no action, no prompt
  -> if shell unavailable, save markdown summary for manual brain extract
failure detected
  -> brain reinforce (shell or CI-driven)
```

## Minimal Integration

1. Copy [`copilot-instructions.md`](./copilot-instructions.md) to `.github/copilot-instructions.md`.
2. Run `brain start --format json` in the first conversation of a session before significant changes.
3. If you open a fresh conversation later in the same session, run `brain conversation-start --format json --task "<task>" --path <path>` and follow the returned `action`.
4. Run `brain suggest-skills --format json` for task-aware routing.
5. At phase boundaries, run `brain capture` to let local rules decide. Default is candidate-first.
6. Use markdown summaries for `brain extract` and `brain reinforce` when shell is not available.

## Recommended Integration

1. Keep Copilot instructions focused on consuming the shared contract.
2. Use repo scripts, Actions, or local shell helpers to collect `brain start` for the first conversation in a session.
3. If a fresh conversation starts later in that same session, let RepoBrain decide the lightest valid refresh with `brain conversation-start --format json --task "<task>" --path <path>`.
4. At phase boundaries, run `brain capture` and let the local detection decide.
5. If your workflow already has external tooling, emit the shared JSON envelopes for extract candidates and reinforce events.
6. Keep RepoBrain Core responsible for review and durable writes.
7. Do not repeat the same capture suggestion in the same conversation turn.

## Limitations

- Copilot custom instructions are not a durable memory store.
- Most Copilot flows will rely on markdown summaries or external scripts for session-end writes.
- The adapter should stay lightweight and avoid turning into a Copilot-specific SDK.
