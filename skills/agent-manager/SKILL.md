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
**Detail:** [reference.md](./reference.md) · [reporting.md](./reporting.md) · [../../docs/OPERATOR.md](../../docs/OPERATOR.md)

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

1. **Master Dev stays the human channel.** Workers never own the conversation.
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
   · Pass 1**.
8. **One eval loop only (anti-perpetual).** Per parent `runId`: Pass 1 → at
   most **one** worker correction (`revise` or `relaunch`) → **Pass 2**
   correction report to the operator. Master **must not** open Pass 3, issue
   another revise/relaunch, or start another eval loop. Further work requires
   an **operator-ordered** new run (new `runId`).
9. **Workers do not commit/merge/tag** unless the workflow explicitly allows it
   (default: forbidden). Shipping goes through **Ship Gate** *after* an
   accepting Delivery Review (Pass 1 or Pass 2).
10. **Integrate** (`integrate: true` in workflow) folds successful lanes into
    `am/<runId>/integrate` after coding finishes. It prepares the branch only —
    Master still owns Delivery Review → Ship Gate → push / `gh pr create` /
    `gh pr merge --auto --squash`. Never ask the operator to click Merge.
11. **Never** pass `--dangerously-skip-permissions` unless the operator explicitly
    demands it for that run.
12. On `needs-input` / blocked lanes: surface the question in chat, wait for the
    operator, then resume/reply (or cancel) — do not guess product decisions.

## Quick commands

Prefer absolute paths to your clone:

```bash
node /path/to/agent-manager/bin/agent-manager.mjs run <workflow.yaml> --detach
node /path/to/agent-manager/bin/agent-manager.mjs status [runId]
node /path/to/agent-manager/bin/agent-manager.mjs monitor [runId]
node /path/to/agent-manager/bin/agent-manager.mjs watch-signal [runId] --heartbeat-sec 180
node /path/to/agent-manager/bin/agent-manager.mjs reply <runId> <laneId> --message "..."
node /path/to/agent-manager/bin/agent-manager.mjs cancel <runId>
node /path/to/agent-manager/bin/agent-manager.mjs integrate <runId>
node /path/to/agent-manager/bin/agent-manager.mjs cleanup <runId>
```

Example: `examples/two-lane-smoke.yaml` (set `AGENT_MANAGER_DEV_ROOT` to the
parent that contains the `agent-manager` folder).

## Operator flow (Master Dev)

1. **Clarify** target repo + lane scopes + prompts (or confirm a workflow file).
2. **Run detached** — `agent-manager run <workflow> --detach`. Read `runId` /
   `telemetry` from stdout (exits immediately). **Do not** await a non-detach run.
3. **Report** immediately with **Run board** template ([reporting.md](./reporting.md)).
4. **Arm watch-signal** (mandatory) — see **Watch loop** below. Optionally tell
   the operator they can open `monitor <runId>` in a side terminal.
5. On each wake: Heartbeat / Run board / Escalation / Run outcome per templates.
6. **Escalate** any `blocked` / `needsInput` with the **Escalation** template.
7. **On terminal state** (`done` | `failed` | `cancelled` | stuck `blocked`): post
   **Run outcome**, then **stop** watch-signal (kill the background PID).
8. **Delivery Review · Pass 1** — compare proposal vs worktrees; post the board;
   wait for `accept` | `accept-with-notes` | `revise` | `relaunch` | `reject`.
9. **At most one correction** — on `revise` / `relaunch` only: feed gaps to
   workers once (same worktrees or one new workflow slice). When that finishes,
   post **Delivery Review · Pass 2** to the operator. **Stop.** Master does not
   eval again.
10. **Ship** only via Ship Gate after Pass 1 or Pass 2 accepts (target-repo lane
    results or agent-manager itself).

## Watch loop (mandatory after detach)

Silence after detach is a bug. Master must wake on status changes and on a
**3-minute** heartbeat so the operator sees activity without asking.

### Arm (Cursor / hosts with notify_on_output)

1. Start in the **background** (`block_until_ms: 0`):

```bash
node /path/to/agent-manager/bin/agent-manager.mjs watch-signal <runId> --heartbeat-sec 180
```

**Heartbeat default is 180 seconds (3 minutes).** Use that unless the operator
asks for a different cadence (`--heartbeat-sec 300` for 5m, etc.). State-change /
needs-input / terminal wakes are immediate either way — the interval only controls
the “still running, nothing changed” pulse.

2. Attach `notify_on_output` (or host equivalent) with pattern:

```text
^AGENT_MANAGER_WAKE_
```

3. On each matching line, parse the JSON after the sentinel. `reason` is one of:
   `heartbeat` | `state_change` | `needs_input` | `terminal`.
4. **Always** re-read `$AGENT_MANAGER_RUNS_ROOT/<runId>/status.json` before posting
   (never invent state from the wake payload alone).
5. Post the matching template:
   - `heartbeat` + still running → **Heartbeat**
   - `state_change` → **Run board**
   - `needs_input` → **Escalation** (loop continues)
   - `terminal` → **Run outcome**, then kill watch-signal and stop arming wakes
6. Operator may keep chatting (Multitask / parallel turns are fine). Stop the
   loop when the operator says stop watching, or on `terminal`.

### Side terminal (human glance)

```bash
node /path/to/agent-manager/bin/agent-manager.mjs monitor <runId>
```

Live lane board; exits on `done` / `failed` / `cancelled`. Does **not** replace
chat Heartbeat / Run outcome posts.

### If the host has `/loop`

Same contract: prefer `watch-signal` as the wake source (event + 3m fallback)
over a blind “sleep 3m and guess.” Follow the host `loop` skill for arming
sentinels; the prompt on each wake is “read status.json and post the agent-manager
template for this wake reason.”

## Telemetry contract (do not reinvent)

Runs root defaults to `~/.agent-manager/runs` (`AGENT_MANAGER_RUNS_ROOT`).

| Path | Role |
|---|---|
| `<runs>/<runId>/status.json` | Source of truth for live state |
| `<runs>/<runId>/report.md` | End-of-run synthesis for Master |
| `<runs>/<runId>/supervisor.log` | Detached supervisor stdout/stderr |
| `<runs>/<runId>/<lane>/stdout.log` | Harness stream (debug) |
| `<runs>/<runId>/<lane>/needs-input.json` | Blocking question from worker |
| `<runs>/<runId>/<lane>/wt/` | Lane worktree (code changes) |

`status.json` fields used in boards: `runId`, `state`, `repo`, `target_dev_flow`,
`startedAt`, `updatedAt`, `lanes[]` (`id`, `harness`, `state`, `branch`, `scope`,
`elapsedSec`, `lastActivity`, `exitCode`, `needsInput`, `worktree`, `logPath`).
Lanes also record `sessionId`, `endedAt`, changed files, guardrail
violations, and claim state. Runs record terminal `endedAt` and optional feed health.

## Deploying this skill elsewhere

Canonical copy stays in this repo. To expose it to a host agent:

| Host | Install |
|---|---|
| Claude Code (user) | Copy/symlink folder → `~/.claude/skills/agent-manager/` |
| Cursor (user) | Copy/symlink folder → `~/.cursor/skills/agent-manager/` |
| Codex (user) | Copy/symlink folder → `~/.codex/skills/agent-manager/` |
| Another repo | Pointer in that repo's `CLAUDE.md` / `AGENTS.md` to this path, or vendor a copy under `.cursor/skills/` / `.claude/skills/` |

## Related

- Operator detail: `docs/OPERATOR.md`
- Claims: bundled `tools/claim.mjs`
- Ship Gate: host / org ship-gate skill when that convention applies
- Cursor loop skill: host `/loop` for notify_on_output wakes
