---
enabled: true
current: 1.26.0
dev_flow: simple
test_gate: local
---

# Version History

## 1.26.0 - 2026-09-04

Reconcile terminal run outcomes with goal lifecycle state and add idempotent historical repair.

## 1.25.1 - 2026-08-27

Make Formal release stamping idempotent, reconcile immutable base commits with provider branch references, and complete verified tag-only releases without requiring a GitHub Release object.

## 1.25.0 - 2026-08-27

Add explicit run classifications and retry/recovery lineage across telemetry and Fleet, plus read-only stale-run cleanup previews.

## 1.24.0 - 2026-08-27

Add selected-harness preflight, serialized-topology guidance, portable-script line-ending guards, and single-lane initialization defaults.

## 1.23.1 - 2026-08-24

Repair GitHub Formal Flow and cache dependency setup.

## 1.23.0 - 2026-08-23

Streamline internal shipping, runtime activation, and truthful delivery.

## 1.22.0 - 2026-08-21

Add declarative integration setup, bounded conditional shipping authorization, and safe demo and host installer flows.

## 1.21.0 - 2026-08-17

Close the human loop: `agent-manager ratify` records Master's audit of guardrail-failed lanes and force-integrate folds ratified snapshots (coverage-checked); worker lanes auto-allow their workflow's own verification commands; `reply --extend-scope` makes granted extensions guardrail-real; `review --recovered` persists verdicts on manually recovered runs; `--force-lanes` list parsing and goal docId slugs fixed.

## 1.20.0 - 2026-08-15

Resilience batch: codex `exec resume` argv contract (fixes the 3/3-fatal reply-resume crash) with a recorded option-contract test, doctor models-cache validation, reply allowed on failed lanes with a needs-input marker, `integrate --force-lanes done,failed-with-snapshot` surfaced through Delivery Review, wip snapshots for every writable lane at lane end, ship-poll retry/backoff + stale version-plan invalidation, and a validate-time cross-lane depends_on import advisory.

## 1.19.0 - 2026-08-10

Redesigned Fleet goals/core boards with progress and goal staleness context, clarified token totals, added an opt-in OS notification sink, a startup logomark, and a read-only localhost dashboard.

## 1.18.0 - 2026-08-09

Lock telemetry and path roots to `config.env` so ambient env/CLI cannot redirect runs; require `AGENT_MANAGER_ALLOW_PATH_OVERRIDE=1` to unlock overrides or `config init --force`.

## 1.17.0 - 2026-08-09

Director proposal bridge: validated workflow YAML drafts + Master kickoff lines, scoped `risk_exceptions` for CodeQL-class security, fixture-only source providers, and docs/skills retuned to proposal (not autopilot).

## 1.16.0 - 2026-08-09

Add accept-without-ship filed closeout with brain artifact links, force test isolation for runs/claims/brain, fail closed on acceptEdits+allow_commit, resolve ship base_ref HEAD to the default branch, and add mid-flight lane corrections.

## 1.15.0 - 2026-08-09

Add Cursor as a first-class worker harness with native Windows Agent CLI discovery, model selection, doctor/setup docs, and a structured empty-prompt detector that no longer false-fails when workers read harness source.

## 1.14.0 - 2026-08-08

Added the Autopilot Director Phase 1 foundation (schemas, fail-closed CLI, single-repo lease, dry-run cycle), pluggable token usage providers, a portable-install sweep, and docs closeout.

## 1.13.0 - 2026-08-08

Added a tabbed Fleet operations board (Runs, Goals, Core, Tokens) with cached
tab switches, a Core knowledge-graph view, and skill Step 0 conversational
goal setup before lane launch.

## 1.12.0 - 2026-08-08

Added read-only `tokens` telemetry for local Claude Code and Codex session
usage with cost estimates.

## 1.11.0 - 2026-08-08

Added a packaged MAADB-backed goal graph, deterministic progress tracking, run-to-goal references, and self-contained visual goal maps.

## 1.10.0 - 2026-08-07

Added safe unattended Claude lanes with lane-scoped permission modes, narrow
tool allowlists, deterministic setup, blocker propagation, and faster test and
CI execution.

## 1.9.1 - 2026-08-07

Prevented visible Windows Codex process churn by selecting a complete native
package, enforcing hidden shell launches and private-desktop sandboxing, and
failing preflight when the packaged sandbox helper is missing. Documented the
approved Autopilot Director architecture for future implementation.

## 1.9.0 - 2026-08-06

Added CLI and viewer version reporting, captured the Agent Manager engine
version for each run, and added offline update notices so viewers can restart
without interrupting active detached runs.

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
