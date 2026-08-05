# Operator guide

agent-manager lets one host conversation supervise several isolated Claude Code or Codex CLI lanes. The host launches a detached supervisor, reads status from disk, escalates blocking questions, verifies delivery, and keeps shipping under explicit operator control.

## Component boundary

- **🎛️ Agent Manager** is the orchestration core. It plans and supervises lane
  work, integration, telemetry, and Delivery Review.
- **📦 PR Manager** is the deterministic `agent-manager ship` function. It is
  not another autonomous agent and cannot grant its own approval.
- **🚦 Ship Gate** is the standalone human approval skill. A single developer
  can use it without Agent Manager; an Agent Manager run reaches it only after
  Delivery Review.

The controlled path is Agent Manager → Delivery Review → Ship Gate → PR
Manager. See the README's [standalone instructions](../README.md#use-each-component-standalone)
for the smallest supported setup for each use case.

## First run

```bash
npm ci
npm link
agent-manager doctor
agent-manager init --repo /path/to/repo --request "Describe the change" --harnesses claude,codex
# Complete workflow.planning and agent-manager.context.md after reviewing the
# work source, repository instructions, relevant code, and lane scopes.
agent-manager validate /path/to/repo/agent-manager.yaml
agent-manager run /path/to/repo/agent-manager.yaml --detach --json
```

Always inspect generated lane scopes before launch.

The invoking manager owns source check-in and close-out. Agent Manager remains
source-neutral and does not require workers to query a ticket, planning, or
session system. `init` creates a draft planning block with false attestations.
Before validation, record the authoritative source and plan references, the
reviewed repository paths and instruction files, and the full reviewed base SHA.
Set the attestations true only after completing those checks.
The workflow schema accepts this draft structure; `validate` and `run` enforce
launch readiness and require all four attestations to be true.

`doctor`, detached launch output, and `status.json` expose an automatically
detected runtime profile. The profile records the actual host platform, OS,
architecture, shell, shellless command mode, and path style. Every lane prompt
receives this block before its assignment. Do not use a manual OS selector to
override the host; a planning target must not disguise the machine that will
execute commands.

Validation and launch fail closed when planning is missing or incomplete, or
when `reviewed_base_sha` differs from the commit resolved by `base_ref`. The
shared context file must be a relative, non-empty file inside the target repo.
Launch copies it to the private run directory, records its SHA-256 digest, and
injects the same frozen contents into every worker prompt. Resume and integration
continue to use that frozen copy.

Workflows may define up to five lanes. `max_concurrency` defaults to three and
controls how many workers are active at once; other lanes remain visibly
queued. Workflow validation rejects overlapping write scopes before launch.
Use one writable owner per path.

## Detach is mandatory from a host chat

```bash
agent-manager run <workflow.yaml> --detach --json
```

The command validates the workflow, planning evidence, repository, base ref,
harness names, and required binaries before reporting detach success. It returns
a `runId`, runtime profile, telemetry path, supervisor log, and status command
in milliseconds.
A foreground run is for a dedicated terminal, not a chat turn.

Master return is independent of the worker lane harness. Codex and Claude Code
launches capture `CODEX_THREAD_ID` or `CLAUDE_CODE_SESSION_ID` as a private
return channel and start a detached watcher. Actionable changes such as worker
completion, blocked input, and terminal delivery resume the originating Master
Dev thread. Cursor Agent CLI supports direct return when a chat ID is supplied
with `--return-host cursor --return-session <chat-id>`. Cursor IDE launches use
signal mode because the IDE does not expose a documented chat ID to terminal
subprocesses; keep the host's `AGENT_MANAGER_WAKE_` notification attached.
Routine lane progress does not create extra turns. Use `--no-master-return` to
disable return handling. Session IDs are stored only in private run telemetry
and are omitted from `status` output.

Worker success enters `delivery_review_pending`. It is deliberately not a
terminal delivery state. Change-producing work reaches `merged` or `released`
only after its
persisted Delivery Review, Ship Gate, and PR Manager evidence are complete.
Never gate another wave on lane state, released claims, or worker completion.
Review-only or approved no-change work terminates at `reviewed` after Delivery
Review acceptance and does not enter Ship Gate.
Use:

```bash
agent-manager delivery-ready <runId> --require merged
agent-manager delivery-ready <runId> --require released
```

The readiness command exits with code 2 until the selected boundary is proven.

## Operator cadence

Every operator board ends with a deterministic transition:

| Transition | Host behavior |
|---|---|
| `AUTO_CONTINUE` | Take the stated next action before ending the turn |
| `WAIT_OPERATOR` | Present the exact reply vocabulary and stop |
| `TERMINAL` | Post final evidence, close the source record, and stop watching |

Use `agent-manager next-action <runId> --json` to resolve the current stage.
Never report only that a stage completed. In particular, worker completion is
`AUTO_CONTINUE`: post Run Outcome, perform Delivery Review, and only then wait
for the operator's verdict. A persisted `revise` or `relaunch` automatically
starts the one correction. An accepted review automatically advances to Ship
Gate presentation.

## Observe without blocking

```bash
agent-manager status <runId> --json
agent-manager monitor <runId>
agent-manager fleet
agent-manager fleet --active
agent-manager fleet --stream
agent-manager events <runId> --jsonl
agent-manager watch-signal <runId> --heartbeat-sec 180
```

`fleet` is the read-only side-terminal view across runs. In an interactive
terminal it redraws with lane progress, worker updates, blockers, transitions,
and keyboard focus. Use `--stream` for an append-only event feed or `--once`
for logs and scripts. It reads the run directory directly and does not need a
mounted service.

`status.json` is authoritative. `events.jsonl` and `watch-signal` are notification sources, not alternate state stores. A `blocked` run is resumable and is not terminal.

Inspect the sanitized return state with
`agent-manager status <runId>`. Private return telemetry is stored at
`<run>/master-return.json`; the latest structured handoff is
`<run>/master-handoff.json`. If delivery fails, resume manually with
`agent-manager next-action <runId> --json` and inspect
`<run>/master-return-supervisor.log`. An actionable `AUTO_CONTINUE` stage is
retried on its next heartbeat if a direct return attempt fails. The normal
`watch-signal` remains the portable heartbeat and fallback path for every host.

Every wake payload includes `cadence.stage`, `cadence.transition`,
`cadence.nextAction`, `cadence.operatorInputRequired`, and the canonical
template name. Waiting stages do not emit repetitive heartbeats.

Cursor support for waking an idle chat from arbitrary process output is host-version dependent. Keep the run detached. Use the side-terminal monitor, event consumer, or operating-system notifications when the host cannot re-enter the chat automatically.

For a Codex thread heartbeat, preserve Codex's required heartbeat response
envelope. The scheduled prompt may request the canonical Agent Manager board,
but it must also require the response to end with the host-provided
`<heartbeat>` block and a `NOTIFY` or `DONT_NOTIFY` decision. Do not say “only
the canonical template,” because that conflicts with the Codex heartbeat
protocol. Telemetry wakes the host; delivery state remains enforced on disk.

## Answer a lane

```bash
agent-manager reply <runId> <laneId> --message "approved answer"
```

Reply resumes the recorded Claude or Codex session. It does not create a new independent conversation.

## Delivery Review

```bash
agent-manager review <runId>
agent-manager review <runId> --pass 1 --verdict accept-with-notes \
  --reviewer master-dev --notes "CI required on every target"
```

Calling `review` without a verdict records that the review was presented and
transitions cadence to `WAIT_OPERATOR`. This distinguishes “review must be
performed” from “the operator is now deciding.”

The generated Pass 1 document collects lane states, scopes, changed files, violations, exits, and evidence logs. The host must still compare those facts with the original request and rerun relevant tests. At most one correction is allowed, followed by Pass 2. There is no automatic Pass 3.

Only a persisted accepted Delivery Review can proceed to Ship Gate. The ship
command rejects conversational approval that was not recorded in `status.json`.
Workers do not own commits, pushes, pull requests, merges, tags, or releases
unless the workflow explicitly permits a narrower action.

## Integration

```bash
agent-manager integrate <runId>
```

Integration snapshots successful lane worktrees and merges them into
`am/<runId>/integrate` from the immutable base SHA recorded at launch. Before
merging, it blocks any file changed by multiple unordered lanes even when Git
could merge that file cleanly. A `depends_on` chain explicitly approves
sequential edits to the same file; the overlap is recorded as a Delivery Review
risk. Configured `verification.commands` then run without a shell in the
integration worktree. A merge conflict or failed verification becomes a
resumable escalation. Integration does not push or merge to the target
repository default branch.

If `integrate: false` is used for more than one writable lane, the workflow
must declare a `delivery.targets` train that maps every lane to an explicit
destination. Branch and existing PR coordinates are optional; omitted branches
use the generated lane branch. Validation fails when any writable lane is
unmapped. Simple Flow requires `integrate: true` for multi-lane writable work.

## Dependencies and ownership

Use `depends_on` when a lane needs completed prerequisite output. Independent
lanes still run in parallel. A dependent worktree receives snapshot commits
from successful prerequisites before its worker starts. If a prerequisite asks
for input, dependent lanes remain in `dependency-waiting` and start after the
exact prerequisite session resumes successfully.

Dependency ordering may also sequence two writable lanes over the same scope.
This is the supported multi-writer case: the dependent starts from the
prerequisite snapshot, and the resulting same-file overlap remains visible in
Delivery Review.

Scope exceptions remain single-writer:

```yaml
scope_overrides:
  - path: src/ui/**
    lanes: [platform, ui]
    owner: ui
    reason: The platform lane reads the UI contract; the UI lane owns edits.
```

The non-owner receives a read-only guardrail for the override path. A
multi-writer exception is not supported.

## PR Manager after Ship Gate

PR Manager starts only after a persisted accepted Delivery Review and an
explicit Ship Gate approval. It uses the same run ID and `status.json`.

Formal Flow through the pull request:

For a delivery train, pass the next target ID. Omit `--target` for a single
integrate branch.

```bash
agent-manager ship <runId> \
  --approve through-pr \
  --target <delivery-target-id> \
  --commit-message "feat: approved change" \
  --detach --json
```

Formal release stamping uses a private run-owned worktree. Local changes in the
operator's shared checkout do not block or participate in the release. GitHub
check registration has a 90-second grace period by default; override it with
`--check-grace-sec <seconds>` when needed.

Formal or Simple Flow through version and tag:

```bash
agent-manager ship <runId> \
  --approve all \
  --commit-message "feat: approved change" \
  --version 1.2.0 \
  --summary "Add the approved capability." \
  --detach --json
```

For a Formal delivery train, use `through-pr` on earlier targets and `all` only
on the final target. Release stamping proves that every recorded target merge
SHA is an ancestor of the release base. Simple Flow pushes the reviewed
single/integrated worktree commit directly to its base branch and then tags it.

The detached supervisor commits only when the approved worktree is dirty,
pushes the recorded branch, finds or creates the pull request, enables
`gh pr merge --auto --squash`, and watches checks until merge. For `all`, it
updates the existing version stamp set, runs `check:version` when provided,
pushes the release commit, waits for configured GitHub Actions workflows, and
then publishes the matching tag.

Optional overrides are `--repo`, `--worktree`, `--branch`, `--base`,
`--remote`, and `--pr`. Use them only when the run metadata is incomplete and
the operator has confirmed the target.

After launch:

```bash
agent-manager watch-signal <runId> --heartbeat-sec 180
```

Read `status.json.ship` on every wake. Report with
[`skills/pr-manager/reporting.md`](../skills/pr-manager/reporting.md). A
blocked ship phase is resumable by correcting the external condition and
rerunning the same detached command. Cancel with the normal `cancel` command.
The ship phase never bypasses failed checks or creates a GitHub Release.

## Cancellation and retention

```bash
agent-manager cancel <runId>
agent-manager cleanup <runId>
agent-manager cleanup --stale --older-than-days 30
```

Cancellation writes an authoritative marker. The live supervisor then
terminates lane process trees it owns. The detached ship supervisor stops
between bounded Git or GitHub commands and polling cycles. The cancel command
does not kill an unverified stale PID. Cleanup refuses every incomplete
delivery state. Stale cleanup removes only overall-terminal runs.

## Claims

Workflow claim modes:

- `auto`: use the configured registry; registry failure is advisory.
- `off`: do not claim. Useful for a single local operator.
- `required`: fail if the claim cannot be recorded.

The bundled registry defaults to `~/.agent-manager/claims`. Claims are leased
and renewed by the supervisor. An expired claim is recovered automatically only
when its recorded local supervisor process is confirmed inactive; unverifiable
remote or legacy claims remain blocking until explicit release. Set
`AGENT_MANAGER_CLAIM_BIN` to use another implementation.

## Dangerous permissions

Dangerous permission bypass is disabled by default. Enabling it requires both:

1. `policy.dangerously_skip_permissions: true` in the workflow.
2. `--allow-dangerous-permissions` on that launch, or `AGENT_MANAGER_ALLOW_DANGEROUS_PERMISSIONS=1` in the invoking environment.

Do not make either setting a persistent default.

## Sensitive run data

The runs directory can contain prompts, replies, model output, file paths, session identifiers, and worktrees. agent-manager creates run and claim files with private permissions where supported and filters the environment passed to workers. Add extra variable names only through `env_allowlist` or `AGENT_MANAGER_ENV_ALLOWLIST` when a harness genuinely needs them.

Keep run data outside public or synchronized folders. Use retention cleanup. Never commit it.

## Cursor installation

```bash
agent-manager install cursor
agent-manager install cursor --project /path/to/repo
```

The first command installs the canonical agent-manager and PR Manager user
skills. Project mode also installs a concise `.cursor/rules` fallback.
Reporting templates remain canonical in the skills; the rule points to the
CLI flow instead of duplicating them.

Ship Gate is installed or referenced separately because it is repository-owned
approval policy, not part of the orchestration runtime.

## Public repository hygiene

Run these checks before proposing a public change:

```bash
npm test
npm run hygiene
npm pack --dry-run
```

See [PUBLIC-REPO-HYGIENE.md](PUBLIC-REPO-HYGIENE.md), [SECURITY.md](../SECURITY.md), and [CONTRIBUTING.md](../CONTRIBUTING.md).
