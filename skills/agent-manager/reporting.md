# agent-manager — chat reporting templates

**Mandatory.** Every model uses these markdown tables in chat. No freestyle
status walls, emoji dashboards, or invented schemas.

Fill from `status.json` / `report.md`. Use `n/a` when unknown. Refresh when
state changes, on a **Heartbeat** wake, or when the operator asks.

## Mandatory transition footer

End every board with this block. Never end a turn with only “stage complete.”

```markdown
### Transition

| | |
|---|---|
| **Mode** | `AUTO_CONTINUE \| WAIT_OPERATOR \| TERMINAL` |
| **Next action** | `<exact action>` |
| **Operator input required** | `none \| <exact reply vocabulary>` |
```

- `AUTO_CONTINUE`: perform the next action before ending the turn. If that
  action presents an approval board, end that board with `WAIT_OPERATOR`.
- `WAIT_OPERATOR`: ask one exact question or present exact replies, then stop.
- `TERMINAL`: post final evidence, complete source-system closeout, and stop.

Use `agent-manager next-action <runId> --json` when the correct transition is
unclear. Its result is authoritative for cadence; `status.json` remains
authoritative for run facts.

After detach, Master **must** arm `watch-signal` (see SKILL). On each wake:
unchanged + running → Heartbeat; changed → Run board; needs-input → Escalation;
`delivery_review_pending` → Run outcome then Delivery Review while the watcher
stays active; overall terminal (`reviewed|merged|released|rejected|failed|cancelled`) →
final outcome then **stop**. After an accepted
Delivery Review and Ship Gate approval, switch to the canonical templates in
[`../pr-manager/reporting.md`](../pr-manager/reporting.md).

---

## Template — Build plan / launch proposal

Post before launch. Do not ask twice: if the operator already authorized this
exact plan, use `AUTO_CONTINUE` and launch it.

```markdown
## Agent Manager · Build plan

| | |
|---|---|
| **repo / base** | `<repo>` · `<reviewed SHA>` |
| **plan** | `<planning.planRef>` |
| **lanes / concurrency** | `<count>` / `<maxConcurrency>` |
| **integration** | `<single integrate branch \| ordered delivery train \| review-only>` |
| **verification** | `<commands or evidence>` |
| **main risk** | `<risk or none>` |

| Lane | Owns | Depends on | Deliverable |
|---|---|---|---|
| `<id>` | `<scope>` | `<lane ids or none>` | `<result>` |

### Transition

| | |
|---|---|
| **Mode** | `<AUTO_CONTINUE if already authorized; otherwise WAIT_OPERATOR>` |
| **Next action** | `<launch detached \| wait for launch approval>` |
| **Operator input required** | `<none \| launch \| revise \| reject>` |
```

---

## Template — Heartbeat (unchanged running tick)

Post on a `watch-signal` `heartbeat` wake when the run is still `running` and
lane states did not change. Keep it short — not a full Run board.

Default cadence is **180s** (`--heartbeat-sec 180`). Operator may ask for
another interval at any time; Master restarts `watch-signal` with the new value.

```markdown
## Agent Manager · Heartbeat

` <runId> ` still **running** · elapsed ~`<Ns>` · updated `<updatedAt>`

Runtime: `<runtime.os>/<runtime.arch> (<runtime.hostPlatform>) · <runtime.shell> · <runtime.commandMode>`

| Lane | State | Elapsed | Last activity |
|------|-------|---------|---------------|
| `<id>` | `running\|…` | `<Ns>` | `<lastActivity>` |

_Side terminal:_ `agent-manager monitor <runId>`

### Transition

| | |
|---|---|
| **Mode** | `AUTO_CONTINUE` |
| **Next action** | Keep monitoring the detached run. |
| **Operator input required** | `none` |
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
| **title** | `<identity.displayTitle>` |
| **repo** | `<repo>` |
| **Manager Harness** | `<identity.manager.harness or n/a>` |
| **Manager Model** | `<identity.manager.model or n/a>` |
| **state** | `running \| delivery_review_pending \| correction_pending \| ship_gate_pending \| shipping \| blocked \| release_pending \| reviewed \| filed \| merged \| released \| rejected \| failed \| cancelled` |
| **target_dev_flow** | `simple \| formal` |
| **runtime** | `<runtime.os>/<runtime.arch> (<runtime.hostPlatform>) · <runtime.shell> · <runtime.commandMode>` |
| **workflow** | `<path>` |
| **plan** | `<planning.planRef>` |
| **planning context** | `sha256:<planning.contextDigest>` |
| **started** | `<ISO or local>` |
| **updated** | `<from status.json updatedAt>` |
| **telemetry** | `$AGENT_MANAGER_RUNS_ROOT/<runId>/status.json` |

### Lanes

| Lane | State | Harness | Model | Branch | Elapsed | Last activity |
|------|-------|---------|-------|--------|---------|---------------|
| `<id>` | `queued\|running\|blocked\|done\|failed\|cancelled` | `claude\|…` | `<observed \| requested + unverified>` | `<branch>` | `<Ns>` | `<lastActivity>` |

### Actions
- Monitor (side terminal): `agent-manager monitor <runId>`
- Watch-signal (Master loop): `agent-manager watch-signal <runId>`
- Cancel: `agent-manager cancel <runId>`
- Logs: `$AGENT_MANAGER_RUNS_ROOT/<runId>/<lane>/stdout.log`

### Transition

| | |
|---|---|
| **Mode** | `AUTO_CONTINUE` |
| **Next action** | Keep monitoring; advance on the next state change. |
| **Operator input required** | `none` |
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
| **runtime** | `<runtime.os>/<runtime.arch> (<runtime.hostPlatform>) · <runtime.shell> · <runtime.commandMode>` |

### Question
<prompt text from needs-input.json or lastActivity>

### Options (if any)
- `<A>`
- `<B>`

### Waiting on
Operator reply in this chat. Other independent lanes may keep running.

### Reply command
- `agent-manager reply <runId> <lane> --message "<answer>"`

### Transition

| | |
|---|---|
| **Mode** | `WAIT_OPERATOR` |
| **Next action** | Resume the exact blocked lane after the answer. |
| **Operator input required** | `<exact answer or listed option>` |
```

---

## Template — Run outcome (workers complete)

Post when run `state` becomes `delivery_review_pending`. It means the workers
completed; it is not a terminal delivery state. A `blocked` run uses the
Escalation template. Failed, cancelled, or rejected runs use Final outcome.

```markdown
## Agent Manager · Run outcome

| | |
|---|---|
| **runId** | `<runId>` |
| **repo** | `<repo>` |
| **run state** | `delivery_review_pending` |
| **delivery state** | `<delivery.state>` |
| **report** | `$AGENT_MANAGER_RUNS_ROOT/<runId>/report.md` |
| **target_dev_flow** | `simple \| formal` |
| **runtime** | `<runtime.os>/<runtime.arch> (<runtime.hostPlatform>) · <runtime.shell> · <runtime.commandMode>` |
| **integrate** | `n/a \| ready \| blocked \| failed` · branch `<am/…/integrate>` |

### Lanes

| Lane | Final | Exit | Branch | Worktree / notes |
|------|-------|------|--------|------------------|
| `<id>` | `done\|failed\|…` | `<code>` | `<branch>` | `<short note / files touched if known>` |

### Recommended next
- [ ] **Delivery Review** (mandatory before Ship Gate — template below)
- [ ] Persist the decision: `agent-manager review <runId> --pass <n> --verdict <decision> --reviewer <id>`
- [ ] Review integrate worktree when `status.integrate.state=ready`
- [ ] Answer open escalations (if any)
- [ ] Ship Gate only after Delivery Review verdict `accept` or `accept-with-notes`
- [ ] After Ship Gate approval: detach `agent-manager ship <runId> ... --detach`
- [ ] Post PR Manager Handoff and stop babysitting CI/merge in this chat
- [ ] Do not remove worktrees while delivery remains incomplete
- [ ] Manual fold if needed: `agent-manager integrate <runId>`
- [ ] Cleanup only after overall terminal closeout; incomplete delivery is retained

### Transition

| | |
|---|---|
| **Mode** | `AUTO_CONTINUE` |
| **Next action** | Verify the work and present Delivery Review Pass 1 now. |
| **Operator input required** | `none` |
```

---

## Template — Correction kickoff

Post immediately after persisting `revise` or `relaunch`. The verdict itself
authorizes one correction; do not ask whether to begin it.

```markdown
## Agent Manager · Correction kickoff

| | |
|---|---|
| **runId** | `<parent runId>` |
| **method** | `revise \| relaunch` |
| **correction attempt** | `1 of 1` |
| **monitoring** | `armed` |

| Lane | Exact gap | Required proof |
|---|---|---|
| `<id>` | `<file/behavior to correct>` | `<test/evidence>` |

### Transition

| | |
|---|---|
| **Mode** | `AUTO_CONTINUE` |
| **Next action** | Run the correction and present Delivery Review Pass 2 when it finishes. |
| **Operator input required** | `none` |
```

---

## Template — Delivery Review (one-shot eval loop)

**Mandatory before Ship Gate** whenever a multi-lane (or multi-artifact) run
enters `delivery_review_pending`. Worker completion is not a terminal delivery
state and does not authorize shipping or cleanup.

Workers exiting 0 is **not** acceptance. Master Dev must:

1. Re-read the **original proposal** (decision, followup, workflow prompts, checklist).
   Confirm it matches the recorded planning reference, reviewed base, and frozen
   context digest.
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

After the operator chooses a verdict, persist it before any Ship Gate:

```bash
agent-manager review <runId> --pass <1|2> \
  --verdict <accept|accept-with-notes|revise|relaunch|reject> \
  --reviewer <reviewer-id> [--notes "<evidence or constraints>"]
```

Chat acceptance alone is not machine-readable approval. `agent-manager ship`
fails closed until `status.json` contains an accepted review decision.

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
| **runtime** | `<runtime.os>/<runtime.arch> (<runtime.hostPlatform>) · <runtime.shell> · <runtime.commandMode>` |
| **proposal** | `<decision id / follow-up id / workflow path / checklist>` |
| **planning context** | `sha256:<status.planning.contextDigest>` |
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

### Transition

| | |
|---|---|
| **Mode** | `WAIT_OPERATOR` |
| **Next action** | Persist the selected verdict, then advance without another confirmation. |
| **Operator input required** | `<the pass-specific reply vocabulary above>` |
```

---

## Template — Goal closeout required

Use for `filed`, `rejected`, `failed`, or `cancelled` runs whose declared goals
still need an explicit disposition.

```markdown
## Agent Manager · Goal closeout

| | |
|---|---|
| **runId** | `<runId>` |
| **run state** | `filed \| rejected \| failed \| cancelled` |
| **historical evidence** | `retained` |
| **goals needing disposition** | `<goal ids with lifecycle>` |

### Command

`agent-manager reconcile <runId> --goal-disposition <goal-id>=<outcome> --operator <id>`

Repeat `--goal-disposition` for every goal. Outcomes: `delivered`,
`superseded`, `deferred`, `open`, or `cancelled`.

### Transition

| | |
|---|---|
| **Mode** | `WAIT_OPERATOR` |
| **Next action** | Record the explicit dispositions, then post Final outcome. |
| **Operator input required** | `delivered \| superseded \| deferred \| open \| cancelled` per goal |
```

---

## Template — Final outcome

Post for overall `reviewed`, `filed`, `merged`, `released`, `rejected`, `failed`, or `cancelled` after any required goal dispositions are settled. A `filed`, `rejected`, `failed`, or `cancelled` run with open goal hints stays `WAIT_OPERATOR` until the goal closeout receipt exists.

`goals awaiting advancement` comes from `next-action --json` (`goalHints`) or the
report's **Goal advancement** block. It is a hint for the operator — never
advance a goal automatically.

```markdown
## Agent Manager · Final outcome

| | |
|---|---|
| **runId** | `<runId>` |
| **state** | `reviewed \| filed \| merged \| released \| rejected \| failed \| cancelled` |
| **evidence** | `<PR / merge SHA / release SHA / tag / artifact bundle / error>` |
| **artifacts filed** | `<closeout.artifactRef + count, or n/a>` |
| **goals awaiting advancement** | `<goal ids with lifecycle, or none>` |
| **remaining risk** | `<none or exact item>` |
| **source closeout** | `<updated \| pending with owner>` |

### Transition

| | |
|---|---|
| **Mode** | `TERMINAL` |
| **Next action** | Complete source-system closeout and stop watching. |
| **Operator input required** | `none` |
```

---

## Template — Filed (accepted, not shipped)

Post instead of Ship Gate when the operator accepts work that will not ship —
research, audits, investigations. Never use `cancel` for this: `filed` is a
delivered outcome, `cancelled` means abandoned.

```markdown
## Agent Manager · Filed

| | |
|---|---|
| **runId** | `<runId>` |
| **state** | `filed` |
| **filed by / when** | `<delivery.filed.operator>` · `<delivery.filed.filedAt>` |
| **reason** | `<delivery.filed.reason>` |
| **accepted but unshipped** | `<delivery.filed.unshippedTargets, or none>` |
| **artifact bundle** | `<closeout.bundleRoot>` |
| **artifact reference** | `<closeout.artifactRef>` · `<closeout.artifactCount>` files |
| **goal links** | `<goalId → linkId, or none>` |
| **goal dispositions** | `<goalId → delivered \| superseded \| deferred \| open \| cancelled>` |
| **goals awaiting advancement** | `<goal ids with lifecycle, or none>` |

### Command used

```bash
agent-manager closeout <runId> --operator <id> \
  --goal-disposition <goal-id>=<outcome> --reason "<why>"
```

### Transition

| | |
|---|---|
| **Mode** | `TERMINAL` |
| **Next action** | Advance any listed goals, complete source-system closeout, and stop watching. |
| **Operator input required** | `none` |
```

---

## Refresh policy (Master Dev)

| Moment | Action |
|---|---|
| Build plan ready | Post **Build plan**; launch immediately when already authorized |
| Run kicked off (`--detach`) | Capture `runId`; post **Run board**, arm watch, and keep going |
| ~15–30s while running (or on operator ask) | Re-read `status.json`; post updated **Run board** only if something changed |
| Lane blocked | Post **Escalation** immediately |
| Workers finished (`delivery_review_pending`) | Post **Run outcome**, then **Delivery Review · Pass 1**; keep the watcher active |
| Operator says `revise` / `relaunch` | Persist it, post **Correction kickoff**, and launch the one correction without another prompt |
| After one correction completes | Post **Delivery Review · Pass 2** to the operator — **no further Master eval** |
| Delivery Review accepted | Persist it and present **Ship Gate** in the same turn |
| Accepted work will not ship | Run `agent-manager closeout` and post **Filed** — never `cancel` accepted work |
| Overall terminal | Post **Final outcome**, list any goals awaiting advancement, close the source record, and stop watching |
| Operator says “status?” | Re-read JSON; post **Run board** (current) |
| Operator says “review” / after outcome | Post Pass 1 if not yet posted; if Pass 2 already posted, do **not** open Pass 3 |

Do **not** await a foreground `run` to “know when it’s done.” Do **not** spam
identical boards. Do **not** skip Delivery Review because lanes exited 0.
Do **not** run a second correction or a third review pass.
Do **not** call a change-producing run delivered until its overall state is
`merged` or `released`. Review-only or approved no-change work is terminal at
`reviewed`.
Do **not** claim Canvas/`/loop` is wired unless it actually is for that session.
