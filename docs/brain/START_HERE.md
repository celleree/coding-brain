# Agent Navigation Bootstrap

## Purpose

This directory is a navigation layer, not a second knowledge store.

Its job is to let an AI start from a vague user intent such as "continue the project", "fix this review finding", or "what should I do next?" and discover the right RepoBrain context, canonical files, and live checks without requiring the user to remember the repository's internal structure.

Durable project knowledge remains in `.brain/`. Existing canonical documentation and source files remain authoritative at their current paths.

## Bootstrap

### Shell-capable agent

Run:

```bash
brain start --format json --task "<current task>"
```

Consume all applicable parts of the result:

- `context_markdown`: task-relevant durable RepoBrain memory;
- `skill_plan`: deterministic routing policy;
- `navigation_plan`: canonical source paths, live checks, and route-specific next steps.

For a later fresh conversation in the same session, follow the existing `brain conversation-start` contract. Both `start` and `inject` outcomes may carry `navigation_plan`; consume it whenever present.

### Repository-reading agent without shell access

1. Read `AI_START_HERE.md`.
2. Read `.brain/index.md` when it is available in Git, then load only relevant active memory files it points to.
3. Read `docs/brain/ROUTES.yaml`.
4. Classify the user's intent into the closest route.
5. Load the route's canonical sources only.
6. Inspect directly relevant code/tests as needed.
7. Reverify live GitHub state before relying on branch, PR, SHA, review, or CI facts.

If `.brain/index.md` is missing, explicitly mark durable RepoBrain memory as unavailable to the repository-reading surface. Do not infer that no memory exists.

Reviewed durable RepoBrain knowledge is intended to be Git-shareable. Local-only runtime/session state stays excluded by `.brain/.gitignore`. A shell-capable operator can use `brain share --all-active` to prepare active durable memory for Git review when needed.

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

Do not dump every document into the model. Start with task-relevant durable memory plus route-selected canonical sources, then expand only when evidence shows another source is needed.

This keeps relevant information near the task and avoids burying critical instructions inside an oversized context window.

## Durable knowledge rule

Do not manually copy decisions, gotchas, conventions, patterns, goals, or routing preferences into this directory.

Those belong to the existing RepoBrain capture/review flow and `.brain/` store. This navigation layer should point to durable knowledge rather than fork it.

## Task routing

`ROUTES.yaml` contains stable task classes and canonical source IDs. Agents should choose the closest matching route and may combine routes when a task genuinely spans more than one concern.

The runtime matcher tolerates simple wording differences and reports when no route matched and the fallback route was used. Do not silently treat a fallback as a confident classification.

Unknown tasks should start from the `continue_project` route, then narrow after inspecting the evidence.

## User experience target

The user should be able to give intent rather than orchestration instructions.

Examples that should be sufficient:

- "Continue this project."
- "Fix this review finding."
- "Take over PR #123."
- "Why did CI fail?"
- "What should we build next?"
- "Review this exact HEAD."

The agent is responsible for locating the workflow and sources needed to execute that intent.

## Preservation

No legacy source is moved or deleted by this navigation foundation. See `MIGRATION_AUDIT.md` for the preservation record and for sources that are intentionally not duplicated into the bootstrap layer.
