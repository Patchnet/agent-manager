# agent-manager — chat reporting templates

**Mandatory.** Every model uses these markdown tables in chat. No freestyle
status walls, emoji dashboards, or invented schemas.

Fill from `status.json` / `report.md`. Use `n/a` when unknown. Refresh when
state changes, on a **Heartbeat** wake, or when the operator asks.

After detach, Master **must** arm `watch-signal` (see SKILL). On each wake:
unchanged + running → Heartbeat; changed → Run board; needs-input → Escalation;
terminal → Run outcome then **stop** the watch loop.

---

## Template — Heartbeat (unchanged running tick)

Post on a `watch-signal` `heartbeat` wake when the run is still `running` and
lane states did not change. Keep it short — not a full Run board.

Default cadence is **180s** (`--heartbeat-sec 180`). Operator may ask for
another interval at any time; Master restarts `watch-signal` with the new value.

```markdown
## Agent Manager · Heartbeat

` <runId> ` still **running** · elapsed ~`<Ns>` · updated `<updatedAt>`

| Lane | State | Elapsed | Last activity |
|------|-------|---------|---------------|
| `<id>` | `running\|…` | `<Ns>` | `<lastActivity>` |

_Side terminal:_ `node /path/to/agent-manager/bin/agent-manager.mjs monitor <runId>`
```

---

## Template — Run board (live / kickoff)

Post once when a run starts, then again on meaningful updates
(`state_change` wake or operator ask).

```markdown
## Agent Manager · Run board

| | |
|---|---|
| **runId** | `<runId>` |
| **repo** | `<repo>` |
| **state** | `running \| blocked \| done \| failed \| cancelled` |
| **target_dev_flow** | `simple \| formal` |
| **workflow** | `<path>` |
| **started** | `<ISO or local>` |
| **updated** | `<from status.json updatedAt>` |
| **telemetry** | `$AGENT_MANAGER_RUNS_ROOT/<runId>/status.json` |

### Lanes

| Lane | State | Harness | Branch | Elapsed | Last activity |
|------|-------|---------|--------|---------|---------------|
| `<id>` | `queued\|running\|blocked\|done\|failed\|cancelled` | `claude\|…` | `<branch>` | `<Ns>` | `<lastActivity>` |

### Actions
- Monitor (side terminal): `node /path/to/agent-manager/bin/agent-manager.mjs monitor <runId>`
- Watch-signal (Master loop): `node /path/to/agent-manager/bin/agent-manager.mjs watch-signal <runId>`
- Cancel: `node /path/to/agent-manager/bin/agent-manager.mjs cancel <runId>`
- Logs: `$AGENT_MANAGER_RUNS_ROOT/<runId>/<lane>/stdout.log`
```

---

## Template — Escalation (blocked / needs-input)

Post when any lane has `state: blocked` or `needsInput` set.

```markdown
## Agent Manager · Escalation

| | |
|---|---|
| **runId** | `<runId>` |
| **lane** | `<id>` |
| **branch** | `<branch>` |
| **type** | `question \| permission \| blocked` |

### Question
<prompt text from needs-input.json or lastActivity>

### Options (if any)
- `<A>`
- `<B>`

### Waiting on
Operator reply in this chat. Other independent lanes may keep running.

### Reply command
- `node /path/to/agent-manager/bin/agent-manager.mjs reply <runId> <lane> --message "<answer>"`
```

---

## Template — Run outcome (terminal)

Post when run `state` is `done`, `failed`, `cancelled`, or stuck `blocked`
awaiting a decision that ends the session slice.

```markdown
## Agent Manager · Run outcome

| | |
|---|---|
| **runId** | `<runId>` |
| **repo** | `<repo>` |
| **final state** | `done \| failed \| cancelled \| blocked` |
| **report** | `$AGENT_MANAGER_RUNS_ROOT/<runId>/report.md` |
| **target_dev_flow** | `simple \| formal` |
| **integrate** | `n/a \| ready \| blocked \| failed` · branch `<am/…/integrate>` |

### Lanes

| Lane | Final | Exit | Branch | Worktree / notes |
|------|-------|------|--------|------------------|
| `<id>` | `done\|failed\|…` | `<code>` | `<branch>` | `<short note / files touched if known>` |

### Recommended next
- [ ] **Delivery Review** (mandatory before Ship Gate — template below)
- [ ] Review integrate worktree when `status.integrate.state=ready`
- [ ] Answer open escalations (if any)
- [ ] Ship Gate only after Delivery Review verdict `accept` or `accept-with-notes`
- [ ] Formal: push → PR → `gh pr merge --auto --squash` (no manual Merge click)
- [ ] After merge: `npm run release:formal` when the target repo has it
- [ ] Release claims / remove worktrees when abandoned
- [ ] Manual fold if needed: `node /path/to/agent-manager/bin/agent-manager.mjs integrate <runId>`
- [ ] Cleanup abandoned artifacts: `node /path/to/agent-manager/bin/agent-manager.mjs cleanup <runId>`
```

---

## Template — Delivery Review (one-shot eval loop)

**Mandatory before Ship Gate** whenever a multi-lane (or multi-artifact) run
reaches a terminal `done` / partial-success state that Master intends to ship
or close.

Workers exiting 0 is **not** acceptance. Master Dev must:

1. Re-read the **original proposal** (decision, followup, workflow prompts, checklist).
2. **Verify** each deliverable in the worktrees against that proposal (not against
   lane self-summary alone). Cross-check coupled artifacts (schema ↔ sample ↔
   docs ↔ UI).
3. Post **Delivery Review · Pass 1** with a verdict. **Stop** for the operator
   unless the reply vocabulary below already authorizes the next step.

### One-eval-loop hard rule (no perpetual revise)

Per parent runId (the original multi-lane run under review):

| Phase | Who | Allowed? |
|-------|-----|----------|
| **Pass 1 — Delivery Review** | Master | **Once.** Post the board below (`eval_pass: 1`). |
| **Correction** | Workers | **Once.** Only if Pass 1 verdict is `revise` (same worktrees + patch prompts) or `relaunch` (one new workflow slice). |
| **Pass 2 — Correction report** | Master | **Once.** After correction finishes, re-verify and post **Delivery Review · Pass 2** (`eval_pass: 2`). Present to the **operator**. |
| **Further eval** | Master | **Forbidden.** Master must **not** open Pass 3, issue another `revise`/`relaunch`, or start another eval loop. Operator decides: Ship Gate, abandon, or a **new operator-ordered** run (new runId — not Master self-looping). |

`accept` / `accept-with-notes` / `reject` on Pass 1 skip correction — go straight to Ship Gate or close-out.

Lane exit codes and CI green may still leave **contract drift** (e.g. docs
sample ≠ live Zod). Call that out explicitly under Gaps.

```markdown
## Agent Manager · Delivery Review · Pass <1|2>

| | |
|---|---|
| **runId** | `<runId>` (parent run under review) |
| **eval_pass** | `1 \| 2` |
| **correction_used** | `no \| revise \| relaunch` (Pass 2 must show which; Pass 1 usually `no`) |
| **repo** | `<repo>` |
| **proposal** | `<decision id / follow-up id / workflow path / checklist>` |
| **reviewed** | `<ISO or local>` |
| **verdict** | Pass 1: `accept \| accept-with-notes \| revise \| relaunch \| reject` · Pass 2: `accept \| accept-with-notes \| reject` only |

### Proposal checklist

| Item | Asked | Delivered? | Evidence (path / test / note) |
|------|-------|------------|-------------------------------|
| `<checklist item>` | `<short ask>` | `yes \| partial \| no \| n/a` | `<path or proof>` |

### Cross-lane / contract checks

| Couple | OK? | Note |
|--------|-----|------|
| `<e.g. schema ↔ starter sample>` | `yes \| no \| n/a` | `<mismatch or proof>` |
| `<e.g. UI ↔ defaults / when gates>` | `yes \| no \| n/a` | |
| `<e.g. docs ↔ deleted/renamed paths>` | `yes \| no \| n/a` | |

### Gaps / feedback (by lane)

| Lane | Grade | Feedback for worker (actionable) |
|------|-------|----------------------------------|
| `<id>` | `<A–F or n/a>` | `<what to fix; cite files>` |

### Recommended next
- [ ] Pass 1 `accept` / `accept-with-notes` → integrate if needed → **Ship Gate**
- [ ] Pass 1 `revise` / `relaunch` → **one** correction → Pass 2 report to operator (Master must not eval again)
- [ ] Pass 1 `reject` → release claims; do not ship; file/update a follow-up record if needed
- [ ] Pass 2 `accept` / `accept-with-notes` → **Ship Gate**
- [ ] Pass 2 `reject` → stop; operator may order a **new** run (new runId) — Master does not self-loop

### Waiting on
Pass 1: operator `accept` | `accept-with-notes` | `revise` | `relaunch` | `reject`  
Pass 2: operator `accept` | `accept-with-notes` | `reject` (or operator-ordered new run)
```

---

## Refresh policy (Master Dev)

| Moment | Action |
|---|---|
| Run kicked off (`--detach`) | Capture `runId` from detach stdout; post **Run board** (chat stays free) |
| ~15–30s while running (or on operator ask) | Re-read `status.json`; post updated **Run board** only if something changed |
| Lane blocked | Post **Escalation** immediately |
| Run finished | Post **Run outcome**, then **Delivery Review · Pass 1** before Ship Gate |
| After one correction completes | Post **Delivery Review · Pass 2** to the operator — **no further Master eval** |
| Operator says “status?” | Re-read JSON; post **Run board** (current) |
| Operator says “review” / after outcome | Post Pass 1 if not yet posted; if Pass 2 already posted, do **not** open Pass 3 |

Do **not** await a foreground `run` to “know when it’s done.” Do **not** spam
identical boards. Do **not** skip Delivery Review because lanes exited 0.
Do **not** run a second correction or a third review pass.
Do **not** claim Canvas/`/loop` is wired unless it actually is for that session.
