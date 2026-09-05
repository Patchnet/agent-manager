# Goal alignment and change control

Agent Manager provides the goal and operating framework. Director connects
operator intent to assignments, reviews and releases. Coding history and working
context stay in the harness; organizational knowledge stays in the operator's
chosen store. The local goal graph stores goal records, assessments and evidence
references, not copied conversations.

## Assess material requests

The manager supplies a reasoned relationship: `advances`, `dependency`,
`optional`, `changes-goal`, or `unrelated`. The CLI validates the assessment; it
does not infer semantic relevance from keywords or independently verify a claimed
operator instruction. Skills and the invoking manager remain responsible for
faithfully interpreting the request and authority.

Use `goal show <id> --json` to obtain the current `goalDigest`, version and
criteria. Prepare a JSON assessment:

```json
{
  "request": "Add a progress dashboard",
  "relationship": "optional",
  "criteria": [],
  "reason": "Visibility helps operation but is not required for the delivery path",
  "impact": "Adds UI work before the first unattended delivery milestone",
  "by": "manager",
  "goalDigest": "<digest from goal show>",
  "decision": "proposed"
}
```

```text
agent-manager goal assess <id> --assessment request.json --json
agent-manager goal assess <id> --assessment request.json --record --json
```

The first command evaluates without recording a request. The second appends it
to the goal record under the graph lock. Identical submissions replay without a
new write. A changed goal digest requires reassessment. Proposed and deferred
ideas remain visible in `goal show`; neither creates a commitment or launches a
run. There is no automatic archive or abandonment based on inactivity.

`advances` and `dependency` must reference exact existing criterion text. To
continue within an existing instruction, record `decision: continue` and its
`authorityRef`. No new confirmation is required. Other relationships require an
explicit `defer`, `amend`, `separate`, or `replace` decision with an authority
reference. These record the decision; they do not change goals or grant file,
shipping, or production permissions. A newly authorized separate goal must be
created explicitly. Keep unrelated authorized work moving while a decision waits.

For a scope decision, present one short comparison: current goal, requested
addition, relationship, effect on the current release and a recommendation.
Avoid turning every routine edit into a checkpoint.

## Amend the goal deliberately

Changing title, outcome or success criteria requires the current goal version,
the decision maker, reason, impact and a reference to the instruction authorizing
the change. Existing explicit instructions are sufficient; these fields do not
require a second approval conversation.

```text
agent-manager goal update <id> --outcome "Revised outcome" --expected-version 3 --change-by operator --change-reason "Approved expansion" --change-impact "Move reporting to the next release" --authority-ref "decision:expand-delivery"
```

The record retains before/after definitions and decision metadata. A changed
definition reopens a delivered goal. Old run snapshots remain unchanged; do not
rewrite their acceptance criteria to fit whatever shipped. Resume an existing
run only within its frozen assignment; use a new assignment when the accepted
goal change materially replaces that contract. File-scope checks still apply.

## Review work and assess goal fulfillment separately

New runs with `goal_refs` freeze a criterion-evidence requirement. For review,
`agent-manager review <runId> --json` provides `goalEvidenceTemplate`. Complete it
using the actual changes and verification results, then pass the JSON array:

```text
agent-manager review <runId> --pass 1 --verdict accept --reviewer manager --goal-evidence evidence.json
```

Every referenced goal and every criterion must be covered once. Use `met`,
`unmet`, or `not-addressed`, with evidence or an explanation. The goal digest must
match the run's frozen definition. The review reports `fulfilled` only when all
criteria are met, otherwise `partial`. It may accept a correctly completed
partial work item without declaring its parent goal complete. Evidence strings
are reviewer assertions: the reviewing agent must inspect the evidence, and an
independent reviewer is still required wherever the shipping policy requires one.

Accepted, merged and released goal-aligned runs contribute pending goal-delivery
evidence rather than automatic goal fulfillment. Use the existing explicit goal
disposition path after evaluating the whole goal. Conditional shipping grants
include criterion assessments in their review digest. A fulfilled assessment
does not itself supply shipping authority.

## Compatibility and limits

- Goal definition updates now require decision metadata; lifecycle-only updates
  retain the existing API. Existing goal histories are widened without rewriting
  their contents.
- Existing run snapshots and legacy progress semantics remain readable. New
  goal-linked runs require criterion evidence. Goal-less small runs still work.
- Request assessment is invoked by the manager skill or CLI. This release does
  not intercept every message in every harness or launch a continuous Director.
- External source references remain opaque. No external knowledge store is
  mirrored or modified by these commands.
