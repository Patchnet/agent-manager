# agent-manager — reference

Companion to [SKILL.md](./SKILL.md). Keep skill short; put detail here.

## Architecture

```text
Master Dev (chat)
    → skill: agent-manager
    → CLI: bin/agent-manager.mjs run … --detach   (exits immediately)
         → detached supervisor (same CLI, --run-id)
              → tools/claim.mjs (or AGENT_MANAGER_CLAIM_BIN)
              → git worktree per lane
              → harness adapter (claude -p | codex exec --json)
              → $AGENT_MANAGER_RUNS_ROOT/<runId>/status.json  (supervisor polls ~2s)
    → Master arms watch-signal (3m heartbeat + state wakes) → chat templates
    → optional side terminal: monitor
    → accepted Delivery Review + Ship Gate
         → ship --detach → PR / CI / merge / release telemetry in status.ship
```

Not a bridge/daemon. Master Dev **must** arm `watch-signal` after detach so
chat is not silent. Side-terminal `monitor` is for human glance; chat boards
still come from Master reading `status.json` on each wake
([reporting.md](./reporting.md)).

## Paths / environment

| Variable | Default | Role |
|---|---|---|
| `AGENT_MANAGER_DEV_ROOT` | `cwd` | Parent of target `repo` folders |
| `AGENT_MANAGER_RUNS_ROOT` | `~/.agent-manager/runs` | Telemetry + worktrees |
| `AGENT_MANAGER_CLAIMS_ROOT` | `~/.agent-manager/claims` | Claim JSON registry |
| `AGENT_MANAGER_CLAIM_BIN` | `<pkg>/tools/claim.mjs` | Claims CLI |
| `AGENT_MANAGER_ENV_ALLOWLIST` | empty | Extra worker environment names |

Workers also receive automatically generated, non-secret runtime variables:
`AGENT_MANAGER_HOST_PLATFORM`, `AGENT_MANAGER_HOST_OS`,
`AGENT_MANAGER_HOST_ARCH`, `AGENT_MANAGER_HOST_SHELL`,
`AGENT_MANAGER_COMMAND_MODE`, and `AGENT_MANAGER_PATH_STYLE`.

## Detach (Master Dev mandatory)

```bash
node bin/agent-manager.mjs run <workflow.yaml> --detach
```

Prints `runId`, `pid`, `telemetry`, `supervisorLog` and exits. The supervisor
continues writing `status.json` under the runs root. Never await a
non-detach `run` from a Master Dev chat turn.

## Watch-signal + monitor

```bash
node bin/agent-manager.mjs watch-signal <runId> --heartbeat-sec 180
# prints: AGENT_MANAGER_WAKE_<runId> {"reason":"heartbeat|state_change|needs_input|terminal",...}

node bin/agent-manager.mjs monitor <runId> [--interval 2]
# live lane/delivery board; exits on reviewed/merged/released/rejected/failed/cancelled
```

`watch-signal` baselines `status.json`, then emits wakes for Cursor
`notify_on_output` (`^AGENT_MANAGER_WAKE_`). Heartbeat default is **180s**;
pass `--heartbeat-sec <n>` to adjust (operator preference). State-change /
needs-input / terminal wakes do not wait for that interval. `monitor` is the
side-terminal cooking view (`status --watch` aliases it).

Every wake contains an `agent-manager.operator-cadence.v1` object. Query the
same deterministic mapping directly with:

```bash
agent-manager next-action <runId> --json
```

`delivery_review_pending` initially emits `state_change` with
`AUTO_CONTINUE`. After `agent-manager review <runId>` presents and records the
review, the review state becomes `awaiting_operator` and emits `needs_input`
with the exact verdict vocabulary. Heartbeats are suppressed while waiting on
an operator decision.

## Workflow YAML (minimal)

```yaml
repo: <folder-under-DEV_ROOT>
harness_default: claude
claim_mode: required
max_concurrency: 3        # 1..5; extra lanes remain queued
target_dev_flow: simple   # optional override; else Version.md; else simple
integrate: true           # optional — fold lanes into am/<runId>/integrate when done
delivery:                 # required for multi-lane writable runs without integration
  mode: single            # single | train | review-only
  release_required: false
  targets: []             # train: one explicit target for every writable lane
feed:
  enabled: false          # optional; normal operation never requires Agent Feed
  baseUrl: http://localhost:8787
  topic: agent-manager/my-repo
policy:
  allow_commit: false
  allow_pr: false
  stall_timeout_sec: 900
  permission_mode: acceptEdits
planning:
  source_refs: [<work-source-reference>]
  plan_ref: <approved-plan-reference>
  context: |
    <private shared planning packet>
  reviewed_base_sha: <full-git-commit-sha>
  verified_by: <manager-agent>
  verified_at: <ISO-date-time>
  reviewed_paths: [src/**, test/**]
  repository_instruction_refs: [AGENTS.md]
  attestations:
    source_reviewed: true
    repository_instructions_reviewed: true
    relevant_code_reviewed: true
    scope_verified: true
lanes:
  - id: <lane>
    kind: implementation    # implementation | review
    depends_on: []        # optional lane ids that must finish first
    scope: "path/or/glob/**"
    expected_outputs: [path/to/required-file.ts]
    prompt: |
      …task…
```

Max **5** lanes per run. Active concurrency defaults to three and is bounded by
`max_concurrency`. Remaining lanes report `queued`; lanes waiting on unfinished
prerequisites report `dependency-waiting`.

`planning` is a launch attestation owned by the invoking manager. `validate`
and `run` require every attestation and require `reviewed_base_sha` to equal the
commit resolved by `base_ref`. Use inline `context` to avoid target-repository
files; `context_file` remains compatible with existing workflows. At launch the
packet is copied to the private run directory, hashed, and injected identically
into every lane prompt.

An `implementation` lane must produce at least one changed file unless
`allow_no_changes: true` is explicit. A `review` lane may finish without edits.
Concrete `expected_outputs` must be covered by the lane scope and must exist at
completion. Exit code 0 alone never proves delivery. The preflight records the
dependency topology and warns when a multi-lane graph is fully serialized.

Write scopes are validated pairwise before claims or worktrees are created.
Unapproved overlap fails closed. `scope_overrides` may name exactly one writable
owner and make the overlapping path read-only for participating non-owners.
Lanes ordered through `depends_on` may write the same scope sequentially. Their
actual same-file changes are recorded as approved sequential overlap evidence.

When `integrate: true` and all coding lanes exit `done`, the supervisor snapshots
dirty lane worktrees, merges them into `am/<runId>/integrate` from the recorded immutable base SHA,
and writes `integrate/summary.json` + `integrate/README.md`. Conflicts →
`needs-input` / run `blocked`. Integrate never pushes, opens a PR, stamps
versions, or merges to `main`. After Delivery Review and Ship Gate, PR Manager
owns those approved operations through the detached `ship` phase.

Before a merge, integration blocks any file changed by multiple unordered
lanes even if Git could merge it cleanly. Ordered same-file edits remain visible
as Delivery Review risk evidence. After merging, configured
`verification.commands` run without a shell in the integration worktree; a
failed command blocks delivery and is included in Delivery Review evidence.

With `integrate: false`, every writable lane must have an explicit delivery
target. Omit a target `branch` to use the generated lane branch. A target may
record `branch`, `base`, and an existing PR number, but shipping fails closed if
the checked-out worktree or pull-request head does not match those coordinates.
This prevents a correction run from silently claiming it updated an unrelated
existing PR.
Simple Flow requires `integrate: true` for multi-lane writable work, because it
ships one direct release branch rather than a PR train.

Worker completion transitions the run to `delivery_review_pending`. Record the
operator's decision with `agent-manager review ... --verdict ... --reviewer ...`.
Only an accepted persisted decision allows shipping. For a delivery train,
ship one target at a time with `--target <id>`. Use `delivery-ready --require
merged|released` as the machine-readable downstream gate.

## CLI notes (Windows)

- The detected runtime profile reports `win32`, `windows`, `powershell`,
  `spawn-no-shell`, and Windows path style before work starts.
- Command scripts such as `npm` and `*.cmd` run through `cmd.exe`; native
  executables continue to launch without a shell.
- Prompt is delivered on **stdin** (multiline argv is unreliable).
- Binary resolved to `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`
  when present (`CLAUDE_BIN` override supported).
- Empty-prompt failure is detected and marked failed (exit 2).

## status.json shape

```json
{
  "runId": "run-YYYYMMDD-HHMMSS-random",
  "state": "running|delivery_review_pending|correction_pending|ship_gate_pending|shipping|blocked|release_pending|reviewed|merged|released|rejected|failed|cancelled",
  "repo": "my-repo",
  "workflow": "/abs/path/workflow.yaml",
  "target_dev_flow": "simple",
  "runtime": {
    "hostPlatform": "win32",
    "os": "windows",
    "arch": "x64",
    "release": "10.0.0",
    "shell": "powershell",
    "commandMode": "spawn-no-shell",
    "pathStyle": "windows"
  },
  "maxConcurrency": 3,
  "baseCommit": "immutable SHA",
  "planning": {
    "state": "verified",
    "planRef": "approved plan reference",
    "reviewedBaseSha": "immutable SHA",
    "contextDigest": "SHA-256"
  },
  "startedAt": "ISO",
  "updatedAt": "ISO",
  "lanes": [
    {
      "id": "build-plan",
      "harness": "claude",
      "repo": "…",
      "branch": "am/<runId>/<lane>",
      "scope": "BUILD_PLAN.md",
      "readOnly": "",
      "dependsOn": [],
      "waitingFor": [],
      "state": "queued|dependency-waiting|running|blocked|done|failed|cancelled",
      "pid": 123,
      "startedAt": "ISO",
      "elapsedSec": 42,
      "lastActivity": "…",
      "exitCode": null,
      "worktree": "…/runs/…/wt",
      "logPath": "…/runs/…/stdout.log",
      "needsInput": null
    }
  ],
  "integrate": {
    "state": "ready|blocked|failed|running|skipped",
    "branch": "am/<runId>/integrate",
    "worktree": "…/runs/…/integrate/wt",
    "merged": ["lane-a", "lane-b"],
    "changedFileOverlaps": [],
    "verification": { "state": "passed|failed|not-configured", "commands": [] },
    "shipGateHint": "…"
  },
  "delivery": {
    "schema": "agent-manager.delivery.v1",
    "mode": "single|train|review-only",
    "state": "workers_running|review_pending|correction_pending|ship_gate_pending|shipping|targets_pending|release_pending|reviewed|merged|released|rejected|blocked|failed|cancelled",
    "review": {
      "state": "not_started|awaiting_operator|accepted|correction_required|rejected",
      "latestPass": 1,
      "verdict": "accept|accept-with-notes|revise|relaunch|reject"
    },
    "targets": [
      {
        "id": "api-pr",
        "laneId": "api",
        "state": "pending|changes_ready|no_changes|shipping|merged|blocked|failed",
        "branch": "am/<runId>/api",
        "prUrl": "https://example.invalid/pull/1",
        "mergeSha": "…"
      }
    ],
    "release": { "state": "pending|released", "verifiedMergeShas": [] }
  },
  "ship": {
    "state": "queued|running|blocked|done|failed|cancelled",
    "phase": "preflight|commit|push|pr|merge|release|release-push|ci|tag|done",
    "approve": "through-pr|all",
    "prUrl": "https://example.invalid/pull/1",
    "mergeSha": "…",
    "releaseSha": "…",
    "tag": "v1.2.0"
  }
}
```

`integrate` is omitted when the workflow did not set `integrate: true`.
`ship` is omitted until an approved detached shipping phase starts.
`delivery` remains authoritative after workers stop. A completed `ship` target
does not make the overall run terminal while another target or the release is
pending.

## Coordination lifecycle

- `run --detach --json` returns one launch object and exits immediately.
- Agent Feed publishing is HTTP-based and fail-soft. Lifecycle event bodies include
  `runId`, repo, lane/session identifiers, state, and terminal details.
- Each adapter implements `start`, `resume`, `cancel`,
  `parseSessionId`, and `parseNeedsInput`.
- `reply` clears the prior escalation, resumes the stored session, and runs
  guardrails again before the lane becomes `done`.
- Completed lanes release advisory claims, but their worktrees remain until
  overall delivery is terminal or the run is explicitly cancelled/rejected.
- Claim leases renew while the supervisor runs. Expired local claims are
  recoverable only after the recorded supervisor process is confirmed inactive.
- `cleanup` preserves top-level telemetry and refuses incomplete delivery runs.
- `integrate <runId>` invokes the same integration path used by `integrate: true`.

## Inheritance

Workers run with cwd = lane worktree under the **target repo**. They load that
repo’s `CLAUDE.md` / skills / MCP like a normal in-repo session. Do not pass
`--bare`. Because lanes are Git worktrees, tracked repository instructions are
present automatically. Gitignored or otherwise untracked local instruction files
are not copied into new worktrees; include required guidance in the shared
planning context or make it available through the target repo's normal tooling.

## Harnesses

| Name | Status | Notes |
|---|---|---|
| `claude` | supported | `claude -p --output-format stream-json` |
| `codex` | supported | `codex exec --json` / `codex exec resume <id>` |
| `cursor` | not implemented | stub only |
| `fake` | test-only | gated by `AGENT_MANAGER_TEST_MODE=1` in the launching process |

Codex session ids come from `thread.started.thread_id`. Needs-input still uses
lane `needs-input.json` (same contract as Claude).

## Out of scope (current)

- Cursor Agent CLI/SDK harness adapter
- Cross-repo lanes in one workflow (one `repo:` per run today)
- Canvas auto-refresh / `/loop`
- Always-on daemon / HTTP status API (detach supervisor ≠ always-on daemon)
- Attaching to existing interactive TUI sessions
