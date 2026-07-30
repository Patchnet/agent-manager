---
name: pr-manager
description: >-
  Detach an explicitly approved Ship Gate workflow into agent-manager so the
  host chat does not babysit GitHub pull requests, CI, merges, version stamps,
  or tags. Use after an accepted Delivery Review and a Ship Gate reply of
  `through-pr` or `all`, or when the operator asks to hand off, background,
  or monitor approved shipping. Never invoke before Ship Gate approval.
---

# PR Manager

Use the existing agent-manager run and telemetry. PR Manager is a shipping
phase, not a second application or an independent approval system.

Read [reporting.md](./reporting.md) before posting any ship status.

## Hard rules

1. Require an accepted Delivery Review and an explicit Ship Gate approval.
2. Map the approval exactly:
   - `through-pr`: commit if needed, push, create or find the pull request,
     enable squash auto-merge, and stop after merge.
   - `all`: perform `through-pr`, then create the approved version stamp,
     push it, wait for release CI when configured, and publish the tag.
3. Always run `agent-manager ship ... --detach`. Never poll CI or merge in the
   host chat after handoff.
4. Pass the approved commit message, version, and public release summary. Do
   not invent them. `all` requires `--version` and `--summary`.
5. Keep `status.json` authoritative. Arm `watch-signal`; re-read status before
   posting a board.
6. Formal Flow always uses `gh pr merge --auto --squash`. Never ask the
   operator to click Merge.
7. Do not bypass reviews, branch protection, failed CI, version checks, merge
   conflicts, or authentication failures.
8. A blocked ship phase escalates once with actionable options. Do not guess,
   open another Delivery Review pass, or silently downgrade `all` to
   `through-pr`.
9. When `mergeStateStatus` is `BLOCKED` but CI conclusions look green and
   `reviewDecision` is empty: **diagnose required status-check name mismatch
   before asking for a human Approve.** Compare branch-protection contexts to
   `statusCheckRollup[].name` (exact string). Formal Flow expects the check
   name to stay the CI job id (commonly `quality`) — not a marketing
   `name:` label. Prefer restoring the job display name over changing
   protection.
10. Do not create a GitHub Release. Release-note publication remains a separate
    reviewed action.

## Launch

Formal Flow, stop after merge:

```bash
agent-manager ship <runId> \
  --approve through-pr \
  --commit-message "feat: approved change" \
  --detach --json
```

Formal Flow, merge and release:

```bash
agent-manager ship <runId> \
  --approve all \
  --commit-message "feat: approved change" \
  --version 1.2.0 \
  --summary "Add the approved capability." \
  --detach --json
```

Simple Flow uses `--approve all`, an explicit `--commit-message`, version, and
summary. Use `--branch`, `--base`, `--remote`, `--repo`, or `--pr` only when
the recorded run metadata is insufficient or the operator supplied an
override.

## Host workflow

1. Validate that Delivery Review accepted the work.
2. Present Ship Gate and wait for `through-pr` or `all`.
3. Launch `ship --detach` with the exact approval and release inputs.
4. Post **PR Manager · Handoff** and exit the turn.
5. Arm:

   ```bash
   agent-manager watch-signal <runId> --heartbeat-sec 180
   ```

6. On wake, read `status.json`:
   - ship progress: **Ship board**
   - ship blocker: **Ship escalation**
   - terminal: **Ship outcome**, then stop watching
7. If the operator resolves a blocker, rerun the same `ship` command. The
   phase reuses existing commits, pull requests, merges, and matching tags
   when safe.

## Telemetry

`status.json.ship` contains:

- `state`: `queued | running | blocked | done | failed | cancelled`
- `phase`: `preflight | commit | push | pr | merge | release | release-push | ci | tag | done`
- approval, branch, base, remote, pull-request URL, merge SHA, release SHA,
  tag, steps, last activity, and optional `needsInput`

Private ship artifacts are stored under
`$AGENT_MANAGER_RUNS_ROOT/<runId>/ship/`.
