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

## 3. Start Codex with context + routing

Use `.codex/session-start-prompt.md` as the lightweight session entrypoint. It loads RepoBrain context and applies `.codex/global-routing-policy.md` so each substantial task explicitly chooses:

- Codex surface: VS Code sidebar / Terminal-CLI / Desktop app
- continue vs fresh session
- lowest-cost capable model and reasoning level
- safe parallel execution where appropriate
- fresh implementation/review conversations when useful

The values are task-specific decisions, not fixed examples.

## 4. Install the lightweight Git hook

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

## 5. Reviewable extract is the recommended default

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

## 6. Manual extract

You can always extract manually from a summary file:

```bash
cat session-summary.txt | brain extract
```

Manual `brain extract` writes active memories immediately.

Or from the latest commit context without the hook:

```bash
brain extract-commit
```
