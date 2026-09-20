# RepoBrain

<p align="center">
  <img src="./docs/assets/repobrain-logo.png" alt="RepoBrain logo" width="720" />
</p>

**Git-friendly repo memory for coding agents.**

[English](./README.md) | [中文](./README.zh-CN.md)

<p align="center">
  <a href="https://www.npmjs.com/package/repobrain"><img src="https://img.shields.io/npm/v/repobrain?label=npm" alt="npm version" /></a>
  <a href="https://github.com/XD319/RepoBrain/blob/main/package.json"><img src="https://img.shields.io/badge/node-%3E%3D20-339933" alt="Node >=20" /></a>
  <a href="https://github.com/XD319/RepoBrain/blob/main/LICENSE"><img src="https://img.shields.io/github/license/XD319/RepoBrain" alt="License: MIT" /></a>
</p>

RepoBrain is local, Git-friendly memory infrastructure for coding agents such as Claude Code, Codex, Cursor, and Copilot. It turns architecture decisions, gotchas, conventions, and reusable patterns into reviewable repo artifacts so your agent can carry project context across sessions instead of relearning it every time.

## Why RepoBrain

- Keep durable repo knowledge in `.brain/` as plain Markdown plus frontmatter.
- Review memory changes with normal Git workflows instead of hiding them in a hosted black box.
- Re-inject the right context with `brain conversation-start`, `brain inject`, `brain suggest-skills`, and `brain route`.

## Quick Start

### Prerequisites

- Node.js `>=20`
- A Git repository you want your agent to remember

### Install

```bash
npm install -g repobrain
brain --version
```

`brain` and `repobrain` point to the same CLI. If you prefer not to install globally, the generated steering rules also document `npx brain` and `node dist/cli.js` fallbacks.

### Recommended setup

```bash
brain setup
```

`brain setup` is the recommended onboarding path. It initializes `.brain/`, applies the default workflow preset, can install the matching low-risk Git hook, and can generate steering rules for supported agent tools. If you only want the workspace and steering rules without setup automation, use `brain init`.

### 60-second flow

In the default `recommended-semi-auto` mode, RepoBrain handles the repetitive capture loop for you: `brain setup` can install the matching low-risk Git hook, extraction opportunities are auto-detected during normal Git work, and new memories land in the candidate queue for review instead of becoming active immediately.

```bash
# One-time setup: initialize .brain/ and install the default low-risk hook
brain setup

# If the repo already has AGENTS.md or similar guidance, migrate it into candidate memories first
brain import AGENTS.md CONVENTIONS.md

# Work normally; the default mode auto-detects extraction opportunities
git commit -m "refactor request validation"

# You can still capture explicit takeaways when needed
echo "decision: keep API validation at the controller boundary" | brain capture --task "stabilize request validation"

# Review the auto-detected + manually captured candidate queue
brain review
brain approve --safe

# Start a new session with context plus routing
brain start --format json --task "continue request validation cleanup"

# If a fresh conversation opens later in the same session, let RepoBrain decide
brain conversation-start --format json --task "continue request validation cleanup"

# Build context plus routing hints for a task-aware agent session
brain route --task "refactor request validation" --format json
```

Default loop summary: bootstrap a new session with `brain start`, let later fresh conversations in that same session use `brain conversation-start` for a smart `start` / `inject` / `skip` decision, auto-detect during regular work, queue candidates for review, then use `brain approve --safe` for the obvious wins and `brain approve <id>` for edge cases.

Optional interactive UI:

```bash
brain tui
```

The TUI now includes a dedicated `Search` screen for debounced keyword lookup with type filtering and result detail drill-down. Use `6` to open it from the navigation bar.

## Choose A Workflow Preset

RepoBrain ships with three workflow presets so teams can choose how much automation they want without changing the core CLI contract.

| Preset | Best for | Capture style | Promotion style |
| --- | --- | --- | --- |
| `ultra-safe-manual` | Strict human-controlled repos | Manual extraction only | Manual approval only |
| `recommended-semi-auto` | Most teams and solo repos | Detect opportunities, save as candidate | Manual review with fast safe approval |
| `automation-first` | Mature repos with stable review discipline | Detect opportunities, save as candidate | Safe auto-promotion when checks pass |

Examples:

```bash
brain setup --workflow ultra-safe-manual
brain setup --workflow recommended-semi-auto
brain setup --workflow automation-first
```

See [docs/workflow-modes.md](./docs/workflow-modes.md) for the full preset comparison and the recommended default loop.

## How It Fits In The Repo

RepoBrain keeps memory local to the repository:

```text
.brain/
  decisions/
  gotchas/
  conventions/
  patterns/
  preferences/
  runtime/session-profile.json
  index.md
```

- Durable knowledge such as decisions, gotchas, conventions, and patterns is meant to stay in Git.
- Preferences in `.brain/preferences/` steer routing choices such as preferred or avoided skills and workflows.
- Runtime data in `.brain/runtime/` is session-scoped and can stay ephemeral.

## Core Commands

| Goal | Command | What it gives you |
| --- | --- | --- |
| Initialize a repo | `brain setup`, `brain init` | Create `.brain/`, apply a workflow preset, and optionally write steering rules |
| Capture knowledge | `brain extract`, `brain extract-commit`, `brain capture`, `brain import` | Turn stdin, commit context, session summaries, or existing rule files into candidate-first durable memory |
| Review candidates | `brain review`, `brain approve`, `brain dismiss`, `brain promote-candidates` | Keep candidate-first workflows reviewable |
| Start a task | `brain inject`, `brain conversation-start`, `brain suggest-skills`, `brain route`, `brain start` | Produce context blocks and deterministic routing plans |
| Inspect memory | `brain list`, `brain diff`, `brain search`, `brain timeline`, `brain explain-memory`, `brain explain-preference` | Explore what the repo already knows and what changed since the last inject |
| Keep things healthy | `brain status`, `brain next`, `brain audit-memory`, `brain lint-memory`, `brain normalize-memory`, `brain score`, `brain sweep` (`brain gc` alias for auto sweep) | Maintain memory quality over time |
| Team and adapters | `brain share`, `brain mcp`, `brain reinforce`, `brain routing-feedback` | Explicitly share reviewed memory, integrate adapters, and close the feedback loop |

The complete command reference lives in [docs/cli-reference.md](./docs/cli-reference.md).

### MCP Server Tools

`brain mcp` exposes the same repo memory workflow over stdio MCP for agent hosts.

- Retrieval and routing: `brain_get_context`, `brain_search`, `brain_suggest_skills`, `brain_route`, `brain_conversation_start`
- Capture and review: `brain_add_memory`, `brain_capture`, `brain_review`, `brain_approve`
- Inspection and maintenance: `brain_list`, `brain_status`, `brain_sweep`

`brain_sweep` is dry-run only in MCP and returns cleanup candidates without changing files. `brain_conversation_start` mirrors the CLI smart refresh contract and can return `start`, `inject`, or `skip`.

### Inspect Recent Memory Changes

Use `brain diff` when you want a quick read-only summary of what changed in `.brain/` since the last context load, or inside a specific time window.

```bash
brain diff
brain diff --since-days 7
brain diff --since 2026-04-01T00:00:00Z --format json
```

- Default behavior uses the last recorded `brain inject` / context-load timestamp from `.brain/activity.json`.
- `--since-days <n>` shows recent changes without needing an exact timestamp.
- `--format json` returns the same diff buckets as machine-readable JSON for scripts.

## Import Rule Files

RepoBrain now exposes a core parser for rule-oriented Markdown files such as `AGENTS.md`, `CLAUDE.md`, `CONVENTIONS.md`, and `.cursorrules`. It turns heading sections into candidate memories while preserving the existing candidate-first review flow.

```ts
import { parseRuleFileToMemories } from "repobrain";

const memories = parseRuleFileToMemories(ruleMarkdown, "AGENTS.md", {
  defaultType: "convention",
  defaultImportance: "medium",
});
```

The parser prefers explicit `decision:`, `gotcha:`, `convention:`, `pattern:`, and `goal:` prefixes, falls back to heading-based inference, skips weak sections such as table-of-contents blocks or link-only references, and returns normalized memories with `source: "manual"` plus `status: "candidate"`.

## Progressive Retrieval

RepoBrain keeps the default `brain inject` behavior compatible as the lightweight follow-up path when you explicitly want compact context, while `brain conversation-start` can decide whether a later fresh conversation in the same session should `inject`, rerun the full bundle, or skip a redundant refresh.

```bash
brain inject --layer index --task "fix refund flow"
brain inject --layer summary --task "fix refund flow"
brain inject --layer full --ids "2026-04-01-refund-boundary-090000000"
```

- `index` gives a compact retrieval list.
- `summary` keeps the familiar session-start Markdown payload.
- `full` expands explicitly selected memory bodies.

`brain route` and `brain start` can also emit lightweight expansion hints in JSON bundles, and RepoBrain can maintain a derived `.brain/memory-index.json` cache to speed up targeted lookups without changing the Markdown source of truth.

## Docs And Integrations

Use the top-level README as the onboarding path, then go deeper from here:

| Need | Go to |
| --- | --- |
| Full CLI reference | [docs/cli-reference.md](./docs/cli-reference.md) |
| Workflow presets | [docs/workflow-modes.md](./docs/workflow-modes.md) |
| Architecture and storage model | [docs/architecture.md](./docs/architecture.md) |
| Library/API usage | [docs/api.md](./docs/api.md) |
| Team rollout and evaluation | [docs/team-workflow.md](./docs/team-workflow.md), [docs/evaluation.md](./docs/evaluation.md) |
| Case studies and demo proof | [docs/case-studies](./docs/case-studies), [docs/demo-proof.md](./docs/demo-proof.md) |
| Extended integrations overview | [integrations/README.md](./integrations/README.md) |
| Agent-specific adapter setup | [integrations/claude/README.md](./integrations/claude/README.md), [integrations/codex/README.md](./integrations/codex/README.md), [integrations/cursor/README.md](./integrations/cursor/README.md), [integrations/copilot/README.md](./integrations/copilot/README.md) |

For extended integrations, adapter contracts, and agent-specific setup details, review the `/docs` and `/integrations` directories.
