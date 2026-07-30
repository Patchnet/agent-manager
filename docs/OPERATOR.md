# agent-manager — Operator / Master Dev guide

How a human (or Master Dev agent) runs multi-lane work consistently.

## Mental model

You talk to **one** Master Dev session. That session loads the
**agent-manager skill**, kicks the CLI **detached**, and reports lane status in
chat using fixed templates. Coding agents are children in worktrees — not
separate chats you babysit. The Master Dev chat turn must stay free while lanes
run.

## Install / skill visibility

| Location | Purpose |
|---|---|
| `skills/agent-manager/` (this repo) | **Canonical** skill + reporting templates |
| `docs/OPERATOR.md` (this file) | Human-readable process |
| `~/.claude/skills/agent-manager/` etc. | Optional user-level mirrors for discovery |

## Day-one commands

```bash
cd /path/to/agent-manager
npm install   # once

# Parent folder that contains target repos (sibling of agent-manager)
export AGENT_MANAGER_DEV_ROOT="$(dirname "$PWD")"

node bin/agent-manager.mjs run examples/two-lane-smoke.yaml --detach
node bin/agent-manager.mjs monitor
node bin/agent-manager.mjs watch-signal --heartbeat-sec 180
```

## Detach rule (mandatory for Master Dev)

**Never await a foreground `run`.** Always:

```bash
node /path/to/agent-manager/bin/agent-manager.mjs run <workflow.yaml> --detach
```

Stdout prints `runId`, `telemetry`, and `supervisorLog`, then the CLI exits.
Add `--json` for one machine-readable launch object.
Workers keep running under a detached supervisor. Master Dev posts the **Run
board**, arms **watch-signal**, and keeps the chat available for the operator.

Foreground `run` (no `--detach`) is only for a dedicated side terminal the
operator is watching themselves — not for an agent chat turn.

## Telemetry

Default run root: `~/.agent-manager/runs/<runId>/` (override with
`AGENT_MANAGER_RUNS_ROOT`).

```bash
node bin/agent-manager.mjs status <runId>
node bin/agent-manager.mjs monitor <runId>
node bin/agent-manager.mjs watch-signal <runId> --heartbeat-sec 180
```

## Needs-input

```bash
node bin/agent-manager.mjs reply <runId> <laneId> --message "approved answer"
```

## Integrate / cleanup

```bash
node bin/agent-manager.mjs integrate <runId>
node bin/agent-manager.mjs cleanup <runId>
```

## Delivery Review → Ship Gate

Lane exit 0 is not acceptance. Master runs **Delivery Review** (see skill
`reporting.md`), then Ship Gate for the target repo. Workers stay
no-commit / no-PR unless the workflow explicitly allows otherwise.

## Claims

Bundled `tools/claim.mjs` stores advisory claims under
`~/.agent-manager/claims` (or `AGENT_MANAGER_CLAIMS_ROOT`). Override the binary
with `AGENT_MANAGER_CLAIM_BIN` if you share a fleet registry.
