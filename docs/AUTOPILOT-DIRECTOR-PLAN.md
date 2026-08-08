# Autopilot Director plan

Status: Approved architecture; Phase 1 foundation implemented

The first shipped foundation includes versioned policy, source-item, cycle, and
persisted-state schemas; strict `pr-only` policy validation; separate Director
harness/model/reasoning identity; a deterministic fixture-backed dry cycle;
single-repository leasing; replay-safe persisted evidence; and the
`agent-manager director` CLI. See [DIRECTOR.md](./DIRECTOR.md).

Worker launch, automated Delivery Review, and policy-authorized pull-request
shipping remain later Phase 1 increments. The current cycle requires
`--dry-run` and performs no outward action.

## Decision

Autopilot Director is a higher-autonomy operating mode above Agent Manager.
It is not a replacement for Agent Manager and it is not another worker lane.

The mode promotes the decision-making responsibilities normally shared by the
human operator and Manager agent into a policy-bound Director agent. Agent
Manager, PR Manager, and the worker lanes retain narrower, deterministic jobs.

The human remains the policy owner. The Director may act without synchronous
human input only inside an explicit standing policy. Work outside that policy
is quarantined for review; the Director must not guess through a blocker or
grant itself broader authority.

## Role model

### Manager mode

```text
Human Director
    -> Manager Agent
    -> Agent Manager
    -> Worker Agents
```

The human selects work, resolves material decisions, accepts Delivery Review,
and approves shipping. The Manager Agent plans and supervises the run. Agent
Manager provides deterministic validation, isolation, execution, integration,
telemetry, and delivery-state enforcement.

### Director mode

```text
Human Policy Owner
    -> Autopilot Director
    -> Agent Manager
    -> Worker Agents
    -> PR Manager
```

The Autopilot Director uses a higher-capability planning model to select
eligible work, orient on the repository, build the plan, choose the fleet,
evaluate delivery, and apply the standing policy. Agent Manager executes the
approved plan. PR Manager performs only the shipping actions authorized by the
policy.

This is a promotion of responsibility, not a duplicate orchestration layer.
The intelligence moves upward while the execution path becomes more
deterministic.

## Responsibility boundaries

| Role | Owns | Must not own |
|---|---|---|
| Human policy owner | goals, repository enrollment, autonomy policy, risk limits, exceptions | routine run supervision |
| Autopilot Director | work selection, source review, planning, fleet design, risk classification, Delivery Review, bounded correction, closeout | work outside policy, permission escalation, implementation edits |
| Agent Manager | workflow validation, worktrees, claims, lane execution, integration, telemetry, lifecycle state | product judgment, source prioritization, approval invention |
| Worker agent | one bounded implementation or review assignment | orchestration, self-approval, merge, release |
| PR Manager | authorized commit, push, PR, CI wait, merge, version, and tag steps | code authoring, policy decisions, approval expansion |

The scheduler is infrastructure, not an agent role. It wakes the Director on a
timer or source event and does not make planning or shipping decisions.

## Harness and model identity

A harness is the application or CLI that runs an agent. A model is the
reasoning model selected inside that harness. Director and worker identity must
record both fields separately.

Proposed configuration:

```yaml
director:
  harness: <host-harness>
  model: <planning-model>
  reasoning: high

workers:
  - role: implementation
    harness: <worker-harness>
    model: <implementation-model>
  - role: review
    harness: <review-harness>
    model: <review-model>
```

For an autonomous run, the Director is the recorded Manager identity. Run
telemetry should expose Manager Harness, Manager Model, reasoning level,
autopilot policy, source references, and plan reference. Each lane continues
to expose its own requested and observed worker harness and model.

## Deterministic lifecycle

The Director operates through a persisted state machine rather than an
unbounded shell loop:

```text
DISCOVER -> TRIAGE -> PLAN -> VALIDATE -> RUN -> REVIEW -> SHIP -> CLOSE
Any policy violation or unresolved blocker -> QUARANTINE
```

Each transition records its inputs, result, policy decision, and next action.
Restarts must resume from persisted state without repeating an outward action.
The Director must use idempotency keys for source claims, run creation, pull
requests, merges, releases, and source closeout.

## Standing autonomy policy

Director mode replaces per-run operator prompting only for actions covered by
a durable repository policy. It does not simulate an operator replying `all`.

Example policy shape:

```yaml
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

Policy validation must fail closed. Dangerous permission bypass is never
implied by Director mode and retains its existing explicit controls.

## Autonomy levels

| Mode | Automated boundary | Recommendation |
|---|---|---|
| `pr-only` | plan, implement, test, review, push, and open a review-ready PR | first release |
| `auto-merge` | `pr-only` plus merge after independent review, required CI, and repository protections | later, low-risk allowlist only |
| `release` | `auto-merge` plus version and release actions | explicit repository enrollment only |

An unattended cycle means no synchronous human response is required. It does
not mean every item must complete. Ambiguous requirements, policy violations,
failed checks, merge conflicts, missing credentials, and unavailable services
must be quarantined while the cycle continues with other eligible work.

## Review independence

The Director may perform Delivery Review for `pr-only` mode, but unattended
merge or release requires an independent reviewer identity. The reviewer must
not be a worker that authored the change. Its verdict, model identity, test
evidence, and policy result must be stored with the run.

The existing one-correction limit remains. A second failed review quarantines
the item and starts no further autonomous correction loop.

## Source and repository scope

Agent Manager remains source-neutral. Source discovery and closeout belong to
Director connectors. A connector converts an external work item into a common
record containing at least:

- stable source and item identifiers;
- target repository and base branch;
- approved objective and acceptance criteria;
- priority, dependencies, and automation eligibility;
- claim, status-update, and closeout operations.

One Agent Manager run continues to target one repository. A future portfolio
scheduler may run Directors across several repositories while enforcing global
concurrency, repository leases, and per-source item claims.

## Implementation plan

### Phase 1: `pr-only` foundation

1. Define the Director policy, source-item, cycle, and persisted-state schemas.
2. Add a deterministic scheduler entry point and single-repository lease.
3. Add a Director harness adapter with separate harness, model, and reasoning
   configuration.
4. Convert eligible source items into draft workflows and require the existing
   planning, scope, base-SHA, and repository-instruction validations.
5. Launch Agent Manager detached and consume its status and wake contracts.
6. Run automated Delivery Review with one bounded correction.
7. Add policy-authorized `pr-only` shipping without fabricating a Ship Gate
   reply.
8. Update or quarantine the source item and produce a cycle digest.

### Phase 2: independent auto-merge

1. Add independent reviewer identity and evidence requirements.
2. Enforce repository allowlists, protected branches, required CI, risk rules,
   and merge idempotency.
3. Add `auto-merge` policy authorization and exception reporting.
4. Run a shadow period in which the system records intended merge decisions
   without executing them.

### Phase 3: release and portfolio operation

1. Add repository-specific release authorization, version policy, and release
   idempotency.
2. Add source connectors behind the common contract.
3. Add multi-repository scheduling with a global concurrency budget.
4. Add daily and event-driven modes, consolidated telemetry, and operator
   digests.

## Acceptance criteria for the first release

- A scheduled cycle can discover and claim an eligible item without a chat
  session.
- The Director records source, repository, code-review, base-SHA, and scope
  evidence before Agent Manager starts.
- Director harness and model remain distinct from every worker harness and
  model in configuration and telemetry.
- Agent Manager rejects stale plans, overlapping scopes, and invalid outputs
  before workers start.
- A successful run receives an evidence-backed Delivery Review and at most one
  correction.
- `pr-only` policy can commit, push, and open a review-ready PR without human
  input, but cannot merge, tag, release, or bypass protection.
- A blocked item is quarantined and does not prevent the cycle from processing
  another eligible item.
- Replaying or restarting a cycle does not duplicate a run, PR, or source
  closeout.
- The final digest lists completed, quarantined, skipped, and still-running
  items with evidence links.

## Non-goals

- An unrestricted autonomous coding daemon.
- Allowing a model to grant itself permissions.
- Replacing native harness sandboxing or repository branch protection.
- Making worker agents query or close external work items independently.
- Guaranteeing completion when product judgment or external recovery is
  required.
