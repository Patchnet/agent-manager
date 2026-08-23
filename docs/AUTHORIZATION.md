# Conditional shipping authorization

Conditional authorization is an optional, provider-neutral alternative to a
second interactive Ship Gate. It does not replace Delivery Review. Repositories
without an explicit policy keep the existing behavior: accepted Delivery
Review followed by an explicit `through-pr` or `all` Ship Gate reply.

A private immutable grant applies to one run and one delivery target. It records
the exact approval level, reviewed base and head, evidence and manifest digests,
risk ceiling, provider mode, runtime version, permitted mutations, independent
reviewer policy, operator provenance, and expiry.

## Repo policy: one acceptance

Store a public JSON or YAML policy in, or explicitly scoped to, the target
repository. The policy is provider-neutral: `provider.mode` names the selected
adapter contract but does not grant provider bypasses.

```yaml
schema: agent-manager.automation-policy.v1
enabled: true
repository:
  path: .
  base_ref: main
approval:
  level: through-pr
  operator: release-operator
  approved_at: 2026-08-23T12:00:00Z
  expires_at: 2026-08-24T12:00:00Z
risk:
  observed: moderate
  ceiling: moderate
  classes: []
  exceptions: []
provider:
  mode: github
shipment:
  commit_message: "feat: approved change"
revocation: null
```

The approval window must be active and no more than seven days from the
accepting review. `security` and `authentication` classes remain manual unless
the same class is named in `risk.exceptions`. Set `enabled: false`, add a
`revocation` record, or use the immutable grant revocation command to stop
automation.

The independent manager accepts and materializes the exact grant in one
operation:

```text
agent-manager review <runId> --pass 1 --verdict accept \
  --reviewer <label> --reviewer-role manager \
  --automation-policy <policy-file>
```

If the policy is missing, disabled, revoked, expired, out of scope, above its
risk ceiling, or lacks an explicit risk exception, the acceptance remains
recorded but conditional authority is blocked. Cadence reports the reason and
requires the manual Ship Gate. It never silently changes the approval level.

When the policy is valid, cadence returns `conditional_authority_ready` and
`AUTO_CONTINUE`. Launch exactly once:

```text
agent-manager ship <runId> --authorized --detach
```

## Manual grant compatibility

The earlier explicit grant command remains available. It creates a grant after
worker completion, then waits for an independently attributable review. Expiry
must be within seven days.

```text
agent-manager authorization create <runId> \
  --level through-pr \
  --operator <operator-id> \
  --expires-at <iso-8601> \
  --risk moderate \
  --risk-ceiling moderate \
  --provider-mode github \
  --commit-message "feat: approved change"
```

For `all`, also supply the exact `--version` and `--summary`. Simple Flow also
requires `--commit-message`. Delivery trains require `--target`. Optional ship
inputs such as `--base`, `--branch`, and `--remote` become part of the immutable
manifest.

The independent reviewer records the decision against the run's existing
manager identity:

```text
agent-manager review <runId> --pass 1 --verdict accept \
  --reviewer <label> --reviewer-role manager
```

A reviewer label alone never proves independence. The run must have attributable
manager harness plus model or thread metadata, and that identity must not
collide with a worker author identity.

The launch re-hashes the current base, head, worktree state, evidence, runtime
a separate immutable receipt before queueing. The ship supervisor validates the
receipt and current evidence again before its first provider command.

Policy grants also bind the normalized policy digest and the exact accepting
review decision. Policy edits, provider changes, reviewer drift, or decision
drift invalidate the grant.

## Inspect or revoke

```text
agent-manager authorization inspect <runId>
agent-manager authorization revoke <runId> --operator <operator-id> --reason "scope changed"
```

Status, events, wakes, and CLI output expose safe state and digests only. Full
grants, provenance, manifests, revocations, and receipts stay in the private run
directory under `authorization/` with owner-only permissions.

Revocation is immutable. A consumed grant cannot be revoked or replayed. A
failed launch after receipt creation still consumes the grant.
Each run can hold only one grant. After revocation, expiry, consumption, or
material drift, use a new explicit manual Ship Gate or start a new reviewed run
and create its grant.

Conditional advance fails closed on rejection or inconclusive review, missing
or colliding reviewer identity, expiry, revocation, replay, modified authority
files, or any base, head, evidence, manifest, provider-mode, runtime-version,
release-version, or risk drift. It never downgrades authority, approves a review,
or bypasses branch, provider, CI, or release policy. Provider adapters and hosted
shipment scheduling remain separate from this foundation.
