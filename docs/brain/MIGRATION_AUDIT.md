# Agent Navigation Migration Audit

This audit records how the navigation foundation relates to existing RepoBrain knowledge and integrations.

## Preservation result

No existing knowledge file is deleted or renamed by the navigation stack.

Information discarded as unimportant: **None.**

The navigation layer references canonical sources instead of copying their contents.

## Canonical sources retained

Existing sources remain authoritative at their original paths, including:

- `README.md`
- `docs/architecture.md`
- `docs/schema.md`
- `docs/workflow-modes.md`
- `docs/team-workflow.md`
- `docs/cli-reference.md`
- `docs/api.md`
- `.codex/INSTALL.md`
- `.codex/session-start-prompt.md`
- `.codex/global-AGENTS.md`
- integration contracts under `integrations/`
- orchestrator lifecycle/rotation/checkpoint/runtime-health source
- release checklist and release guide

`docs/brain/ROUTES.yaml` is an index/router over those sources, not a replacement for them.

## Durable-memory bridge

Local `.brain/` state remains ignored by default.

Default `brain share`:

- verifies each selected active memory before sharing;
- force-adds only selected memory records and `.brain/shared/index.md`;
- excludes raw source blobs.

`brain share --include-source-evidence` additionally includes only the exact provenance blobs required by the selected records after verification.

`.brain/shared/index.md` is the repository-reading entrypoint for explicitly shared durable memory. Its absence means shared durable-memory context is unavailable on that surface; it does not prove the local store is empty.

## Runtime/session compatibility

Navigation extends existing:

- `brain start`
- `brain route`
- `brain conversation-start`
- skill routing
- session-profile behavior

It does not replace those systems or create a parallel durable store.

## Dynamic state

PR state, SHAs, CI, branches, deployments, and similar facts remain live-verified state. Navigation documents must not freeze them as current authority.
