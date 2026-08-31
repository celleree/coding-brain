# Global Codex Routing Policy

Use this as a reusable default for future projects. Values in task examples are routing outputs, not hard-coded defaults.

For every substantial coding task, choose and state:

- `WHERE`: Codex VS Code sidebar / Terminal-CLI / Desktop app
- `SESSION`: CONTINUE or NEW, with a short chat/session name when new
- `MODEL`: choose the lowest-cost capable current Codex model; prefer lower-cost models such as Terra or Luna when they can complete the task reliably
- `REASONING`: use the lowest sufficient reasoning level; escalate only when task complexity, uncertainty, or risk justifies it
- `PARALLEL`: YES or NO; prefer parallel work when tasks can be isolated without conflicting edits, and name worktree/area ownership when parallel

Session rules:

- Preserve chat context as a resource. Do not keep implementation, planning, debugging, and review in one indefinitely growing chat when separate fresh contexts improve reliability.
- Prefer a fresh implementation chat when a new phase or materially different workstream begins.
- Use a fresh independent chat/session for code review; it must not inherit the implementer's reasoning or conclusions.
- Use additional fresh chats for focused remediation or error investigation when the existing chat has become long, noisy, or biased by prior attempts.
- Carry forward durable state through repo truth: exact SHA/branch, Issue/PR, acceptance criteria, checkpoint, code/config/tests, and RepoBrain context. Do not depend on a raw transcript.
- Continue an existing chat only when its retained context materially helps and remains reasonably fresh.

Parallel rules:

- Default toward parallel execution when work can be partitioned cleanly.
- Do not parallelize overlapping edits to the same shared contracts/files unless ownership and integration order are explicit.
- Assign each parallel agent a bounded scope, branch/worktree ownership, source of truth, and verification responsibility.
- Keep independent review separate from implementation even when other work is parallel.

Cost rule:

- Optimize for correctness per credit, not maximum model strength by default.
- Start with the cheapest model/reasoning combination likely to succeed.
- Escalate model or reasoning when failure risk, ambiguity, architectural scope, security/safety impact, or repeated unsuccessful attempts justify it.

Recommended routing handoff shape:

```text
WHERE: <VS Code sidebar | Terminal / CLI | Desktop app>
SESSION: <CONTINUE | NEW — short name>
MODEL: <current suitable Codex model>
REASONING: <lowest sufficient level>
PARALLEL: <YES | NO — reason and ownership when YES>
```

Example only:

```text
WHERE: Codex Terminal / CLI
SESSION: CONTINUE — Phase 1B Short-Video Remediation
MODEL: GPT-5.6 Luna
REASONING: Low
PARALLEL: NO — publish the exact reviewed SHA before any further branch changes
```
