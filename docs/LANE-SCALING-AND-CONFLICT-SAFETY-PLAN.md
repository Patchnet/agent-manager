# Lane scaling and conflict-safety plan

Status: Implemented locally; pending Delivery Review and release

## Implementation outcome

The implementation now includes:

- a five-lane workflow limit with a shared constant;
- `max_concurrency` scheduling with visible queued lanes;
- fail-closed pairwise scope validation;
- explicit single-owner `scope_overrides` with read-only enforcement;
- required all-lane claim admission with rollback, claim groups, registry
  locking, lease renewal, and release;
- `depends_on` graph validation and dependency-aware execution;
- prerequisite snapshot integration before dependent workers start;
- actual changed-file overlap blocking before integration, with explicit
  dependency-ordered overlap recorded as review risk;
- configured post-integration verification commands;
- expanded status, monitor, report, and Delivery Review evidence;
- a fail-closed manager planning attestation bound to the immutable base commit;
- one private, digest-verified shared context packet frozen for every lane and
  reused during resume and integration;
- unit and end-to-end coverage for five-lane, dependency, claim, scope, and
  verification behavior.

Historical scope recommendations from accumulated telemetry remain a future
analytics enhancement. The runtime now records the queue, dependency,
ownership, overlap, claim, and verification evidence that feature will need.

## Objective

Allow workflows to define up to five lanes while preventing avoidable
cross-lane and cross-run conflicts. Preserve isolated worktrees, deterministic
integration, and explicit operator control.

The target is low-intervention operation: conflicting work should be rejected
before workers start, dependency ordering should be explicit, and integration
should surface semantic-risk overlaps even when Git can merge them cleanly.

## Decisions

- Support up to five lanes per workflow.
- Keep one worktree and one agent per lane.
- Treat lane count and active concurrency as separate settings.
- Default active concurrency to three during rollout.
- Require one writable owner for each path in a wave.
- Reject unapproved scope overlap before creating worktrees.
- Require the invoking manager to attest source, repository-instruction,
  relevant-code, and scope review before creating a run.
- Keep source-system check-in and close-out with the invoking manager; workers
  receive the frozen handoff and do not query that system independently.
- Keep Delivery Review mandatory after integration.

## Starting state

- Workflow validation accepts at most three lanes.
- The interactive initializer selects at most three harness entries.
- Lanes run in isolated worktrees and branches.
- Guardrails detect changes outside a lane's declared scope.
- Git integration detects textual merge conflicts.
- Scope overlap is not rejected during workflow validation.
- A clean Git merge does not prove that overlapping changes are semantically
  compatible.

## Work package 1: five-lane workflow support

1. Define a shared `MAX_LANES` constant with a value of `5`.
2. Use the constant in workflow validation and interactive initialization.
3. Confirm that status, monitor, reporting, cleanup, review, and integration
   render and process five lanes without truncation.
4. Add tests proving:
   - one through five lanes are accepted;
   - six lanes are rejected with a useful error;
   - lane identifiers remain unique;
   - five worktrees and branches are isolated.
5. Update operator documentation and checked-in examples.

## Work package 2: bounded concurrency

Add an optional workflow field:

```yaml
max_concurrency: 3
```

Rules:

- The value must be an integer from `1` through `5`.
- The default is `min(3, lane_count)`.
- At most `max_concurrency` workers may run at once.
- Remaining lanes stay in a visible `queued` state.
- Cancellation prevents queued lanes from starting.
- A blocked lane occupies a slot until it is resumed or cancelled.
- Terminal lane transitions immediately make a slot available.

This permits five independently scoped lanes without forcing every provider or
operator machine to execute all five simultaneously.

## Work package 3: fail-closed scope validation

Extend `agent-manager validate` and launch preflight to compare every pair of
lane write scopes.

The validator must detect:

- the same explicit file in two scopes;
- a file contained by another lane's directory scope;
- intersecting directory scopes;
- common glob intersections that can be determined safely;
- ambiguous patterns that cannot be proven disjoint.

Unapproved overlap must stop the run before claims or worktrees are created.
The error must identify both lanes and the intersecting path or pattern.

Example:

```text
Workflow rejected: overlapping write scopes

lane "frontend" and lane "model-selector"
both own "src/components/WorkspaceWorkbench.tsx"
```

Ambiguous patterns should fail closed with guidance to replace them with
narrower scopes.

## Work package 4: explicit ownership exceptions

Some workflows may need planned overlap. Add a narrow exception form rather
than a global bypass:

```yaml
scope_overrides:
  - path: src/generated/client.ts
    lanes: [generator, integration-tests]
    owner: generator
    reason: Tests verify generated output but do not edit it.
    access:
      integration-tests: read-only
```

Requirements:

- The path and participating lanes must be explicit.
- Exactly one lane remains the writable owner.
- Other lanes default to read-only.
- True multi-writer exceptions are rejected. Sequence the work instead.
- Overrides cannot grant access outside the workflow's declared scopes.

The preferred resolution remains narrowing scopes or sequencing the work.

## Work package 5: required and atomic claims

Strengthen claims for cross-run coordination:

1. Resolve and validate all lane claims before launching any worker.
2. Acquire the complete claim set atomically.
3. If any required claim conflicts, acquire none and reject the run.
4. Report the conflicting run, lane, and scope without exposing sensitive
   environment details.
5. Add leases, heartbeat renewal, and explicit release.
6. Recover stale claims only after verifying that the owning supervisor is no
   longer active.

Use required claims for delivery workflows. Advisory claims remain available
for local experiments.

## Work package 6: dependency-aware scheduling

Add optional lane dependencies:

```yaml
lanes:
  - id: contracts
    scope:
      - src/contracts/**

  - id: api
    depends_on: [contracts]
    scope:
      - src/api/**

  - id: ui
    depends_on: [contracts]
    scope:
      - src/ui/**
```

The scheduler must:

- reject unknown dependencies and cycles;
- run independent lanes in parallel;
- integrate successful prerequisites before dependents start;
- base dependent worktrees on the resulting integration commit;
- prevent dependents from starting after a prerequisite failure;
- show dependency waits separately from resource-queue waits.

Until this work ships, dependent changes should use separate sequential
workflows.

## Work package 7: pre-integration overlap analysis

Before merging lane branches:

1. Collect the actual changed-file set for every lane.
2. Compare changed files with declared ownership.
3. Report any file changed by more than one lane.
4. Block unapproved same-file changes even when Git predicts a clean merge.
5. Record approved overlap as a Delivery Review risk.
6. Preserve Git's normal merge-conflict handling as the final textual check.

This check addresses semantic conflicts that Git cannot detect.

## Work package 8: integrated verification

After integration:

- run configured repository-level tests, type checks, lint checks, and builds;
- verify shared contracts used by multiple lanes;
- include planned scopes, actual changes, overlaps, violations, claims, and
  test evidence in the Delivery Review;
- do not treat successful individual lanes as acceptance of the integrated
  result.

The existing one-correction maximum remains unchanged.

## Telemetry

Add structured events and status fields for:

- queued and dependency-waiting lanes;
- scope-overlap rejections;
- claim conflicts and lease state;
- actual changed-file overlap;
- approved ownership exceptions;
- integration conflicts;
- post-integration verification results;
- operator interventions and worker corrections.

Historical telemetry can later support planning hints, such as identifying
paths that repeatedly cause contention.

## Delivery order

1. Five-lane validation, initialization, and rendering support.
2. Bounded concurrency with queued-lane state.
3. Fail-closed scope-overlap validation.
4. Atomic required claims.
5. Pre-integration changed-file overlap analysis.
6. Integrated verification and Delivery Review evidence.
7. Dependency-aware scheduling.
8. Planning preflight attestation and frozen context handoff.
9. Historical planning recommendations.

Five-lane support may be developed first, but broad production use should wait
until scope-overlap validation and required claims are active.

## Acceptance criteria

The plan is complete when:

- workflows with five lanes validate and run;
- workflows with six lanes fail before launch;
- operators can limit active concurrency independently of lane count;
- conflicting write scopes cannot start without an explicit exception;
- conflicting required claims admit no partial wave;
- every writable path has one declared owner;
- changed files are checked again before integration;
- dependent lanes start only from successful prerequisite output;
- integrated repository checks pass before Delivery Review acceptance;
- launch fails when planning evidence is missing, incomplete, or stale;
- every lane receives the same recorded planning-context digest;
- every rejection names the responsible lanes, scope, and recovery action.
