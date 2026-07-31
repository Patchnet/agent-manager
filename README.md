# agent-manager

A detached CLI supervisor for running Claude Code and Codex CLI in parallel Git worktrees. The host chat stays responsive, each lane has an explicit file scope, blocking questions return through one status contract, and delivery stops at review until the operator approves shipping.

## What it provides

- One isolated Git worktree per lane
- Claude and Codex harnesses behind one workflow format
- Detached launch with authoritative `status.json`
- Fail-closed manager planning attestation with one frozen shared context packet
- Resumable `needs_input` and same-session `reply`
- Changed-file, scope, commit, and pull-request guardrails
- Up to five lanes with configurable bounded concurrency
- Fail-closed write-scope overlap validation and single-owner exceptions
- Dependency-aware lane scheduling from completed prerequisite branches
- Cross-lane changed-file checks and configured post-integration verification
- Host-neutral JSONL events and wake signals
- Evidence-backed Delivery Review before Ship Gate
- Optional integration branch without automatic merge
- Detached PR Manager for approved push, PR, CI, merge, version, and tag work
- Cursor skill installer and project-rule fallback

agent-manager is not a sandbox, terminal multiplexer, fleet dashboard, or auto-merge service. Harness permission systems remain the execution boundary. Command-event inspection is best-effort detection.

## Requirements

- Node.js 24 or later
- Git and GitHub CLI (`gh`) for the detached shipping phase
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
# Review the source, repository instructions, relevant code, and generated scopes.
# Complete workflow.planning and agent-manager.context.md before validation.
agent-manager validate /path/to/repo/agent-manager.yaml
agent-manager run /path/to/repo/agent-manager.yaml --detach --json
```

Review the generated scopes and complete the draft `planning` block before
launch. The initializer records the current full Git SHA, creates
`agent-manager.context.md`, and leaves all planning attestations false. The
invoking manager must supply the source and plan references, review repository
instructions and relevant code, then set the four attestations true. Validation
fails if planning is incomplete or if the reviewed SHA no longer matches
`base_ref`. Agent Manager does not query the source system itself.

The initializer produces up to five
independent lanes, defaults active concurrency to three, and never enables
commits, pull requests, integration, or dangerous permission bypass.

Lane count and active concurrency are separate:

```yaml
repo: .
claim_mode: required
max_concurrency: 3
integrate: true

planning:
  source_refs: [work-item-reference]
  plan_ref: approved-plan-reference
  context_file: agent-manager.context.md
  reviewed_base_sha: 0123456789abcdef0123456789abcdef01234567
  verified_by: manager-agent
  verified_at: 2026-01-01T12:00:00Z
  reviewed_paths: [src/**, test/**]
  repository_instruction_refs: [AGENTS.md]
  attestations:
    source_reviewed: true
    repository_instructions_reviewed: true
    relevant_code_reviewed: true
    scope_verified: true

verification:
  commands:
    - command: npm
      args: [test]

lanes:
  - id: contracts
    scope: src/contracts/**
    prompt: Implement the shared contracts.

  - id: api
    depends_on: [contracts]
    scope: src/api/**
    prompt: Implement the API against the completed contracts.

  - id: ui
    depends_on: [contracts]
    scope: src/ui/**
    prompt: Implement the UI against the completed contracts.
```

Write scopes must be provably disjoint. When one broad scope must include a
narrow path owned by another lane, use `scope_overrides` to designate exactly
one writer. Agent Manager adds the path to every non-owner lane's read-only
guardrail. Ambiguous or unapproved overlap stops validation before claims or
worktrees are created. A `depends_on` chain can instead sequence writable
ownership of the same path; any actual same-file edit is retained as Delivery
Review risk evidence.

At launch, the context file is copied into the private run directory and its
SHA-256 digest is recorded in status and review evidence. Every lane receives
that exact packet. Resume and integration use the frozen copy, so later edits
to the original context file cannot change an active run.

## Cursor cockpit

Install the user-level agent-manager and PR Manager skills:

```bash
agent-manager install cursor
```

Install both skills plus a project rule:

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
agent-manager ship <runId> --approve through-pr|all --detach
agent-manager cancel <runId>
agent-manager cleanup <runId>
agent-manager cleanup --stale --older-than-days 30
```

Dangerous permission bypass requires two independent inputs: `policy.dangerously_skip_permissions: true` in the workflow and `--allow-dangerous-permissions` on that invocation (or the matching environment confirmation).

## Detached PR Manager

After Delivery Review accepts the work and the operator approves Ship Gate,
hand shipping to the same run instead of polling GitHub in the host chat:

```bash
agent-manager ship <runId> \
  --approve through-pr \
  --commit-message "feat: approved change" \
  --detach --json
```

`through-pr` stops after the pull request merges. `all` also requires an
explicit version and public release summary:

```bash
agent-manager ship <runId> \
  --approve all \
  --commit-message "feat: approved change" \
  --version 1.2.0 \
  --summary "Add the approved capability." \
  --detach --json
```

Formal Flow uses squash auto-merge. Release tags are created only after the
version stamp passes and configured GitHub Actions workflows are green. Merge
conflicts, failed checks, branch protection, authentication failures, and
version mismatches become `status.ship.needsInput`; they are never bypassed.

Keep `watch-signal` armed and use the templates in
[`skills/pr-manager/reporting.md`](skills/pr-manager/reporting.md). PR Manager
does not create GitHub Releases.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_MANAGER_DEV_ROOT` | current directory | Root used for simple relative repository names |
| `AGENT_MANAGER_RUNS_ROOT` | `~/.agent-manager/runs` | Private status, prompts, replies, logs, events, and worktrees |
| `AGENT_MANAGER_CLAIMS_ROOT` | `~/.agent-manager/claims` | Bundled advisory claim registry |
| `AGENT_MANAGER_CLAIM_BIN` | bundled `tools/claim.mjs` | Optional external claim implementation |
| `AGENT_MANAGER_ENV_ALLOWLIST` | empty | Extra comma-separated variables passed to workers |
| `AGENT_MANAGER_ALLOW_DANGEROUS_PERMISSIONS` | unset | Invocation-level dangerous-mode confirmation |

Workflow claim modes are `auto`, `off`, and `required`. `auto` uses the bundled
registry but treats registry failure as advisory; `required` fails closed.
Required admission is all-or-nothing. Leases renew while the supervisor is
active, and an expired claim is recovered only after its recorded local
supervisor process is confirmed inactive.

## Security and privacy

Prompts, replies, logs, paths, and session identifiers can contain sensitive data. Run and claim directories use private permissions where supported. Use stale cleanup, keep the runs root out of synchronized/public folders, and never commit telemetry.

See [SECURITY.md](SECURITY.md), [public repository hygiene](docs/PUBLIC-REPO-HYGIENE.md), and [the operator guide](docs/OPERATOR.md).

## Contracts

Published JSON schemas live under [`schemas/`](schemas/): workflow, detached
launch, status, JSONL events, Delivery Review, ship handoff, and detached ship
launch. `status.json` remains authoritative; integrations stay thin and
replaceable.

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
