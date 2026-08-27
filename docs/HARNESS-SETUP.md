# Worker harness setup

Agent Manager launches the agent CLIs that are already installed and
authenticated for the operating-system user that starts Agent Manager. It does
not install a harness, copy credentials between harnesses, or weaken a harness's
sandbox and permission policy. Native Windows Codex lanes explicitly keep the
sandbox private desktop enabled so worker shells do not present interactive
console windows on the operator's desktop.

## Standard setup rule

Install each worker CLI at user scope in the same operating-system environment
that launches Agent Manager. Native Windows, WSL, containers, remote hosts, and
CI runners are separate environments. An installation visible inside one is not
automatically visible inside another.

After an install or PATH change:

1. Restart Codex, Claude Code, Cursor, or the terminal that will launch Agent
   Manager.
2. Verify the CLI from that exact environment.
3. Run `agent-manager doctor --json` there.
4. Authenticate with the vendor CLI if Doctor finds the binary but a lane cannot
   start a session.

Doctor reports the detected runtime and returns structured `setup` and
`recommendation` fields for a missing worker harness. It separately reports
the inspected source-checkout version, invoked runtime version, and installed
host-skill versions. Use its single `activation.command` to install or refresh
one host safely. The installer updates only a managed copy whose recorded
digest still matches; local edits fail closed.
It reports that a CLI is not executable from the current process; it does not
claim that the CLI is uninstalled. A stale PATH, a missing override, or the
launching harness's sandbox can produce the same result.

Every run repeats the existing version check for each distinct selected worker
harness after planning validation and before run admission, claims, worktrees,
or workers. An unavailable harness that the workflow does not select does not
block the run, and GitHub CLI remains a shipping-phase dependency only. This
check proves executable discovery and version-command usability; it does not
prove that a session is authenticated. Authentication can still expire after
preflight.

## Official installation commands

### Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

See the [Claude Code setup guide](https://docs.anthropic.com/en/docs/claude-code/getting-started).

#### Detached Claude permissions

`acceptEdits` permits file edits but can still ask before shell commands. A
detached worker cannot answer an interactive prompt. For unattended Claude
lanes, select the behavior explicitly on that lane:

```yaml
lanes:
  - id: implementation
    harness: claude
    permission_mode: auto
    scope: "src/**"
    prompt: "Implement and test the scoped change."

  - id: benchmark
    harness: claude
    permission_mode: dontAsk
    setup:
      timeout_sec: 300
      commands:
        - command: npm
          args: [ci, --no-audit, --no-fund]
    allowed_tools:
      - "Bash(node --test *)"
      - "PowerShell(node --test *)"
    kind: review
    scope: "test/**"
    prompt: "Run the approved benchmark commands and report the results."
```

Use `auto` for general hands-off implementation. Claude Code applies its safety
classifier and can still deny actions outside the requested boundary. Use
`dontAsk` for deterministic CI or benchmark work: only the narrow
`allowed_tools` rules execute, and everything else is denied instead of
prompting. Agent Manager rejects unrestricted shell rules and checks that the
installed Claude CLI advertises the requested mode before launch.

Fresh Git worktrees do not inherit gitignored dependency directories such as
`node_modules`. When a lane must run tests, declare a deterministic lane
`setup` command instead of giving the model package-install permission. Agent
Manager completes setup before starting Claude and fails the lane if setup does
not pass.

Within one run, equivalent pristine worktrees can reuse a private setup
snapshot. The cache key includes the exact setup plan, worktree revision,
Node/platform identity, and the effective setup environment. The first lane
runs the command and records a complete file overlay. A later lane receives
copied files in its own worktree; it never shares a writable dependency tree.

Reuse is fail-safe. A revision or plan change is a miss. Baseline drift,
unsupported file types, incomplete manifests, corrupt files, or an unsafe
restore causes Agent Manager to run the declared setup command normally. Setup
telemetry records `cache.outcome` as `hit`, `miss`, or `fallback`, along with a
content-derived key and the reason. A cache error never substitutes for a
successful setup command.

Integration verification has the same rule. If `verification.commands` invokes
`npm`, `npx`, `tsc`, or another common project-local Node binary, the workflow
must contain a lockfile and the matching deterministic setup. For example:

```yaml
verification:
  setup:
    commands:
      - { command: npm, args: [ci] }
  commands:
    - { command: npm, args: [test] }
    - { command: npx, args: [tsc, --noEmit] }
```

Agent Manager validates this before lanes start and names the exact setup for
`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, or a
Bun lockfile. Setup evidence remains a separate, revision-bound phase and can
be reused safely on retry.

Auto mode availability also depends on the Claude account, provider, model,
and administrative policy. If Claude rejects it at session startup, choose an
eligible configuration or use `dontAsk` with a narrow allowlist. Do not use
`--dangerously-skip-permissions` as a compatibility fallback.

### Codex CLI

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
codex --version
```

macOS or Linux:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex --version
```

The npm package remains a fallback: `npm install -g @openai/codex`. See the
[Codex CLI installation instructions](https://github.com/openai/codex#installing-and-running-codex-cli).

#### Complete native Windows package

The native Windows Codex sandbox requires the executable and its companion
`codex-windows-sandbox-setup.exe`. Agent Manager prefers a complete packaged
installation over a bare `codex.exe`, even when the bare executable appears
earlier in the normal discovery order. This prevents a detached lane from
repeatedly falling back to PowerShell launches on the operator's interactive
desktop when the setup helper is unavailable.

`agent-manager doctor --json` reports the selected installation source and
sandbox-helper readiness. Workflow preflight stops before workers start when a
known packaged installation is incomplete. Set `CODEX_BIN` only when you
intentionally want to select another supported installation.

Codex uses a private desktop by default for both native Windows sandbox modes.
Agent Manager also passes that setting explicitly for every sandboxed Codex
lane. See the official [Codex Windows sandbox
guide](https://learn.chatgpt.com/docs/windows/windows-sandbox).

Agent Manager can hide processes it launches directly, but it cannot set
Windows creation flags on grandchildren created inside a third-party harness.
If a complete helper launches successfully and an approval or escalated command
still flashes a window, collect the Codex sandbox log and report that remaining
process-launch issue to the harness owner rather than disabling the sandbox.

### Cursor Agent CLI

Windows PowerShell (native, no WSL):

```powershell
irm 'https://cursor.com/install?win32=true' | iex
agent --version
```

macOS or Linux:

```bash
curl https://cursor.com/install -fsS | bash
cursor-agent --version
```

See the [Cursor CLI installation guide](https://cursor.com/docs/cli/installation).
Cursor can host the Manager workflow, receive Master returns, and run worker
lanes (`harness: cursor`).

The installer places both launcher names — `agent` and `cursor-agent` — in
`%LOCALAPPDATA%\cursor-agent` on Windows and `~/.local/bin` elsewhere. Agent
Manager discovers either one; `CURSOR_AGENT_BIN` overrides discovery.

#### Cursor lane behavior

Lanes run `agent -p --output-format stream-json`, with `--model` when the lane
or workflow requests one. Session ids come from the `system.init` event and
feed `--resume=<chatId>`. Needs-input uses the same lane `needs-input.json`
contract as Claude and Codex.

`permission_mode` maps onto Cursor's native flags:

| `permission_mode` | Cursor flags |
|---|---|
| `readOnly`, `read-only`, `read_only` | `--mode plan` |
| `auto` | `--auto-review` (server-side classifier) |
| `acceptEdits`, `workspace-write` | print-mode defaults |
| `dontAsk` | rejected — Cursor has no allowlist-only mode |

`--force` / `--yolo` is reachable only through an explicit
`dangerously_skip_permissions` policy. Agent Manager does pass `--trust` so a
detached lane is not stopped by the workspace-trust prompt: the worktree is a
checkout of the operator's own repository that Agent Manager created. That flag
grants no command permissions. MCP servers are not auto-approved; approve the
ones a lane needs in Cursor before the run.

Cursor takes the prompt as a command-line value and does not read it from
stdin, so Agent Manager always writes the full briefing to the lane's
`prompt.md` and adds the lane directory with `--add-dir`. On macOS and Linux
the prompt is also passed inline. On Windows the launcher is a `.cmd`/`.ps1`
shim, and both cmd.exe and PowerShell corrupt a multiline argument — cmd
truncates at the first newline, PowerShell strips quotes — so Windows lanes
receive a single-line pointer to `prompt.md` instead.

Cursor authenticates through `agent login` or the documented `CURSOR_API_KEY`
environment variable. Both reach worker lanes: login state through the normal
user profile, and `CURSOR_API_KEY` / `CURSOR_API_ENDPOINT` through the worker
environment allowlist. `CURSOR_MODEL` supplies a default model for lanes that
do not name one.

## Windows npm shims

Global npm tools commonly install `claude.cmd`, `claude.ps1`, or `codex.cmd`
without installing a same-named `.exe`. Agent Manager recognizes `.cmd`, `.bat`,
and `.ps1` launchers and invokes them without enabling a general-purpose shell
for worker commands.

Check what the launching PowerShell session can see:

```powershell
Get-Command claude -All
claude --version
Get-Command codex -All
codex --version
Get-Command agent -All
agent --version
agent-manager doctor --json
```

If the version command works but automatic discovery does not, set an explicit
binary override for the current session:

```powershell
$env:CLAUDE_BIN = "$env:APPDATA\npm\claude.cmd"
$env:CODEX_BIN = "$env:APPDATA\npm\codex.cmd"
$env:CURSOR_AGENT_BIN = "$env:LOCALAPPDATA\cursor-agent\agent.cmd"
agent-manager doctor --json
```

To make the override available to future processes:

```powershell
setx CLAUDE_BIN "%APPDATA%\npm\claude.cmd"
setx CODEX_BIN "%APPDATA%\npm\codex.cmd"
setx CURSOR_AGENT_BIN "%LOCALAPPDATA%\cursor-agent\agent.cmd"
```

`setx` does not update the current process. Restart the launching harness after
using it. Do not reinstall a CLI merely because another already-running app has
stale PATH state.

## macOS and Linux discovery

```bash
command -v claude
claude --version
command -v codex
codex --version
command -v cursor-agent
cursor-agent --version
agent-manager doctor --json
```

Use `CLAUDE_BIN`, `CODEX_BIN`, or `CURSOR_AGENT_BIN` for nonstandard locations.
Keep machine-specific paths in the local environment. Do not commit them to a
public workflow file.

## Discovery versus authentication

Binary discovery proves only that Agent Manager can launch the CLI.
Authentication is still owned by that CLI. If `--version` succeeds but a lane
fails during session startup, run the vendor's normal login or diagnostic flow
from the same environment. Agent Manager does not copy tokens or bypass
permissions.
