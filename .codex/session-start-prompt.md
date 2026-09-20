# Codex Session Start

Before starting a new coding session in this repository, run:

```bash
brain start --format json --task "<current task>"
```

Use `context_markdown` as repo knowledge context, `skill_plan` as RepoBrain routing policy, and consume `navigation_plan` whenever it is present by loading its canonical source paths, performing its live checks, and following its next steps.

If a fresh conversation opens later in the same session, run:

```bash
brain conversation-start --format json --task "<current task>" --path <changed-path>
```

Follow the returned `action`; both `start` and `inject` results may include `navigation_plan`.

Also apply the reusable personal defaults from `~/.codex/AGENTS.md` when installed from `.codex/global-AGENTS.md`. Repository-specific `AGENTS.md` rules remain authoritative when they are stricter or more specific.

When ChatGPT is routing the session, preserve the supplied model, chat/session name, reasoning level, and parallel decision rather than redefining them inside Codex.

If you have not initialized Project Brain yet, run:

```bash
brain setup
```
