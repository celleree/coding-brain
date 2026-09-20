# Agent Navigation Bootstrap

## Purpose

This directory is a navigation layer, not a second knowledge store.

Its job is to let an AI start from a vague user intent such as "continue the project", "fix this review", or "what should I do next?" and discover the right RepoBrain context, canonical files, and live checks without requiring the user to remember the repository's internal structure.

Durable project knowledge remains in `.brain/`. Existing canonical documentation and source files remain authoritative at their current paths.

## Bootstrap

### Shell-capable agent

Run:

```bash
brain start --format json --task "<current task>"
```

Use RepoBrain's returned context and routing first. Then use `ROUTES.yaml` only to locate repository sources that are needed beyond the injected memory.

For a later fresh conversation in the same session, follow the existing `brain conversation-start` contract.

### Repository-reading agent without shell access

1. Read `AI_START_HERE.md`.
2. Read `docs/brain/ROUTES.yaml`.
3. Classify the user's intent into the closest route.
4. Load the route's canonical sources only.
5. Inspect directly relevant code/tests as needed.
6. Reverify live GitHub state before relying on branch, PR, SHA, review, or CI facts.

Do not ask the user to identify internal files when the route map can determine them.

## Source-of-truth order

When sources disagree, prefer the most specific current authority:

1. explicit current user instruction;
2. current repository code, tests, config, and live Git/GitHub state;
3. task-specific canonical requirement or architecture source;
4. active durable RepoBrain memory;
5. integration/runbook guidance;
6. historical release notes, examples, demos, or old handoffs.

A handoff or document that records repository state is not proof that the state is still current.

## Context loading rule

Load the minimum context that can correctly complete the task.

Do not dump every document into the model. Start with the route-selected canonical sources, then expand only when evidence shows another source is needed.

This keeps relevant information near the task and avoids burying critical instructions inside an oversized context window.

## Durable knowledge rule

Do not manually copy decisions, gotchas, conventions, patterns, goals, or routing preferences into this directory.

Those belong to the existing RepoBrain capture/review flow and `.brain/` store. This navigation layer should point to durable knowledge rather than fork it.

## Task routing

`ROUTES.yaml` contains stable task classes and canonical source IDs. Agents should choose the closest matching route and may combine routes when a task genuinely spans more than one concern.

Unknown tasks should start from the `continue_project` route, then narrow after inspecting the evidence.

## User experience target

The user should be able to give intent rather than orchestration instructions.

Examples that should be sufficient:

- "Continue this project."
- "Fix this review finding."
- "Take over PR #123."
- "Why is CI failing?"
- "What should we build next?"
- "Review this exact HEAD."

The agent is responsible for locating the workflow and sources needed to execute that intent.

## Preservation

No legacy source is moved or deleted by this navigation foundation. See `MIGRATION_AUDIT.md` for the preservation record and for sources that are intentionally not duplicated into the bootstrap layer.
