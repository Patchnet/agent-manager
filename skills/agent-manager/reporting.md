# agent-manager — reporting

Short, factual, from `status.json` or the event that woke you. One message per
event worth the operator's attention; silence for routine progress.

## Launch

```markdown
**Agent Manager · launched** `<runId>` — <title>
| Lane | Harness | Scope |
|---|---|---|
| api | codex | `src/api/**` |
| ui | claude | `src/ui/**` (after api) |
Waking on events.
```

## Question (lane `waiting_operator` or `blocked`)

```markdown
**Agent Manager · question** `<runId>` · lane `<laneId>`
> <the exact question from the event>

Options (if the lane gave any): <a> / <b>
I will reply with your answer and the lane resumes in the same session.
```

## Review

```markdown
**Agent Manager · review** `<runId>` → **<accept|revise|reject>** by <reviewer>
- Blocking: <none | one line each: correctness/safety/data/authz/brief drift>
- Notes: <non-blocking, at most three>
```

## Ship notice (tier 0/1)

One line, copied from `ship` output:

```text
Ship · <runId> · integrate · tier 1 · PR <url> · auto-merge armed
```

## Ship Gate (tier 2)

```markdown
**Ship Gate · tier 2** `<runId>` · PR <url or "direct push">
Touches: `<tier 2 paths>`
Intent: <one sentence: what changes for users or data>
Reviewer: <verdict, reviewer>
Reply **approve** to arm auto-merge, or say what to change.
```

## Outcome

```markdown
**Agent Manager · done** `<runId>` — merged `<sha>` (tier <n>) | closed: <reason> | rejected: <reason>
```
