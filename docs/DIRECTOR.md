# Autopilot Director Phase 1

Autopilot Director now has a fail-closed, local `pr-only` foundation. It can
validate a standing policy and run a deterministic, fixture-backed dry cycle.
This slice does not start workers, commit, push, open a pull request, merge,
tag, release, or bypass harness permissions.

The Director identity is configured separately from worker identities. Worker
harnesses and models remain in the workflow that a later phase will launch.

## Standing policy

Create a JSON or YAML policy outside the repository when it contains private
operating details. A portable example is:

```yaml
schema: agent-manager.director-policy.v1
repository:
  path: ../target-repository
  base_ref: main
director:
  harness: codex
  model: planning-model
  reasoning: high
autopilot:
  enabled: true
  mode: pr-only
  source_filter: automation-ready
  allowed_actions: [plan, run, review, commit, push, open-pr]
  allowed_paths: [src/**, test/**, docs/**]
  forbidden_risks: [security, authentication, billing, migrations, infrastructure]
  max_items_per_cycle: 3
  max_concurrency: 3
  correction_limit: 1
  on_blocker: quarantine-and-continue
```

Validate it before scheduling a cycle:

```powershell
agent-manager director validate --policy .\director-policy.yaml
```

Validation rejects disabled policies, modes other than `pr-only`, merge/tag/
release or unknown actions, missing Director identity, unknown fields, invalid
bounds, and repositories that do not exist. Director mode never grants
dangerous permissions.

## Local source fixtures

The Phase 1 cycle accepts a local JSON or YAML fixture with this envelope:

```yaml
schema: agent-manager.director-source-list.v1
items:
  - schema: agent-manager.director-source-item.v1
    source:
      provider: fixture
      item_id: work-17
      ref: fixture:work-17
    repository:
      path: ../target-repository
      base_ref: main
      reviewed_base_sha: 0123456789abcdef0123456789abcdef01234567
    objective: Add the approved feature.
    acceptance_criteria:
      - Focused tests pass.
    priority: 80
    dependencies: []
    automation_eligible: true
    labels: [automation-ready]
    risks: []
    scope: [src/feature/**, test/feature/**]
    planning:
      plan_ref: plan:work-17
      verified_by: manager-agent
      verified_at: 2026-08-08T16:30:00.000Z
      repository_instruction_refs: [AGENTS.md]
      reviewed_paths: [src/feature/**, test/feature/**]
```

Relative repository paths are resolved from the policy or fixture file that
contains them. They must resolve to the same canonical repository. Items with
forbidden risks, a different repository or base, or scope outside the policy
are quarantined. Ineligible and filter-mismatched items are skipped. Local
fixtures do not provide authoritative dependency state, so items with declared
dependencies are skipped until a connector supplies that state.

## Run a dry cycle

The explicit `--dry-run` flag is mandatory:

```powershell
agent-manager director cycle `
  --policy .\director-policy.yaml `
  --items .\director-items.yaml `
  --dry-run `
  --json
```

Use `--repo <path>` to override the policy repository, `--state-dir <path>` to
place private cycle state elsewhere, or `--cycle-id <safe-id>` for an explicit
idempotency boundary. The default state root is:

```text
$AGENT_MANAGER_RUNS_ROOT/director/
  leases/<repository-digest>.lock
  cycles/<cycle-id>/state.json
  cycles/<cycle-id>/cycle.json
```

Only one Director cycle can hold a repository lease. A second cycle fails
closed. Cycle selection is stable: priority descending, then source provider
and item ID. The default cycle ID is derived from the normalized policy and
source digests. Replaying the same inputs returns the persisted cycle instead
of creating duplicate claim, run, or closeout identities.

The persisted dry-cycle lifecycle is:

```text
DISCOVER -> TRIAGE -> PLAN -> VALIDATE -> CLOSE
```

Every transition has a timestamp and decision. Selected items receive reserved
idempotency keys for source claim, run creation, and source closeout. Those
keys are evidence only in this slice; no outward action consumes them yet.

## Current boundary

This is the Director scheduler and policy foundation, not unattended shipping.
The next implementation step must connect selected items to validated Agent
Manager workflows and the existing detached run/wake contracts. Shipping must
remain limited to policy-authorized `pr-only` behavior. It must not fabricate a
Ship Gate `all` reply. Auto-merge, release autonomy, multi-repository scheduling,
and unrestricted daemon operation remain out of scope.
