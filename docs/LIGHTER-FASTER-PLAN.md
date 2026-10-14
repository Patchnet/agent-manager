# Lighter, faster delivery — plan

Status: **proposal, awaiting operator go**. Nothing below is implemented yet.
Several items reverse rules the operator wrote; they are listed under
*Rules this overrides* and need an explicit override before the rewrite.

## Goal

Push code through as fast as is safe. Trust current models and harnesses. Keep
safety in **deterministic** places: path-based risk tiers, a required PR check,
CI on every `main` commit, and automatic revert of a red `main`. Remove process
built when harnesses were less reliable. Measure success as a smaller footprint
and fewer operator touches per PR.

Sources: Anthropic, *Redesigning source control* (Oct 2026): no global merge
lock, post-merge testing with automatic revert, semantic approvals by path,
humans review intent, AI review steered away from over-engineering, agents
resolve conflicts, one watcher agent per component, few refs. Harness
capabilities were checked against current docs on 2026-10-13 (see
[HARNESS-NATIVE.md](./HARNESS-NATIVE.md), added by this change).

## Where the time goes today

Measured on the main consumer repo (Formal Flow, ~15 merges/day):

| Cost | Cause | Fix in this plan |
|---|---|---|
| CI re-runs (one PR ran 4×) | strict up-to-date: every merge forces other ready PRs to update and re-run 22 min of CI | drop strict up-to-date; required PR check + post-merge CI + auto-revert |
| Operator wait on every step | typed Ship Gate reply for each PR, Delivery Review pass, release | path tiers: tier 0/1 auto-merge with a notice; only tier 2 asks |
| ~⅓ of Master Dev time | update-branch, patch-id check, re-arming auto-merge, relaying ACCEPT/CHANGES between threads | no update-branch churn; author thread spawns its own reviewer; auto-merge armed once |
| 22 min CI | serial Docker step (typecheck, tests, lint, build, Chromium) | separate CI-speed lane (not duplicated here) + test tiering below |

## The new delivery model

### 1. Risk tiers by file path (deterministic)

Each repo has `.github/ship-tiers.yml`:

```yaml
# Highest matching tier wins. Unmatched files are `default`.
default: 1
tier2:            # operator Ship Gate
  - "src/db/migrations/**"
  - "src/**/billing/**"
  - "src/**/auth/**"
  - ".github/**"
tier0:            # CI + automatic reviewer, then merge
  - "docs/**"
  - "**/*.md"
  - "tests/**"
```

A PR's tier is the **maximum** tier over every changed path (both sides of a
rename). No judgment, no model call. Agent Manager ships a zero-dependency
classifier (`agent-manager tier`, also usable as a standalone script in CI).

| Tier | Paths (example) | Gate | Operator |
|---|---|---|---|
| 0 | docs, tests, canary, copy | required CI + automatic reviewer | nothing (log line) |
| 1 | product, UI (default) | required CI + independent reviewer, then auto-merge | one-line **notice** |
| 2 | billing/payments, DB migrations, auth/permissions, tenant ops data, `.github`/infra | required CI + independent reviewer + operator Ship Gate | one reply (or one label tap) |

Optional hard enforcement (Ops decision): a `tier-gate` CI job fails a tier-2
PR that lacks a `ship:approved` label. That turns the rule into a GitHub check
instead of a convention, with no CODEOWNERS dependency (a solo operator cannot
approve PRs opened under their own account).

### 2. Review: independent, lighter, in the author's thread

- The author thread spawns a **fresh-context reviewer** (harness subagent, or
  `/code-review`) with the bundled reviewer prompt. Master Dev integrates only;
  it no longer relays ACCEPT/CHANGES between threads.
- The reviewer **blocks only** on: correctness, safety, data loss/integrity,
  authz, or drift from the brief. Everything else is a non-blocking note. It is
  told not to ask for extra validation, abstraction or tests that do not change
  risk.
- Tier 2 additionally gets the operator's intent check (not a line review).
- Delivery Review for multi-lane runs collapses to one recorded verdict
  (`accept | revise | reject`); no multi-pass boards, review budgets or
  conditional grants.

### 3. Merging without the up-to-date treadmill

- Required: PR + required check (`quality` or an aggregate) + auto-merge
  (`gh pr merge --auto --squash`, armed once by whoever opens the PR when tier
  ≤ 1 and the reviewer accepted).
- **Drop "require branches to be up to date".** No merge queue (GitHub merge
  queue on private repos appears to need Enterprise Cloud — unverified — and is
  unnecessary with the next item).
- CI runs on **every** `main` commit (no cancel-in-progress on `main`).
- **Auto-revert on red `main`:** a small workflow re-runs the failed job once
  (flake guard); if still red and the parent commit was green, it opens a
  revert PR for that squash commit, labelled tier 0, with auto-merge. Every
  `main` commit has its own CI result, so the culprit is the first red commit
  after a green one — no bisect needed. Template shipped in
  `templates/github/revert-on-red.yml`; Ops installs it.
- Real merge conflicts go back to the **author thread**, which merges `main`,
  resolves, re-runs affected tests and pushes. They never go to the operator.
- PRs older than ~3 days: rebased by their author or closed (scheduled check).

### 4. Releases on a schedule

Releases move out of the per-PR path. A scheduled task (twice a day, only when
`main` moved and `main` CI is green) runs the repo's own release script
(`release:formal`: stamp → push → wait CI → tag). Versions come from
conventional commits since the last tag. Ops still rolls production from tags.
Agent Manager stops stamping and tagging.

### 5. Standing watchers (harness-native, no code here)

Scheduled harness tasks, one per concern, each with a short prompt: `main`/CI
health (backs up auto-revert), production health and billing ledger (Ops
owns these two), stale PRs. Documented in HARNESS-NATIVE.md as recipes.

### 6. Event stream (one log of every delivery transition)

Every deterministic run or ship transition appends **one JSON line** to
`<runsRoot>/events.jsonl` and to the run's own `events.jsonl`. This replaces
today's per-run status snapshots, which are bulky.

- **Kinds:** `lane_started`, `lane_done`, `review_verdict`
  (accept/revise/reject plus the reviewer's identity), `pr_opened` (number,
  url, tier), `automerge_armed`, `merged` (sha), `reverted`, `waiting_operator`
  (the exact question), `operator_reply` (the verbatim text and the decision it
  unblocked), `blocked`, `cancelled`, `run_closed`.
- **Shape (stable, versioned):**
  `{v:1, ts, kind, repo, runId?, lane?, pr?, sha?, tier?, verdict?, text?, actor}`,
  documented in `docs/EVENTS.md`. New fields are additive; anything that
  changes or removes a field bumps `v`.
- **Sinks:** config `event_sinks: [<command>, …]`. Each event goes as one JSON
  line to each sink command's stdin, fire-and-forget, with a timeout (default
  5 s). A sink failure never fails a run; it is logged once per sink per
  process. The file is the only built-in sink. Sinks receive exactly the line
  written to the file, so a private sink can drain, store or report without
  any other contract.
- **Standalone emitter:** `agent-manager emit <kind> --repo … [--pr …]
  [--sha …] [--tier …] [--text …]`. Threads that are not inside an Agent
  Manager run (for example, a plain desktop coding thread opening its own PR)
  log the same events with one command. `runId` is optional for these.
- Agent Manager owns only the log, the sink hook and the emitter. Any
  tracker-specific sink, outbox or report is built separately.

## Testing: how much do we need?

Safety per minute, for a TypeScript/Next.js repo with a large `node:test` suite:

| Check | Catches | Cost | Where it runs |
|---|---|---|---|
| `tsc` typecheck | type/contract breaks across modules — the most common agent regression | low (1–2 min, incremental) | **PR (required)** |
| Unit + integration suite | behavior regressions; most of the real safety | medium; shard it, never subset it | **PR (required, sharded)** |
| Lint | style, some bug patterns | low | **PR (required)** |
| Production build | framework-boundary errors typecheck misses | medium | **PR, parallel job** |
| Browser canary (Chromium) | user-visible integration | high, flake-prone | **post-merge on `main`** (blocks release, triggers auto-revert) + **nightly across viewports** |
| Image build, smoke, platform probes | deploy readiness | high | **`main` / release only** |
| `check:version` on PRs | nothing (versions are assigned at release) | low | **drop from PRs**; release script keeps it |

Recommendation:

- **PR = typecheck + lint + the full unit/integration suite, sharded + build**,
  all in parallel. Do not build "affected tests" selection: it is the kind of
  machinery this plan removes, and sharding gives the same wall clock without
  coverage risk.
- **Docs-only PRs (tier 0, no code)** report the required check green via a
  path filter instead of running the suite.
- **`main` = everything above + browser canary + image smoke.** Red `main`
  auto-reverts. Releases refuse to tag on red `main` (already true).
- **Nightly = canary across viewports** plus anything slow.
- **Local before commit:** typecheck + the tests the author touched. In a repo
  with a required CI check, running the full suite locally before every commit
  is redundant; CI is the gate.
- Keep: no unregistered suppressions, never weaken assertions, flaky tests
  quarantined with an exemption. These are cheap and still pay.

## What changes in this repo

### Delete

| Area | Files | ~Lines (src + tests + docs/schemas) | Why |
|---|---|---|---|
| Director / autopilot | `src/director/*`, director schemas, DIRECTOR + AUTOPILOT docs | 2,500 | proposal cycles; harness scheduled tasks + a human prompt do this |
| Fleet, tokens, UI dashboard | `fleet`, `core-board`, `tokens`, `token-usage`, `ui-server`, `ui/`, `bin/agent-manager-fleet.mjs`, launchers | 7,400 | harness apps show sessions, usage and status |
| Goals graph + brain store | `goals`, `goal-*`, `goals-board`, `brain`, goal schemas/docs, `@maadb/core` dependency | 4,700 | goals live in the operator's project tracker; a workflow keeps a free-text `goal` field |
| Conditional authority | `authorization.mjs`, its schema, AUTHORIZATION doc | 1,800 | replaced by path tiers |
| Release/stamp/tag shipping | most of `ship-run.mjs` (release PRs, stamp manifests, tag observation, version plans, capability fingerprints) | 3,600 | scheduled release script owns versions/tags |
| Manager-thread return + watch loop | `master-return`, `watch-signal`, `notify`, `cadence`, `monitor`, wake/handoff schemas | 2,400 | replaced by `agent-manager wait` run as a harness background command (the harness notifies the thread when it exits) |
| Reconcile, demo, install, run classification | `reconcile`, `demo`, `install`, `run-classification` | 2,300 | external-release repair and setup helpers no longer needed |
| Multi-pass Delivery Review | `review-budget`, closeout/file-artifacts, most of `review.mjs`/`delivery.mjs` | 2,000 | one recorded verdict |
| PR Manager skill | `skills/pr-manager/` | 310 | folded into `ship` (one command, no separate phase) |
| Plan/alignment docs | LANE-SCALING, HARNESS-ALIGNMENT, FOUNDATION-ALIGNMENT, GOAL-*, RUN-CLASSIFICATION, FLEET, UI | 1,100 | historical |

### Simplify

- `ship <runId>` → push the delivery branch, open/find the PR, apply the
  `tier:N` label, arm auto-merge when tier ≤ 1 and the verdict is `accept`;
  tier 2 prints the one-line Ship Gate request and stops. ~300 lines instead of
  2,514. No polling loop: the harness's PR/CI monitor (or `wait`) watches.
- `bin/agent-manager.mjs`: ~30 subcommands → ~12 (`run --detach`, `status`,
  `wait`, `reply`, `cancel`, `cleanup`, `integrate`, `review`, `ship`, `tier`,
  `emit`, `doctor`, `validate`, `config`, `version`).
- Skills: `agent-manager/SKILL.md` + reporting + reference (1,410 lines) →
  ~250. Boards: Run board, Escalation, Outcome — no mandatory transition
  footer, no heartbeat template.
- Bundled `ship-gate` skill (346) → ~100: tier table, one-line notice for tier
  0/1, the board only for tier 2 and Simple-flow version/tag.
- README (1,176) → ~200; OPERATOR (999) → ~250.
- Own CI: keep the 3-OS matrix (lane spawning is OS-sensitive); the suite
  shrinks with the code.

### Keep (what harnesses do not do)

Cross-harness lanes (Claude Code, Codex, Cursor) in one run; one worktree per
lane; scope claims; `status.json` as deterministic run state; lane fold
(`integrate`); reply/resume of a blocked lane; guardrails on lane scope;
dependency cache; the tier classifier; the event log (rewritten as small
transition events, see §6).

### Add

- `agent-manager tier` + `.github/ship-tiers.yml` format (~120 lines incl.
  tests).
- `agent-manager wait <runId>` — blocks until the run's next event (§6),
  prints that JSON line, exits (~80 lines). Hosts run it as a background
  command, so the harness wakes the thread.
- Event stream (§6): transition events, `event_sinks` hook, `emit` command,
  `docs/EVENTS.md` (~150 lines incl. tests). It replaces the snapshot events
  and part of the deleted notify/return code, so it adds nothing net.
- `skills/ship-gate/reviewer.md` — the lighter reviewer prompt (~40 lines).
- `templates/github/revert-on-red.yml` and `tier-gate.yml` (~100 lines).
- `docs/HARNESS-NATIVE.md` — "what your harness already does", one table per
  harness with doc links and a *last checked* date (~120 lines).

### Size

| | Before | After (est.) |
|---|---|---|
| Tracked files (excl. lockfile) | 216 | ~110 |
| Lines (excl. lockfile) | ~52,500 | ~19,000 (−64%) |
| `src/` + `bin/` | 23,400 | ~8,100 |
| `test/` | 15,400 | ~7,000 |
| docs + skills + schemas + README | 9,500 | ~2,000 |
| `ui/` dashboard | 1,800 | 0 |
| Runtime deps | 2 | 1 (`yaml`) |
| Local suite | 479 tests, ~130 s | ~250 tests, ~60 s |

Totals include the additions (~600 lines: tier, wait, event stream, reviewer
prompt, templates, HARNESS-NATIVE, EVENTS).

Operator touches per PR: today 2–3 typed replies (Delivery Review, Ship Gate,
release). After: **0** for tier 0/1 (a notice), **1** for tier 2, plus none
for releases.

## Rules this overrides (playbook conflict guard)

Each needs explicit operator confirmation. The canonical playbook lives in a
separate repo; the matching patch is drafted as a proposal for the Master Dev
or framework session to land after approval. Branch protection changes are
written up for Ops, not made here.

1. **Ship Gate on every commit/PR/merge** → tier 0/1 get a one-line notice;
   the board stays for tier 2 and Simple-flow version/tag.
2. **Ordinary authors stop at `open-pr`; a different developer or Master Dev
   reviews** → the author thread may spawn its own fresh-context reviewer and
   arm auto-merge for tier ≤ 1.
3. **Strict up-to-date + `gh pr update-branch`** → dropped; post-merge CI on
   `main` + auto-revert (Ops change).
4. **Version assigned at each integration** → scheduled releases.
5. **Test gate: full suite locally before every commit; CI runs the same
   canonical suite on every PR, not a subset** → full unit/integration suite
   still runs on every PR; the browser canary and image checks move to
   post-merge `main` and nightly; local runs become targeted.
6. **Delivery Review passes, review budgets, conditional grants** (Agent
   Manager 2.x) → one recorded verdict; tiers replace grants.
7. **Goal alignment and Director authority** (Agent Manager 2.0.0) → removed.
8. **Mandatory watch-signal heartbeat after every detach** → harness
   background command + notification.

## Rollout

1. Operator go on this plan (and the overrides above).
2. Rewrite this repo in one major version (3.0.0), in deletion-first slices,
   each green on `npm test` + `npm run hygiene`.
3. Hand Master Dev: the playbook patch (Ship Gate, git-workflow,
   agent-coordination, Test-Master, Version-Master) and the Ops write-up
   (branch protection, `revert-on-red`, `tier-gate`, consumer
   `ship-tiers.yml`).
4. First week: track merges/day, CI minutes per merge, reverts, operator
   touches per PR. A revert rate above ~5% of merges means a path belongs in a
   higher tier.
