# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting for this repository. If that feature is unavailable, contact the repository maintainers through the organization profile without including exploit details in a public channel.

Include the affected version, impact, reproduction steps, and any suggested mitigation. We will acknowledge a complete report within five business days.

## Security boundaries

agent-manager coordinates local command-line tools. Worktrees and policy checks reduce accidental cross-lane changes, but command-event inspection is best-effort detection and is not a sandbox. The Claude and Codex permission systems remain the execution boundary.

Run data can include prompts, replies, logs, file paths, and harness session identifiers. Keep the runs directory private and remove stale runs according to your retention policy.
