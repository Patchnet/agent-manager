# PR Manager chat templates

Use these boards only. Fill every value from `status.json`; use `n/a` when it
is not available.

## PR Manager · Handoff

| | |
|---|---|
| **runId** | `<runId>` |
| **repo** | `<repo>` |
| **approval** | `through-pr \| all` |
| **branch** | `<branch>` |
| **base** | `<base>` |
| **runtime** | `<runtime.os>/<runtime.arch> (<runtime.hostPlatform>) · <runtime.shell> · <runtime.commandMode>` |
| **state** | `shipping` |
| **telemetry** | `$AGENT_MANAGER_RUNS_ROOT/<runId>/status.json` |

The approved shipping phase is detached. The host chat is free. PR Manager
will wake on a blocker, meaningful state change, heartbeat, or terminal
outcome.

## PR Manager · Ship board

| | |
|---|---|
| **runId** | `<runId>` |
| **state** | `queued \| running` |
| **phase** | `<ship.phase>` |
| **approval** | `through-pr \| all` |
| **branch** | `<branch>` |
| **runtime** | `<runtime.os>/<runtime.arch> (<runtime.hostPlatform>) · <runtime.shell> · <runtime.commandMode>` |
| **PR** | `<URL or n/a>` |
| **last activity** | `<ship.lastActivity>` |

| Step | State | Detail |
|---|---|---|
| `<name>` | `running \| done \| skipped` | `<detail>` |

## PR Manager · Ship escalation

| | |
|---|---|
| **runId** | `<runId>` |
| **phase** | `<ship.phase>` |
| **PR** | `<URL or n/a>` |
| **state** | `blocked` |
| **runtime** | `<runtime.os>/<runtime.arch> (<runtime.hostPlatform>) · <runtime.shell> · <runtime.commandMode>` |

### Blocker

`<ship.needsInput.prompt>`

### Options

- `<option from ship.needsInput.options>`

### Waiting on

Operator direction. PR Manager does not bypass or guess.

## PR Manager · Ship outcome

| | |
|---|---|
| **runId** | `<runId>` |
| **final state** | `done \| failed \| cancelled` |
| **approval** | `through-pr \| all` |
| **PR** | `<URL or n/a>` |
| **merge SHA** | `<SHA or n/a>` |
| **release SHA** | `<SHA or n/a>` |
| **tag** | `<tag or n/a>` |
| **ended** | `<ISO timestamp>` |
| **runtime** | `<runtime.os>/<runtime.arch> (<runtime.hostPlatform>) · <runtime.shell> · <runtime.commandMode>` |

### Result

- `<short evidence-backed result from ship steps>`
- GitHub Release: **not created**
