# Codex Session Start

Before starting a new coding session in this repository, run:

```bash
brain inject
```

Use the output as repo knowledge context for the session. It helps Codex see the latest project decisions, gotchas, and conventions before suggesting changes.

Also apply the reusable personal defaults from `~/.codex/AGENTS.md` when installed from `.codex/global-AGENTS.md`. Repository-specific `AGENTS.md` rules remain authoritative when they are stricter or more specific.

When ChatGPT is routing the session, preserve the supplied model, chat/session name, reasoning level, and parallel decision rather than redefining them inside Codex.

If you have not initialized Project Brain yet, run:

```bash
brain init
```
