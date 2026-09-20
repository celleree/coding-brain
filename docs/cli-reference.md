# CLI Reference

Complete command reference moved from `README.md`.

## Core Setup

- `brain init`: initialize `.brain/` in current repo and generate steering rules
- `brain setup`: initialize `.brain/`, apply workflow preset, optionally install low-risk post-commit hook

## Extraction and Capture

- `brain extract`: extract durable memory from `stdin`
- `brain extract --type working`: force output memory type to `working`
- `brain extract --type goal`: force output memory type to `goal`
- `brain extract-commit`: extract from richer git commit context
- `brain suggest-extract`: local heuristic check for whether extraction is worth doing
- `brain capture`: suggest-extract + extract in one step, candidate-first by default
- `brain import <files...>`: import existing rule files such as `AGENTS.md`, `CLAUDE.md`, `CONVENTIONS.md`, or `.cursorrules` into candidate memories
- `brain import <files...> --dry-run`: preview parsed memories without writing files
- `brain import <files...> --type <type>`: force imported memories to a specific type
- `brain import <files...> --format json`: print machine-readable import summary

Examples:

```bash
cat session-summary.txt | brain extract
brain suggest-extract --task "fix refund bug" --path src/payments/handler.ts --json
echo "gotcha: retry loop exits too early" | brain capture --task "fix refund bug" --path src/payments/handler.ts
brain import AGENTS.md CONVENTIONS.md
brain import AGENTS.md --dry-run --format json
```

## Context and Routing

- `brain inject`: build compact repo-context block when you explicitly want a lightweight durable-context refresh
- `brain conversation-start`: decide whether a fresh conversation should run the full session bundle, reload compact context, or skip a redundant refresh
- `brain suggest-skills`: build deterministic skill routing plan
- `brain route` / `brain start`: return the combined context + routing bundle for session bootstrap

Examples:

```bash
brain inject --task "refactor config loading" --path src/config.ts --path src/cli.ts --module cli
brain conversation-start --format json --task "refactor config loading" --path src/config.ts
brain suggest-skills --task "debug flaky browser tests" --path tests/e2e/login.spec.ts
brain start --format json --task "fix refund bug"
```

## Candidate Review and Promotion

- `brain review`: inspect candidate memories
- `brain approve <id>` / `brain approve --safe` / `brain approve --all`
- `brain dismiss <id>` / `brain dismiss --all`
- `brain promote-candidates [--dry-run]`: auto-promote strict safe candidates when enabled

## Memory Management

- `brain list [--type <type>] [--goals]`
- `brain diff [--since <iso-date>] [--since-days <n>] [--format text|json]`: inspect memory changes since the last inject/context load or a caller-selected time window
- `brain search "<query>" [--type] [--tag] [--status] [--all] [--json]`
- `brain stats`
- `brain goal done <keyword>`
- `brain supersede <new-memory-file> <old-memory-file>`
- `brain lineage [<file>]`
- `brain timeline [<file-or-id>] [--preferences]`
- `brain explain-memory <id>`
- `brain explain-preference <id>`

Examples:

```bash
brain diff
brain diff --since-days 7
brain diff --since 2026-04-01T00:00:00Z --format json
```

## Hygiene and Diagnostics

- `brain status`
- `brain next`
- `brain audit-memory [--json]`
- `brain score`
- `brain sweep [--dry-run|--auto]`
- `brain gc`: alias for `brain sweep --auto` with a compact cleanup summary line
- `brain lint-memory`
- `brain normalize-memory`

## Reinforcement and Feedback

- `brain reinforce --pending`
- `brain reinforce < session-summary.txt`
- `brain routing-feedback` (JSON array or NDJSON from stdin)
- `brain routing-feedback --explain <skill>`
- `brain routing-feedback --ack-reminders`

## Team and Integrations

- `brain share <memory-id>`: explicitly share one verified active memory plus the portable shared index
- `brain share --all-active`: share all verified active memories
- `brain share --include-source-evidence`: also include only the selected memories' exact verified provenance blobs
- `brain mcp`

## Global Debugging

- Use `brain --debug ...` or `REPOBRAIN_DEBUG=1` for internal stack traces.
- User-facing usage errors remain concise on `stderr` with exit code `1`.
