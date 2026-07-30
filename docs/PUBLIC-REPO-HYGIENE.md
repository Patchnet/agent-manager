# Public repo hygiene

`agent-manager` is a **public** Apache-2.0 repository. Every tracked file,
commit message, GitHub Release note, and example is visible to contributors,
forks, and search engines. Treat that as the default constraint.

Agents and humans editing this repo must follow these rules before every commit.

## Never commit

**Credentials and secrets**

- API keys, tokens, private keys, `.env` values, connection strings
- Anything under `.secrets/` or operator credential stores

**Personally identifiable or customer-specific information**

- Real names, company names, domains, or email addresses (staff or client)
- Customer or tenant data, deployment targets, or named production systems
- Use placeholders such as `user@example.com`, `my-target-repo`, `localhost`

**Internal identifiers and infrastructure**

- Internal project / brain IDs (`prj_*`, `agt-*`, `sess-*`, `jrn-*`, `fup-*`, …)
- Internal hostnames, IP addresses, droplet names, or fleet-specific paths
- Patchnet-internal workflow or codenames that are not part of this repo's public product story

**Scope bleed**

- Deployment events, client relationships, or fleet status that belong in a private ops repo
- Version history or changelogs for *other* repositories

**Test:** If a line could identify a customer, a staff member, or a specific deployment target, it does not belong in a tracked file here.

## Commit messages

Commit messages are permanent history — a separate leak surface from file content.

- Describe the technical change only; do not cite internal projects, clients, or incidents as rationale unless the operator explicitly approves a public disclosure.
- No emails, hostnames, tokens, or internal IDs in subject or body.

## What stays local (gitignored)

Operator-specific and fleet-specific material must never be tracked:

| Pattern / path | Purpose |
|---|---|
| `*.local.md` | Operator context, machine paths, internal planning coordinates |
| `AGENTS.md`, `Codex.local.md` | Codex bootstrap siblings (operator-local) |
| `.claude/`, `.cursor/`, `.codex/` | Host agent settings |
| `.env`, `.env.*` (except `.env.example`) | Secrets and local config |
| `.secrets/` | Credential storage |
| `workflows/` | Operator workflows targeting private sibling repos |
| `CHANGELOG.md` | Internal dev log — public release notes use GitHub Releases |
| `brains/`, `user-data/` | Runtime / tenant data |

If you need a new local-only category, add it to `.gitignore` **before** creating files there.

## Release notes

- **`CHANGELOG.md` is local only** (gitignored). Write freely for internal dev notes.
- **GitHub Releases** is the public channel. Draft release notes from the local log, apply this hygiene pass, and get operator review before publishing.

## Examples and workflows

- Checked-in examples under `examples/` must use **generic** repo names and scopes unless the target is this repository itself (`agent-manager`).
- Workflows that target private sibling repos belong in gitignored `workflows/`, not in tracked paths.
- Lane prompts in examples should remind workers not to invent hostnames or internal IDs.

## Pre-publication checklist (maintainers)

Before first public push or after scrubbing private development history:

- [ ] Run `npm run hygiene` across tracked and untracked publishable files
- [ ] Scan commit history for the same patterns; rewrite history if needed (`git filter-repo` or equivalent)
- [ ] Recreate tags after a history rewrite
- [ ] Confirm `.gitignore` includes the public-repo contract rows above
- [ ] Confirm no tracked workflow YAML references private fleet repos
- [ ] Confirm GitHub secret scanning and push protection are enabled
- [ ] Run `npm test` and inspect `npm pack --dry-run` contents
- [ ] Final sanity pass: known staff emails, client names, internal-only identifiers

## Agent bootstrap

- **Claude Code:** `CLAUDE.md` (tracked, safe-public)
- **Codex / other hosts:** `AGENTS.md` (gitignored — operator copies or mirrors locally)
- **Operator context:** `CLAUDE.local.md` (gitignored)

When adding tracked agent instructions, keep `CLAUDE.md` self-contained for public readers and put internal planning, fleet, and machine-specific context in `*.local.md` only.
