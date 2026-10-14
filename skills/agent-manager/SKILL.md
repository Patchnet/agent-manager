---
name: agent-manager
description: >-
  Run multi-lane, cross-harness coding work with the agent-manager CLI: lanes
  in isolated worktrees, one recorded review verdict, and path-tiered shipping.
  Use when the operator says "fire up agent manager", "agent-manager", "run
  lanes", "multi-lane", "orchestrate agents", or asks for run status. Always
  launch with --detach and wake on events with `agent-manager wait`.
---

# agent-manager

Use it for work that needs **more than one harness or more than one disjoint
scope at once**. For one coherent task, work directly in a single session (with
your harness's own worktree and subagents) and ship with the
[Ship Gate](../ship-gate/SKILL.md) tiers; no run needed.

Before reaching for a feature here, check
[what your harness already does](../../docs/HARNESS-NATIVE.md).

## Rules

1. **Launch detached.** `agent-manager run <workflow> --detach`. Never await a
   full run in the chat.
2. **Wake on events, do not poll.** Run `agent-manager wait <runId>` as a
   background command. It exits with one JSON event line. Handle it, then run
   it again until `run_closed`.
3. **Read state from disk.** `agent-manager status <runId> [--json]`. Never
   invent lane state.
4. **Questions go to the operator verbatim** (`waiting_operator`). Make
   routine engineering calls yourself. Ask only for product decisions, scope
   beyond the brief, or a tier 2 approval.
5. **One verdict.** When the run reaches `review_pending`, have a
   fresh-context reviewer (subagent or `/code-review`) check the diff against
   the brief with the [reviewer prompt](../ship-gate/reviewer.md), then record it:
   `agent-manager review <runId> --verdict accept|revise|reject --reviewer <id> --notes "..."`.
6. **Ship by tier.** `agent-manager ship <runId>`. Tier 0/1: auto-merge armed,
   so post the one-line notice and move on. Tier 2: post the question and wait
   for the operator. Never approve a tier 2 change yourself.
7. **Conflicts and red checks go to the author thread**, not the operator:
   merge the base, resolve, re-run the affected tests, push.
8. **Workers never commit, push, merge, or tag** unless the workflow policy
   says so. agent-manager never bumps versions or tags.
9. **Never redirect path roots** or enable dangerous permissions on your own.

## Commands

```bash
agent-manager doctor                                  # before the first run on a machine
agent-manager init --repo <path> --request "<brief>" [--harnesses claude,codex]
agent-manager validate <workflow.yaml>
agent-manager run <workflow.yaml> --detach --json
agent-manager wait <runId>                            # background
agent-manager status <runId>
agent-manager reply <runId> <laneId> --message "<answer>" [--extend-scope "<globs>" --by <id>]
agent-manager ratify <runId> <laneId> --reason "<why>" --by <id>
agent-manager integrate <runId> [--force-lanes done,failed-with-snapshot]
agent-manager review <runId> --verdict accept --reviewer <id> [--notes "<text>"]
agent-manager ship <runId> [--message "<type>: <summary>"] [--approved-by <operator>]
agent-manager close <runId> --reason "<why>"          # accepted, not shipping
agent-manager cancel <runId> [--remove-worktrees]
agent-manager emit <kind> --repo <name> [--pr <n>] [--text "<detail>"]   # from outside a run
```

## Event handling

| Event | Do |
|---|---|
| `lane_started`, `lane_done` | nothing unless the operator asked to follow along; `wait` again |
| `waiting_operator` (lane) | relay the question verbatim; on the answer, `reply` |
| `blocked` | read `status`; fix integration or guardrail issues (`ratify`, `integrate --force-lanes`), or escalate |
| `run_closed` with `review_pending` reached | review, then `ship` |
| `waiting_operator` (tier 2) | ask the operator to approve; on yes, `ship --approved-by <them>` |
| `pr_opened`, `automerge_armed` | post the notice; `wait` until `merged` |
| `merged`, `run_closed` | report the outcome in one line and stop |

Report with [reporting.md](./reporting.md).

## Workflow essentials

```yaml
repo: my-app
goal: <one line the lanes share>
integrate: true
lanes:
  - id: api
    harness: codex
    scope: ["src/api/**", "test/api/**"]
    prompt: <the lane's brief, with acceptance criteria>
  - id: ui
    harness: claude
    scope: ["src/ui/**"]
    depends_on: [api]
    prompt: <...>
```

At most five lanes; `max_concurrency` defaults to three. Scopes must not
overlap. Full reference: [docs/OPERATOR.md](../../docs/OPERATOR.md).
