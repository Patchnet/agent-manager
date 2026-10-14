# What your harness already does

Last checked: **2026-10-13** against the linked docs. Harnesses ship features
weekly; when one lands here, prefer it and delete the agent-manager equivalent.

**Refresh this page:** ask your harness to re-check each row against the linked
page (not its memory), update the *Last checked* date, and open a PR. Rows
marked *preview* or *experimental* change most often.

## Claude Code and the Claude desktop app

| Need | Native feature | How | Docs |
|---|---|---|---|
| Parallel isolated work | worktree per session | `claude --worktree <name>`; desktop worktree toggle | [worktrees](https://code.claude.com/docs/en/worktrees) |
| Work in the background | background sessions *(preview)* | `claude --bg "…"`, `/bg`, `claude agents` | [agent view](https://code.claude.com/docs/en/agent-view) |
| Talk between threads | cross-session messaging | `/list-agents`, `SendMessage`, `notify_when_idle` | [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) |
| Fan out inside one task | subagents (up to 20 parallel), custom agents | `.claude/agents/*.md`, `isolation: worktree` | [subagents](https://code.claude.com/docs/en/sub-agents) |
| Multi-agent scripts | workflows | `/workflows`, `.claude/workflows/` | [workflows](https://code.claude.com/docs/en/workflows) |
| Review a diff | `/code-review [low…max\|ultra]`, `/security-review` | `--fix`, `--comment` | [code review](https://code.claude.com/docs/en/code-review) |
| Review every PR | managed Code Review *(preview, Team/Enterprise)* | `@claude review`; tune with `REVIEW.md`; never approves or blocks | [code review](https://code.claude.com/docs/en/code-review) |
| Deep cloud review | ultrareview *(preview)* | `/code-review ultra <PR>` | [ultrareview](https://code.claude.com/docs/en/ultrareview) |
| Watch a PR, fix CI, merge | desktop PR bar | "Auto-fix CI & address comments", "Auto-merge when ready" (needs repo auto-merge) | [desktop](https://code.claude.com/docs/en/desktop) |
| Recurring work | `/loop`, desktop scheduled tasks, cloud routines *(preview)* | `/loop 30m …`, `/schedule` | [scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks), [routines](https://code.claude.com/docs/en/routines) |
| Gates on tool use | hooks (PreToolUse … Stop) | `settings.json` `hooks`; path filters are best-effort | [hooks](https://code.claude.com/docs/en/hooks) |
| Hard allow/deny | permission rules, managed settings | `permissions` in settings | [managed settings](https://code.claude.com/docs/en/managed-settings) |
| Scripted runs | headless mode, Agent SDK | `claude -p --output-format stream-json` | [headless](https://code.claude.com/docs/en/headless) |
| CI agent | GitHub Action | `anthropics/claude-code-action@v1` | [GitHub Actions](https://code.claude.com/docs/en/github-actions) |

## OpenAI Codex

| Need | Native feature | How | Docs |
|---|---|---|---|
| Parallel isolated work | worktrees (desktop app), cloud tasks | composer **Worktree**; Work in › Cloud | [worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees), [cloud](https://learn.chatgpt.com/docs/cloud) |
| Fan out | subagents, custom agents | `.codex/agents/*.toml`, `/subagents` | [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) |
| Review every PR | automatic review, `@codex review` | Codex settings › Automatic review; rules under `## Code Review Rules` in AGENTS.md | [code review](https://learn.chatgpt.com/docs/code-review), [GitHub](https://learn.chatgpt.com/docs/third-party/github) |
| Scripted runs | `codex exec` | `--json`, `resume --last`, `--sandbox workspace-write` (`--full-auto` is gone) | [non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode) |
| Gates on tool use | hooks | `.codex/hooks.json` | [hooks](https://learn.chatgpt.com/docs/hooks) |
| Recurring work | automations (desktop/web) | Scheduled | [automations](https://learn.chatgpt.com/docs/automations) |
| CI agent | GitHub Action | `openai/codex-action@v1` | [GitHub Action](https://learn.chatgpt.com/docs/github-action) |
| Skills | skills | `.agents/skills/`, `~/.agents/skills/` | [skills](https://learn.chatgpt.com/docs/build-skills) |

## GitHub

| Need | Native feature | Notes | Docs |
|---|---|---|---|
| Land when green | auto-merge | `gh pr merge --auto --squash`; enable in repo settings | [auto-merge](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request) |
| Serialize merges | merge queue | private repos appear to need Enterprise Cloud (unverified) | [merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) |
| Per-path owners | CODEOWNERS + rulesets | a PR author cannot approve their own PR | [code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) |
| Bot review | Copilot automatic review | ruleset or personal setting | [Copilot review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/configure-automatic-review) |

## What this means for agent-manager

- **Removed in 3.0 because harnesses do it:** heartbeat watchers and
  Manager-thread return (use `wait` as a background command, desktop
  notifications, cross-session messaging), the dashboard and fleet/token views
  (harness apps), detached PR babysitting (desktop PR bar, auto-merge), the
  Director proposal loop (scheduled tasks), skill installers (copy the folder).
- **Kept because no harness does it:** one run mixing Claude Code, Codex, and
  Cursor lanes; scope claims across tools; deterministic `status.json` and an
  event log shared by all of them; path-based ship tiers.

## Recipes

**Author thread reviews its own PR, independently.** Spawn a fresh-context
reviewer subagent with [the reviewer prompt](../skills/ship-gate/reviewer.md),
or run `/code-review` (Claude Code) / `@codex review` (Codex). Record the
verdict with `agent-manager review` or `emit review_verdict`.

**Standing watchers.** One scheduled task per concern, each with a short
prompt: "If `main` CI is red and no revert PR is open, open one" (backs up
`revert-on-red`), "list PRs older than 3 days; rebase or close each", and any
production or ledger health checks your operations team owns.

**Wake on events.** In Claude Code run `agent-manager wait <runId>` with
`run_in_background`; the session is notified when it exits. Codex and Cursor
hosts run the same command in a background terminal.
