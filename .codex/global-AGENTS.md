# Global Codex Working Rules

Use these as personal defaults across repositories. Repository-specific `AGENTS.md` files and canonical project sources may add stricter rules.

## Default work style

- Work in credit-saving mode unless the task genuinely needs broader investigation.
- Start from the issue, error, named file, or smallest relevant source of truth.
- Do not scan the whole repository by default.
- For meaningful work, investigate and propose the smallest coherent plan before editing.
- Do not refactor, rename, reformat, add dependencies, or expand scope unless required and approved.
- Run focused verification first.
- Treat code/config/tests as stronger evidence than stale prose when they conflict, unless the repository explicitly says otherwise.

## ChatGPT <-> Codex handoffs

When work is being manually coordinated through ChatGPT, return compact copy/paste-ready results rather than explanatory transcripts.

Default return fields:

```text
STATUS:
TASK:
BRANCH:
BASE SHA:
HEAD SHA:
FILES INSPECTED/CHANGED:
IMPLEMENTATION / FINDINGS:
VERIFICATION:
BLOCKERS:
DECISIONS NEEDED:
SHARED CONTRACTS / AREAS AFFECTED:
RISKS / CONFLICTS:
REMAINING:
NEXT RECOMMENDED ACTION:
PARALLEL-SAFE NEXT WORK: YES | NO
Reason:
```

Use `N/A` when a SHA does not apply and `NONE` for empty sections. Do not include private chain-of-thought or long command logs unless they are needed to explain a failure.

## Staged implementation cycle

For substantive work coordinated with ChatGPT:

1. Investigation/plan only; do not edit yet.
2. Return the plan for ChatGPT/human review.
3. Continue the original implementation session with only the approved scope.
4. Use a fresh session for independent review when required.
5. Send verified findings back to the original implementation session for repair.
6. Re-run focused verification after fixes.
7. Re-review the exact new HEAD when a material change invalidates a required prior review.

Simple low-risk mechanical work may combine planning and implementation when a separate checkpoint adds no meaningful value.

## Review depth

Do not create infinite review loops to enumerate every theoretical edge case.

Default maximum: three independent review passes for the same bounded change.

- Pass 1: correctness, acceptance criteria, regressions, realistic edge cases, contracts, and safety.
- Pass 2: verify fixes and target missed realistic edge cases/shared-contract failures.
- Pass 3: final bounded challenge pass when warranted.

After three passes, ordinary residual edge cases should be disclosed or moved to follow-up work rather than triggering more automatic reviews.

Continue beyond three passes only while an unresolved or newly discovered material high-severity risk remains, including security/authentication/authorization failures, exposed secrets, destructive production behavior, persistent data loss/corruption, billing/payment risk, unauthorized publishing/spend, or a comparably consequential failure.

## Parallel work

Default to one implementation agent.

Recommend parallel implementation only when tasks are independently bounded, do not depend on unresolved shared contracts or architecture decisions, have low file/subsystem overlap, can be developed and verified independently in isolated branches/worktrees, and are likely to save meaningful time after coordination cost.

Start with at most two concurrent implementation agents unless explicitly approved otherwise.

If a supposedly independent task discovers a shared-contract dependency, stop that workstream and report the dependency instead of inventing a competing design.

## PR reviewability

Prefer the smallest coherent self-contained PR that leaves the repository valid.

- Preferred target: <=200 substantive changed lines when practical.
- Normal soft ceiling: <=400 substantive changed lines.
- Split or justify when more than 10 substantive files are touched.
- High-risk changes should prefer <=200 substantive changed lines.
- Generated/mechanical changes do not count the same as substantive handwritten review work.
- Do not batch a fixed number of tasks by default.

If splitting would reduce correctness or create an invalid intermediate state, keep the coherent change together and provide a large-PR justification and review order.

## Durable learning

When a failure or correction produces a reusable lesson, prefer stronger enforcement over more prose:

1. regression test/eval;
2. deterministic validation/guard;
3. reusable helper/tool;
4. code/config contract;
5. canonical architecture/product/deployment documentation;
6. deferred issue;
7. agent instruction only when stronger enforcement is impractical.

Do not permanently capture routine syntax/type/build fixes, expected failed experiments, transient failures, abandoned ideas, or one-off debugging unless they expose a deeper missing invariant.
