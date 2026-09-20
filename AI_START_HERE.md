# AI Start Here

Use this file as the repository-reading entrypoint for AI agents.

1. Read `docs/brain/START_HERE.md`.
2. Use `docs/brain/ROUTES.yaml` to select the task route.
3. Load only the canonical sources listed by that route.
4. Reverify dynamic Git/GitHub facts before acting.
5. Treat `.brain/` as RepoBrain's only durable knowledge store.

If `.brain/shared/index.md` exists, it is the portable index of memories explicitly shared through Git.
If it is absent, durable-memory context is unavailable on this repository-reading surface; do not infer that no RepoBrain memory exists.

For shell-capable agents, prefer `brain start` for the first task-aware conversation and `brain conversation-start` for later fresh conversations in the same session.
