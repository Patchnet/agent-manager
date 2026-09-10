---
name: agent-manager
description: >-
  Run multi-lane agent orchestration via the agent-manager CLI.
  Use when the operator says "fire up agent manager", "agent-manager",
  "run lanes", "multi-lane", "orchestrate agents", "kick off parallel agents",
  or asks for fleet/lane status from a Master Dev session. Read status.json,
  report with the standard board templates, escalate needs-input in chat,
  run Delivery Review before Ship Gate, never freestyle status formats.
  Always run with --detach so Master Dev chat stays free. After detach, arm
  watch-signal (3m heartbeat + state wakes) so the chat is not silent.
---

# agent-manager (Master Dev skill)

**Canonical home:** `<agent-manager-repo>/skills/agent-manager/`  
**CLI:** `<agent-manager-repo>/bin/agent-manager.mjs`  
**Telemetry:** resolved runs root from `agent-manager config show` →
`<runsRoot>/<runId>/status.json` (never invent a path)  
**Detail:** [reference.md](./reference.md) · [reporting.md](./reporting.md) · [operator guide](https://github.com/Patchnet/agent-manager/blob/main/docs/OPERATOR.md)

This skill is model-neutral. Claude Code, Codex, Cursor, and others follow the
**same** command surface and **same** chat reporting templates.

## When to run

Load this skill immediately when the operator:

- Says **fire up agent manager** / **run agent-manager** / **kick off lanes**
- Asks to run parallel agents across scopes in sibling repos under `AGENT_MANAGER_DEV_ROOT`
- Asks for **lane status**, **run status**, or **what the agents are doing**
- Mentions a workflow YAML for multi-lane work

Do **not** use this for single-repo interactive coding the operator wants to do
themselves in one chat — that stays a normal focused session.

## Hard rules

1. **Master Dev stays the human channel and owns source check-in.** Before launch,
   the invoking manager reviews the source references, repository instructions,
   relevant code, and lane scope. Record that evidence in `workflow.planning`.
   Agent Manager is source-neutral: workers receive a frozen assignment packet
   and may verify it through permitted read-only sources; the manager owns updates.
2. **Never await a full `run`.** Always use `run <workflow> --detach`. Capture
   `runId` from stdout, post the **Run board**, then arm **watch-signal**. A
   foreground / long-blocking await on `run` freezes the Master Dev chat turn
   for the whole lane duration — that is a session bug, not optional.
   Host agents (Cursor / Claude Code / Codex): set shell `block_until_ms: 0` or
   equivalent only as a fallback; prefer `--detach` so the Node supervisor itself
   exits in milliseconds.
3. **Arm a watch loop after every detach (mandatory).** Do not leave the operator
   in silence until they ask for status. See **Watch loop** below.
4. **One worktree + one agent per lane** (CLI enforces via worktrees + claims).
5. **Read telemetry from disk** — `status.json` / `report.md` under the runs root
   from `agent-manager config show`. Do not invent lane state. Prefer
   `node … status` / `monitor` or reading JSON.
6. **Never redirect path roots.** Do not set/export `AGENT_MANAGER_*_ROOT`,
   pass write-path overrides, or run `config init --force`. User `config.env`
   is authoritative; conflicting ambient values are ignored. Only the operator
   may unlock with `AGENT_MANAGER_ALLOW_PATH_OVERRIDE=1`.
7. **Chat status uses the templates in [reporting.md](./reporting.md) only** —
   no freestyle dashboards.
8. **Delivery Review before Ship Gate.** Lane exit 0 / CI green is not
   acceptance. Master re-reads the original proposal, verifies worktree
   deliverables (including cross-lane contracts), and posts **Delivery Review
   · Pass 1**. Worker completion is `delivery_review_pending`, not a terminal
   delivery state. Persist the operator decision with `agent-manager review`.
9. **Bound corrections.** The default remains one correction and a final Pass 2.
   An explicitly authorized workflow may set `delivery.review_budget` with
   up to five corrections and an elapsed-time limit. Each correction still
   requires a recorded `revise` or `relaunch` decision; extra corrections
   require notes showing progress and remaining gaps. Stop on repeated lack of
   progress. At the count/time limit, accept, accept-with-notes, or reject.
   A larger budget supplies no shipping authority and does not authorize an
   autonomous review loop. Do not silently raise it or start replacement runs.
10. **Workers do not commit/merge/tag** unless the workflow explicitly allows it
   (default: forbidden). Shipping goes through **Ship Gate** *after* an
   accepting Delivery Review within the run budget.
11. **Integrate** (`integrate: true` in workflow) folds successful lanes into
    `am/<runId>/integrate` after coding finishes. It prepares the branch only.
    Master owns Delivery Review and Ship Gate. After approval, hand shipping to
    the **pr-manager** skill with `ship --detach`; do not babysit push, PR, CI,
    merge, or tag in the host chat. Never ask the operator to click Merge.
    When `integrate: false` has multiple writable lanes, `delivery.targets`
    must map every lane to its delivery branch/PR. Downstream work must use
    `agent-manager delivery-ready <runId> --require merged|released`, never
    worker `done` or released claims.
12. **Dangerous permissions need two approvals.** The workflow policy and the launch flag
    `--allow-dangerous-permissions` (or matching environment confirmation) must both be present.
    **Conditional authority is separate and immutable.** The manual Delivery
    Review + Ship Gate path remains the default. With a valid grant, record the
    acceptance using `--reviewer-role manager`, follow `next-action`, and launch
    only with `ship <runId> --authorized --detach`. Never repair, replay,
    downgrade, or override a grant. See [AUTHORIZATION.md](../../docs/AUTHORIZATION.md).
13. On `needs-input` / blocked lanes: surface the question in chat, wait for the
    operator, then resume/reply (or cancel) — do not guess product decisions.
14. **Every operator board declares its transition.** End with
    `AUTO_CONTINUE`, `WAIT_OPERATOR`, or `TERMINAL`, plus the exact next action
    and reply vocabulary. On `AUTO_CONTINUE`, take that action before ending
    the turn. Never report only that a stage finished. Use
    `agent-manager next-action <runId> --json` to resolve ambiguity.
15. **Verify worker harness visibility before planning a run.** Run
    `agent-manager doctor --json` in the same OS environment that will launch
    Agent Manager. If a harness is missing, follow Doctor's structured setup
    recommendation. Restart the host after PATH or binary-override changes.
    Native Windows, WSL, containers, remote hosts, and CI are separate
    environments. See `docs/HARNESS-SETUP.md`.

## Quick commands

Prefer absolute paths to your clone:

```bash
agent-manager run <workflow.yaml> --detach
agent-manager status [runId]
agent-manager monitor [runId]
agent-manager fleet [runId] [--active | --stream | --once] [--classification <kind>]
agent-manager watch-signal [runId] --heartbeat-sec 180
agent-manager reply <runId> <laneId> --message "..."
agent-manager cancel <runId>
agent-manager integrate <runId>
agent-manager cleanup <runId>
agent-manager cleanup --stale --dry-run [--json]
agent-manager review <runId>
agent-manager review <runId> --pass 1 --verdict accept --reviewer master-dev
agent-manager authorization inspect <runId>
agent-manager next-action <runId> --json
agent-manager delivery-ready <runId> --require released
agent-manager reconcile <runId> --goal-disposition <goal-id>=<outcome> --operator <id>
agent-manager ship <runId> --approve through-pr|all --detach
agent-manager ship <runId> --authorized --detach
agent-manager director validate --policy <director-policy.yaml>
agent-manager director cycle --policy <director-policy.yaml> --items <fixtures.yaml> --dry-run
```

Example: `examples/two-lane-smoke.yaml` (set `AGENT_MANAGER_DEV_ROOT` to the
parent that contains the `agent-manager` folder).

### Director proposal cycle

Director is a **proposal** layer, not full autopilot. Validate the standing
policy, then run an explicit fixture-backed `--dry-run`. The cycle records
Director identity (separate from workers), leases one repository, triages items,
writes validated workflow YAML drafts, and prints `kickoff:` lines. Master Dev
launches drafts with `run --detach`. Director does not auto-detach, call a
planner LLM, or invoke Ship Gate. Keep `security` forbidden by default; use
`risk_exceptions` for CodeQL-class waves. Non-`fixture` providers quarantine as
`connector-not-implemented:…`. See `docs/DIRECTOR.md`.

## Operator flow (Master Dev)

### Step 0 — Outcome and authority

Check engine/skill alignment with `doctor --json` after an upgrade. An executable
runtime (`ok`) does not imply current instructions (`aligned`). Use its activation
commands for the affected hosts; loaded conversations need an explicit refresh
or a new session. See [foundation continuity](./foundation-alignment.md)
for goal policy, claim preflight, external release reconciliation and correction
families. Corrections must retain retry/recovery lineage and the parent budget;
after accepting a child, use supported parent closeout instead of leaving the
original snapshot at another shipping gate.

Use the repo and outcome already supplied by the operator. Ask only for missing
information that materially changes the work. Start with one cohesive lane;
add lanes for independent work or distinct ownership, not arbitrary phases.

For sustained development, select the existing goal, include its `goal_refs`,
and set `goal_policy: required`. Carry those references into corrections and
retries. Create a goal only when the operator has requested one or goal tracking.
If a sustained assignment has no agreed goal, establish that outcome before launch.
A small authorized task may use `goal_policy: exempt` with a concrete
`goal_exemption` reason. Do not use an exemption merely to avoid goal migration.
The Fleet view remains available through `agent-manager-fleet`.

For goal-driven work, apply [goal alignment](https://github.com/Patchnet/agent-manager/blob/main/docs/GOAL-ALIGNMENT.md) at
assignment, material new instructions, review, and release closeout. Identify
which success criterion the work advances. Carry the original goal through side
questions and compaction; discussing an idea does not add it to the release.

Continue routine implementation and necessary dependencies within established
authority. For optional features, changed outcomes, or unrelated initiatives,
briefly state the active goal, relationship, added work and what would be displaced;
recommend deferral, a separate goal, or an amendment. Ask only for an unresolved
scope decision. Honor an explicit decision already given without asking twice.
Record material requests with `goal assess --record`; proposed/deferred requests
do not launch work or change the goal. Apply approved amendments with `goal update`
and change metadata. Do not invent new goals or silently park an operator priority.

New goal-linked runs require `review --goal-evidence` on acceptance. Evaluate the
frozen criteria against the actual diff and tests. Partial work may be accepted
as a work item; it does not fulfill the overall goal. Record the goal's delivered
disposition only after its full criteria are satisfied. A release alone is not
that assessment. Distinguish deliberate deferral, blockers and loss of momentum;
do not classify inactivity as abandonment without context.

Keep the shared packet concise: requested outcome, acceptance criteria, source
references, scope, permissions, and required verification. Let the worker choose
implementation steps, native tools, and context management. See
[HARNESS-ALIGNMENT.md](../../docs/HARNESS-ALIGNMENT.md) for settings and supervision.

### Efficient assignment and fleet review

Use a focused session for small cohesive work; launch lanes for independent
ownership or useful parallel work. Do not create an authoring lane solely to
work around Ship Gate role selection. When Master Dev authored the work, use
the canonical Ship Gate's independently reviewed author path where available;
review evidence and operator shipping authority remain separate.

Before retrying a startup failure, identify what changed: executable access,
authentication, claim ownership, dependency setup, or workflow input. A successful
version check does not prove the worker can initialize. Repeating the same
environment failure is not a correction strategy. Keep retry/recovery lineage
and the existing budget; include required integration files in the planned scope.

For a fleet audit, distinguish unfinished delivery from executing workers. The
default fleet view shows only 12 rows: compare `counts.visible` with `counts.total`
and raise `--limit` to inspect all matching records. Read compact status and
`next-action` first, then inspect logs only for the relevant blocker. Token
telemetry is local observed usage, not a complete account bill or a reliable
manager-versus-worker split unless those roles are explicitly attributed.

Check accepted correction children and verified external releases before
proposing another run. Use the supported reconciliation paths in
[foundation continuity](./foundation-alignment.md); stale age alone is not
evidence to cancel, release claims, or mark work delivered.

### Steps 1+ — Plan, detach, supervise

1. **Check in and plan** - review the authoritative work source, target-repo
   instructions, relevant code, base commit, lane scopes, and shared context.
   Complete `workflow.planning`; `validate` and `run` fail closed if it is
   missing, incomplete, or stale. Include `goal_refs` when selected.
2. **Run detached** — `agent-manager run <workflow> --detach`. Read `runId` /
   `telemetry` from stdout (exits immediately). **Do not** await a non-detach run.
   Codex and Claude Code launches automatically capture the originating thread
   and arm a private Master return watcher unless `--no-master-return` is
   supplied. Cursor Agent CLI requires an explicit chat ID for direct return;
   Cursor IDE uses the portable signal watcher. Worker harness choice does not
   change this host return route. Do not print private IDs into boards.
3. **Report** immediately with **Run board** template ([reporting.md](./reporting.md)).
4. **Arm watch-signal** (mandatory) — see **Watch loop** below. Optionally tell
   the operator they can open `fleet` (all runs; tabs for Goals/Core/Tokens) or
   `monitor <runId>` (one run) in a side terminal. `fleet` is observational and
   does not replace the required chat reporting templates.
5. On each wake: Heartbeat / Run board / Escalation / Run outcome per templates.
6. **Escalate** any `blocked` / `needsInput` with the **Escalation** template.
7. **On `delivery_review_pending`:** post **Run outcome**, then immediately
   perform Delivery Review. Keep watch-signal active; worker completion is not
   terminal delivery. A `blocked` run is resumable: post **Escalation**.
8. **Delivery Review · Pass 1** — compare proposal vs worktrees; post the board;
   wait for `accept` | `accept-with-notes` | `revise` | `relaunch` | `reject`,
   then persist that decision before Ship Gate.
9. **Correction within budget** — after a recorded `revise` / `relaunch`,
   feed the exact gaps to workers and present the next sequential review pass.
   Follow the frozen count/time budget and report evidence of progress. Existing
   workflows still end corrections at Pass 2; do not add authority by inference.
10. **Ship** only via Ship Gate after a permitted review pass accepts. On
    `through-pr` or `all`, load `skills/pr-manager/SKILL.md`, launch
    `agent-manager ship ... --detach`, post the PR Manager Handoff board, and
    exit the turn.

### Cadence state machine

| Stage | Transition | Required behavior |
|---|---|---|
| Plan ready | `WAIT_OPERATOR` unless already authorized | Present Build plan; launch without asking twice when already approved |
| Run/ship active | `AUTO_CONTINUE` | Monitor detached telemetry and report cadence updates |
| Lane/ship blocked | `WAIT_OPERATOR` | Ask one exact question; continue independent work |
| Workers complete | `AUTO_CONTINUE` | Post Run outcome and perform the next sequential Delivery Review in the same turn |
| Delivery Review presented | `WAIT_OPERATOR` | Wait for the pass-specific verdict |
| `revise` / `relaunch` persisted | `AUTO_CONTINUE` | Launch the recorded correction; do not ask again |
| Review accepted | `AUTO_CONTINUE` | Persist it and present Ship Gate in the same turn |
| Ship Gate presented | `WAIT_OPERATOR` | Wait for exact shipping authority |
| Overall delivery terminal | `TERMINAL` | Post final evidence, close the source record, stop watching |

## Watch loop (mandatory after detach)

Silence after detach is a bug. Master must wake on status changes and on a
**3-minute** telemetry heartbeat. Surface meaningful changes immediately; do not
open repetitive model turns merely to restate unchanged status.

### Arm (Cursor / hosts with notify_on_output)

1. Start in the **background** (`block_until_ms: 0`):

```bash
agent-manager watch-signal <runId> --heartbeat-sec 180
```

**Heartbeat default is 180 seconds (3 minutes).** Use that unless the operator
asks for a different cadence (`--heartbeat-sec 300` for 5m, etc.). State-change /
needs-input / terminal wakes are immediate either way — the interval only controls
the “still running, nothing changed” pulse.
If the watcher attaches after the run already reached an actionable delivery
stage, it emits that stage immediately instead of waiting for the first
heartbeat.

2. Attach `notify_on_output` (or host equivalent) with pattern:

```text
^AGENT_MANAGER_WAKE_
```

3. On each matching line, parse the JSON after the sentinel. `reason` is one of:
   `heartbeat` | `state_change` | `needs_input` | `terminal`. Delivery states
   now include `cadence.transition`, `cadence.nextAction`, and exact operator
   replies. `delivery_review_pending` is `state_change` + `AUTO_CONTINUE`, not
   `needs_input`: perform the review before asking the operator. Treat
   external-output wake support as host-dependent; fall back to a side terminal
   or JSONL event consumer.
4. **Always** re-read `$AGENT_MANAGER_RUNS_ROOT/<runId>/status.json` before posting
   (never invent state from the wake payload alone).
5. Post the matching template for actionable changes. Routine unchanged heartbeats may stay in telemetry unless the operator requests chat pulses:
   - `heartbeat` + still running → update telemetry; **Heartbeat** in chat only when requested
   - `state_change` → **Run board** or PR Manager **Ship board**
   - `needs_input` → lane **Escalation** or PR Manager **Ship escalation**
   - `terminal` → final reviewed/merged/released/rejected/failed/cancelled outcome, then stop
   Obey `cadence.transition` after posting. A status board alone is not a
   completed host turn when the transition is `AUTO_CONTINUE`.
6. Operator may keep chatting (Multitask / parallel turns are fine). Stop the
   loop when the operator says stop watching, or on `terminal`.

### Side terminal (human glance)

```bash
agent-manager monitor <runId>
```

Live lane board; exits on `reviewed` / `merged` / `released` / `rejected` / `failed` /
`cancelled`. Does **not** replace
actionable chat updates / Run outcome posts.

### If the host has `/loop`

Same contract: prefer `watch-signal` as the wake source (event + 3m fallback)
over a blind “sleep 3m and guess.” Follow the host `loop` skill for arming
sentinels; the prompt on each wake is “read status.json and post the agent-manager
template for this wake reason.”

### Master return and host heartbeat

Codex and Claude Code runs automatically return actionable state changes to the
originating Master Dev thread. Cursor Agent CLI does the same when an explicit
chat ID is configured. Cursor IDE uses signal mode and requires the host's
`AGENT_MANAGER_WAKE_` notification to stay attached. Worker completion therefore
resumes at Run Outcome and Delivery Review instead of ending with the worker's
stop message. The return watcher does not open turns for routine lane progress.
Meaningful shipping phase, PR-check, and GitHub Actions transitions do return a
PR Manager Ship board; unchanged CI polling does not create repeated updates.
Inspect its sanitized state with `agent-manager status <runId>`. On delivery
failure, use `agent-manager next-action <runId> --json` and inspect the private
`master-return-supervisor.log`; keep the portable watcher armed as fallback.

Codex scheduled heartbeats require their host-provided final XML decision
envelope. A heartbeat prompt may request the canonical board, but it must also
say to end with the exact `<heartbeat>` block and `NOTIFY` or `DONT_NOTIFY`.
Never instruct Codex to output “only” the Agent Manager Markdown template; that
conflicts with the heartbeat protocol and can suppress delivery to the chat.
The heartbeat is telemetry only. Delivery enforcement remains in `status.json`.

### Run identity and host title

Set a concise workflow `title` and optional `repo_shorthand`. Agent Manager
emits one canonical title for every harness:

```text
[AM <short-run-id>] <repo-shorthand> · <subject>
```

After detach, use `suggestedThreadTitle` to rename the originating Master Dev
task when the host exposes a supported title action. Native title changes are
best effort and must never gate the run. Do not rename worker tasks. Supply the
Manager identity with `--manager-harness` and `--manager-model` when the host
cannot expose it automatically. Fleet keeps this metadata in the selected
run's expanded details; it does not crowd the compact run list.

## Telemetry contract (do not reinvent)

Runs root defaults to `~/.agent-manager/runs` (`AGENT_MANAGER_RUNS_ROOT`).

| Path | Role |
|---|---|
| `<runs>/<runId>/status.json` | Source of truth for live state |
| `<runs>/<runId>/events.jsonl` | Host-neutral state-change stream |
| `<runs>/<runId>/report.md` | End-of-run synthesis for Master |
| `<runs>/<runId>/planning-context.md` | Private frozen context packet shared by every lane |
| `<runs>/<runId>/supervisor.log` | Detached supervisor stdout/stderr |
| `<runs>/<runId>/master-return.json` | Private originating-host route and delivery state |
| `<runs>/<runId>/master-handoff.json` | Latest structured handoff back to Master Dev |
| `<runs>/<runId>/master-return-supervisor.log` | Detached return-watcher diagnostics |
| `<runs>/<runId>/ship/` | Private ship handoff, supervisor log, and summary |
| `<runs>/<runId>/<lane>/stdout.log` | Harness stream (debug) |
| `<runs>/<runId>/<lane>/needs-input.json` | Blocking question from worker |
| `<runs>/<runId>/<lane>/wt/` | Lane worktree (code changes) |

`status.json` fields used in boards: `runId`, `state`, `repo`, `target_dev_flow`,
`runtime` (`hostPlatform`, `os`, `arch`, `release`, `shell`, `commandMode`,
`pathStyle`), `startedAt`, `updatedAt`, `maxConcurrency`, `baseCommit`, `planning`, `lanes[]` (`id`,
`harness`, `state`, `branch`, `scope`, `readOnly`, `dependsOn`, `waitingFor`,
`elapsedSec`, `lastActivity`, `exitCode`, `needsInput`, `worktree`, `logPath`).
Lanes also record `sessionId`, `endedAt`, changed files, guardrail
violations, and claim state. Runs also record `execution`, `delivery.review`,
ordered `delivery.targets`, merge SHAs, and release ancestry evidence. `endedAt`
is reserved for an overall delivery-terminal state.

## Deploying this skill elsewhere

Canonical copy stays in this repo. To expose it to a host agent:

| Host | Install |
|---|---|
| Claude Code (user) | Copy/symlink folder → `~/.claude/skills/agent-manager/` |
| Cursor (user) | Copy/symlink folder → `~/.cursor/skills/agent-manager/` |
| Codex (user) | Copy/symlink folder → `~/.codex/skills/agent-manager/` |
| Another repo | Pointer in that repo's `CLAUDE.md` / `AGENTS.md` to this path, or vendor a copy under `.cursor/skills/` / `.claude/skills/` |

## Related

- Operator guide: https://github.com/Patchnet/agent-manager/blob/main/docs/OPERATOR.md
- Claims: bundled `tools/claim.mjs`
- Ship Gate: use the host's existing `ship-gate` skill; the source package also includes a portable starter
- Cursor loop skill: host `/loop` for notify_on_output wakes
