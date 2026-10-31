---
name: ship-gate
description: >-
  Decide how a finished change ships: through the repository's pipeline gate
  when it has one, by path tier with auto-merge when it has only a tier policy,
  and stop for the operator when it has neither. Use when work is ready to
  commit, push, open a PR, merge, or release, or when the user asks to ship.
  Bundled starter; an organization may replace it with its own ship-gate skill.
version: 2.0.0
purpose: Route a finished change to the repository's gate or tier policy, with no approval step.
author_model: Claude Code (claude-opus-5-5)
created: 2026-07-30
updated: 2026-10-30
---

# Ship Gate

Automated checks decide whether a change ships, not a person reading each one.
Nobody approves a change, except in the one stop below.

## 1. Find the route

Look at the **base branch**, so a change cannot pick its own route:

| Base branch has | Route | Who is asked |
|---|---|---|
| `pipeline.json` and `scripts/quality.mjs` | the gate, then push to the base | nobody |
| a usable `.github/ship-tiers.yml`, no gate | a tier label, then PR with auto-merge, or one commit pushed in Simple Flow | nobody |
| no gate and no usable policy | stop | the operator, once for this change |

The gate wins when a repository has both, and tiers do not apply there. Without
a gate, a policy that is missing, empty, or malformed means stop: it never means
tier 1. `agent-manager tier --base origin/main` shows the route.

## 2. Review (independent, light)

The author thread may start its own reviewer: a fresh-context subagent given
only the brief and the diff, using [reviewer.md](./reviewer.md), or the
harness's review command (`/code-review`, `@codex review`). The author never
reviews its own diff in its own context.

- Blocking findings (correctness, safety, data, authz, drift from the brief):
  fix, re-run the affected tests, review again.
- Non-blocking notes: mention them with the change; do not hold it.

## 3. Ship

Inside an agent-manager run, `agent-manager ship <runId>` does all of this.

**Gate:** commit one change with a conventional message, rebase on the base, run
`node scripts/quality.mjs`, and push to the base. A declared Formal Flow does not
change this. If the gate fails, fix the change and run it again. Post one line:

```text
Ship · <repo> · gate · merged <sha> · reviewed by <reviewer>
```

**Tier policy:** run the repository's required local checks first (its
`test_gate`). Commit, push, open the PR, add the `tier:N` label, and arm
auto-merge (`gh pr merge --auto --squash`); in a Simple Flow repo, push the one
commit to the base. Post one line:

```text
Ship · <repo> · tier 1 · PR <url> · auto-merge armed · reviewed by <reviewer>
```

**Stop:** push nothing to the base, and ask once:

```markdown
**Ship Gate** · <repo> · no gate and no usable ship policy
Intent: <one sentence on what changes for users or data>
Review: <verdict> by <reviewer> · checks: <local result>
Add a policy file or the gate, or reply **approve** to ship this one change.
```

On `approve`, run `agent-manager ship <runId> --approved-by <operator>` and post
the one-line notice. Never approve for the operator.

## Rules

1. Never hide a red check or weaken a test to get green.
2. Never push over a failed gate, and never merge over a failed required check,
   a blocking review finding, or an unresolved conflict. Conflicts are the
   author's to resolve: merge the base, re-run the affected tests, push.
3. Never push straight to a protected base branch, and never use admin bypass.
4. Versions and tags come from the repository's release, not from a change.
5. Production belongs to Ops: rollouts, rings, and any stop before production.
   A change never deploys, and shipping to the base is not a deploy.
6. Release any scope claim after the merge or abandonment.
7. An explicit operator approval for a scope stays valid; do not ask twice.
