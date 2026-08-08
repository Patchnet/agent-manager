# agent-manager 🎛️

[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-4b5563)](#requirements)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**One operator. Up to five isolated coding lanes. Explicit approval before anything ships.**

> **Why we built it**
>
> Agent Manager started as an internal tool for coordinating coding agents
> across our own repositories. In practice, three to five focused agents is
> the current sweet spot for this kind of work: enough parallelism to matter,
> but still small enough for one operator to understand and review.
>
> This is a deliberately focused tool. More advanced orchestration platforms
> exist, but if you want a straightforward way to run multiple Claude Code or
> Codex harnesses in isolated worktrees, Agent Manager provides the core loop.
> Its optional PR Manager and Ship Gate flow also keeps review, approval, CI,
> and shipping explicit, which reduces the operator's cognitive load.

agent-manager is a detached CLI supervisor for Claude Code and Codex CLI. It
runs parallel work in isolated Git worktrees while the host chat stays free for
decisions, questions, and review.

The current shipping path is a **managed compatibility mode** built around Git
and GitHub CLI. The core orchestration contracts are provider-neutral; native
GitHub execution and additional provider connectors are planned separately.

## Three components, three clear jobs

| Component | What it is | Owns | Does not own |
|---|---|---|---|
| **[🎛️ Agent Manager — core](skills/agent-manager/SKILL.md)** | CLI supervisor + host skill | planning evidence, lane isolation, bounded concurrency, questions, telemetry, integration, Delivery Review | source-system check-in, approval, or automatic shipping |
| **[📦 PR Manager — function](skills/pr-manager/SKILL.md)** | deterministic `agent-manager ship` phase + reporting skill | approved commit, push, pull request, CI wait, merge, version stamp, and tag | code authoring, approval decisions, policy bypasses, or GitHub Releases |
| **[🚦 Ship Gate — approval](skills/ship-gate/SKILL.md)** | standalone, model-neutral skill | the human approval board and exact authorized Git actions | orchestration or background execution |

Agent Manager is the product core. PR Manager is not another autonomous agent;
it is the core's detached shipping function. Ship Gate is deliberately
independent and can govern a normal single-agent pull request without Agent
Manager.

```mermaid
flowchart LR
    Plan["📝 Plan + source review"] --> AM["🎛️ Agent Manager<br/>parallel work"]
    AM --> Review["🔍 Delivery Review"]
    Single["👤 Single author"] --> Gate{"🚦 Ship Gate<br/>human approval"}
    Review --> Gate
    Gate -->|"open-pr"| Handoff["📬 Review-ready PR<br/>author stops"]
    Gate -->|"through-pr / all"| PR["📦 PR Manager<br/>detached shipping"]
    PR --> Done["✅ Merge / version / tag"]
```

### Choose the smallest useful setup

| Need | Use |
|---|---|
| One agent should prepare a review-ready PR | 🚦 Ship Gate only (`open-pr`) |
| Several agents should build in parallel | 🎛️ Agent Manager, then 🚦 Ship Gate |
| Approved work should ship without blocking the host chat | All three |
| A human will handle GitHub after review | 🎛️ Agent Manager only; stop after Delivery Review |

### Planned: Autopilot Director

Autopilot Director is the approved higher-autonomy mode for scheduled or
continuous operation. It promotes the planning and oversight role normally
shared by the human operator and Manager agent into a policy-bound Director
agent. Agent Manager remains the deterministic execution layer beneath it.

The first planned boundary is `pr-only`: select eligible work, plan, run,
review, push, and open a review-ready pull request without synchronous human
input. Automatic merge and release require later, narrower policies and
independent review. This mode is not implemented in the current release.

See the [Autopilot Director plan](docs/AUTOPILOT-DIRECTOR-PLAN.md) for the role
model, autonomy levels, policy contract, and phased implementation.

### Worker completion is not delivery completion

Agent Manager fails closed after the lanes finish. A successful coding run now
enters `delivery_review_pending`; it does not become `done`. The full lifecycle
is explicit:

```text
running → delivery_review_pending → ship_gate_pending → shipping
        → merged
        → release_pending → released
        → reviewed (review-only or approved no-change work)
```

`correction_pending`, `blocked`, `rejected`, `failed`, and `cancelled` retain
their own meanings. Downstream work must use the deterministic readiness gate,
not a lane or worker state:

```bash
agent-manager delivery-ready <runId> --require merged
agent-manager delivery-ready <runId> --require released
```

The command exits nonzero until the required boundary is proven. This prevents
a later wave from starting merely because workers released their file claims.

Every operator update also carries a deterministic cadence transition:

| Transition | Meaning |
|---|---|
| `AUTO_CONTINUE` | The Master takes the named next action before ending its turn |
| `WAIT_OPERATOR` | One exact operator decision is required |
| `TERMINAL` | Delivery is complete or closed; report evidence and stop |

```bash
agent-manager next-action <runId> --json
```

This prevents “stage finished” dead ends. Worker completion automatically
advances into Delivery Review; `revise` automatically launches the one
correction; accepted review automatically presents Ship Gate. Only actual
approval or blocker stages wait for the operator.

When writable lanes are not folded into one integrate branch, declare every
delivery destination. Multi-lane workflows with `integrate: false` are rejected
without this manifest:

```yaml
integrate: false
target_dev_flow: formal
delivery:
  mode: train
  release_required: true
  targets:
    - id: api-pr
      lane: api
      base: main
    - id: ui-pr
      lane: ui
      base: main
```

Each target must contain changed files. Shipping refuses no-code targets. A
release also verifies that every recorded target merge SHA is an ancestor of
the release commit before it creates the tag.

When `branch` is omitted, a target uses its isolated generated lane branch and
opens a new PR. Existing PR corrections may declare `branch` and `pr`, but the
recorded PR head and checked-out worktree must already align. A mismatch blocks
shipping instead of overwriting or falsely claiming the existing PR.

## What the operator sees

The process is designed to make the next decision obvious. Agent Manager posts
the same structured boards in every supported harness, wakes the operator only
for meaningful changes or questions, and shows the exact authority requested
before any Git or shipping action. The examples below use illustrative data.

```mermaid
flowchart LR
    Run["Run board<br/>what is running"] --> Question{"Decision needed?"}
    Question -->|yes| Escalation["Escalation<br/>one focused question"]
    Question -->|no| Review["Delivery Review<br/>what was delivered"]
    Escalation --> Review
    Review --> Gate{"Ship Gate<br/>exact approval scope"}
    Gate --> Handoff["PR Manager<br/>detached execution"]
```

<details>
<summary><strong>1. Kickoff — a compact live run board</strong></summary>

## Agent Manager · Run board

| | |
|---|---|
| **runId** | `run-20260731-1432` |
| **repo** | `sample-app` |
| **state** | `running` |
| **target_dev_flow** | `formal` |
| **runtime** | `macos/arm64 (darwin) · zsh · spawn-no-shell` |
| **workflow** | `.agent-manager/profile-settings.yaml` |
| **plan** | `docs/plans/profile-settings.md` |
| **planning context** | `sha256:7d4b…91ac` |
| **started** | `2026-07-31 14:32 EDT` |
| **updated** | `2026-07-31 14:36 EDT` |
| **telemetry** | `$AGENT_MANAGER_RUNS_ROOT/run-20260731-1432/status.json` |

### Lanes

| Lane | State | Harness | Branch | Elapsed | Last activity |
|------|-------|---------|--------|---------|---------------|
| `contracts` | `done` | `codex` | `am/run-20260731-1432/contracts` | `94s` | Contract tests passed |
| `api` | `running` | `claude` | `am/run-20260731-1432/api` | `211s` | Updating request validation |
| `ui` | `running` | `codex` | `am/run-20260731-1432/ui` | `208s` | Adding the profile form |

### Actions

- Monitor (side terminal): `agent-manager monitor run-20260731-1432`
- Watch-signal (Master loop): `agent-manager watch-signal run-20260731-1432`
- Cancel: `agent-manager cancel run-20260731-1432`
- Logs: `$AGENT_MANAGER_RUNS_ROOT/run-20260731-1432/<lane>/stdout.log`

### Transition

| | |
|---|---|
| **Mode** | `AUTO_CONTINUE` |
| **Next action** | Keep monitoring the detached run. |
| **Operator input required** | `none` |

</details>

<details>
<summary><strong>2. Decision needed — one lane asks, independent work continues</strong></summary>

## Agent Manager · Escalation

| | |
|---|---|
| **runId** | `run-20260731-1432` |
| **lane** | `api` |
| **branch** | `am/run-20260731-1432/api` |
| **type** | `question` |
| **runtime** | `macos/arm64 (darwin) · zsh · spawn-no-shell` |

### Question

Should an empty display name preserve the current value or clear it?

### Options (if any)

- `A` — Preserve the current value
- `B` — Clear the value

### Waiting on

Operator reply in this chat. Other independent lanes may keep running.

### Reply command

- `agent-manager reply run-20260731-1432 api --message "Preserve the current value"`

### Transition

| | |
|---|---|
| **Mode** | `WAIT_OPERATOR` |
| **Next action** | Resume the `api` lane after the answer. |
| **Operator input required** | `A | B` |

</details>

<details>
<summary><strong>3. Delivery Review — evidence replaces lane self-reporting</strong></summary>

## Agent Manager · Delivery Review · Pass 1

| | |
|---|---|
| **runId** | `run-20260731-1432` |
| **eval_pass** | `1` |
| **correction_used** | `no` |
| **repo** | `sample-app` |
| **runtime** | `macos/arm64 (darwin) · zsh · spawn-no-shell` |
| **proposal** | `docs/plans/profile-settings.md` |
| **planning context** | `sha256:7d4b…91ac` |
| **reviewed** | `2026-07-31 14:51 EDT` |
| **verdict** | `accept` |

### Proposal checklist

| Item | Asked | Delivered? | Evidence (path / test / note) |
|------|-------|------------|-------------------------------|
| Shared contract | Define the profile update shape | `yes` | `src/contracts/profile.ts` · contract tests pass |
| API | Validate and save profile changes | `yes` | `src/api/profile.ts` · API tests pass |
| UI | Add an accessible profile form | `yes` | `src/ui/ProfileForm.tsx` · component tests pass |

### Cross-lane / contract checks

| Couple | OK? | Note |
|--------|-----|------|
| Contract ↔ API | `yes` | API imports the shared schema |
| Contract ↔ UI | `yes` | Form fields and defaults match the schema |
| Documentation ↔ behavior | `yes` | Empty display names preserve the current value |

### Gaps / feedback (by lane)

| Lane | Grade | Feedback for worker (actionable) |
|------|-------|----------------------------------|
| `contracts` | `A` | No changes requested |
| `api` | `A` | No changes requested |
| `ui` | `A` | No changes requested |

### Recommended next

- [x] Pass 1 `accept` → integrate if needed → **Ship Gate**
- [ ] Pass 1 `revise` / `relaunch` → one correction → Pass 2 report
- [ ] Pass 1 `reject` → release claims; do not ship
- [ ] Pass 2 `accept` / `accept-with-notes` → **Ship Gate**
- [ ] Pass 2 `reject` → stop; only the operator may order a new run

### Waiting on

Operator `accept` | `accept-with-notes` | `revise` | `relaunch` | `reject`

### Transition

| | |
|---|---|
| **Mode** | `WAIT_OPERATOR` |
| **Next action** | Persist the verdict, then advance without another confirmation. |
| **Operator input required** | `accept | accept-with-notes | revise | relaunch | reject` |

</details>

<details>
<summary><strong>4. Ship Gate — the operator approves an exact boundary</strong></summary>

## Ship Gate · Formal

| | |
|---|---|
| **Repo** | `sample-app` |
| **Branch** | `am/run-20260731-1432/integrate` |
| **Agent** | `Codex · Master Dev` |
| **Role** | `reviewer/integrator` |
| **Claim** | `n/a` |
| **Version** | at merge (not on branch) · current `1.4.0` |
| **Test gate** | `full` · suite **pass** |
| **CI** | `n/a` (not pushed yet) |
| **PR** | `none` |
| **check:version** | **n/a** (no stamp on branch) |

### Done

- [x] Work complete on branch
- [x] Tests (if required)
- [x] Claim held / scope clear (when claims apply)
- [ ] Code-review run (required before merge)
- [ ] Full stamp set ready on `main`
- [ ] `npm run check:version` pass on stamp
- [ ] CI quality green on stamp commit (before tag)

### Needs your OK

| Step | Action | Detail |
|------|--------|--------|
| COMMIT | waiting | `feat: add profile settings flow` |
| PUSH | waiting | `origin am/run-20260731-1432/integrate` |
| PR | waiting | open + `gh pr merge --auto --squash` |
| MERGE | waiting | only after CI and independent review are green |
| VERSION | waiting | on `main` after merge → `1.5.0` |
| TAG | waiting | only after stamp verification and CI |

### Approve — reply with one

| Reply | Does |
|-------|------|
| `all` | reviewer/integrator — commit → push → PR + auto-merge → release/stamp on `main` |
| `through-pr` | reviewer/integrator — commit → push → PR + auto-merge; version/tag later |
| `commit+push` | stop before PR |
| `commit` | commit only |
| `reject` | stop — add why |

After `through-pr` or `all`, PR Manager runs the approved steps in the
background and reports any CI or policy blocker. It never expands the approval
or invents a workaround.

### Transition

| | |
|---|---|
| **Mode** | `WAIT_OPERATOR` |
| **Next action** | Execute exactly the approved Formal Flow scope. |
| **Operator input required** | `all | through-pr | commit+push | commit | reject` |

</details>

These filled examples follow the canonical
[Agent Manager report templates](skills/agent-manager/reporting.md),
[Ship Gate boards](skills/ship-gate/SKILL.md), and
[PR Manager reports](skills/pr-manager/reporting.md).

## What the core provides

- One isolated Git worktree per lane
- Claude and Codex harnesses behind one workflow format
- Detached launch with authoritative `status.json`
- Actionable Master handoff for Codex, Claude Code, and Cursor
- Automatic host runtime profile in doctor, prompts, telemetry, and shipping
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

## Sandboxing and permissions

Agent Manager is not a sandbox. It launches each worker through its existing
agent CLI inside an isolated Git worktree. The underlying harness—such as
Claude Code or Codex—continues to enforce its native sandbox, approval,
authentication, and permission configuration.

Agent Manager passes the requested native permission mode and adds
orchestration guardrails such as file scopes, environment filtering,
Git-operation checks, and explicit shipping approval. Command-event inspection
is best-effort detection. These controls reduce accidental drift, but they do
not replace the harness security model or operating-system isolation.

Dangerous permission bypass is disabled by default. Enabling it requires two
explicit approvals: one in the workflow and one at launch.

Agent Manager is also not a terminal multiplexer, hosted dashboard, or automatic
merge service. Its `fleet` command is a local, read-only terminal watcher over
the same run telemetry used by `status` and `monitor`.

Agent Manager does maintain a separate coordination brain. Before claims or
worktrees are created, the supervisor writes a `run_intent` to an embedded
MAADB project in explicit `feed` mode. The brain has no Git repository. It
blocks overlapping active edit scopes, exposes non-overlapping related runs,
and records overlapping pending-delivery runs as dependencies in the frozen
lane context. Run telemetry remains in `AGENT_MANAGER_RUNS_ROOT`; semantic
coordination remains in `AGENT_MANAGER_BRAIN_ROOT`.

## Requirements

- Node.js 24 or later
- Git and GitHub CLI (`gh`) for the detached shipping phase
- Claude Code, Codex CLI, or both, already authenticated through their normal subscription CLI

## Install the core CLI

```bash
git clone https://github.com/Patchnet/agent-manager.git
cd agent-manager
npm ci
npm link
agent-manager --version
agent-manager config init --dev-root /path/to/your/dev
agent-manager config show
agent-manager version
agent-manager doctor
agent-manager-fleet
```

You can also replace `agent-manager` in the examples with `node bin/agent-manager.mjs`.

`doctor` detects the authoritative host platform, architecture, shell, command
mode, and path style. Agent Manager injects the same profile into every lane
prompt and worker environment. Operators do not select the host OS manually;
platform-specific command adapters use the detected profile. On Windows, npm
and other command scripts run through `cmd.exe` while authored lane commands
are identified as PowerShell commands.

Install worker CLIs in the same OS environment that launches Agent Manager,
restart that harness after PATH changes, and run `agent-manager doctor --json`
there. Doctor provides structured remediation for missing harnesses. On Windows,
Agent Manager recognizes npm `.cmd` and `.ps1` shims and supports explicit
`CLAUDE_BIN` and `CODEX_BIN` overrides. See the
[worker harness setup guide](docs/HARNESS-SETUP.md) for standardized Claude Code,
Codex CLI, Cursor, Windows, macOS, and Linux instructions.

### Watch the fleet in a terminal

Launch one self-contained CLI view from any terminal. It discovers runs under
`AGENT_MANAGER_RUNS_ROOT`, redraws live when attached to a TTY, and does not
mount a web app or modify orchestration state.

```bash
agent-manager-fleet
agent-manager fleet --active
agent-manager fleet --stream
agent-manager fleet --once --no-color
agent-manager fleet --json
agent-manager fleet --runs-root /path/to/another/runs-root
```

`agent-manager-fleet` is a dedicated executable alias for `agent-manager fleet`.
An npm global install or `npm link` creates the correct shell command on macOS,
Linux, and Windows, so the launch location does not control telemetry discovery.
Fleet prints the resolved telemetry root and its source in the header and in
JSON output.

For a double-click launcher, the package includes
`launchers/Agent Manager Fleet.command` for macOS and
`launchers/Agent Manager Fleet.cmd` for Windows. Copy the appropriate file to a
convenient location. On macOS, run `chmod +x "Agent Manager Fleet.command"`
once after copying it. Both launchers call the globally installed
`agent-manager-fleet` executable and therefore use the same user configuration.

The live view shows plans or tickets, repositories, run states, lane progress,
worker summaries, elapsed time, blockers, and recent transitions. Use arrow
keys or `j`/`k` to focus a run, `a` to toggle active-only filtering, `r` to
refresh, and `q` to quit. Colors, progress animation, transition flashes, and
the alternate screen are enabled for interactive terminals; pipes receive a
stable one-shot view automatically.

Fleet displays its own runtime version and the engine version recorded by each
new run. `agent-manager version` reports the running version, the version now on
disk, and whether the current process needs a restart. If Agent Manager is
updated while Fleet is open, Fleet shows `UPDATE INSTALLED` and asks the operator
to quit and restart the viewer. This check is offline and read-only; Fleet does
not contact an update service or modify run telemetry.

It is safe to restart `fleet` or `monitor` while detached runs are active. They
are passive readers, and the run supervisors and workers continue independently.
An active run keeps the engine version it started with; only future runs use
newly installed code. `watch-signal` is also safe to restart, but stop the old
watcher first so two notification processes do not emit duplicate wakes.

## Use each component standalone

### 🎛️ Agent Manager core only

Use the core by itself when you want isolated parallel work and evidence-backed
review, but a human or another system will handle Git afterward.

```bash
agent-manager init --repo /path/to/repo \
  --request "Implement the approved plan" \
  --harnesses claude,codex
# Review and complete the generated planning block and context file.
agent-manager validate /path/to/repo/agent-manager.yaml
agent-manager run /path/to/repo/agent-manager.yaml --detach --json
agent-manager watch-signal <runId> --heartbeat-sec 180
agent-manager review <runId>
# After the operator decides:
agent-manager review <runId> --pass 1 --verdict accept --reviewer <reviewer-id>
```

Stop after Delivery Review. Agent Manager does not require PR Manager when a
person will perform integration, and it does not require Ship Gate until an
outward shipping action is proposed.

### 📦 PR Manager function

PR Manager is not a separate agent or binary. It is the deterministic shipping
phase exposed by the core CLI. It requires an existing run, an accepted
Delivery Review, and an explicit Ship Gate approval.
The acceptance must be persisted by `agent-manager review --verdict ...`; a
chat-only verdict cannot start PR Manager.

```bash
agent-manager ship <runId> \
  --approve through-pr \
  --commit-message "feat: approved change" \
  --detach --json
agent-manager watch-signal <runId> --heartbeat-sec 180
```

The host can walk away after the detached handoff. PR Manager reads the same
`status.json`, stops on policy or CI blockers, and reports the blocker through
the run instead of inventing a workaround.

### 🚦 Ship Gate only

Ship Gate can govern a single developer or coding agent without Agent Manager.
Copy or symlink [`skills/ship-gate/`](skills/ship-gate/) into the host's skill
directory, or vendor it into the target repository.

| Host | Typical destination |
|---|---|
| Claude Code | `~/.claude/skills/ship-gate/` |
| Cursor | `~/.cursor/skills/ship-gate/` or `<repo>/.cursor/skills/ship-gate/` |
| Codex | `~/.codex/skills/ship-gate/` |
| Any repository | Point `AGENTS.md` or `CLAUDE.md` to the vendored skill |

Portable repository instruction:

```markdown
Before any commit, push, or pull request, follow the repository Ship Gate.

PR authors request `open-pr` and stop after the PR is review-ready. They must
not approve, auto-merge, merge, version, tag, or release their own PR. A
different developer or Master Dev owns integration and release.
```

The approval replies are intentionally narrow:

| Reply | Authority |
|---|---|
| `open-pr` | Author: commit, push, create/update PR, attach evidence, then stop |
| `through-pr` | Independent reviewer: ship through merge; version/tag later |
| `all` | Independent reviewer: ship through merge, approved version, and tag |
| `commit` / `commit+push` | Perform only the named Git steps |
| `reject` | Stop |

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

## 🎛️ Agent Manager: create a real workflow

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

The initializer produces up to five independent lanes, defaults active
concurrency to three, and enables a local integrate branch so lane changes are
not stranded. It never enables worker commits, pull requests, or dangerous
permission bypass.

Lane count and active concurrency are separate:

```yaml
repo: .
title: Fleet telemetry
repo_shorthand: agent-manager
claim_mode: required
max_concurrency: 3
integrate: true

planning:
  source_refs: [work-item-reference]
  plan_ref: approved-plan-reference
  context: |
    Private planning packet shared with every lane.
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
    kind: implementation
    scope: src/contracts/**
    expected_outputs: [src/contracts/index.ts]
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

Inline `planning.context` is recommended because it creates no untracked file
in the target checkout. `planning.context_file` remains available for existing
workflows. At launch, either input is frozen in the private run directory and
its SHA-256 digest is recorded in status and review evidence. Every lane
receives that exact packet.

Implementation lanes do not succeed on process exit alone. They must leave at
least one in-scope changed file unless `allow_no_changes: true` was explicitly
approved. Review lanes use `kind: review` and may finish without edits. A run
with no change-producing lanes ends as `reviewed` after an accepted Delivery
Review; it never opens an empty Ship Gate.
`expected_outputs` lists concrete required file paths; validation rejects an
output not covered by the lane scope, including extension mismatches such as a
`.tsx` output under a `.ts`-only pattern. Status and Delivery Review also report
when the dependency graph is fully serialized and a single queued agent would
be more efficient.

## Install host skills (Cursor)

Install the user-level agent-manager and PR Manager skills:

```bash
agent-manager install cursor
```

Install both skills plus a project rule:

```bash
agent-manager install cursor --project /path/to/repo
```

This command installs the Agent Manager and PR Manager skills. Install or
reference Ship Gate separately because approval policy belongs to the target
repository, not to the orchestration runtime.

Cursor launches runs with `--detach`, reads `status.json`, replies to blocking lanes, and generates Delivery Review. `watch-signal` and `events --jsonl` are the portable wake sources:

```bash
agent-manager watch-signal <runId> --heartbeat-sec 180
agent-manager events <runId> --jsonl
```

Cursor does not currently document a stable API that wakes an idle chat from arbitrary external process output. Automatic chat re-entry is therefore experimental. A side-terminal watcher or operating-system notification can consume the same event stream without changing orchestration state.

Master return is independent of worker harness choice. Codex and Claude Code
launches auto-detect `CODEX_THREAD_ID` and `CLAUDE_CODE_SESSION_ID`; Agent
Manager privately resumes the originating Master Dev thread for actionable
transitions, including `delivery_review_pending`. Cursor Agent CLI supports the
same direct route when launched with an explicit chat ID:
`--return-host cursor --return-session <chat-id>`. Cursor IDE does not expose a
documented chat ID to terminal subprocesses, so `CURSOR_AGENT` selects signal
mode: the structured handoff and `AGENT_MANAGER_WAKE_` sentinel drive the host's
background watcher without claiming direct thread resume. Routine progress
does not open extra turns. Use `--no-master-return` to opt out. If delivery
fails, run `agent-manager next-action <runId> --json`; private diagnostics live
in `master-return.json`, `master-handoff.json`, and
`master-return-supervisor.log` under the run directory.

## Command map

### 🎛️ Core orchestration

```text
agent-manager doctor [--repo <path>]
agent-manager validate <workflow.yaml> [--repo <path>]
agent-manager init --repo <path> [--request <text>] [--harnesses claude,codex]
agent-manager run <workflow.yaml> --detach [--repo <path>] [--json]
  [--title <subject>] [--repo-shorthand <name>]
  [--manager-harness <name>] [--manager-model <model>]
  [--manager-thread-title <title>]
  [--return-host codex|claude|cursor --return-session <thread-id> | --no-master-return]
agent-manager status [runId] [--json]
agent-manager monitor [runId]
agent-manager fleet [runId] [--active] [--since 24h] [--repo <name>]
  [--stream | --once | --json] [--no-color] [--no-effects]
agent-manager events <runId> --jsonl
agent-manager watch-signal <runId>
agent-manager reply <runId> <laneId> --message <text>
agent-manager review <runId> [--pass 1|2]
agent-manager review <runId> --pass 1 --verdict accept|accept-with-notes|revise|relaunch|reject --reviewer <id> [--notes <text>]
agent-manager next-action <runId> [--json]
agent-manager delivery-ready <runId> [--require merged|released]
agent-manager integrate <runId>
agent-manager cancel <runId>
agent-manager cleanup <runId>
agent-manager cleanup --stale --older-than-days 30
```

Every run has a harness-neutral identity:

```text
[AM <short-run-id>] <repo-shorthand> · <subject>
```

Set `title` and optional `repo_shorthand` in the workflow, or override them at
launch. Detached launch output includes `suggestedThreadTitle`; a host may use
it to rename the originating Manager task when its API supports title changes.
Title synchronization is best effort and never gates orchestration. Selecting
a run in `fleet` expands its Manager Harness, Manager Model, optional host
thread title, and each lane's requested or observed worker model. Requested
models remain marked unverified until the harness reports the effective model.
During shipping, the same expanded panel shows the active ship phase, completed
and running steps, PR context, and per-workflow GitHub Actions progress.

### 📦 PR Manager function

```text
agent-manager ship <runId> --approve through-pr|all [--target <delivery-target-id>] --detach
```

Dangerous permission bypass requires two independent inputs: `policy.dangerously_skip_permissions: true` in the workflow and `--allow-dangerous-permissions` on that invocation (or the matching environment confirmation).

## 📦 PR Manager: detached shipping

After Delivery Review accepts the work and the operator approves Ship Gate,
hand shipping to the same run instead of polling GitHub in the host chat. For
a delivery train, supply the next manifest target; omit `--target` for a
single integrate branch:

```bash
agent-manager ship <runId> \
  --approve through-pr \
  --target api-pr \
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

Formal releases are stamped, committed, pushed, checked, and tagged from a
private worktree under the run directory. PR Manager never switches, cleans,
or requires a clean shared checkout. GitHub receives a bounded registration
grace period before missing required checks are diagnosed; use
`--check-grace-sec <n>` to override the 90-second default.

Formal Flow uses squash auto-merge. Release tags are created only after the
version stamp passes and configured GitHub Actions workflows are green. Merge
conflicts, failed checks, branch protection, authentication failures, and
version mismatches become `status.ship.needsInput`; they are never bypassed.

Keep `watch-signal` armed and use the templates in
[`skills/pr-manager/reporting.md`](skills/pr-manager/reporting.md). PR Manager
does not create GitHub Releases.

## Configuration

Agent Manager reads optional user-owned configuration from
`~/.agent-manager/config.env` (on Windows,
`%USERPROFILE%\.agent-manager\config.env`). The file is outside the npm package,
so upgrades do not overwrite it. Initialize it once from the directory that
contains your repositories, or provide an explicit development root:

```bash
agent-manager config init --dev-root /path/to/your/dev
agent-manager config show
```

Use `--runs-root`, `--claims-root`, and `--brain-root` with `config init` to choose other
locations. `config init` refuses to replace an existing file unless `--force`
is supplied. Resolution order is command-line override, process environment,
user config, then the built-in default. Relative paths in a manually edited
user config are resolved from the config file's directory.

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_MANAGER_CONFIG` | `~/.agent-manager/config.env` | Optional user configuration file |
| `AGENT_MANAGER_DEV_ROOT` | current directory | Root used for simple relative repository names |
| `AGENT_MANAGER_RUNS_ROOT` | `~/.agent-manager/runs` | Private status, prompts, replies, logs, events, and worktrees |
| `AGENT_MANAGER_CLAIMS_ROOT` | `~/.agent-manager/claims` | Bundled advisory claim registry |
| `AGENT_MANAGER_BRAIN_ROOT` | `~/.agent-manager/brain` | Git-free MAADB run-intent and cross-run awareness project |
| `AGENT_MANAGER_CLAIM_BIN` | bundled `tools/claim.mjs` | Optional external claim implementation |
| `AGENT_MANAGER_ENV_ALLOWLIST` | empty | Extra comma-separated variables passed to workers |
| `AGENT_MANAGER_ALLOW_DANGEROUS_PERMISSIONS` | unset | Invocation-level dangerous-mode confirmation |

Workflow claim modes are `auto`, `off`, and `required`. `auto` uses the bundled
registry but treats registry failure as advisory; `required` fails closed.
Required admission is all-or-nothing. Leases renew while the supervisor is
active, and an expired claim is recovered only after its recorded local
supervisor process is confirmed inactive.

Initialize or inspect the awareness plane directly:

```bash
agent-manager brain init
agent-manager brain status
agent-manager brain status --repo /path/to/repo --json
```

Manage durable goals and inspect their evidence-based progress from the same
local brain:

```bash
agent-manager goal create --title "Ship the local workflow" --id goal-local-workflow
agent-manager goal create --title "Verify delivery" --parent goal-local-workflow
agent-manager goal link goal-local-workflow --type plan --ref plan:local-workflow --state active
agent-manager goals
agent-manager goal status goal-local-workflow
agent-manager goal map goal-local-workflow --output ./goal-local-workflow.html
```

`goal status` reports the effective state, the exact completed-leaf ratio, and
the decisive goal, artifact, and run evidence. Add `--json` for the stable
`agent-manager.goal-progress.v1` payload. `goal map` writes one responsive HTML
file that works offline without scripts, remote fonts, CDNs, or a running Agent
Manager process. Its JSON result uses `agent-manager.goal-map-export.v1` and
includes the resolved output path. Stored labels and references are escaped and
rendered as text, not active links. See [the goal model](docs/GOAL-MODEL.md).

Repository identity prefers a normalized Git remote, so two local checkouts of
the same repository coordinate under one key. A repository without a remote
falls back to its canonical local path and therefore coordinates only on that
machine. Point every Agent Manager installation at the same durable
`AGENT_MANAGER_BRAIN_ROOT` when cross-machine awareness is required. The shared
filesystem must provide reliable exclusive-create and SQLite locking semantics.

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

CI runs the tests and package review on Windows, Linux, and macOS. Dependency
review runs on pull requests.

## License

Apache-2.0. See [LICENSE](LICENSE).
