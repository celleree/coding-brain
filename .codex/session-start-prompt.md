# Codex Session Start

Before substantial coding work:

1. Run `brain start --format json --task "<current task>"` for a new session, or `brain conversation-start --format json --task "<current task>" --path <changed-path>` for a fresh conversation in an existing workstream.
2. Read `.codex/global-routing-policy.md`.
3. Before handing work to Codex, state the selected `WHERE`, `SESSION`, `MODEL`, `REASONING`, and `PARALLEL` values.

Treat those values as task-specific routing decisions, not fixed defaults. Prefer the lowest-cost capable model/reasoning level, safe parallel work, and fresh implementation/review conversations when they improve context quality.

If RepoBrain is not initialized yet, run `brain setup`.
