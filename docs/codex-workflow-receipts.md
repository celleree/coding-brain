# Launch and completion evidence

Run `node scripts/codex-workflow-receipt.mjs` inside the actual checkout. It prints executor/home, Git root/branch/HEAD/dirty state and hashes of home/root instruction files. It writes nothing and does not initialize Brain. It reads only three allowlisted top-level Codex configuration values; it never prints the config or credentials. Active profile resolution and nested instruction discovery still belong to the executor.

A saved project label or old Windows/WSL path cannot replace this launch observation. Check that the checkout and home are the ones the session actually uses. Install personal defaults deliberately in each executor home; preserve nonempty existing personal instructions and overrides. Never copy a large repository policy into every home.

For completion, put a compact receipt in the PR description or delivered report:

```text
Base: <SHA and branch>
Final HEAD: <SHA>
Verification: <required CI URL/result at that SHA; focused local evidence>
Independent review: <reviewed SHA, reviewer/source, scope and PASS/FAIL, or not required with reason>
Acceptance gaps: <mocked vs backend/provider/device checks still unverified>
Authorization: <draft only / explicit merge or deploy scope>
Next action: <one concrete action>
```

Before marking ready, fetch the current PR head and required checks from GitHub and compare the full SHA to the review receipt. A receipt is a claim with a source, not a new independent approval system. Unobserved checks remain pending; stale review does not cover changed behavior. Reuse passing CI and existing exact-SHA review when valid instead of replaying the full matrix or arranging another reviewer.

Hosted agent wrappers apply only where their documented visibility/access restrictions permit them. A disabled private-only wrapper on a public repository supplies no review evidence; keep its restriction and use the project's supported independent review path. Do not count documentation as enforcement.

For interruptions, reconcile current process status, descendants, locks and durable receipts before resume; an old heartbeat alone proves neither liveness nor completion. Do not delete recoverable work to make a launch look clean.
