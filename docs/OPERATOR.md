# Operator guide

agent-manager lets one host conversation supervise several isolated Claude Code or Codex CLI lanes. The host launches a detached supervisor, reads status from disk, escalates blocking questions, verifies delivery, and keeps shipping under explicit operator control.

## First run

```bash
npm ci
npm link
agent-manager doctor
agent-manager init --repo /path/to/repo --request "Describe the change" --harnesses claude,codex
agent-manager validate /path/to/repo/agent-manager.yaml
agent-manager run /path/to/repo/agent-manager.yaml --detach --json
```

Always inspect generated lane scopes before launch.

## Detach is mandatory from a host chat

```bash
agent-manager run <workflow.yaml> --detach --json
```

The command validates the workflow, repository, base ref, harness names, and required binaries before reporting detach success. It returns a `runId`, telemetry path, supervisor log, and status command in milliseconds. A foreground run is for a dedicated terminal, not a chat turn.

## Observe without blocking

```bash
agent-manager status <runId> --json
agent-manager monitor <runId>
agent-manager events <runId> --jsonl
agent-manager watch-signal <runId> --heartbeat-sec 180
```

`status.json` is authoritative. `events.jsonl` and `watch-signal` are notification sources, not alternate state stores. A `blocked` run is resumable and is not terminal.

Cursor support for waking an idle chat from arbitrary process output is host-version dependent. Keep the run detached. Use the side-terminal monitor, event consumer, or operating-system notifications when the host cannot re-enter the chat automatically.

## Answer a lane

```bash
agent-manager reply <runId> <laneId> --message "approved answer"
```

Reply resumes the recorded Claude or Codex session. It does not create a new independent conversation.

## Delivery Review

```bash
agent-manager review <runId>
```

The generated Pass 1 document collects lane states, scopes, changed files, violations, exits, and evidence logs. The host must still compare those facts with the original request and rerun relevant tests. At most one correction is allowed, followed by Pass 2. There is no automatic Pass 3.

Only an accepted Delivery Review can proceed to Ship Gate. Workers do not own commits, pushes, pull requests, merges, tags, or releases unless the workflow explicitly permits a narrower action.

## Integration

```bash
agent-manager integrate <runId>
```

Integration snapshots successful lane worktrees and merges them into `am/<runId>/integrate` from the immutable base SHA recorded at launch. It does not push or merge to the target repository default branch. Conflicts are aborted and reported as a resumable escalation.

## Cancellation and retention

```bash
agent-manager cancel <runId>
agent-manager cleanup <runId>
agent-manager cleanup --stale --older-than-days 30
```

Cancellation writes an authoritative marker. The live supervisor then terminates the process trees it owns. The cancel command does not kill an unverified stale PID. Stale cleanup skips running and blocked runs.

## Claims

Workflow claim modes:

- `auto`: use the configured registry; registry failure is advisory.
- `off`: do not claim. Useful for a single local operator.
- `required`: fail if the claim cannot be recorded.

The bundled registry defaults to `~/.agent-manager/claims`. Set `AGENT_MANAGER_CLAIM_BIN` to use another implementation.

## Dangerous permissions

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

The first command installs the canonical user skill. Project mode also installs a concise `.cursor/rules` fallback. Reporting templates remain canonical in the skill; the rule points to the CLI flow instead of duplicating them.

## Public repository hygiene

Run these checks before proposing a public change:

```bash
npm test
npm run hygiene
npm pack --dry-run
```

See [PUBLIC-REPO-HYGIENE.md](PUBLIC-REPO-HYGIENE.md), [SECURITY.md](../SECURITY.md), and [CONTRIBUTING.md](../CONTRIBUTING.md).
