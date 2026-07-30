# agent-manager — agent bootstrap

Tracked, **safe-public** pointer. Assume any contributor or fork can read this
file. Operator-specific context lives in `CLAUDE.local.md` (gitignored). Codex
sibling: `AGENTS.md` (gitignored).

## What this repo is

Thin **Master Dev CLI supervisor** for multi-lane work. It does **not** replace
Claude Code / Codex / Cursor Agent — it claims scopes, creates one worktree per
lane, spawns those harnesses in-repo (full skills/MCP inheritance), writes run
telemetry under `AGENT_MANAGER_RUNS_ROOT` (default `~/.agent-manager/runs`),
escalates blockers, and writes a report.

## Working agreements

- **This repo is public.** Never commit secrets, tokens, private keys, internal
  hostnames/IPs, emails, internal identifiers (`prj_*`, `agt-*`, `sess-*`, …),
  customer/tenant data, or fleet-specific paths. Operator workflows and brain
  context stay gitignored (`workflows/`, `*.local.md`). Full rules:
  **`docs/PUBLIC-REPO-HYGIENE.md`**
- **Dev flow: Simple** (`Version.md` `dev_flow: simple`) — direct commits to `main`.
- **Test gate:** `npm test`, followed by `npm run hygiene` for public changes.
- **Ship Gate** before commit/push/tag when operating under that convention.
- Workers spawned by this tool inherit the **target repo's** agent files; do not
  invent a parallel skill system here.
- Never default to `--dangerously-skip-permissions`. Fail-closed + escalate.
- Target-repo ship behavior follows **that** repo's `Version.md` `dev_flow`
  (absent → simple). Configurable per workflow via `target_dev_flow`.

## Skill (canonical)

Load **`skills/agent-manager/SKILL.md`**.

- Reporting templates (mandatory): `skills/agent-manager/reporting.md`
- Reference: `skills/agent-manager/reference.md`
- Ship Gate (bundled starter): `skills/ship-gate/SKILL.md` — prefer a
  host/org ship-gate when present
- Operator guide: `docs/OPERATOR.md`

## Commands

```bash
node bin/agent-manager.mjs run <workflow.yaml> --detach
node bin/agent-manager.mjs status [runId] [--watch]
node bin/agent-manager.mjs monitor [runId]
node bin/agent-manager.mjs watch-signal [runId] --heartbeat-sec 180
node bin/agent-manager.mjs cancel <runId>
```

## Paths

Set `AGENT_MANAGER_DEV_ROOT` to the folder that contains sibling target repos.
Runs and claims default under `~/.agent-manager/` unless overridden
(`AGENT_MANAGER_RUNS_ROOT`, `AGENT_MANAGER_CLAIMS_ROOT`).

## Stack

Node.js 24 LTS · ESM · `yaml` for workflows · bundled `tools/claim.mjs`
