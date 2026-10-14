---
name: ship-gate
description: >-
  Decide how a finished change ships: classify it by file path into tier 0, 1,
  or 2, run the light independent review, then auto-merge with a one-line
  notice (tier 0/1) or ask the operator once (tier 2, or a manual version/tag).
  Use when work is ready to commit, push, open a PR, merge, or release, or when
  the user asks to ship. Bundled starter; an organization may replace it with
  its own ship-gate skill.
---

# Ship Gate

The files a change touches decide who must look at it. Judgment goes into the
tiers file once, not into every PR.

## 1. Classify

```bash
agent-manager tier --base origin/main      # or: node tools/ship-tier.mjs --base origin/main
```

The policy is `.github/ship-tiers.yml` on the base branch (no file: every path
is tier 1). A change takes the highest tier among its paths; editing the tiers
file is always tier 2.

| Tier | Typical paths | Gate |
|---|---|---|
| 0 | docs, tests, copy, canaries | required CI + automatic reviewer |
| 1 | product and UI (the default) | required CI + independent reviewer |
| 2 | billing/payments, DB migrations, auth/permissions, tenant data, `.github`/infra | required CI + independent reviewer + operator approval |

## 2. Review (independent, light)

The author thread may start its own reviewer: a fresh-context subagent given
only the brief and the diff, using [reviewer.md](./reviewer.md), or the
harness's review command (`/code-review`, `@codex review`). The author never
reviews its own diff in its own context.

- Blocking findings (correctness, safety, data, authz, drift from the brief):
  fix, re-run the affected tests, review again.
- Non-blocking notes: mention them in the PR; do not hold the merge.

## 3. Ship

Run the repository's required local checks first (its `test_gate`), then:

**Tier 0 or 1:** no approval board. Commit, push, open the PR, add the
`tier:N` label, and arm auto-merge (`gh pr merge --auto --squash`); in a
Simple Flow repo, push the one commit to `main`. Post one line:

```text
Ship · <repo> · tier 1 · PR <url> · auto-merge armed · reviewed by <reviewer>
```

Inside an agent-manager run, `agent-manager ship <runId>` does all of this.

**Tier 2:** open the PR with the `tier:2` label, do **not** arm auto-merge,
and ask once:

```markdown
**Ship Gate · tier 2** · <repo> · PR <url>
Touches: `<tier 2 paths>`
Intent: <one sentence on what changes for users or data>
Review: <verdict> by <reviewer> · checks: <local result>
Reply **approve** to arm auto-merge, or say what to change.
```

On `approve`, arm auto-merge (`agent-manager ship <runId> --approved-by <operator>`)
and post the one-line notice. Never approve tier 2 for the operator.

## Rules

1. Never hide a red check or weaken a test to get green.
2. Never merge over a failed required check, a blocking review finding, or an
   unresolved conflict. Conflicts are the author's to resolve: merge the base,
   re-run the affected tests, push.
3. Never push straight to a protected `main`, and never use admin bypass.
4. Versions and tags happen in the repository's scheduled release, not per
   change. A manual release outside that schedule is tier 2: show the version
   (`<current> → <next>`), the stamp files, and the release command, and wait
   for **approve**.
5. Release any scope claim after the merge or abandonment.
6. An explicit operator approval for a scope stays valid; do not ask twice.
