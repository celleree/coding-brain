# RepoBrain Team Workflow

This guide describes the practical team path for keeping `.brain/` changes reviewable and useful instead of turning them into another source of noisy repo churn.

## Default Team Loop

1. Fix a real issue or complete a meaningful task.
2. Capture the durable lesson with `brain extract`, `brain extract-commit`, or hook-driven candidate extraction.
3. Review `.brain/` changes the same way you review code changes.
4. Approve only the memories that are still correct, specific, and worth reusing.
5. Commit the `.brain/` change with the related code change whenever the knowledge belongs with that code.

## Recommended Rules

- Keep `inject` automatic or easy to run because it is read-only.
- Keep `extract` reviewable because it writes durable repo knowledge.
- Prefer specific lessons over generic advice.
- Reject temporary debugging notes unless they will matter again later.
- Treat `.brain/` as shared project knowledge, not as personal scratch space.

## Suggested PR Flow

1. Run `brain review`.
2. Approve the candidates that still look durable.
3. Inspect the generated markdown under `.brain/`.
4. Run `brain share <memory-id>` or `brain share --all-active`.
5. Review the generated `.brain/shared/index.md` and copy the suggested force-add / commit commands.
6. By default, raw provenance source blobs stay private. Use `--include-source-evidence` only when another shell-capable checkout needs full provenance verification, and review those raw blobs before committing.
7. Open the PR with the explicitly selected `.brain/` files when they belong together.

## What Belongs In `.brain/`

Good examples:

- architecture decisions with rationale
- repo-specific gotchas that are easy to repeat
- conventions that future agents should follow
- reusable implementation or workflow patterns

Bad examples:

- one-off debugging transcripts
- local environment noise that will not matter later
- generic advice that already exists in common tooling docs
- broad notes that do not point to a clear repo-specific lesson

## Review Checklist

Before approving a memory, ask:

1. Is it specific to this repo or this team's workflow?
2. Will it still help in a later session?
3. Is the scope narrow enough to avoid noisy injection?
4. Does it duplicate or conflict with an existing memory?
5. Would I be comfortable seeing this injected into the next coding session?

## Release And Cleanup Moments

Run these before a release or before sharing a large memory batch:

```bash
brain audit-memory
brain sweep --dry-run
brain score
```

Use the release checklist in [release-checklist.md](./release-checklist.md) when preparing a public package or first release.
