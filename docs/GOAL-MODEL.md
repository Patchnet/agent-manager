# Goal graph data model

Agent Manager stores its goal graph in the same local, Git-free MAADB brain as
run-intent records. The model is portable: it does not require a project
tracker, source host, network service, or Agent Manager process to remain
running.

## Brain schema versions

Brain schema version 2 adds two MAADB object types while retaining the existing
`run_intent.v1` type and records:

| Object type | MAADB schema | ID prefix | Directory |
|---|---|---|---|
| Run intent | `run_intent.v1` | `ari-` | `run-intents/` |
| Goal | `goal.v1` | `goal-` | `goals/` |
| Artifact link | `artifact_link.v1` | `glink-` | `artifact-links/` |

Opening a supported older brain performs an explicit, idempotent migration. It
adds missing registrations and schema files, then changes the brain marker to
`agent-manager.brain.v3`. It does not rewrite run-intent documents or change
their schema. Incompatible registrations or schema definitions fail closed.

The current brain marker is version 3. Goal disposition fields are optional,
forward-compatible additions to `goal.v1`; opening an older compatible brain
widens that schema in place without rewriting stored goal or run documents.

## Goal (`goal.v1`)

The MAADB `doc_id` is the stable local goal ID. Callers can supply a safe
`goal-...` ID or let the source API derive a collision-safe ID from the title.

| Field | Required | Meaning |
|---|---:|---|
| `title` | yes | Human-readable goal title |
| `lifecycle` | yes | `planned`, `active`, `blocked`, `delivered`, `superseded`, or `cancelled` |
| `parent_goal` | no | Local `goal` ref establishing hierarchy |
| `dependencies` | yes | Local goal refs that must precede this goal |
| `outcome` | no | Intended result |
| `success_criteria` | yes | Explicit criteria used to judge delivery |
| `external_source_refs` | no | Opaque source references retained for synchronization or traceability |
| `change_history` | no | Append-only JSON records of before/after goal definitions, authority reference, reason, impact and actor |
| `request_history` | no | JSON records of material request assessments and their proposed or explicit decisions |
| `disposition` | no | Operator outcome: `delivered`, `superseded`, `deferred`, `open`, or `cancelled` |
| `disposition_by` | no | Operator identity that recorded the disposition |
| `disposition_reason` | no | Optional explanation |
| `disposition_run_id` | no | Terminal run whose history was reconciled |
| `disposition_at` | no | Disposition timestamp |
| `created_at` | yes | Creation timestamp with at least second precision |
| `updated_at` | yes | Last source-API update timestamp with at least second precision |

`external_source_refs` are deliberately opaque strings. A client can use a
namespaced form such as `system:item`, but the brain does not interpret it or
contact that system.

## Artifact link (`artifact_link.v1`)

An artifact link connects one local goal to evidence or work tracked anywhere.
Its `artifact_ref` remains opaque and does not imply network access.

| Field | Required | Meaning |
|---|---:|---|
| `goal_id` | yes | Existing local goal ref |
| `artifact_type` | yes | `fup`, `decision`, `plan`, `bug`, `pr`, `release`, or `other` |
| `artifact_ref` | yes | Opaque client-defined artifact identifier |
| `relationship` | yes | `supports`, `blocks`, `delivers`, `tracks`, or `relates` |
| `state` | yes | `unknown`, `planned`, `active`, `blocked`, `pending_delivery`, `delivered`, `superseded`, or `cancelled` |
| `label` | no | Optional display label |
| `created_at` | yes | Creation timestamp |
| `updated_at` | yes | Last source-API update timestamp |

The normalized `state` is stored evidence for later deterministic progress
calculation. It is not an invented completion percentage.

## Integrity rules

All graph mutations use one local edit lock. Before a write, the source API
checks the current graph and the proposed graph. It rejects:

- missing parent goals;
- self-parenting and hierarchy cycles;
- missing, self, duplicate, or cyclic goal dependencies;
- artifact links whose local goal does not exist; and
- exact duplicate artifact relationships for the same goal, type, reference,
  and relationship.

Rejected changes do not mutate the stored record. `validateGoalGraph()` checks
the complete stored graph and returns stable issue codes for diagnostics.

## Source API

[`src/goals.mjs`](../src/goals.mjs) exposes the reusable model surface:

- `createGoal`, `updateGoal`, `getGoal`, and `listGoals`;
- `assertGoalsExist` for run admission and other consumers;
- `linkGoalArtifact`, `updateArtifactLink`, and
  `listGoalArtifactLinks`; and
- `inspectGoalGraph` and `validateGoalGraph` for integrity diagnostics.

The API returns camel-case objects while the durable MAADB frontmatter uses the
snake-case fields documented above. Read operations are deterministic and
sorted by stable document ID.

## Effective state and historical attempts

Goal progress uses evidence epochs instead of applying one precedence order to
every run forever. An explicit terminal goal lifecycle or accepted terminal run
(`reviewed`, `merged`, or `released`) establishes a settlement point. Older
failed, rejected, abandoned, cancelled, or filed attempts stay in the evidence
list with `historical: true`, but they no longer downgrade the effective state.

A newer run in editing or delivery is explicitly current and can reopen a
terminal goal. A failed terminal attempt that started after the settlement also
remains blocking. This preserves fail-closed delivery: labels, lane exits, and
lifecycle prose do not create successful delivery evidence.

New goal-linked runs require criterion evidence and mark their run intent
`goal_alignment_required`. Their accepted/merged/released state contributes
`pending_delivery`, not automatic goal fulfillment. Legacy runs keep their
historical behavior. Explicit goal disposition remains separate from accepting
a work item. Definition changes preserve before/after decisions and reopen a
delivered goal; see [goal alignment](GOAL-ALIGNMENT.md) for the CLI and migration.

Filed evidence is intentionally ambiguous. Filing preserves the artifacts but
does not choose the goal outcome. Closeout therefore requires one disposition
for every declared goal:

```bash
agent-manager closeout <runId> --operator <id> \
  --goal-disposition goal-example=delivered
```

For older terminal runs, use the same durable repair model without editing run
telemetry or run-intent history:

```bash
agent-manager reconcile <runId> \
  --goal-disposition goal-example=deferred \
  --operator <id> --reason "follow-up remains open"
```

Repeat `--goal-disposition` for every `goal_refs` entry. `deferred` maps to a
planned lifecycle and `open` maps to active. Exact replays are no-ops. The goal
document retains version history, and the run receives a structured
`goalReconciliation` receipt. Settled run receipts are immutable: a conflicting
replay fails closed, and a later outcome must be attributed to a new run.
