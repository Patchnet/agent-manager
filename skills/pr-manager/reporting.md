# PR Manager chat templates

Use these boards only. Fill every value from `status.json`; use `n/a` when it
is not available.

End every board with the Transition block. `AUTO_CONTINUE` means keep the
detached ship process and watcher moving before ending the host turn;
`WAIT_OPERATOR` means ask only for the listed decision; `TERMINAL` means close
out and stop.

## PR Manager · Handoff

| | |
|---|---|
| **runId** | `<runId>` |
| **title** | `<identity.displayTitle>` |
| **repo** | `<repo>` |
| **approval** | `through-pr \| all` |
| **target** | `<ship.targetId or single>` |
| **branch** | `<branch>` |
| **base** | `<base>` |
| **runtime** | `<runtime.os>/<runtime.arch> (<runtime.hostPlatform>) · <runtime.shell> · <runtime.commandMode>` |
| **state** | `shipping` |
| **telemetry** | `$AGENT_MANAGER_RUNS_ROOT/<runId>/status.json` |

The approved shipping phase is detached. The host chat is free. PR Manager
will wake on a blocker, meaningful state change, heartbeat, or terminal
outcome.

### Transition

| | |
|---|---|
| **Mode** | `AUTO_CONTINUE` |
| **Next action** | Arm monitoring and let the detached ship phase continue. |
| **Operator input required** | `none` |

## PR Manager · Ship board

| | |
|---|---|
| **runId** | `<runId>` |
| **title** | `<identity.displayTitle>` |
| **state** | `queued \| running` |
| **phase** | `<ship.phase>` |
| **approval** | `through-pr \| all` |
| **target** | `<ship.targetId or single>` |
| **branch** | `<branch>` |
| **runtime** | `<runtime.os>/<runtime.arch> (<runtime.hostPlatform>) · <runtime.shell> · <runtime.commandMode>` |
| **PR** | `<URL or n/a>` |
| **release PR** | `<ship.releasePrUrl or n/a>` |
| **release transaction** | `<ship.releaseTransaction.mode or n/a>` |
| **last activity** | `<ship.lastActivity>` |

| Step | State | Detail |
|---|---|---|
| `<name>` | `running \| done \| skipped` | `<detail>` |

When `ship.phase=ci` or GitHub check telemetry is present, append:

| GitHub workflow / check | Status | Result | URL |
|---|---|---|---|
| `<workflow or check name>` | `<queued \| in_progress \| completed>` | `<conclusion or pending>` | `<URL or n/a>` |

### Transition

| | |
|---|---|
| **Mode** | `AUTO_CONTINUE` |
| **Next action** | Continue detached monitoring until progress, blocker, or outcome. |
| **Operator input required** | `none` |

## PR Manager · Ship escalation

| | |
|---|---|
| **runId** | `<runId>` |
| **phase** | `<ship.phase>` |
| **target** | `<ship.targetId or single>` |
| **PR** | `<URL or n/a>` |
| **release PR** | `<ship.releasePrUrl or n/a>` |
| **state** | `blocked` |
| **runtime** | `<runtime.os>/<runtime.arch> (<runtime.hostPlatform>) · <runtime.shell> · <runtime.commandMode>` |

### Blocker

`<ship.needsInput.prompt>`

### Options

- `<option from ship.needsInput.options>`

### Waiting on

Operator direction. PR Manager does not bypass or guess.

### Transition

| | |
|---|---|
| **Mode** | `WAIT_OPERATOR` |
| **Next action** | Apply only the selected resolution, then resume the same ship phase. |
| **Operator input required** | `<exact option above>` |

## PR Manager · Ship outcome

| | |
|---|---|
| **runId** | `<runId>` |
| **final state** | `done \| failed \| cancelled` |
| **target** | `<ship.targetId or single>` |
| **overall delivery** | `<status.state>` |
| **approval** | `through-pr \| all` |
| **PR** | `<URL or n/a>` |
| **release PR** | `<ship.releasePrUrl or n/a>` |
| **merge SHA** | `<SHA or n/a>` |
| **release SHA** | `<SHA or n/a>` |
| **tag** | `<tag or n/a>` |
| **release mode / tag CI** | `<delivery.release.mode or n/a>` · `<delivery.release.tagCi.state or ship.releaseCi.state or n/a>` |
| **ended** | `<ISO timestamp>` |
| **runtime** | `<runtime.os>/<runtime.arch> (<runtime.hostPlatform>) · <runtime.shell> · <runtime.commandMode>` |

### Result

- `<short evidence-backed result from ship steps>`
- `<remaining targets or release requirement; n/a only when overall delivery is terminal>`
- GitHub Release: **not directly created by PR Manager**; `tag-only` completion
  does not require one, while `published-release` mode does

### Transition

| | |
|---|---|
| **Mode** | `<AUTO_CONTINUE when an already-approved train target remains; WAIT_OPERATOR when new Ship Gate authority is required; TERMINAL when overall delivery is terminal>` |
| **Next action** | `<ship next approved target \| present next Ship Gate \| close out and stop>` |
| **Operator input required** | `<none \| exact Ship Gate reply>` |
