# AI Start Here

This is the stable repository entrypoint for an AI agent that needs to work on this project without relying on the user to remember internal files, workflows, or prompts.

## If you can run repository commands

Before substantive work, run:

```bash
brain start --format json --task "<current task>"
```

Use:

- `context_markdown` as task-relevant RepoBrain memory;
- `skill_plan` as routing policy;
- `navigation_plan` to locate canonical repository sources, perform required live checks, and follow route-specific next steps.

If this is a later fresh conversation in the same session, use `brain conversation-start`. Its `start` and `inject` responses may both include `navigation_plan`; consume it whenever present.

## If you can read the repository but cannot run local commands

Read, in order:

1. `docs/brain/START_HERE.md`
2. `.brain/index.md` when it exists in the repository, then only the relevant linked active memory files
3. `docs/brain/ROUTES.yaml`
4. only the canonical sources selected by the matching route

If `.brain/index.md` is unavailable, do not silently assume there is no durable RepoBrain knowledge. Treat durable-memory context as unavailable on this surface and say so. The repository is configured so reviewed durable `.brain/` knowledge can be shared through Git; local-only runtime state remains ignored.

Do not ask the user to remember file names or internal workflow details that the repository can discover.

## Permanent rules

- `.brain/` remains the only durable RepoBrain knowledge store.
- Do not create a second memory database or copy canonical knowledge into a competing hierarchy.
- Treat branch names, PR state, SHAs, CI state, and other repository observations as dynamic facts that must be reverified live before acting.
- Prefer links/routing to canonical sources over duplicating their content.
- See `docs/brain/MIGRATION_AUDIT.md` for what this navigation layer intentionally does and does not duplicate.
