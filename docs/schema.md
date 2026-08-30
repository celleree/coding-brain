# Schema Reference

Detailed frontmatter and schema guidance moved from `README.md`.

## Memory Types

- `decision`
- `gotcha`
- `convention`
- `pattern`
- optional: `working`, `goal`

## Common Frontmatter Fields

- `type`
- `title`
- `summary`
- `detail`
- `importance`
- `date`
- `tags`

## Lifecycle and Ranking Fields

- `score` (default `60`)
- `hit_count` (default `0`)
- `last_used` (default `null`)
- `created_at` (default from `date`)
- `created` (date-only, default from `created_at`)
- `updated` (date-only, default from `created`)
- `stale` (default `false`)
- `status` (for example `active`, `done`, `stale`, `candidate`, `superseded`)
- `review_state` (`unset`, `pending_review`, `cleared`)

## Lineage and Relationship Fields

- `supersedes`
- `superseded_by`
- `version` (default `1`)
- `related`
- `supersession_reason`

## Scope and Domain Fields

- `path_scope`
- `files`
- `area`
- `expires`
- `origin`
- `source_episode`
- `record_digest`

`source_episode` is the shared `sha256:<digest>` identity of the exact raw source bytes stored under
`.brain/sources/sha256/`. `record_digest` separately attests the normalized persisted record and its
`.brain`-relative path. Source blobs are evidence only: they are not indexed, injected, ranked, or routed.

New writes and promotions require valid provenance. Injection and routing exclude active records whose source blob
or record attestation does not verify. Normalization preserves provenance fields as written and never creates or
repairs them.

## Temporal Validity Fields

- `valid_from`
- `valid_until`
- `observed_at`
- `confidence` (0-1, default `1`)

## Skill Routing Fields

- `recommended_skills`
- `required_skills`
- `suppressed_skills`
- `skill_trigger_paths`
- `skill_trigger_tasks`
- `invocation_mode` (`required` / `prefer` / `optional` / `suppress`)
- `risk_level` (`high` / `medium` / `low`)

## Compatibility and Defaults

When routing fields are omitted, RepoBrain keeps backward compatibility through safe defaults:

- list fields -> `[]`
- `invocation_mode` -> `optional`
- `risk_level` -> `low`
- lifecycle metadata auto-filled when absent

## Best Practices

- Keep memories concise but causal ("what + why")
- Use short stable tags, avoid tag spam
- Avoid repeating the same path in both `path_scope` and `files`
- Add skill metadata only when trigger conditions are clear
- Let lint/normalize perform safe autofill instead of manual mass migration

## Governance Commands

```bash
brain lint-memory
brain normalize-memory
```

`lint-memory` reports schema issues and conflicts.
`normalize-memory` applies compatible autofill/normalization while preserving incompatible files for manual fixes.

## Minimal Example

```md
---
type: "decision"
title: "Route browser test work through Playwright guidance"
summary: "Prefer Playwright guidance for flaky browser test debugging."
importance: "medium"
date: "2026-04-01T12:34:56.000Z"
path_scope:
  - "tests/e2e/"
required_skills:
  - "playwright"
invocation_mode: "prefer"
risk_level: "medium"
---
```
