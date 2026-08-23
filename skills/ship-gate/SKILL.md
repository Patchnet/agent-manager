---
name: ship-gate
description: >-
  Present the standard Ship Gate approval board before any commit, push, PR,
  merge, version bump, or tag. Use when work is ready to ship, when the user
  asks for a subordinate author-only PR handoff, asks to
  commit/push/PR/merge/tag/release, when recommending a version, or when
  choosing Simple vs Formal flow next steps. Never freestyle a commit/merge
  summary — use this skill's templates. Companion to agent-manager; orgs may
  replace this with their own fuller ship-gate skill.
---

# Ship Gate (bundled companion)

**Mandatory handoff board** before mutating git history or remotes when this
convention is in use.

Every host agent (Claude Code, Codex, Cursor, others) uses **this format only**.
No custom “ready to commit” write-ups.

This copy ships with **agent-manager** as a portable starter. If your workspace
already has a richer `ship-gate` skill (org playbook, preference tools, etc.),
**prefer that one** and ignore this folder.

Pairs with [agent-manager](../agent-manager/SKILL.md): Delivery Review accepts
lane work → then Ship Gate ships the target repo (or agent-manager itself).
Agent Manager is optional: a single author preparing a PR uses Ship Gate
directly and does not need lane orchestration.

## When to run

Run **before** any of: `git commit`, `git push`, `gh pr create`, `gh pr merge`,
`git tag`, `Version.md` bump, or a release create.

Also run when work is complete and you would otherwise ask “want me to commit?”

## Hard rules

1. Read `Version.md` → `dev_flow` (`simple` | `formal`; absent → **simple**).
2. Pick the matching template below. Fill every field; use `n/a` when a step does not apply.
3. Render as **markdown tables** (not a fenced monospace block) so it scans in CLI and chat.
4. **Stop and wait** for an approve reply. Do not commit / push / open PR / merge / tag until then.
5. Never hide a red suite. Never invent a parallel approval format.
6. **Version stamps:** when VERSION/TAG is in scope, the stamp set is
   `Version.md` + `package.json` + `package-lock.json` (when each exists). Prefer
   the repo bump script (`npm run bump:version` when present). Run
   `npm run check:version` (or equivalent) and show the result on the board.
   **Never tag until check:version is green** — and when the repo has CI /
   Formal / `test_gate: full`, **never tag until CI is green on the stamp commit**.
7. **Formal integration is auto-merge only after independent approval.** On
   reviewer/integrator approval of `through-pr` / `all`, use
   `gh pr merge --auto --squash`. Never ask the operator to click Merge on GitHub.
8. **PR authors stop at `open-pr`.** An author may commit, push, create or
   update the PR, apply required labels, and attach review evidence. The author
   must not approve their own PR, enable auto-merge, merge, edit merge-time
   version stamps, create tags, or publish a release. A different developer or
   Master Dev owns review, merge approval, versioning, and release. Authors
   must not use `through-pr` or `all` for their own PR.
9. After Formal merge or abandon, release any advisory claim for that branch
   (`agent-manager` / bundled `tools/claim.mjs` when that lane used claims).
10. End every approval board with the Transition block. Ship Gate presentation
    is always `WAIT_OPERATOR`. After approval, execute the authorized scope
    without asking for another confirmation; that execution is
    `AUTO_CONTINUE` until blocked or complete.
11. A conditional grant is an immutable operator record, not a chat approval.
    An explicitly enabled repo policy may let the independently attributable
    accepting Delivery Review materialize that grant in the same operation.
    With an unchanged `conditional_authority_ready` result, that acceptance is
    the only human approval: do not present a second Ship Gate. Launch only with
    `agent-manager ship <runId> --authorized --detach`. Never edit, override,
    downgrade, or replay it. Missing, blocked, expired, revoked, or drifted
    policy authority returns to this manual Ship Gate with the failure visible.

## Approve vocabulary (operator replies with one)

| Reply | Meaning |
|-------|---------|
| `all` | Run every remaining step for this flow; in Formal, reviewer/integrator only |
| `through-pr` | Formal reviewer/integrator only — commit → push → PR + auto-merge; version/tag later on main |
| `open-pr` | Formal author only — commit → push → create/update PR → labels + review evidence → stop; no approval or auto-merge |
| `commit+push` | Commit and push; stop before PR / version as applicable |
| `commit+tag` | Simple only — stamp + check:version + commit + tag; no push (still no tag if check fails) |
| `commit` | Commit only |
| `reject` | Stop; operator may add why |

## Template — Simple Flow

```markdown
## Ship Gate · Simple

| | |
|---|---|
| **Repo** | `<name>` |
| **Branch** | `main` |
| **Agent** | `<tool · model>` |
| **Version.md** | enabled · current `<x.y.z>` · or n/a |
| **Test gate** | `<none\|local\|full\|absent>` · suite **<pass\|n/a\|fail — note>** |
| **check:version** | **<pass\|n/a\|fail — note\|pending stamp>** |

### Done
- [x] Work complete
- [x] Tests (if required)
- [x] Version recommendation ready
- [ ] Full stamp set ready (`Version.md` + `package.json` + `package-lock.json` when present)
- [ ] `npm run check:version` pass (before tag)

### Needs your OK
| Step | Action | Detail |
|------|--------|--------|
| COMMIT | waiting | `<prefix>: <summary>` |
| VERSION | waiting | `<current>` → `<next>` · full stamp set via bump script when available |
| TAG | waiting | `v<next>` **only after** check:version (+ CI green if `test_gate: full`) |
| PUSH | waiting | `main` first; tag push after green when CI applies |

### Approve — reply with one
| Reply | Does |
|-------|------|
| `all` | stamp → check:version → commit → push → (CI if required) → tag |
| `commit+tag` | stamp → check:version → commit + tag, no push |
| `commit` | commit only |
| `reject` | stop — add why |

### Transition

| | |
|---|---|
| **Mode** | `WAIT_OPERATOR` |
| **Next action** | Execute exactly the approved Simple Flow scope. |
| **Operator input required** | `all \| commit+tag \| commit \| reject` |
```

## Formal role selection

- **Author:** the agent that created or changed the branch work, or is submitting
  that work as its PR. Set Role to `author`. In the approval table, show only
  `open-pr`, `commit+push`, `commit`, and `reject`. Mark MERGE, VERSION, TAG,
  and RELEASE (when present) `n/a — independent reviewer`.
- **Reviewer/integrator:** a different developer or Master Dev performing the
  independent review and integration. Set Role to `reviewer/integrator`.
  `through-pr` and `all` are available only in this role.

## Template — Formal Flow

```markdown
## Ship Gate · Formal

| | |
|---|---|
| **Repo** | `<name>` |
| **Branch** | `<type/slug>` |
| **Agent** | `<tool · model>` |
| **Role** | `<author\|reviewer/integrator>` |
| **Claim** | lane `<name>` · scope `<globs>` · or n/a |
| **Version** | at merge (not on branch) · current `<x.y.z>` |
| **Test gate** | `<none\|local\|full\|absent>` · suite **<pass\|n/a\|fail — note>** |
| **CI** | `<n/a\|pending\|green\|red>` |
| **PR** | `<none\|#N\|draft>` |
| **check:version** | **<pass\|n/a\|fail — note\|pending stamp>** |

### Done
- [x] Work complete on branch
- [x] Tests (if required)
- [x] Claim held / scope clear (when claims apply)
- [ ] Code-review run (required before merge)
- [ ] Full stamp set ready on main (`Version.md` + `package.json` + `package-lock.json`)
- [ ] `npm run check:version` pass on stamp
- [ ] CI quality green on stamp commit (before tag)

### Needs your OK
| Step | Action | Detail |
|------|--------|--------|
| COMMIT | waiting | `<prefix>: <summary>` (no version stamp on branch) |
| PUSH | waiting | `origin <branch>` |
| PR | waiting | open/update + required labels/evidence; auto-merge only for `through-pr` / `all` |
| MERGE | waiting/n/a | forbidden for `open-pr`; otherwise when CI green + independent review |
| VERSION | waiting | on main after merge → `<next>` · `npm run release:formal` when present |
| TAG | waiting | after CI green on stamp (or via `release:formal`) |

### Approve — reply with one
| Reply | Does |
|-------|------|
| `all` | reviewer/integrator — commit → push → PR + `gh pr merge --auto --squash` → release/stamp on main |
| `through-pr` | reviewer/integrator — commit → push → PR + auto-merge (version/tag later) |
| `open-pr` | author only — commit → push → create/update PR → labels/evidence → stop |
| `commit+push` | stop before PR |
| `commit` | commit only |
| `reject` | stop — add why |

### Transition

| | |
|---|---|
| **Mode** | `WAIT_OPERATOR` |
| **Next action** | Execute exactly the approved Formal Flow scope. |
| **Operator input required** | `<role-valid reply from the table above>` |
```

## After approval

Execute **only** the steps covered by the reply. Then report what ran (and stop).
Do not ask “shall I proceed?” after a valid approval; the approval is the
authority to continue through its stated boundary.

- Simple `all` / `commit+tag`: full stamp set + `check:version`; tag only when allowed.
- Formal branch commits: conventional prefix only — **no** stamp-set edits on the branch.
- Formal `open-pr`: create or update the PR; apply required labels; attach test
  results, screenshots when applicable, dependencies, risks, and review notes;
  then report the PR URL and stop. Do not approve, enable auto-merge, merge,
  version, tag, release, or release the branch claim.
- Formal `through-pr` / `all`: reviewer/integrator only; use
  `gh pr merge --auto --squash` after independent review. An author cannot
  approve either reply for their own PR.
- Formal version/tag: only on `main` after merge.

The independent reviewer or Master Dev handles the existing PR in a later
Formal Ship Gate. They own requested adjustments, merge approval, merge-time
version stamps, tags, release, and final claim release.

## Related

- Lane orchestration + Delivery Review: [agent-manager](../agent-manager/SKILL.md)
- Filled boards: [examples.md](./examples.md)
