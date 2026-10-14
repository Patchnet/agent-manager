# Operator guide

agent-manager runs a few coding lanes in isolated worktrees, records every
transition, and ships under a path-based policy. The host conversation launches
a run, goes back to other work, and wakes on the next event.

## First run

```bash
npm ci && npm link
agent-manager config init --dev-root ~/code    # where sibling repositories live
agent-manager doctor                           # in the same OS environment that will launch runs
agent-manager init --repo ~/code/my-app --request "Describe the change"
agent-manager validate ~/code/my-app/agent-manager.yaml
agent-manager run ~/code/my-app/agent-manager.yaml --detach
```

Harnesses must be installed, signed in, and on PATH for the launching process.
Native Windows, WSL, containers, and CI are separate environments. See
[Worker harness setup](HARNESS-SETUP.md).

Use one lane for one coherent task. Add lanes only for real scope separation
(at most five; `max_concurrency` defaults to three). Validation rejects
overlapping write scopes; `depends_on` orders lanes that build on each other.

## The loop

```text
run --detach → wait → (reply) → integrate → review → ship → wait → merged
```

1. **Launch** with `run --detach`. It prints the run id and returns.
2. **Wait** with `agent-manager wait <runId>` as a background command. It
   prints the next event as one JSON line and exits; the harness wakes your
   thread. Run it again after handling each event.
3. **Answer** `waiting_operator` questions:
   `agent-manager reply <runId> <lane> --message "..."`. The lane resumes in the
   same harness session. Grant extra paths with `--extend-scope "<globs>" --by <id>`.
4. **Integrate.** With `integrate: true` the supervisor folds finished lanes
   into `am/<runId>/integrate` and runs `verification.commands` there. A lane
   stopped by a guardrail can be accepted with `ratify` and folded with
   `integrate <runId> --force-lanes done,failed-with-snapshot`.
5. **Review.** A fresh-context reviewer reads the brief and the diff and
   records one verdict: `review <runId> --verdict accept|revise|reject
   --reviewer <id> [--notes ...]`. `revise` leaves the worktrees in place for
   a follow-up run or `reply`; `reject` ends the run.
6. **Ship.** `ship <runId>` (see below). Tier 0/1 changes need nothing else.
7. **Close** a run you accept but will not ship: `close <runId> --reason ...`.

`status <runId>` shows the current state at any time; `events <runId>` shows
the history; `cancel <runId> [--remove-worktrees]` stops a run.

## Ship tiers

The target repository declares its policy in `.github/ship-tiers.yml`:

```yaml
default: 1            # unmatched paths
tier2:                # an operator approves
  - "src/db/migrations/**"
  - "src/**/billing/**"
  - "src/**/auth/**"
  - ".github/**"
tier0:                # docs, tests, copy
  - "docs/**"
  - "**/*.md"
  - "tests/**"
```

- A path is tier 2 if any `tier2` pattern matches, else tier 0 if any `tier0`
  pattern matches, else `default`. A change takes the highest tier among its
  paths, counting both sides of a rename.
- `*` stays inside one path segment; `**` spans any number of segments.
- `ship` reads the file from the **base branch**, so a change cannot lower its
  own tier, and any change to the file itself is tier 2.
- No file means every path is tier 1.
- `agent-manager tier --base origin/main` classifies the current branch;
  `tools/ship-tier.mjs` is the same classifier with zero dependencies, ready to
  vendor into CI ([tier-gate template](../templates/github/tier-gate.yml)).

| Tier | `ship` does | You see |
|---|---|---|
| 0 | PR + `tier:0` label + auto-merge (Formal), or one commit pushed to the base (Simple) | a log line |
| 1 | the same | a one-line notice |
| 2 | PR + `tier:2` label, then stops (Formal); nothing pushed (Simple) | a `waiting_operator` event naming the tier 2 paths |

Approve a tier 2 change with `ship <runId> --approved-by <you>`. The approval
is recorded on the target and in the event log, and covers the change as it
stands when you approve. A later `ship` without `--approved-by` re-classifies
the branch: if new commits reach tier 2 while auto-merge is armed, `ship`
disarms it (`gh pr merge --disable-auto`) and asks again.

**Formal Flow** (`dev_flow: formal` in the target's `Version.md`, or
`target_dev_flow` in the workflow) pushes the delivery branch, opens or reuses
the PR, labels it, and runs `gh pr merge --auto --squash`. The repository's
required check gates the merge. `wait` records the merge when GitHub completes
it. Merge conflicts surface as a blocked PR; the author thread merges the base,
resolves, re-runs the affected tests, and pushes again.

**Simple Flow** squashes the lane commits into one commit with `--message`,
rebases it onto the latest base, and pushes it. A rebase conflict stops with
the worktree path; resolve it there and rerun `ship`.

agent-manager never bumps versions or creates tags. Releases are the target
repository's own release script, run on a schedule.

## Reviews that stay light

The reviewer gets the brief and the diff, not the author's reasoning. It
blocks only on correctness, safety, data loss or integrity, authorization, or
drift from the brief. Everything else is a non-blocking note. Use
[the bundled prompt](../skills/ship-gate/reviewer.md) with a subagent, or your
harness's review command.

## After merge

Merges do not wait for a branch to be up to date with `main`. Instead:

- CI runs on every `main` commit (do not cancel in-progress `main` runs).
- [`revert-on-red`](../templates/github/revert-on-red.yml) re-runs a failed
  `main` run once; if it is still red and the parent commit was green, it opens
  a revert PR for that commit with auto-merge. Every `main` commit has its own
  result, so the first red commit after a green one is the culprit.
- The release script refuses to tag a red `main`.

Track the revert rate. A path whose changes revert often belongs in a higher tier.

## Events and sinks

Every transition is a line in `<runsRoot>/events.jsonl`. Configure sink
commands with `AGENT_MANAGER_EVENT_SINKS` to forward events anywhere. Threads
outside a run log with `emit`. Contract: [EVENTS.md](EVENTS.md).

## Workflow reference

```yaml
repo: my-app                 # sibling of AGENT_MANAGER_DEV_ROOT, a relative path, or absolute
title: CSV export            # optional display title
goal: Add CSV export         # optional; prefixed to every lane prompt
base_ref: origin/main        # default HEAD
integrate: true              # fold lanes into one delivery branch
max_concurrency: 3
claim_mode: auto             # auto | required | off
target_dev_flow: formal      # default: target Version.md dev_flow, else simple
harness_default: claude      # claude | codex | cursor
model_default: <model>
env_allowlist: [MY_TOKEN_NAME]
scope_overrides:             # shared paths: one owner, others read-only
  - { path: "src/shared/**", lanes: [api, ui], owner: api, reason: "contract owned by api" }
policy:
  permission_mode: acceptEdits
  stall_timeout_sec: 600
verification:
  setup: { commands: [{ command: npm, args: [ci] }] }
  commands: [{ command: npm, args: [test] }]
delivery:                    # only when integrate is false and lanes ship separately
  targets: [{ id: api, lane: api, base: main }]
lanes:
  - id: api
    harness: codex
    scope: ["src/api/**"]
    depends_on: []
    prompt: ...              # or prompt_file
```

Schema: [workflow.schema.json](../schemas/workflow.schema.json). Keys removed in
3.0 (`planning`, `goal_refs`, `goal_policy`, `feed`, `classification`, …) are
ignored with a warning.

## Claims

Each lane holds an advisory claim on its scope under the claims root
(`tools/claim.mjs`, or a shared registry via `AGENT_MANAGER_CLAIM_BIN`).
`claim_mode: required` refuses to launch over a live overlapping claim. Claims
expire after 24 hours and are released when a lane ends.

## Permissions

Detached lanes cannot answer permission prompts.

- Claude lanes that must run shell commands unattended: use
  `permission_mode: auto`, or `dontAsk` with a narrow `allowed_tools` list.
  Unrestricted `Bash`/`PowerShell` grants are rejected.
- A writable Claude lane with no `allowed_tools` inherits one rule per declared
  verification command (`npm test` → `Bash(npm test*)`). Explicit
  `allowed_tools` always wins; Codex and Cursor lanes are governed by their own
  sandbox modes.
- `lanes[].setup.commands` run before the model (for example `npm ci`) and
  fail closed.
- Dangerous permission bypass needs both `policy.dangerously_skip_permissions:
  true` and `--allow-dangerous-permissions` on that launch. Never make either a
  default.

## Configuration

`~/.agent-manager/config.env` (created by `config init`):

| Key | Meaning |
|---|---|
| `AGENT_MANAGER_DEV_ROOT` | folder containing target repositories |
| `AGENT_MANAGER_RUNS_ROOT` | run telemetry and the global event log (default `~/.agent-manager/runs`) |
| `AGENT_MANAGER_CLAIMS_ROOT` | claim registry (default `~/.agent-manager/claims`) |
| `AGENT_MANAGER_CLAIM_BIN` | optional shared claim CLI |
| `AGENT_MANAGER_EVENT_SINKS` | optional JSON array of sink commands |

Path keys in the file beat environment and CLI overrides unless
`AGENT_MANAGER_ALLOW_PATH_OVERRIDE=1`. `config show` prints the effective values.

## Sensitive run data and retention

Run directories hold prompts, replies, model output, file paths, session ids,
and worktrees. They are created with private permissions where supported, and
workers get a filtered environment (extend it only through `env_allowlist`).
Keep the runs root out of synchronized or public folders.
`cleanup <runId>` removes one finished run; `cleanup --stale --dry-run` previews
runs older than 30 days.
