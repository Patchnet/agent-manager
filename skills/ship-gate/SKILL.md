---
name: ship-gate
description: >-
  Present the standard Ship Gate approval board before any commit, push, PR,
  merge, version bump, or tag. Use when work is ready to ship, when the user
  asks to commit/push/PR/merge/tag/release, when recommending a version, or when
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
7. **Formal merge is auto-merge.** On `through-pr` / `all`, use
   `gh pr merge --auto --squash`. Never ask the operator to click Merge on GitHub.
8. After Formal merge or abandon, release any advisory claim for that branch
   (`agent-manager` / bundled `tools/claim.mjs` when that lane used claims).

## Approve vocabulary (operator replies with one)

| Reply | Meaning |
|-------|---------|
| `all` | Run every remaining step for this flow (including tag-after-green when VERSION is in scope) |
| `through-pr` | Formal only — commit → push → PR + auto-merge; version/tag later on main |
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
```

## Template — Formal Flow

```markdown
## Ship Gate · Formal

| | |
|---|---|
| **Repo** | `<name>` |
| **Branch** | `<type/slug>` |
| **Agent** | `<tool · model>` |
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
| PR | waiting | open + `gh pr merge --auto --squash` |
| MERGE | waiting | when CI green + review |
| VERSION | waiting | on main after merge → `<next>` · `npm run release:formal` when present |
| TAG | waiting | after CI green on stamp (or via `release:formal`) |

### Approve — reply with one
| Reply | Does |
|-------|------|
| `all` | commit → push → PR + `gh pr merge --auto --squash` → release/stamp on main |
| `through-pr` | commit → push → PR + auto-merge (version/tag later) |
| `commit+push` | stop before PR |
| `commit` | commit only |
| `reject` | stop — add why |
```

## After approval

Execute **only** the steps covered by the reply. Then report what ran (and stop).

- Simple `all` / `commit+tag`: full stamp set + `check:version`; tag only when allowed.
- Formal branch commits: conventional prefix only — **no** stamp-set edits on the branch.
- Formal PR steps: always `gh pr merge --auto --squash` — never “please click Merge”.
- Formal version/tag: only on `main` after merge.

## Related

- Lane orchestration + Delivery Review: [agent-manager](../agent-manager/SKILL.md)
- Filled boards: [examples.md](./examples.md)
