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
# live lane board; exits on done/failed/cancelled
```

`watch-signal` baselines `status.json`, then emits wakes for Cursor
`notify_on_output` (`^AGENT_MANAGER_WAKE_`). Heartbeat default is **180s**;
pass `--heartbeat-sec <n>` to adjust (operator preference). State-change /
needs-input / terminal wakes do not wait for that interval. `monitor` is the
side-terminal cooking view (`status --watch` aliases it).

## Workflow YAML (minimal)

```yaml
repo: <folder-under-DEV_ROOT>
harness_default: claude
claim_mode: required
max_concurrency: 3        # 1..5; extra lanes remain queued
target_dev_flow: simple   # optional override; else Version.md; else simple
integrate: true           # optional — fold lanes into am/<runId>/integrate when done
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
  context_file: agent-manager.context.md
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
    depends_on: []        # optional lane ids that must finish first
    scope: "path/or/glob/**"
    prompt: |
      …task…
```

Max **5** lanes per run. Active concurrency defaults to three and is bounded by
`max_concurrency`. Remaining lanes report `queued`; lanes waiting on unfinished
prerequisites report `dependency-waiting`.

`planning` is a launch attestation owned by the invoking manager. `validate`
and `run` require every attestation and require `reviewed_base_sha` to equal the
commit resolved by `base_ref`. The context file must be a non-empty relative
path inside the target repo. At launch it is copied to the private run directory,
hashed, and injected identically into every lane prompt. Resume and integration
use the frozen copy, not a later edit to the source file.

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

## CLI notes (Windows)

- Prompt is delivered on **stdin** (multiline argv is unreliable).
- Binary resolved to `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`
  when present (`CLAUDE_BIN` override supported).
- Empty-prompt failure is detected and marked failed (exit 2).

## status.json shape

```json
{
  "runId": "run-YYYYMMDD-HHMMSS-random",
  "state": "running|shipping|blocked|done|failed|cancelled",
  "repo": "my-repo",
  "workflow": "/abs/path/workflow.yaml",
  "target_dev_flow": "simple",
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

## Coordination lifecycle

- `run --detach --json` returns one launch object and exits immediately.
- Agent Feed publishing is HTTP-based and fail-soft. Lifecycle event bodies include
  `runId`, repo, lane/session identifiers, state, and terminal details.
- Each adapter implements `start`, `resume`, `cancel`,
  `parseSessionId`, and `parseNeedsInput`.
- `reply` clears the prior escalation, resumes the stored session, and runs
  guardrails again before the lane becomes `done`.
- Terminal lanes release advisory claims. Blocked lanes record retained claims.
- Claim leases renew while the supervisor runs. Expired local claims are
  recoverable only after the recorded supervisor process is confirmed inactive.
- `cleanup` preserves top-level telemetry while removing abandoned worktrees/logs.
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
