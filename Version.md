---
enabled: true
current: 1.3.0
dev_flow: simple
test_gate: local
---

# Version History

## 1.3.0 - 2026-07-31

Added five-lane orchestration with bounded concurrency, conflict-safe scopes
and claims, dependency-aware integration, and manager-verified shared planning
context.

## 1.2.1 - 2026-07-30

PR Manager diagnoses BLOCKED PRs with green CI as required status-check name
mismatch (not a missing human Approve), and documents the Formal check-name
contract in the skill.

## 1.2.0 - 2026-07-30

Added detached PR Manager shipping with same-run telemetry, policy gates,
CI monitoring, and release tagging.

## 1.1.0 - 2026-07-30

Hardened public execution boundaries and added portable Cursor cockpit,
validation, review, and installation workflows.

## 1.0.0 â€” 2026-07-29

Public initial release. Portable paths via `AGENT_MANAGER_*` env vars (no
hard-coded workspace root). Bundled `tools/claim.mjs`. Operator workflows and
local agent settings gitignored. Sanitized examples/docs. Orphan history for
public GitHub.
