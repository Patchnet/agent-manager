# Operator guide

agent-manager lets one host conversation supervise several isolated Claude Code or Codex CLI lanes. The host launches a detached supervisor, reads status from disk, escalates blocking questions, verifies delivery, and keeps shipping under explicit operator control.

## Component boundary

- **🎛️ Agent Manager** is the orchestration core. It plans and supervises lane
  work, integration, telemetry, and Delivery Review.
- **📦 PR Manager** is the deterministic `agent-manager ship` function. It is
  not another autonomous agent and cannot grant its own approval.
- **🚦 Ship Gate** is the standalone human approval skill. A single developer
  can use it without Agent Manager; an Agent Manager run reaches it only after
  Delivery Review.

The controlled path is Agent Manager → Delivery Review → Ship Gate → PR
Manager. See the README's [standalone instructions](../README.md#use-each-component-standalone)
for the smallest supported setup for each use case.

## First run

```bash
npm ci
npm link
agent-manager doctor
agent-manager init --repo /path/to/repo --request "Describe the change"
# Complete workflow.planning and agent-manager.context.md after reviewing the
# work source, repository instructions, relevant code, and lane scopes.
agent-manager validate /path/to/repo/agent-manager.yaml
agent-manager run /path/to/repo/agent-manager.yaml --detach --json
```

Worker harnesses must be installed, authenticated, and visible in the same OS
environment that launches Agent Manager. Run `agent-manager doctor --json` from
that environment before the first run. If it reports a missing harness, follow
the structured recommendation and restart the launching app after PATH or
environment changes. See [Worker harness setup](HARNESS-SETUP.md), including
Windows npm-shim guidance.

Always inspect generated lane scopes before launch.

`init` creates one Claude implementation lane unless `--harnesses` explicitly
names more than one harness. Keep one coherent task with one agent. Use multiple
lanes only for real scope separation or useful dependency ordering. For ordinary
single-agent work, a direct agent followed by Ship Gate is usually sufficient.

The invoking manager owns source check-in and close-out. Agent Manager remains
source-neutral and does not require workers to query a ticket, planning, or
session system. `init` creates a draft planning block with false attestations.
Before validation, record the authoritative source and plan references, the
reviewed repository paths and instruction files, and the full reviewed base SHA.
Set the attestations true only after completing those checks.
The workflow schema accepts this draft structure; `validate` and `run` enforce
launch readiness and require all four attestations to be true.

`doctor`, detached launch output, and `status.json` expose an automatically
detected runtime profile. The profile records the actual host platform, OS,
architecture, shell, shellless command mode, and path style. Every lane prompt
receives this block before its assignment. Do not use a manual OS selector to
override the host; a planning target must not disguise the machine that will
execute commands.

Validation and launch fail closed when planning is missing or incomplete, or
when `reviewed_base_sha` differs from the commit resolved by `base_ref`. The
shared context file must be a relative, non-empty file inside the target repo.
Launch copies it to the private run directory, records its SHA-256 digest, and
injects the same frozen contents into every worker prompt. Resume and integration
continue to use that frozen copy.

Workflows may define up to five lanes. `max_concurrency` defaults to three and
controls how many workers are active at once; other lanes remain visibly
queued. Workflow validation rejects overlapping write scopes before launch.
Use one writable owner per path.

Validation reports lane count, configured concurrency, effective parallelism,
and whether the dependency graph is fully serialized. A serialized multi-lane
workflow remains valid, but the CLI recommends one queued agent.

Lane guardrails reject CRLF in changed portable Unix scripts (`.sh`, related
shell extensions, or any file beginning with `#!`). Ordinary text, Markdown,
PowerShell, and batch files may retain CRLF. Integration repeats the portable
script check before Delivery Review and records every offending relative path;
Agent Manager does not rewrite the files.

## Detach is mandatory from a host chat

```bash
agent-manager run <workflow.yaml> --detach --json
```

Classify new work as `operational` (default), `benchmark`, `demo`, `retry`, or
`recovery`. Retry and recovery require `--parent-run <runId>` for a local run in
the same canonical repository. They do not mutate the parent. Full guidance:
[run classification, lineage, and stale records](RUN-CLASSIFICATION.md).

Give the run a concise `title` and optional `repo_shorthand` in the workflow.
The detach payload returns a canonical `suggestedThreadTitle` in this form:

```text
[AM <short-run-id>] <repo-shorthand> · <subject>
```

When supported, the Manager host may apply that title to the originating task.
The run does not depend on native title support. Pass `--manager-harness` and
`--manager-model` when they cannot be detected by the launch environment.
Select a run in `agent-manager fleet` to view Manager identity and requested or
observed lane models without adding those fields to the compact fleet list.
While shipping, the selected run also shows its current phase, last activity,
step progression, pull request, and GitHub workflow/check status. Meaningful
ship phase and CI/check changes wake the Manager thread; unchanged polling does
not create repeated updates.

The command validates the workflow, planning evidence, repository, base ref,
harness names, and required binaries before reporting detach success. It returns
a `runId`, runtime profile, telemetry path, supervisor log, and status command
in milliseconds.
A foreground run is for a dedicated terminal, not a chat turn.

Master return is independent of the worker lane harness. Codex and Claude Code
launches capture `CODEX_THREAD_ID` or `CLAUDE_CODE_SESSION_ID` as a private
return channel and start a detached watcher. Actionable changes such as worker
completion, blocked input, and terminal delivery resume the originating Master
Dev thread. Cursor Agent CLI supports direct return when a chat ID is supplied
with `--return-host cursor --return-session <chat-id>`. Cursor IDE launches use
signal mode because the IDE does not expose a documented chat ID to terminal
subprocesses; keep the host's `AGENT_MANAGER_WAKE_` notification attached.
Routine lane progress does not create extra turns. Use `--no-master-return` to
disable return handling. Session IDs are stored only in private run telemetry
and are omitted from `status` output.

Worker success enters `delivery_review_pending`. It is deliberately not a
terminal delivery state. Change-producing work reaches `merged` or `released`
only after its
persisted Delivery Review, Ship Gate, and PR Manager evidence are complete.
Never gate another wave on lane state, released claims, or worker completion.
Review-only or approved no-change work terminates at `reviewed` after Delivery
Review acceptance and does not enter Ship Gate.
Use:

```bash
agent-manager delivery-ready <runId> --require merged
agent-manager delivery-ready <runId> --require released
```

The readiness command exits with code 2 until the selected boundary is proven.

## Operator cadence

Every operator board ends with a deterministic transition:

| Transition | Host behavior |
|---|---|
| `AUTO_CONTINUE` | Take the stated next action before ending the turn |
| `WAIT_OPERATOR` | Present the exact reply vocabulary and stop |
| `TERMINAL` | Post final evidence, close the source record, and stop watching |

Use `agent-manager next-action <runId> --json` to resolve the current stage.
Never report only that a stage completed. In particular, worker completion is
`AUTO_CONTINUE`: post Run Outcome, perform Delivery Review, and only then wait
for the operator's verdict. A persisted `revise` or `relaunch` automatically
starts the one correction. An accepted review automatically advances to Ship
Gate presentation.

## Observe without blocking

```bash
agent-manager status <runId> --json
agent-manager monitor <runId>
agent-manager-fleet
agent-manager fleet --active
agent-manager fleet --stream
agent-manager events <runId> --jsonl
agent-manager watch-signal <runId> --heartbeat-sec 180
```

`fleet` is the read-only side-terminal operations board. In an interactive
terminal it has four tabs — **Runs**, **Goals**, **Core**, and **Tokens** —
switched with `1`/`2`/`3`/`4`, `f`/`g`/`c`/`t`, or `Tab`. The Runs tab redraws
lane progress, worker updates, blockers, transitions, and keyboard focus. Goals
shows the local goal tree. Core shows the knowledge-store overview and graph
endpoints (goals ↔ runs ↔ artifacts) without exposing internal storage names.
Tokens shows local harness usage/cost. Use `--view core` (or `goals` / `tokens`)
to start on a tab.
Use `--stream` for an append-only event feed or `--once` for logs and scripts.
It reads telemetry and the brain directly and does not need a mounted service.

The Fleet header always identifies the resolved runs root and whether it came
from a command-line override, process environment, user config, or the built-in
default. Use `agent-manager config show` to inspect all resolved paths and any
ignored ambient overrides. Keys present in `~/.agent-manager/config.env` beat
process environment and CLI path overrides unless
`AGENT_MANAGER_ALLOW_PATH_OVERRIDE=1`. Agents must not invent or export
`AGENT_MANAGER_*_ROOT` values, and must not run `config init --force`. Use
`agent-manager fleet --runs-root <path>` for a one-time read-only alternate view
without changing where `run` writes telemetry.

The Fleet header shows the viewer runtime version. Selected run details show
the Agent Manager engine version captured when that run started. If installed
files change while Fleet is open, it displays an offline `UPDATE INSTALLED`
notice; quit and restart Fleet to load the new viewer. Restarting `fleet` or
`monitor` does not affect active detached supervisors or workers. Active runs
continue on their original engine version. Stop an existing `watch-signal`
process before starting its replacement to avoid duplicate notifications.

## Desktop notifications

`watch-signal` can raise an OS notification alongside the wake sentinel:

```bash
agent-manager watch-signal <runId> --heartbeat-sec 180 --notify
```

```powershell
$env:AGENT_MANAGER_NOTIFY = "1"   # same effect, per shell
```

Opt-in only, and off by default. A toast fires on exactly four events:

| Event | Fires when |
|---|---|
| `needs input` | the run or the ship channel is waiting on an operator reply |
| `blocked` | the run state is `blocked`, or a lane blocked |
| `finished` | the run reached a terminal state |
| `ship outcome` | the ship channel reached `done`, `failed`, or `cancelled` |

Each toast carries the short run id and the event in its title, and the run
title, a one-line state, and the thing to open — the PR URL when there is one,
otherwise the path to that run's `status.json` — in its body. Routine
`state_change` and `heartbeat` wakes stay in the terminal. Repeats of the same
event are suppressed, so a poll loop cannot spam the desktop.

No daemon and no extra dependency: Windows uses a PowerShell toast, macOS uses
`osascript`, and Linux uses `notify-send` when the desktop provides it. If the
platform notifier is missing or refuses to run, the watcher logs one line and
keeps watching — notifications never gate the run.

## Track token usage

```bash
agent-manager tokens
agent-manager tokens --since 24h --by repo
agent-manager tokens --watch
agent-manager tokens --json
agent-manager tokens --list-providers
```

`tokens` is the read-only token telemetry page. It parses harness session logs
already on the machine, aggregates token usage by day, model, repository, and
source, and prices it from the rate table in `src/token-usage.mjs`. Nothing is
uploaded; models missing from the pricing table are counted but flagged as
unpriced instead of guessed. `--since` controls the window (`7d` default,
`all` for everything); `--watch` redraws on an interval for a side terminal.

### Reading the LOGGED USAGE block

The board opens with up to three summary rows, in UTC:

| Row | Means |
|---|---|
| `ALL LOGGED (since <date>)` | every session log read in this pass, back to the earliest record found |
| `TODAY (<date> UTC)` | usage stamped with today's UTC date |
| `LAST 7D (<from> → <to>)` | the rolling seven-day window ending today |

These are **spend already incurred**, not a quota balance: subscription plans
do not expose remaining allowance anywhere on the machine, so nothing here can
tell you how much is left. A rolling row is omitted when `--since` is too
narrow to cover it — `--since 24h` prints `ALL LOGGED` and `TODAY` only,
rather than labelling a day of data as a week.

### Token providers

Each log format is a **provider**: an id, a logs root, and a reader. Three ship
with the CLI.

| Provider | Format | Default root | Root override |
|---|---|---|---|
| `claude` | Claude Code session logs | `~/.claude/projects` | `AGENT_MANAGER_CLAUDE_LOGS_ROOT` · `--claude-root` |
| `codex` | Codex CLI rollouts | `~/.codex/sessions` | `AGENT_MANAGER_CODEX_LOGS_ROOT` · `--codex-root` |
| `jsonl` | Generic JSONL usage events | `~/.agent-manager/token-logs` | `AGENT_MANAGER_TOKEN_LOGS_ROOT` · `--provider-root jsonl=<dir>` |

`jsonl` is opt-in: it stays off the board until its root exists, so an unused
extension point never reads as a broken source. `agent-manager tokens
--list-providers` prints every provider, the root it resolved to, and where
that root came from (flag, env var, or default) — start there when a source
reads `not found`. `--providers claude,codex` limits a run to specific ids.

**Adding a harness.** Any tool that can write JSONL usage events gets a source
without code. Point `AGENT_MANAGER_TOKEN_PROVIDERS` at one or more
`<id>=<directory>` pairs, separated by `;`:

```powershell
$env:AGENT_MANAGER_TOKEN_PROVIDERS = "gemini=C:/logs/gemini;my-agent=C:/logs/my-agent"
```

```bash
export AGENT_MANAGER_TOKEN_PROVIDERS="gemini=$HOME/logs/gemini;my-agent=$HOME/logs/my-agent"
```

A JSON object works too when a label matters:
`{"gemini":{"root":"/logs/gemini","label":"Gemini CLI"}}`. Each declared
provider reports under its own id, so `--by source` separates them.

Every `*.jsonl` file under the root is read (nested folders included), one
usage event per line. A line needs a timestamp and at least one non-zero token
count; anything else is skipped. Both common wire shapes are accepted:

```json
{"timestamp":"2026-08-08T10:00:00Z","model":"gemini-3-pro","cwd":"/repos/app","sessionId":"s-1","usage":{"input_tokens":1200,"output_tokens":300,"cache_read_input_tokens":8000}}
{"created":1786060800,"model":"gpt-5.6","usage":{"prompt_tokens":9000,"completion_tokens":250,"prompt_tokens_details":{"cached_tokens":8000}}}
```

Anthropic-style `input_tokens` is treated as excluding cache reads;
OpenAI-style `prompt_tokens` is treated as including them and the cached
portion is subtracted so both price correctly. `cwd` (or `repo`) drives the
BY REPO table; `sessionId` falls back to the file name.

A format that needs a real parser is a code-level provider — call
`registerTokenProvider({ id, label, read })` from `src/token-usage.mjs` before
building a snapshot. `read({ root, sinceMs, now })` returns normalized records
(`ts`, `source`, `model`, `cwd`, `sessionId`, `input`, `output`, `cacheRead`,
`cacheWrite`). A provider that throws is reported as a warning line on the
board instead of taking the page down.

**Pricing new models.** Unknown models stay unpriced rather than guessed. Add
rates without editing the source by pointing `AGENT_MANAGER_TOKEN_PRICING` at a
JSON file (USD per million tokens):

```json
{ "models": [
  { "family": "gemini-3", "test": "^gemini-3", "inputPerM": 2, "outputPerM": 12, "cacheReadPerM": 0.2 }
] }
```

`test` is optional — without it the family name is matched as a model prefix.
The file is re-read when it changes; a malformed file is ignored and the
affected models simply stay flagged as unpriced.

`status.json` is authoritative. `events.jsonl` and `watch-signal` are notification sources, not alternate state stores. A `blocked` run is resumable and is not terminal.

Inspect the sanitized return state with
`agent-manager status <runId>`. Private return telemetry is stored at
`<run>/master-return.json`; the latest structured handoff is
`<run>/master-handoff.json`. If delivery fails, resume manually with
`agent-manager next-action <runId> --json` and inspect
`<run>/master-return-supervisor.log`. An actionable `AUTO_CONTINUE` stage is
retried on its next heartbeat if a direct return attempt fails. The normal
`watch-signal` remains the portable heartbeat and fallback path for every host.

Every wake payload includes `cadence.stage`, `cadence.transition`,
`cadence.nextAction`, `cadence.operatorInputRequired`, and the canonical
template name. Waiting stages do not emit repetitive heartbeats.

Cursor support for waking an idle chat from arbitrary process output is host-version dependent. Keep the run detached. Use the side-terminal monitor, event consumer, or operating-system notifications when the host cannot re-enter the chat automatically.

For a Codex thread heartbeat, preserve Codex's required heartbeat response
envelope. The scheduled prompt may request the canonical Agent Manager board,
but it must also require the response to end with the host-provided
`<heartbeat>` block and a `NOTIFY` or `DONT_NOTIFY` decision. Do not say “only
the canonical template,” because that conflicts with the Codex heartbeat
protocol. Telemetry wakes the host; delivery state remains enforced on disk.

## Answer a lane

```bash
agent-manager reply <runId> <laneId> --message "approved answer"
```

Reply resumes the recorded Claude or Codex session. It does not create a new independent conversation.

### Grant scope along with the answer

A lane that asks "may I also touch `docs/OPERATOR.md`?" cannot act on a yes: its
scope was fixed at launch, so the file it was told to write is a scope violation
at lane exit. `--extend-scope` grants the scope with the answer:

```bash
agent-manager reply <runId> <laneId> \
  --message "yes, the operator guide is yours for this lane" \
  --extend-scope "docs/OPERATOR.md,schemas/**"
```

The grant is recorded on the lane as an appended `scopeExtensions` entry with
who granted it and when, before the harness resumes. Guardrails then union the
granted globs into the lane's writable patterns, so a Master-granted extension
cannot fail the lane at exit. Grants accumulate: a later reply never drops an
earlier extension.

Attribution comes from `--by <id>`, falling back to the run's recorded planning
verifier. A run with neither is refused rather than credited to nobody. Globs
follow the same rules as `lanes[].scope` — repository-relative, no traversal —
and a bad glob is rejected before anything is recorded, so the lane stays
blocked rather than resuming on a typo.

An extension widens what the lane owns. It never reopens a `read_only` path:
those belong to another lane, and only the workflow can reassign them. Every
extension is listed next to the lane's declared scope in Delivery Review.

## Delivery Review

```bash
agent-manager review <runId>
agent-manager review <runId> --pass 1 --verdict accept-with-notes \
  --reviewer master-dev --notes "CI required on every target"
```

Calling `review` without a verdict records that the review was presented and
transitions cadence to `WAIT_OPERATOR`. This distinguishes “review must be
performed” from “the operator is now deciding.”

The generated Pass 1 document collects lane states, scopes, changed files, violations, exits, and evidence logs. The host must still compare those facts with the original request and rerun relevant tests. At most one correction is allowed, followed by Pass 2. There is no automatic Pass 3.

Only a persisted accepted Delivery Review can proceed to Ship Gate. The ship
command rejects conversational approval that was not recorded in `status.json`.
Workers do not own commits, pushes, pull requests, merges, tags, or releases
unless the workflow explicitly permits a narrower action.

### Reviewing a run that never reached review

A run that died, stalled, or was cancelled never reaches an awaiting-review
state, so `review` refuses it — and its verdict had nowhere to live. Add
`--recovered` to record one anyway:

```bash
agent-manager review <runId> --recovered
agent-manager review <runId> --pass 1 --verdict reject \
  --reviewer master-dev --recovered
```

`--recovered` accepts `blocked`, `failed`, and `cancelled`, and nothing else.
The decision and the review summary are both stamped `recovered: true` with the
state they were recorded from, and the review document says so, so a recovered
verdict is never read later as an ordinary one.

It relaxes only the state gate. Structural preflight still gates `accept` and
`accept-with-notes`, so a run with unaccounted failed lanes or an empty delivery
target cannot be accepted just because the flag was passed. Without the flag,
behaviour is unchanged.

## Accept without shipping: closeout and `filed`

Not every accepted run ships. Research, audits, and investigations produce
reports that are the deliverable. Those runs end in `filed`:

```bash
agent-manager closeout <runId> --operator master-dev \
  --reason "research accepted; nothing to ship"
```

`closeout` requires a persisted accepted Delivery Review and a run sitting at
Ship Gate. It files the run's outputs (below), records who filed the run and
why, then ends the run in the terminal state `filed`. Delivery targets keep
their `changes_ready` evidence so the report shows exactly what was accepted
and deliberately not shipped.

**Never use `cancel` to close accepted work.** Cancellation means the work was
abandoned; filing means it was delivered without a merge. The two read very
differently on a run board and in the goal graph.

A run whose workflow declares `delivery.mode: review-only` still ends in
`reviewed` after acceptance. That remains the right choice when a workflow is
research-only by design — including when its lanes write report files.
`review-only` does not require read-only lanes. Use `closeout` for the runs
that were *not* declared review-only but turn out not to need shipping.

Filing is refused when a delivery target has already merged. A half-shipped
train must be finished or released, not filed.

### File run outputs as durable artifacts

```bash
agent-manager file-artifacts <runId>
```

Closeout runs this automatically; the standalone command is for runs in any
other state, and for re-filing after new evidence lands. It copies the run
report, run telemetry, every recorded Delivery Review, and each lane's declared
`expected_outputs` into a private bundle under the brain root
(`<brain>/.artifacts/<runId>/`) with a `manifest.json` carrying a SHA-256 for
every file. This survives `agent-manager cleanup`, which removes the run
directory.

It then records one `artifact_link` per declared `goal_refs` entry, pointing at
`run-artifact:<runId>` with relationship `delivers`. Re-filing updates the
existing link instead of creating a duplicate, so the command is safe to repeat.

A run with no `goal_refs` still gets a bundle and a manifest; there is simply
nothing to link it to. Goal-link failures are reported and do not undo the
filing or the terminal state — the evidence is on disk either way.

### Goal advancement is a hint, never automatic

Runs update themselves; goals do not. When a run reaches any terminal state,
`report.md` and `next-action` list the declared `goal_refs` that the frozen
goal snapshot still shows as open:

```bash
agent-manager next-action <runId>
# goals awaiting advancement: goal-am-research-closeout (active)
```

Agent Manager never advances a goal. Master reads the hint and decides:

```bash
agent-manager goal update goal-am-research-closeout --lifecycle delivered
```

Lifecycles come from the snapshot frozen at launch, so treat them as a prompt to
check the goal, not as proof of its current state.

## Integration

```bash
agent-manager integrate <runId>
```

Integration snapshots successful lane worktrees and merges them into
`am/<runId>/integrate` from the immutable base SHA recorded at launch. Before
merging, it blocks any file changed by multiple unordered lanes even when Git
could merge that file cleanly. A `depends_on` chain explicitly approves
sequential edits to the same file; the overlap is recorded as a Delivery Review
risk. Configured `verification.setup.commands` run first in the integration
worktree, followed by `verification.commands`. Both command lists execute
without a shell and use the verification environment allowlist. Agent Manager
does not infer a package manager or install command from repository files.

```yaml
verification:
  setup:
    timeout_sec: 900
    commands:
      - { command: npm, args: [ci] }
  timeout_sec: 900
  commands:
    - { command: npm, args: [test] }
    - { command: npm, args: [run, hygiene] }
```

Setup has its own state, timing, command evidence, and timeout under
`integrate.verification.setup`. The complete result is also persisted in
`integrate/verification.json`. A setup failure says `verification setup failed`,
preserves the commands that ran, and blocks before verification tests start.
Retry reruns failed setup. After setup passes, a retry at the same integration
revision reuses its evidence; a revision or command-plan change runs setup
again. Workflows without `verification.setup` retain the existing verification
behavior and telemetry shape. A merge conflict or failed verification becomes
a resumable escalation. Integration does not push or merge to the target
repository default branch.

### Folding a lane that a guardrail stopped

`integrate --force-lanes done,failed-with-snapshot` folds lanes that *died* with
a committed end-of-lane snapshot. It deliberately drops lanes that a guardrail
*stopped*: the snapshot of a scope violation is still a scope violation.

When Master audits such a lane and concludes the work was wanted, record that
decision instead of folding by hand:

```bash
agent-manager ratify <runId> <laneId> \
  --reason "audited 2026-08-17: the file belongs to this lane"
agent-manager integrate <runId> --force-lanes done,failed-with-snapshot
```

`ratify` snapshots the lane's violation lists as they stand and records who
accepted them and why (`--by <id>`, falling back to the run's planning
verifier). It refuses a lane with no guardrail violations — there is nothing to
ratify — and a lane with no committed snapshot, because there would be nothing
to fold.

A ratification reaches exactly as far as the violations it was shown. If the
lane strays again after being ratified — a resumed lane writing somewhere new —
the fold is refused and names the uncovered violations, until Master looks at
the new evidence and ratifies again. Ratification never relabels the lane as
`done`: the violations stay on the record, and Delivery Review renders them
under **Ratified violations** with the reason and the ratifier, alongside the
lane's ordinary violation lines. `status.integrate.ratifiedLanes` lists which
lanes were folded this way.

`--force-lanes` takes an exact comma-separated selector list. A value that
merely contains a known selector is a typo, and is rejected.

If `integrate: false` is used for more than one writable lane, the workflow
must declare a `delivery.targets` train that maps every lane to an explicit
destination. Branch and existing PR coordinates are optional; omitted branches
use the generated lane branch. Validation fails when any writable lane is
unmapped. Simple Flow requires `integrate: true` for multi-lane writable work.

## Dependencies and ownership

Use `depends_on` when a lane needs completed prerequisite output. Independent
lanes still run in parallel. A dependent worktree receives snapshot commits
from successful prerequisites before its worker starts. If a prerequisite asks
for input, dependent lanes remain in `dependency-waiting` and start after the
exact prerequisite session resumes successfully.

Dependency ordering may also sequence two writable lanes over the same scope.
This is the supported multi-writer case: the dependent starts from the
prerequisite snapshot, and the resulting same-file overlap remains visible in
Delivery Review.

Scope exceptions remain single-writer:

```yaml
scope_overrides:
  - path: src/ui/**
    lanes: [platform, ui]
    owner: ui
    reason: The platform lane reads the UI contract; the UI lane owns edits.
```

The non-owner receives a read-only guardrail for the override path. A
multi-writer exception is not supported.

## PR Manager after Ship Gate

PR Manager starts only after a persisted accepted Delivery Review and an
explicit Ship Gate approval. It uses the same run ID and `status.json`.

Formal Flow through the pull request:

For a delivery train, pass the next target ID. Omit `--target` for a single
integrate branch.

```bash
agent-manager ship <runId> \
  --approve through-pr \
  --target <delivery-target-id> \
  --commit-message "feat: approved change" \
  --detach --json
```

Formal preflight inspects the GitHub repository, shipping identity and
permission, base protection, required checks and review count, auto-merge, and
squash-merge support before it commits or pushes. The frozen capability set is
checked again by the detached supervisor; permission, identity, or policy drift
fails closed. GitHub check registration has a 90-second grace period by
default; override it with `--check-grace-sec <seconds>` when needed.

Formal or Simple Flow through version and tag:

```bash
agent-manager ship <runId> \
  --approve all \
  --commit-message "feat: approved change" \
  --version 1.2.0 \
  --summary "Add the approved capability." \
  --detach --json
```

For a Formal delivery train, use `through-pr` on earlier targets and `all` only
on the final target. An open final delivery PR receives the deterministic stamp
before its required checks and squash merge, so one feature release normally
uses one PR. The stamp commit is bound to the approved version, exact file/blob
manifest, and pre-stamp head. The pushed head is rechecked before auto-merge.
Prior delivery merges must be present in the base.

If the final delivery PR is already merged, Formal Flow creates or reuses one
run-owned release branch and PR from a private worktree. It verifies every
recorded target merge in the base, waits for required checks, squash-merges the
release PR, and tags that merge without another approval round. Retries reuse
the same stamp commit and PR. Local changes in the operator's shared checkout
do not block or participate in this fallback. Formal Flow never pushes a
release stamp directly to the base. Simple Flow is unchanged: it pushes the
reviewed single/integrated worktree commit directly to its base and then tags.

The detached supervisor commits only approved work, pushes a non-base branch,
finds or creates the pull request, enables `gh pr merge --auto --squash`, and
watches required checks until merge. For `all`, it updates the existing version
stamp set, runs `check:version` when provided, verifies the immutable stamp at
the merge SHA, snapshots existing Actions runs for that SHA, and then publishes
the matching tag. It discovers every newly registered run for the release SHA
and waits for all of them to succeed. If none registers within the bounded
grace period, status records downstream release CI as not configured.

Optional overrides are `--repo`, `--worktree`, `--branch`, `--base`,
`--remote`, and `--pr`. Use them only when the run metadata is incomplete and
the operator has confirmed the target.

After launch:

```bash
agent-manager watch-signal <runId> --heartbeat-sec 180
```

Read `status.json.ship` on every wake. Report with
[`skills/pr-manager/reporting.md`](../skills/pr-manager/reporting.md). A
blocked ship phase is resumable by correcting the external condition and
rerunning the same detached command. Cancel with the normal `cancel` command.
The ship phase never bypasses failed checks and does not directly create a
GitHub Release. A repository workflow triggered by its approved tag may create
one.

## Cancellation and retention

```bash
agent-manager cancel <runId>
agent-manager cleanup <runId>
agent-manager cleanup --stale --older-than-days 30
agent-manager cleanup --stale --dry-run
agent-manager cleanup --stale --dry-run --json
```

Cancellation writes an authoritative marker. The live supervisor then
terminates lane process trees it owns. The detached ship supervisor stops
between bounded Git or GitHub commands and polling cycles. The cancel command
does not kill an unverified stale PID. Cleanup refuses every incomplete
delivery state. Stale cleanup removes only overall-terminal runs.

Use stale dry-run first. It is a read-only preview that separates terminal
cleanup candidates from old nonterminal runs requiring inspection or explicit
cancellation. It does not release claims, remove worktrees, cancel runs,
rewrite status, or update timestamps.

Cancel means abandoned. To close accepted work that will not ship, use
`agent-manager closeout` instead; `filed` is a delivered outcome. File the run's
artifacts before cleanup — cleanup removes the run directory, the brain bundle
survives it.

## Claims

Every new run first performs MAADB brain admission. This happens before the
advisory claim registry and before any target-repository worktree is created.
An unexpired active run with an overlapping scope blocks admission. Active
non-overlapping runs are included as related work, while overlapping runs in
Delivery Review, Ship Gate, shipping, or release-pending states are included as
delivery dependencies and do not hold an edit lease.

```bash
agent-manager brain init
agent-manager brain status --repo /path/to/repo
```

## Goals and evidence maps

Goals are local, durable MAADB records. They remain usable without Git, a
network service, or an external tracker. The command surface supports creation,
updates, hierarchy, artifact links, deterministic status, and an offline map:

```bash
agent-manager goal create --id goal-release --title "Deliver the release"
agent-manager goal update goal-release --lifecycle active
agent-manager goal link goal-release --type release --ref release:next --relationship delivers --state pending_delivery
agent-manager goals --roots
agent-manager goal show goal-release
agent-manager goal status goal-release --json
agent-manager goal map goal-release --output ./goal-release.html --json
```

`goal status` derives effective state from stored lifecycle, descendant goals,
linked artifact states, and attached run intents. Blocked evidence takes
precedence. Superseded branches are excluded. The only ratio is explicitly
labeled `completed-leaf ratio` and includes its numerator and denominator.

`goal map` exports one self-contained HTML file. It shows the selected goal and
nested goals, blockers, active and pending-delivery runs, linked artifacts, and
delivered evidence. It has no runtime network dependency and does not turn
opaque stored references into links. The command prints the resolved path; in
JSON mode it returns `agent-manager.goal-map-export.v1`.

Workflows may include `goal_refs` as local goal IDs. Admission fails before a
run is created when a referenced goal is missing. Existing workflows without
`goal_refs` remain valid.

The packaged brain defaults to `~/.agent-manager/brain` and explicitly uses
MAADB `feed` history, so it writes durable Markdown and an index without
initializing or mutating Git. Edit leases renew with the supervisor heartbeat;
an expired editing intent is marked abandoned during the next atomic admission.
For cross-machine coordination, configure the same durable brain root on every
host. Local telemetry roots may remain separate.

Workflow claim modes:

- `auto`: use the configured registry; registry failure is advisory.
- `off`: do not claim. Useful for a single local operator.
- `required`: fail if the claim cannot be recorded.

The bundled registry defaults to `~/.agent-manager/claims`. Claims are leased
and renewed by the supervisor. An expired claim is recovered automatically only
when its recorded local supervisor process is confirmed inactive; unverifiable
remote or legacy claims remain blocking until explicit release. Set
`AGENT_MANAGER_CLAIM_BIN` to use another implementation.

## Director proposal cycle

Director is the policy-bound **proposal** layer above Agent Manager. It validates
a standing policy, triages local source fixtures, and writes validated workflow
YAML drafts. Master Dev kicks those drafts off with `run --detach`. Director
does **not** auto-launch workers, run a planner LLM, or ship anything.

```bash
agent-manager director validate --policy ./director-policy.yaml
agent-manager director cycle --policy ./director-policy.yaml \
  --items ./director-items.yaml --dry-run --json
# then, for each draft kickoff line:
agent-manager run "<cycle>/workflows/<draft>.yaml" --detach
```

Keep the policy outside the target repository when it describes private
operating details. The Director identity (`harness`, `model`, `reasoning`) is
configured separately from worker identities (`workers.harness_default`,
default `claude`).

Enable it deliberately:

1. Write a `pr-only` policy — see [DIRECTOR.md](./DIRECTOR.md). Keep
   `security` in `forbidden_risks` for boring app work; add
   `risk_exceptions` for CodeQL-class waves (labels + narrow paths).
2. Run `director validate` and confirm repository, mode, and Director identity.
3. Run a `--dry-run` cycle. Read `selected` / `quarantined` / `skipped`, then
   the `kickoff:` lines for each draft.

Boundaries that fail closed rather than warn:

| Attempt | Result |
|---|---|
| `mode` other than `pr-only` | policy rejected |
| `merge`, `tag`, `release`, or unknown action | policy rejected |
| Scope or repository outside the policy | item quarantined |
| Forbidden risk without matching exception | item quarantined |
| Non-`fixture` source provider | `connector-not-implemented:…` |
| A cycle without `--dry-run` | command fails |
| A second cycle on the same repository | repository lease refuses |

Cycle state defaults to `$AGENT_MANAGER_RUNS_ROOT/director` (includes
`workflows/`). Override with `--state-dir`. Replaying the same policy and
fixtures returns the persisted cycle (and draft paths) safely.

Director does not create or approve a Ship Gate reply. Delivery Review and Ship
Gate remain operator-driven for every run launched from a draft.

## Dangerous permissions

Detached Claude lanes should not use `acceptEdits` when their contract requires
unattended shell commands. Set `lanes[].permission_mode: auto` for
classifier-guarded general work, or use `dontAsk` with a narrow
`lanes[].allowed_tools` list for deterministic commands. Lane-level settings
override the workflow default without changing Codex lanes in the same fleet.

Agent Manager rejects unrestricted `Bash` and `PowerShell` grants, requires an
allowlist for `dontAsk`, and verifies CLI support before launch. Claude Code
still owns account, model, provider, and administrative-policy eligibility.
Use `lanes[].setup.commands` for deterministic worktree preparation such as
`npm ci`; setup runs before the model and fails closed with captured evidence.

### Default allowlist from integration verification

Claude prompts before every shell command under `acceptEdits` and
`workspace-write`, and a detached worker has nobody to answer — so a lane whose
own prompt says "run `npm test`" was denied `npm` by default and stalled.

A writable Claude lane that declares no `allowed_tools` inherits one derived
from the workflow's own `verification.setup.commands` and
`verification.commands`: one `Bash(<prefix>*)` rule per declared command, where
the prefix is the executable plus its leading sub-command arguments.

```yaml
verification:
  setup:
    commands:
      - { command: npm, args: [ci] }          # -> Bash(npm ci*)
  commands:
    - { command: npm, args: [test] }          # -> Bash(npm test*)
    - { command: npm, args: [run, hygiene] }  # -> Bash(npm run hygiene*)
```

The rule is derived from what the workflow already declares, never guessed. The
prefix stops at the first flag, at anything that would need quoting, and after
two sub-command arguments, so a command with no leading sub-command grants only
its own name. Each lane's effective source is recorded in `status.json` as
`allowedToolsSource` (`declared`, `verification`, or `none`).

What this does not change:

- An explicit `lanes[].allowed_tools` always wins, untouched.
- `dontAsk` still requires its own complete allowlist and still fails to load
  without one — a derived list would silently under-grant a mode that permits
  nothing else.
- Read-only lanes get nothing.
- Codex and Cursor lanes are untouched. Codex governs execution through its
  sandbox mode, which has no per-command allowlist to synthesize into, so the
  same workflow grants a Claude lane a shell rule and a Codex lane nothing. That
  asymmetry is in the harnesses, not in the policy.
- A workflow with neither `verification.setup.commands` nor
  `verification.commands` grants nothing.

This is an allowlist default, not an execution mechanism. Worktree preparation
that must happen before a lane model runs belongs in `lanes[].setup.commands`.
Dependency preparation needed only in the final integration worktree belongs in
`verification.setup.commands`.

Dangerous permission bypass is disabled by default. Enabling it requires both:

1. `policy.dangerously_skip_permissions: true` in the workflow.
2. `--allow-dangerous-permissions` on that launch, or `AGENT_MANAGER_ALLOW_DANGEROUS_PERMISSIONS=1` in the invoking environment.

Do not make either setting a persistent default.

## Sensitive run data

The runs directory can contain prompts, replies, model output, file paths, session identifiers, and worktrees. agent-manager creates run and claim files with private permissions where supported and filters the environment passed to workers. Add extra variable names only through `env_allowlist` or `AGENT_MANAGER_ENV_ALLOWLIST` when a harness genuinely needs them.

Keep run data outside public or synchronized folders. Use retention cleanup. Never commit it.

## Cursor installation

```bash
agent-manager install cursor
agent-manager install cursor --project /path/to/repo
```

The first command installs the canonical agent-manager and PR Manager user
skills. Project mode also installs a concise `.cursor/rules` fallback.
Reporting templates remain canonical in the skills; the rule points to the
CLI flow instead of duplicating them.

Ship Gate is installed or referenced separately because it is repository-owned
approval policy, not part of the orchestration runtime.

## Reconcile stale external delivery

If GitHub completed an approved delivery while the local supervisor was
interrupted, verify the provider evidence and repair the delivery ledger with:

```bash
agent-manager reconcile <runId> --provider github
```

Reconciliation fails closed unless the recorded pull request is merged, at
least one CI check is present and successful, and any release tag contains the
verified merge. An empty GitHub check rollup is never accepted as successful CI.

## Public repository hygiene

Run these checks before proposing a public change:

```bash
npm test
npm run hygiene
npm pack --dry-run
```

See [PUBLIC-REPO-HYGIENE.md](PUBLIC-REPO-HYGIENE.md), [SECURITY.md](../SECURITY.md), and [CONTRIBUTING.md](../CONTRIBUTING.md).
