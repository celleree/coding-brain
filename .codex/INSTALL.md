# Codex Installation

Project Brain treats Codex support as a lightweight workflow amplifier. The core product is still repo knowledge memory: extract high-value repo knowledge, store it in `.brain/`, and inject it into future sessions.

## 1. Install dependencies

From the repo root:

```bash
npm install
npm run build
```

If you want the `brain` command to be available in your shell and Git hooks:

```bash
npm link
```

If you do not want to link globally, you can still run the CLI with:

```bash
node dist/cli.js <command>
```

## 2. Initialize Project Brain

Create the local `.brain/` workspace for this repository:

```bash
brain setup
```

`brain setup` also installs the lightweight `post-commit` hook when you run it from the Git root. If you only want the workspace without automation, `brain init` still works.

## 3. Install reusable local Codex defaults

This repository includes `.codex/global-AGENTS.md` as the reusable personal Codex instruction source.

Install it into the Codex home directory so the same bounded ChatGPT <-> Codex handoff, review-depth, parallel-work, PR-reviewability, and durable-learning defaults apply across repositories:

```bash
mkdir -p ~/.codex
cp .codex/global-AGENTS.md ~/.codex/AGENTS.md
```

If `~/.codex/AGENTS.md` already contains personal instructions, merge the new rules deliberately instead of overwriting them blindly.

The global file contains reusable defaults only. A repository's own `AGENTS.md` and canonical sources may add stricter project-specific requirements.

The ChatGPT-side routing header should be supplied whenever ChatGPT prepares a Codex prompt:

```text
CODEX MODEL: [recommended model]
CHAT NAME: [specific session/chat name]
REASONING: [light / medium / high / extra high / ultra]
PARALLEL: YES | NO
WHY: [one sentence]
```

These routing fields are selected by ChatGPT/the human before launching or continuing the Codex session; Codex should not invent them after the fact.

## 4. Load repo context before a new Codex session

The simplest option is still:

```bash
brain inject
```

Paste or reference the output in your session so Codex starts with the latest repo decisions, gotchas, and conventions.

If you wire in the session-start hook, this step can be automatic.

## 5. Install the lightweight Git hook

To let Project Brain extract from the latest commit context after each commit:

```bash
sh scripts/setup-git-hooks.sh
```

If you already ran `brain setup` from the Git root, you can skip this step.

The installed `post-commit` hook stays lightweight:

- It gathers the latest commit metadata, changed files, and diff stat
- It runs `brain extract-commit`
- It silently skips if `brain` is not installed
- It never blocks your commit flow

## 6. Reviewable extract is the recommended default

The safest default is:

- session-start injects context automatically
- session-end extracts reviewable `candidate` memories
- you approve the good ones explicitly

Review and approve candidates with:

```bash
brain review
brain approve --safe
brain approve --all
```

Before promoting a lesson to durable memory, prefer a regression test, deterministic guard, reusable helper, code/config contract, or canonical requirement when that can enforce the lesson more reliably than prose.

Do not promote routine syntax/type/build fixes, expected failed experiments, transient failures, abandoned ideas, or one-off debugging unless they reveal a deeper reusable invariant.

## 7. Manual extract

You can always extract manually from a summary file:

```bash
cat session-summary.txt | brain extract
```

Manual `brain extract` writes active memories immediately.

Or from the latest commit context without the hook:

```bash
brain extract-commit
```
