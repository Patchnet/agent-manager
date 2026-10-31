---
version: 2.0.0
purpose: The report formats for agent-manager runs.
author_model: Claude Code (claude-opus-5-5)
created: 2026-07-29
updated: 2026-10-30
---

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

## Ship notice

One line, copied from `ship` output:

```text
Ship · <runId> · integrate · gate · merged <sha>
Ship · <runId> · integrate · tier 1 · PR <url> · auto-merge armed
```

## Ship stop (no gate, no usable policy)

```markdown
**Ship Gate** `<runId>` · PR <url or "nothing pushed"> · no gate and no usable ship policy
Intent: <one sentence: what changes for users or data>
Reviewer: <verdict, reviewer>
Add a policy file or the gate, or reply **approve** to ship this one change.
```

## Outcome

```markdown
**Agent Manager · done** `<runId>` — merged `<sha>` (gate or tier <n>) | closed: <reason> | rejected: <reason>
```
