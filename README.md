# agent-manager 🎛️

[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-4b5563)](#requirements)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Parallel coding lanes across harnesses, gated shipping, one event stream.**

agent-manager runs a few coding agents (Claude Code, Codex CLI, Cursor Agent)
side by side, each in its own Git worktree and scope, then ships the result
under a deterministic policy: the repository's own gate or tier policy decides,
not a person reading each change.

It does only what coding harnesses do not do themselves:

| agent-manager does | your harness already does (use it) |
|---|---|
| lanes that mix Claude Code, Codex, and Cursor in one run | subagents, parallel review, background sessions |
| one worktree + advisory scope claim per lane | a worktree per session |
| `status.json` and an append-only event log | session notifications, cross-session messages |
| one route to ship: the pipeline gate, or path tiers (`.github/ship-tiers.yml`) | PR/CI monitoring, auto-fix, auto-merge buttons |
| one `ship` command: gate or tier → push or PR → auto-merge | `/code-review`, scheduled tasks, hooks |

See [docs/HARNESS-NATIVE.md](docs/HARNESS-NATIVE.md) for the harness side,
with links, so new harness features replace this tool instead of duplicating it.

## How a change ships

```text
run --detach ──► lanes work in worktrees ──► integrate ──► review (one verdict)
                                                             │
                     ship: read the route from the base ◄────┘
                       pipeline gate         → run the gate, push to the base
                       tier policy, no gate  → PR + auto-merge, or push (Simple)
                       neither               → stops and asks the operator
```

- **The route comes from the base branch, never judgment.** A repository with
  `pipeline.json` and `scripts/quality.mjs` ships through that gate. Otherwise
  `.github/ship-tiers.yml` labels the change by path. With neither, `ship` stops
  and asks the operator. See
  [How `ship` picks a route](docs/OPERATOR.md#how-ship-picks-a-route).
- **Review is independent but light.** A fresh-context reviewer blocks only on
  correctness, safety, data, authorization, or drift from the brief
  ([reviewer prompt](skills/ship-gate/reviewer.md)).
- **Safety moves after merge.** The required PR check gates the merge; CI on
  every `main` commit plus [auto-revert](templates/github/revert-on-red.yml)
  catches the rest. No "branches must be up to date" treadmill.
- **Releases are scheduled**, not per change: the target repository's own
  release script runs when `main` moved and is green. agent-manager never tags.

## Requirements

- Node.js 24+, Git, and at least one harness: `claude`, `codex`, or `cursor-agent`
- GitHub CLI (`gh`) for Formal Flow (PR) shipping
- Windows, macOS, or Linux

## Install

```bash
git clone https://github.com/Patchnet/agent-manager.git
cd agent-manager
npm ci
npm link            # optional: puts agent-manager on PATH
agent-manager config init --dev-root ~/code
agent-manager doctor
```

Load the skill in your host harness by copying or linking
`skills/agent-manager/` (and `skills/ship-gate/`) into its skills folder:
`~/.claude/skills/`, `~/.agents/skills/` (Codex), or your Cursor rules.

## Quick start

```bash
agent-manager init --repo ../my-app --request "Add CSV export" --harnesses claude,codex
agent-manager validate ../my-app/agent-manager.yaml
agent-manager run ../my-app/agent-manager.yaml --detach
agent-manager wait <runId>        # run in the background; returns on the next event
agent-manager status <runId>
agent-manager review <runId> --verdict accept --reviewer <id>
agent-manager ship <runId>        # Simple Flow also needs --message "feat: ..."
```

A minimal workflow:

```yaml
repo: my-app
goal: Add CSV export to the reports page
integrate: true
lanes:
  - id: api
    harness: codex
    scope: ["src/api/**", "test/api/**"]
    prompt: Add GET /reports/:id/export.csv with tests.
  - id: ui
    harness: claude
    scope: ["src/ui/**"]
    depends_on: [api]
    prompt: Add an Export CSV button that calls the new endpoint.
```

## Commands

| | |
|---|---|
| `run <workflow> --detach` | start lanes; returns at once with the run id |
| `wait [runId]` | block until the next event, print it, exit (background command) |
| `status [runId]` | current run state |
| `reply <runId> <lane> --message` | answer a lane that asked a question; resumes the same session |
| `ratify`, `integrate`, `cancel`, `cleanup` | fold, recover, stop, tidy |
| `review <runId> --verdict accept\|revise\|reject --reviewer` | the one recorded verdict |
| `ship <runId> [--approved-by <id>]` | gate or tier, push or PR, auto-merge |
| `tier [--base origin/main]` | show the route for the current branch |
| `events [runId]`, `emit <kind> --repo …` | read or append the event stream |
| `doctor`, `config`, `validate`, `init`, `harnesses`, `version` | setup |

Full flags: `agent-manager --help`. Operator guide: [docs/OPERATOR.md](docs/OPERATOR.md).
Event contract: [docs/EVENTS.md](docs/EVENTS.md).

## Contracts

- `status.json` and `events.jsonl` under the runs root
  ([schemas/](schemas/), [docs/EVENTS.md](docs/EVENTS.md))
- workflow YAML ([schemas/workflow.schema.json](schemas/workflow.schema.json))
- `.github/ship-tiers.yml` ([tools/ship-tier.mjs](tools/ship-tier.mjs), zero dependencies,
  vendorable into CI)

## Security and privacy

Workers run with the permissions their harness grants in the lane worktree.
Dangerous permission bypass needs both the workflow policy and
`--allow-dangerous-permissions`. Run data stays under your runs root. See
[SECURITY.md](SECURITY.md) and [docs/PUBLIC-REPO-HYGIENE.md](docs/PUBLIC-REPO-HYGIENE.md).

## Development

```bash
npm test          # canonical suite
npm run hygiene   # public-repository scan
```

Upgrading from 2.x: see the 3.0.0 entry in [Version.md](Version.md).

## License

Apache-2.0
