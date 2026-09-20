# Agent Navigation Migration Audit

## Migration policy

This change uses a preservation-first migration.

Existing project knowledge was not moved, renamed, rewritten, or deleted. The navigation layer points agents to existing canonical sources so a new hierarchy cannot silently fork or replace established knowledge.

## Added navigation files

- `AI_START_HERE.md`
- `docs/brain/START_HERE.md`
- `docs/brain/ROUTES.yaml`
- `docs/brain/MIGRATION_AUDIT.md`

## Runtime integration

The navigation layer is also consumed automatically by existing task routing:

- `src/agent-navigation.ts` loads and validates `docs/brain/ROUTES.yaml` when present.
- `src/task-routing.ts` adds the selected route as `navigation_plan` in the normal task-routing bundle.
- Because `brain start` and `brain conversation-start` already consume task routing, shell-capable agents receive navigation without requiring the user to remember this file system.
- `src/index.ts` and `src/store-api.ts` expose the navigation planner programmatically.
- If a project does not have `docs/brain/ROUTES.yaml`, existing RepoBrain routing remains compatible.

## Existing information brought into the new navigation layer by reference

The route map links to these existing authorities rather than copying their contents:

- `docs/architecture.md`
- `docs/schema.md`
- `docs/temporal-semantics.md`
- `docs/cli-reference.md`
- `docs/api.md`
- `integrations/README.md`
- `integrations/codex/SKILL.md`
- `integrations/codex/README.md`
- `.codex/global-AGENTS.md`
- `package.json`
- `src/index.ts`
- `src/types.ts`
- `src/orchestrator-lifecycle.ts`
- `src/orchestrator-rotation.ts`
- `src/orchestrator-checkpoint-api.ts`
- `src/orchestrator-runtime-health.ts`
- `docs/release-checklist.md`
- `docs/release-guide.md`

The original files remain the source of truth.

## Not brought into the bootstrap layer

The following information was intentionally not copied into the new navigation files.

### Durable `.brain/` records

Not copied because RepoBrain already owns that knowledge lifecycle. Decisions, gotchas, conventions, patterns, goals, working context, preferences, provenance, indexes, orchestration checkpoints, and runtime overlays must continue through the existing RepoBrain APIs and storage rules.

### GitHub branch, PR, SHA, CI, review, and issue state

Not copied because these facts become stale. The navigation layer tells agents to reverify them live instead.

### Historical release notes

Paths such as `docs/releases/**` remain available at their original locations but are not bootstrap context because they describe historical states rather than current behavior.

### Demo, proof, case-study, and example artifacts

Paths such as `docs/demo-assets/**`, `docs/case-studies/**`, and `examples/**` remain intact. They are loaded only when the task is about demos, evaluation, proof, examples, or release evidence.

### Translated documentation

Files such as `README.zh-CN.md` and `docs/*.zh-CN.md` remain intact. The route map points at one canonical path per topic to avoid loading duplicate translations into the same context window.

### Non-Codex adapter detail

Claude, Cursor, and Copilot adapter files remain intact under `integrations/`. They are not part of the default Codex route and should be loaded when the active agent/task requires them.

### Tests

`test/**` remains the executable verification source. Individual test files are not listed as bootstrap sources because the agent should inspect tests connected to the code being changed rather than preloading the entire suite.

### Unlisted implementation files

Source files that are not stable cross-task entrypoints remain at their current paths and are discovered just in time from the task, imports, failing tests, or direct code relationships.

## Information discarded as unimportant

None.

This foundation deliberately discards no existing information. "Not brought into the bootstrap layer" means "retained at the existing canonical location and loaded only when relevant", not deleted or deprecated.

## Future migration rule

If a later change actually moves, consolidates, supersedes, or deletes existing knowledge, update this audit in the same change with:

- original path/source;
- destination or replacement;
- whether content was copied, summarized, superseded, or intentionally dropped;
- reason for any dropped content;
- verification that active routes no longer reference the old source.
