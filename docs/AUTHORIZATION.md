# Conditional shipping authorization

Conditional authorization is an optional, provider-neutral alternative to a
second interactive Ship Gate. It does not replace Delivery Review. The default
remains an accepted Delivery Review followed by an explicit `through-pr` or
`all` Ship Gate reply.

A private immutable grant applies to one run and one delivery target. It records
the exact approval level, reviewed base and head, evidence and manifest digests,
risk ceiling, provider mode, runtime version, permitted mutations, independent
reviewer policy, operator provenance, and expiry.

## Create and use a grant

Create a grant after worker completion freezes delivery evidence. Expiry must
be within seven days.

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

When cadence reports `conditional_authority_ready`, launch exactly once:

```text
agent-manager ship <runId> --authorized --detach
```

The launch re-hashes the current base, head, worktree state, evidence, runtime
version, provider mode, release version, risk, and execution manifest. It writes
a separate immutable receipt before queueing. The ship supervisor validates the
receipt and current evidence again before its first provider command.

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
