# Coding Brain

Read the smallest relevant implementation and tests first. Product contracts live in docs/api.md; repository workflow is in docs/team-workflow.md; release requirements are in docs/release-checklist.md. Codex integration instructions are in integrations/codex/README.md and .codex/INSTALL.md.

Preserve .brain state unless the task explicitly authorizes changing it. Context retrieval may record usage: inspect the current API contract before claiming a read-only operation. Do not activate experimental routing or reuse sealed evaluation data without explicit authorization.

For substantive changes, run focused tests and the required CI checks at the final SHA. Keep review/check receipts bound to that SHA. node scripts/codex-workflow-receipt.mjs prints a read-only local launch receipt; it does not establish approval, run tests or prove release readiness.

