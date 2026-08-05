---
enabled: true
current: 1.8.1
dev_flow: simple
test_gate: local
---

# Version History

## 1.8.1 - 2026-08-05

Made simulated Windows harness discovery use Windows path semantics on every
host so the portability suite passes consistently on Windows, macOS, and Linux.

## 1.8.0 - 2026-08-05

Added canonical run identity and model telemetry, expanded shipping and GitHub
Actions progress, and standardized cross-platform worker-harness discovery and
setup guidance.

## 1.7.0 - 2026-08-05

Added a local, read-only Fleet terminal dashboard for observing multiple runs,
lane progress, worker updates, blockers, and recent transitions.

## 1.6.0 - 2026-08-02

Added cross-host Master return handoffs for Codex, Claude, and Cursor,
including direct chat return where available and a portable signal fallback.

## 1.5.0 - 2026-08-01

Hardened deterministic orchestration and release flow with completion contracts,
private planning context, worktree validation, delivery preflight, and isolated
release workspaces.

## 1.4.0 - 2026-08-01

Added explicit delivery lifecycle enforcement and deterministic operator cadence across orchestration, review, shipping, telemetry, and reporting.

## 1.3.2 - 2026-07-31

Expanded public documentation with operator report examples and added macOS CI coverage.

## 1.3.1 - 2026-07-31

Align harness permissions and repo instructions.

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
