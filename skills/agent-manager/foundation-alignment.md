# Activation and delivery continuity

Agent Manager's engine version and each harness's installed instructions are
separate. Run `doctor --repo <checkout> --json`: `ok` reports executable readiness,
`aligned` reports instruction/version alignment, and `activation.commands` lists
every detected host requiring attention. Both Agent Manager and PR Manager files
are checked against their installation digests. Local modifications are preserved
by the installer unless explicitly replaced after review.

Run `install codex`, `install claude`, and `install cursor` for the hosts in use.
Use `--project <repo>` for an existing project installation. New sessions load the
updated instructions; installing cannot replace instructions already held in a
running conversation. Check other machines in their own environments. Doctor
does not establish that every remote host or existing conversation is aligned.

New run telemetry records the engine version, source commit and tracked-dirty
state captured when its process started. A package installation without Git
metadata reports unknown commit/dirty values rather than borrowing an enclosing
repository's identity.

## Goal routing

For sustained goal-driven work, set `goal_policy: required` with `goal_refs`.
For a small standalone task, set `goal_policy: exempt` and explain why in
`goal_exemption`. A missing policy remains compatible with older workflows but
warns when goal alignment is inactive. The invoking manager owns goal selection;
the runtime does not infer intent or invent goals.

## Claims and startup

`node tools/claim.mjs check --repo <repo> --scope <paths>` is a read-only ownership
preflight. It distinguishes known active, unknown and safely recoverable claims.
Required-claim detached launches check before starting a supervisor; admission
still rechecks under the registry lock. Custom claim adapters without this
protocol retain their own authoritative admission checks.

Expired age alone never authorizes eviction. Recovery requires an expired claim
and a confirmed dead local owner. Unknown remote ownership and permission errors
remain protected. Correct the ownership conflict or environment before retrying.
Executable preflight cannot prove that a harness can initialize every sandbox or
app-server session; a startup permission failure is not a reason to disable its
sandbox or automatically retry with broader permissions.

## External release reconciliation

Repositories that stamp versions on main after merge can continue using their
own release helper after `ship --approve through-pr`. Record the completed release:

```text
agent-manager reconcile <runId> --external-tag vX.Y.Z --operator reviewer --authority-ref "existing release approval" --json
```

This reads provider evidence; it does not create a tag or release. It requires
accepted review, merged PR checks, the remote tag, matching full version stamps,
tag CI, merge-to-release ancestry and release containment in the target base.
For a squashed correction whose parent commit never reached main, base ancestry
may be verified through the PR head only when it exactly matches the recorded
accepted lane snapshot. That evidence path is recorded explicitly.
The operator/authority fields identify an existing decision; they do not grant
permission to ship. Conflicting tags are rejected. Failed verification preserves
the prior ledger. Identical verified requests replay without another transition.
Goal completion and deployment acceptance remain separate.

## Corrections across runs

A retry/recovery of a parent whose latest review requests correction inherits
that parent's correction count, elapsed-time origin and goal references. It
cannot reset the review allowance by becoming a new run. After accepting the
child, retire the original unaccepted snapshot explicitly:

```text
agent-manager reconcile <parentRunId> --superseded-by <childRunId> --operator reviewer --authority-ref "existing correction approval"
```

The command requires recorded correction-family linkage and the same parent pass.
It retains the parent's review history, records the accepted child and marks the
original run cancelled. Ship the child only. Historical runs without structured
family evidence are not silently rewritten. Use one correction child at a time;
this foundation does not implement a concurrent family scheduler or a continuous
Director controller. An unrelated new operational run cannot be semantically
identified as a hidden correction by the CLI; the invoking manager must preserve
lineage rather than reset it.
