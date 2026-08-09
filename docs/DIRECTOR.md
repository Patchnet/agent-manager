# Director proposal cycle (Phase 1+)

Director is the **policy-bound proposal layer** above Agent Manager. A cycle
validates a standing policy, triages local source fixtures, and writes
**validated workflow YAML drafts** that Master Dev can kick off with
`agent-manager run … --detach`.

This is **not** full autopilot. The cycle does not start workers, commit, push,
open a pull request, merge, tag, release, call a planner LLM, or bypass harness
permissions. Scheduled or continuous unattended loops remain deferred until an
explicit execute/detach phase lands.

The Director identity (`harness`, `model`, `reasoning`) is configured separately
from worker identities. Worker harness/model defaults come from an optional
`workers:` block (default harness `claude`).

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
workers:
  harness_default: claude
autopilot:
  enabled: true
  mode: pr-only
  source_filter: automation-ready
  allowed_actions: [plan, run, review, commit, push, open-pr]
  allowed_paths: [src/**, test/**, docs/**, src/lib/security/**, test/security/**]
  forbidden_risks: [security, authentication, billing, migrations, infrastructure]
  risk_exceptions:
    - risk: security
      require_labels: [codeql, automation-ready]
      allowed_paths: [src/lib/security/**, test/security/**]
  max_items_per_cycle: 3
  max_concurrency: 3
  correction_limit: 1
  on_blocker: quarantine-and-continue
```

`forbidden_risks` stay fail-closed. For CodeQL-class work, keep `security` in
`forbidden_risks` and add a `risk_exceptions` entry that requires labels and
narrows paths. Omitting `security` from `forbidden_risks` remains a blunt escape
hatch; exceptions are the precise path.

Validate it before scheduling a cycle:

```powershell
agent-manager director validate --policy .\director-policy.yaml
```

Validation rejects disabled policies, modes other than `pr-only`, merge/tag/
release or unknown actions, missing Director identity, unknown fields, invalid
bounds, risk exceptions outside `allowed_paths`, and repositories that do not
exist. Director mode never grants dangerous permissions.

## Local source fixtures

The Phase 1 cycle accepts a local JSON or YAML fixture with this envelope.
Only `source.provider: fixture` is implemented. Other providers are quarantined
as `connector-not-implemented:<provider>` (Jared / GitHub connectors are not
wired yet).

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
    goal_refs: [goal-am-feature]
    planning:
      plan_ref: plan:work-17
      verified_by: manager-agent
      verified_at: 2026-08-08T16:30:00.000Z
      repository_instruction_refs: [AGENTS.md]
      reviewed_paths: [src/feature/**, test/feature/**]
```

Relative repository paths are resolved from the policy or fixture file that
contains them. They must resolve to the same canonical repository. Items with
forbidden risks (unless a matching exception applies), a different repository
or base, or scope outside the policy are quarantined. Ineligible and
filter-mismatched items are skipped. Local fixtures do not provide authoritative
dependency state, so items with declared dependencies are skipped until a
connector supplies that state.

## Run a proposal / dry cycle

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
  cycles/<cycle-id>/workflows/<draft>.yaml
```

Selected items become validated workflow drafts under `workflows/`. Human and
JSON output include a `kickoff:` line per draft:

```text
agent-manager run "<path-to-draft.yaml>" --detach
```

Master Dev owns that kickoff. Director does not auto-detach.

Only one Director cycle can hold a repository lease. A second cycle fails
closed. Cycle selection is stable: priority descending, then source provider
and item ID. The default cycle ID is derived from the normalized policy and
source digests. Replaying the same inputs returns the persisted cycle instead
of creating duplicate claim, run, or closeout identities.

The persisted proposal lifecycle is:

```text
DISCOVER -> TRIAGE -> PLAN (write drafts) -> VALIDATE -> CLOSE
```

Every transition has a timestamp and decision. Selected items receive reserved
idempotency keys for source claim, run creation, and source closeout. Those
keys are evidence only until a later execute phase consumes them.

## Current boundary

| In scope today | Not in scope yet |
|---|---|
| Policy + fixture triage | Planner LLM session |
| Workflow YAML drafts + kickoff text | Auto `run --detach` |
| Scoped `risk_exceptions` | Jared / GitHub / followup connectors |
| Fail-closed unknown providers | Auto Delivery Review / Ship Gate |
| `goal_refs` on drafts | Continuous / scheduled autopilot |

Shipping must remain limited to policy-authorized `pr-only` behavior after
Master launches a draft. Director must not fabricate a Ship Gate `all` reply.
