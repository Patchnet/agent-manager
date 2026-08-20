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

1. Require an accepted Delivery Review persisted in `status.json` and either an
   explicit Ship Gate approval or a valid immutable conditional grant. A
   chat-only verdict is not sufficient. Conditional launches use only
   `ship <runId> --authorized --detach`; never override or replay a grant.
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
11. A delivery train ships one declared target at a time with `--target <id>`.
    A target with no changed files must fail closed. A completed target does not
    mean the overall run is complete while other targets remain.
12. Use `all` only on the final delivery target. Before a release stamp or tag,
    require every target merge SHA and prove each is an ancestor of the release
    commit.
13. End every board with the reporting transition. Continue automatically for
    detached progress and already-approved train targets. Wait only for a
    blocker or new Ship Gate authority. Never report a completed target and
    stop without naming and taking the next authorized action.
14. Formal release work runs only in the private release worktree under the run
    directory. Never switch, clean, stamp, or require a clean shared checkout.
15. Allow the bounded check-registration grace period before diagnosing a
    missing required check. Routine CI registration and execution are wait
    states, not operator blockers.

## Launch

When `next-action` reports `conditional_authority_ready`:

```bash
agent-manager ship <runId> --authorized --detach --json
```

The private grant supplies every input. Otherwise use the manual commands below.

Formal Flow, stop after merge:

```bash
agent-manager ship <runId> \
  --target <delivery-target-id> \
  --approve through-pr \
  --commit-message "feat: approved change" \
  --detach --json
```

Formal Flow, merge and release:

```bash
agent-manager ship <runId> \
  --target <final-delivery-target-id> \
  --approve all \
  --commit-message "feat: approved change" \
  --version 1.2.0 \
  --summary "Add the approved capability." \
  --detach --json
```

Omit `--target` for a single integrate-branch delivery. Simple Flow uses
`--approve all`, an explicit `--commit-message`, version, and summary. Use
`--branch`, `--base`, `--remote`, `--repo`, or `--pr` only when
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
   - target done but more targets/release pending: **Ship outcome**, then return
     to the next approved target or release decision
   - overall terminal (`merged|released|rejected|failed|cancelled`): **Ship
     outcome**, then stop watching
7. If the operator resolves a blocker, rerun the same `ship` command. The
   phase reuses existing commits, pull requests, merges, and matching tags
   when safe.

## Telemetry

`status.json.ship` contains:

- the authoritative host `runtime` profile used for command selection;
- `state`: `queued | running | blocked | done | failed | cancelled`
- `phase`: `preflight | commit | push | pr | merge | release | release-push | ci | tag | done`
- delivery target id, approval, branch, base, remote, pull-request URL, merge SHA, release SHA,
  tag, steps, last activity, and optional `needsInput`

Private ship artifacts are stored under
`$AGENT_MANAGER_RUNS_ROOT/<runId>/ship/`.
