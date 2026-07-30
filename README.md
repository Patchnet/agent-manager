# agent-manager

CLI supervisor for multi-lane agent work. One Master Dev chat kicks a workflow
**detached**; workers run as real harness CLI sessions (Claude / Codex) in
**one worktree per lane**, inheriting that repo’s skills, MCP, and agent files.
This tool coordinates claims, worktrees, telemetry, and reporting — it does not
replace the harnesses.

## Quick start

```bash
git clone https://github.com/Patchnet/agent-manager.git
cd agent-manager
npm install

# Resolve sibling repos from the parent of this clone (or set AGENT_MANAGER_DEV_ROOT)
export AGENT_MANAGER_DEV_ROOT="$(dirname "$PWD")"   # bash
# PowerShell: $env:AGENT_MANAGER_DEV_ROOT = (Resolve-Path ..).Path

node bin/agent-manager.mjs run examples/two-lane-smoke.yaml --detach
node bin/agent-manager.mjs monitor
node bin/agent-manager.mjs watch-signal --heartbeat-sec 180
npm test
```

## Environment

| Variable | Default | Role |
|---|---|---|
| `AGENT_MANAGER_DEV_ROOT` | `process.cwd()` | Parent folder that contains target `repo` directories |
| `AGENT_MANAGER_RUNS_ROOT` | `~/.agent-manager/runs` | `status.json`, logs, worktrees |
| `AGENT_MANAGER_CLAIMS_ROOT` | `~/.agent-manager/claims` | Advisory claim registry |
| `AGENT_MANAGER_CLAIM_BIN` | `tools/claim.mjs` (bundled) | Claims CLI |

## Skill / Master Dev

| Path | Role |
|---|---|
| `skills/agent-manager/SKILL.md` | When/how to fire up agent-manager |
| `skills/agent-manager/reporting.md` | **Mandatory** chat status templates |
| `skills/agent-manager/reference.md` | Telemetry + workflow detail |
| `docs/OPERATOR.md` | Human/Master process |

Mirror the skill folder to `~/.claude/skills`, `~/.cursor/skills`, or
`~/.codex/skills` for discovery across tools.

## Layout

| Path | Role |
|---|---|
| `bin/agent-manager.mjs` | CLI entry |
| `src/` | run / status / cancel / harness adapters |
| `tools/claim.mjs` | bundled advisory claims CLI |
| `skills/agent-manager/` | skill + reporting templates |
| `docs/OPERATOR.md` | operator process |
| `examples/` | sample workflows |

Operator-only workflows and local agent settings stay out of git
(`workflows/`, `*.local.md`, `AGENTS.md`, `.claude/`, `.cursor/`).

## Coordination contract

- `status.json` is authoritative.
- After detach, Master Dev arms `watch-signal` (3m heartbeat + state wakes).
- Optional Agent Feed publishing is fail-soft and off by default.
- Workers do not commit/merge by default — Ship Gate stays with Master / operator.
- Target `dev_flow` from that repo’s `Version.md` (or workflow override).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
