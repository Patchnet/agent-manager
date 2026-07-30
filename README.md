# agent-manager

A detached CLI supervisor for running Claude Code and Codex CLI in parallel Git worktrees. The host chat stays responsive, each lane has an explicit file scope, blocking questions return through one status contract, and delivery stops at review until the operator approves shipping.

## What it provides

- One isolated Git worktree per lane
- Claude and Codex harnesses behind one workflow format
- Detached launch with authoritative `status.json`
- Resumable `needs_input` and same-session `reply`
- Changed-file, scope, commit, and pull-request guardrails
- Host-neutral JSONL events and wake signals
- Evidence-backed Delivery Review before Ship Gate
- Optional integration branch without automatic merge
- Cursor skill installer and project-rule fallback

agent-manager is not a sandbox, terminal multiplexer, fleet dashboard, or auto-merge service. Harness permission systems remain the execution boundary. Command-event inspection is best-effort detection.

## Requirements

- Node.js 24 or later
- Git
- Claude Code, Codex CLI, or both, already authenticated through their normal subscription CLI

## Install from a clone

```bash
git clone https://github.com/Patchnet/agent-manager.git
cd agent-manager
npm ci
npm link
agent-manager --version
agent-manager doctor
```

You can also replace `agent-manager` in the examples with `node bin/agent-manager.mjs`.

## Local demo without a model subscription

The fake harness is restricted to an explicitly opted-in test process.

PowerShell:

```powershell
$env:AGENT_MANAGER_TEST_MODE="1"
agent-manager run examples/fake-demo.yaml --detach --json
agent-manager status <runId>
agent-manager reply <runId> demo-question --message "Use blue"
agent-manager review <runId>
```

bash or zsh:

```bash
AGENT_MANAGER_TEST_MODE=1 agent-manager run examples/fake-demo.yaml --detach --json
```

## Create a real workflow

```bash
agent-manager init --repo /path/to/repo \
  --request "Implement the feature and update its documentation" \
  --harnesses claude,codex
agent-manager validate /path/to/repo/agent-manager.yaml
agent-manager run /path/to/repo/agent-manager.yaml --detach --json
```

Review the generated scopes before launch. The initializer produces at most three independent lanes and never enables commits, pull requests, integration, or dangerous permission bypass.

## Cursor cockpit

Install the user-level Cursor skill:

```bash
agent-manager install cursor
```

Install the skill plus a project rule:

```bash
agent-manager install cursor --project /path/to/repo
```

Cursor launches runs with `--detach`, reads `status.json`, replies to blocking lanes, and generates Delivery Review. `watch-signal` and `events --jsonl` are the portable wake sources:

```bash
agent-manager watch-signal <runId> --heartbeat-sec 180
agent-manager events <runId> --jsonl
```

Cursor does not currently document a stable API that wakes an idle chat from arbitrary external process output. Automatic chat re-entry is therefore experimental. A side-terminal watcher or operating-system notification can consume the same event stream without changing orchestration state.

## Core commands

```text
agent-manager doctor [--repo <path>]
agent-manager validate <workflow.yaml> [--repo <path>]
agent-manager init --repo <path> [--request <text>] [--harnesses claude,codex]
agent-manager run <workflow.yaml> --detach [--repo <path>] [--json]
agent-manager status [runId] [--json]
agent-manager monitor [runId]
agent-manager events <runId> --jsonl
agent-manager watch-signal <runId>
agent-manager reply <runId> <laneId> --message <text>
agent-manager review <runId> [--pass 1|2]
agent-manager integrate <runId>
agent-manager cancel <runId>
agent-manager cleanup <runId>
agent-manager cleanup --stale --older-than-days 30
```

Dangerous permission bypass requires two independent inputs: `policy.dangerously_skip_permissions: true` in the workflow and `--allow-dangerous-permissions` on that invocation (or the matching environment confirmation).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_MANAGER_DEV_ROOT` | current directory | Root used for simple relative repository names |
| `AGENT_MANAGER_RUNS_ROOT` | `~/.agent-manager/runs` | Private status, prompts, replies, logs, events, and worktrees |
| `AGENT_MANAGER_CLAIMS_ROOT` | `~/.agent-manager/claims` | Bundled advisory claim registry |
| `AGENT_MANAGER_CLAIM_BIN` | bundled `tools/claim.mjs` | Optional external claim implementation |
| `AGENT_MANAGER_ENV_ALLOWLIST` | empty | Extra comma-separated variables passed to workers |
| `AGENT_MANAGER_ALLOW_DANGEROUS_PERMISSIONS` | unset | Invocation-level dangerous-mode confirmation |

Workflow claim modes are `auto`, `off`, and `required`. `auto` uses the bundled registry but treats registry failure as advisory; `required` fails closed.

## Security and privacy

Prompts, replies, logs, paths, and session identifiers can contain sensitive data. Run and claim directories use private permissions where supported. Use stale cleanup, keep the runs root out of synchronized/public folders, and never commit telemetry.

See [SECURITY.md](SECURITY.md), [public repository hygiene](docs/PUBLIC-REPO-HYGIENE.md), and [the operator guide](docs/OPERATOR.md).

## Contracts

Published JSON schemas live under [`schemas/`](schemas/): workflow, detached launch, status, JSONL events, and Delivery Review. `status.json` remains authoritative; integrations stay thin and replaceable.

## Development

```bash
npm ci
npm test
npm run hygiene
npm pack --dry-run
```

CI runs the tests and package review on Windows and Linux. Dependency review runs on pull requests.

## License

Apache-2.0. See [LICENSE](LICENSE).
