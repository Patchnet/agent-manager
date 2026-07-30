# Ship Gate — filled examples

## Simple (ready)

## Ship Gate · Simple

| | |
|---|---|
| **Repo** | `my-app` |
| **Branch** | `main` |
| **Agent** | Cursor · Grok |
| **Version.md** | enabled · current `0.4.2` |
| **Test gate** | `none` · suite **n/a** |
| **check:version** | **pending stamp** |

### Done
- [x] Work complete
- [x] Tests (if required)
- [x] Version recommendation ready
- [ ] Full stamp set ready (`Version.md` + `package.json` + `package-lock.json` when present)
- [ ] `npm run check:version` pass (before tag)

### Needs your OK
| Step | Action | Detail |
|------|--------|--------|
| COMMIT | waiting | `docs: clarify ship-gate pointer in README` |
| VERSION | waiting | `0.4.2` → `0.4.3` · full stamp set via bump script when available |
| TAG | waiting | `v0.4.3` only after check:version |
| PUSH | waiting | `main` first; tag after green when CI applies |

### Approve — reply with one
| Reply | Does |
|-------|------|
| `all` | stamp → check:version → commit → push → (CI if required) → tag |
| `commit+tag` | stamp → check:version → commit + tag, no push |
| `commit` | commit only |
| `reject` | stop — add why |

## Formal (ready — feature branch)

## Ship Gate · Formal

| | |
|---|---|
| **Repo** | `my-app` |
| **Branch** | `fix/version-stamp-lockfile` |
| **Agent** | Cursor · Grok |
| **Claim** | lane `version-stamp` · scope `scripts/bump-version.mjs` |
| **Version** | at merge (not on branch) · current `1.2.0` |
| **Test gate** | `full` · suite **pass** |
| **CI** | n/a (not pushed yet) |
| **PR** | none |
| **check:version** | **n/a** (no stamp on branch) |

### Done
- [x] Work complete on branch
- [x] Tests (if required)
- [x] Claim held / scope clear
- [ ] Code-review run (required before merge)
- [ ] Full stamp set ready on main
- [ ] `npm run check:version` pass on stamp
- [ ] CI quality green on stamp commit (before tag)

### Needs your OK
| Step | Action | Detail |
|------|--------|--------|
| COMMIT | waiting | `fix: keep package-lock in version stamp set` |
| PUSH | waiting | `origin fix/version-stamp-lockfile` |
| PR | waiting | open + `gh pr merge --auto --squash` |
| MERGE | waiting | when CI green + review |
| VERSION | waiting | on main after merge → `1.2.1` |
| TAG | waiting | after CI green on stamp |

### Approve — reply with one
| Reply | Does |
|-------|------|
| `all` | commit → push → PR + auto-merge → release/stamp on main |
| `through-pr` | commit → push → PR + auto-merge (version/tag later) |
| `commit+push` | stop before PR |
| `commit` | commit only |
| `reject` | stop — add why |
