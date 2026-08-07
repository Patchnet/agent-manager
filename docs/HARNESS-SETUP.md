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
`recommendation` fields for a missing worker harness.
It reports that a CLI is not executable from the current process; it does not
claim that the CLI is uninstalled. A stale PATH, a missing override, or the
launching harness's sandbox can produce the same result.

## Official installation commands

### Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

See the [Claude Code setup guide](https://docs.anthropic.com/en/docs/claude-code/getting-started).

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

```bash
curl https://cursor.com/install -fsS | bash
cursor-agent --version
```

On Windows, run this in WSL. See the
[Cursor CLI installation guide](https://docs.cursor.com/en/cli/installation).
Cursor can host the Manager workflow and receive Master returns. A Cursor worker
lane adapter is not implemented yet.

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
agent-manager doctor --json
```

If the version command works but automatic discovery does not, set an explicit
binary override for the current session:

```powershell
$env:CLAUDE_BIN = "$env:APPDATA\npm\claude.cmd"
$env:CODEX_BIN = "$env:APPDATA\npm\codex.cmd"
agent-manager doctor --json
```

To make the override available to future processes:

```powershell
setx CLAUDE_BIN "%APPDATA%\npm\claude.cmd"
setx CODEX_BIN "%APPDATA%\npm\codex.cmd"
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
agent-manager doctor --json
```

Use `CLAUDE_BIN` or `CODEX_BIN` for nonstandard locations. Keep machine-specific
paths in the local environment. Do not commit them to a public workflow file.

## Discovery versus authentication

Binary discovery proves only that Agent Manager can launch the CLI.
Authentication is still owned by that CLI. If `--version` succeeds but a lane
fails during session startup, run the vendor's normal login or diagnostic flow
from the same environment. Agent Manager does not copy tokens or bypass
permissions.
