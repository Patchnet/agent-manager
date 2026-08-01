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
**Telemetry:** `$AGENT_MANAGER_RUNS_ROOT/<runId>/status.json` (default `~/.agent-manager/runs`)  
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
   Agent Manager is source-neutral: workers do not query the planning system and
   receive one frozen context packet from the manager.
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
5. **Read telemetry from disk** — `status.json` / `report.md` under the runs root.
   Do not invent lane state. Prefer `node … status` / `monitor` or reading JSON.
6. **Chat status uses the templates in [reporting.md](./reporting.md) only** —
   no freestyle dashboards.
7. **Delivery Review before Ship Gate.** Lane exit 0 / CI green is not
   acceptance. Master re-reads the original proposal, verifies worktree
   deliverables (including cross-lane contracts), and posts **Delivery Review
   · Pass 1**. Worker completion is `delivery_review_pending`, not a terminal
   delivery state. Persist the operator decision with `agent-manager review`.
8. **One eval loop only (anti-perpetual).** Per parent `runId`: Pass 1 → at
   most **one** worker correction (`revise` or `relaunch`) → **Pass 2**
   correction report to the operator. Master **must not** open Pass 3, issue
   another revise/relaunch, or start another eval loop. Further work requires
   an **operator-ordered** new run (new `runId`).
9. **Workers do not commit/merge/tag** unless the workflow explicitly allows it
   (default: forbidden). Shipping goes through **Ship Gate** *after* an
   accepting Delivery Review (Pass 1 or Pass 2).
10. **Integrate** (`integrate: true` in workflow) folds successful lanes into
    `am/<runId>/integrate` after coding finishes. It prepares the branch only.
    Master owns Delivery Review and Ship Gate. After approval, hand shipping to
    the **pr-manager** skill with `ship --detach`; do not babysit push, PR, CI,
    merge, or tag in the host chat. Never ask the operator to click Merge.
    When `integrate: false` has multiple writable lanes, `delivery.targets`
    must map every lane to its delivery branch/PR. Downstream work must use
    `agent-manager delivery-ready <runId> --require merged|released`, never
    worker `done` or released claims.
11. **Dangerous permissions need two approvals.** The workflow policy and the launch flag
    `--allow-dangerous-permissions` (or matching environment confirmation) must both be present.
12. On `needs-input` / blocked lanes: surface the question in chat, wait for the
    operator, then resume/reply (or cancel) — do not guess product decisions.
13. **Every operator board declares its transition.** End with
    `AUTO_CONTINUE`, `WAIT_OPERATOR`, or `TERMINAL`, plus the exact next action
    and reply vocabulary. On `AUTO_CONTINUE`, take that action before ending
    the turn. Never report only that a stage finished. Use
    `agent-manager next-action <runId> --json` to resolve ambiguity.

## Quick commands

Prefer absolute paths to your clone:

```bash
agent-manager run <workflow.yaml> --detach
agent-manager status [runId]
agent-manager monitor [runId]
agent-manager watch-signal [runId] --heartbeat-sec 180
agent-manager reply <runId> <laneId> --message "..."
agent-manager cancel <runId>
agent-manager integrate <runId>
agent-manager cleanup <runId>
agent-manager review <runId>
agent-manager review <runId> --pass 1 --verdict accept --reviewer master-dev
agent-manager next-action <runId> --json
agent-manager delivery-ready <runId> --require released
agent-manager ship <runId> --approve through-pr|all --detach
```

Example: `examples/two-lane-smoke.yaml` (set `AGENT_MANAGER_DEV_ROOT` to the
parent that contains the `agent-manager` folder).

## Operator flow (Master Dev)

1. **Check in and plan** - review the authoritative work source, target-repo
   instructions, relevant code, base commit, lane scopes, and shared context.
   Complete `workflow.planning`; `validate` and `run` fail closed if it is
   missing, incomplete, or stale.
2. **Run detached** — `agent-manager run <workflow> --detach`. Read `runId` /
   `telemetry` from stdout (exits immediately). **Do not** await a non-detach run.
3. **Report** immediately with **Run board** template ([reporting.md](./reporting.md)).
4. **Arm watch-signal** (mandatory) — see **Watch loop** below. Optionally tell
   the operator they can open `monitor <runId>` in a side terminal.
5. On each wake: Heartbeat / Run board / Escalation / Run outcome per templates.
6. **Escalate** any `blocked` / `needsInput` with the **Escalation** template.
7. **On `delivery_review_pending`:** post **Run outcome**, then immediately
   perform Delivery Review. Keep watch-signal active; worker completion is not
   terminal delivery. A `blocked` run is resumable: post **Escalation**.
8. **Delivery Review · Pass 1** — compare proposal vs worktrees; post the board;
   wait for `accept` | `accept-with-notes` | `revise` | `relaunch` | `reject`,
   then persist that decision before Ship Gate.
9. **At most one correction** — on `revise` / `relaunch` only: feed gaps to
   workers once (same worktrees or one new workflow slice). When that finishes,
   post **Delivery Review · Pass 2** to the operator. **Stop.** Master does not
   eval again.
10. **Ship** only via Ship Gate after Pass 1 or Pass 2 accepts. On
    `through-pr` or `all`, load `skills/pr-manager/SKILL.md`, launch
    `agent-manager ship ... --detach`, post the PR Manager Handoff board, and
    exit the turn.

### Cadence state machine

| Stage | Transition | Required behavior |
|---|---|---|
| Plan ready | `WAIT_OPERATOR` unless already authorized | Present Build plan; launch without asking twice when already approved |
| Run/ship active | `AUTO_CONTINUE` | Monitor detached telemetry and report cadence updates |
| Lane/ship blocked | `WAIT_OPERATOR` | Ask one exact question; continue independent work |
| Workers complete | `AUTO_CONTINUE` | Post Run outcome and perform Delivery Review Pass 1 in the same turn |
| Delivery Review presented | `WAIT_OPERATOR` | Wait for the pass-specific verdict |
| `revise` / `relaunch` persisted | `AUTO_CONTINUE` | Launch the single correction; do not ask again |
| Review accepted | `AUTO_CONTINUE` | Persist it and present Ship Gate in the same turn |
| Ship Gate presented | `WAIT_OPERATOR` | Wait for exact shipping authority |
| Overall delivery terminal | `TERMINAL` | Post final evidence, close the source record, stop watching |

## Watch loop (mandatory after detach)

Silence after detach is a bug. Master must wake on status changes and on a
**3-minute** heartbeat so the operator sees activity without asking.

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
5. Post the matching template:
   - `heartbeat` + still running → **Heartbeat**
   - `state_change` → **Run board** or PR Manager **Ship board**
   - `needs_input` → lane **Escalation** or PR Manager **Ship escalation**
   - `terminal` → final merged/released/rejected/failed/cancelled outcome, then stop
   Obey `cadence.transition` after posting. A status board alone is not a
   completed host turn when the transition is `AUTO_CONTINUE`.
6. Operator may keep chatting (Multitask / parallel turns are fine). Stop the
   loop when the operator says stop watching, or on `terminal`.

### Side terminal (human glance)

```bash
agent-manager monitor <runId>
```

Live lane board; exits on `merged` / `released` / `rejected` / `failed` /
`cancelled`. Does **not** replace
chat Heartbeat / Run outcome posts.

### If the host has `/loop`

Same contract: prefer `watch-signal` as the wake source (event + 3m fallback)
over a blind “sleep 3m and guess.” Follow the host `loop` skill for arming
sentinels; the prompt on each wake is “read status.json and post the agent-manager
template for this wake reason.”

### Codex thread heartbeat

Codex scheduled heartbeats require their host-provided final XML decision
envelope. A heartbeat prompt may request the canonical board, but it must also
say to end with the exact `<heartbeat>` block and `NOTIFY` or `DONT_NOTIFY`.
Never instruct Codex to output “only” the Agent Manager Markdown template; that
conflicts with the heartbeat protocol and can suppress delivery to the chat.
The heartbeat is telemetry only. Delivery enforcement remains in `status.json`.

## Telemetry contract (do not reinvent)

Runs root defaults to `~/.agent-manager/runs` (`AGENT_MANAGER_RUNS_ROOT`).

| Path | Role |
|---|---|
| `<runs>/<runId>/status.json` | Source of truth for live state |
| `<runs>/<runId>/events.jsonl` | Host-neutral state-change stream |
| `<runs>/<runId>/report.md` | End-of-run synthesis for Master |
| `<runs>/<runId>/planning-context.md` | Private frozen context packet shared by every lane |
| `<runs>/<runId>/supervisor.log` | Detached supervisor stdout/stderr |
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
