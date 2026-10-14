# Event stream

Every delivery transition is one JSON line, appended to:

- `<runsRoot>/events.jsonl`: every run, plus anything sent with `emit`
- `<runsRoot>/<runId>/events.jsonl`: the same lines for one run

The log is the integration point. Tools read it, `wait` blocks on it, and
sinks receive each line as it is written.

## Shape (`v: 1`)

```json
{"v":1,"ts":"2026-10-13T21:04:05.120Z","kind":"pr_opened","repo":"my-app","runId":"run-20261013-210102-ab12cd34","lane":"integrate","pr":42,"tier":1,"text":"https://github.com/org/my-app/pull/42","actor":"agent-manager"}
```

| Field | Type | Present |
|---|---|---|
| `v` | integer | always; `1` |
| `ts` | ISO-8601 string | always |
| `kind` | string | always; see below |
| `repo` | string | always; workflow `repo` value |
| `runId` | string | events from a run; optional for `emit` |
| `lane` | string | lane or delivery-target lane |
| `pr` | integer | PR events |
| `sha` | string | `merged`, `reverted` |
| `tier` | 0, 1, or 2 | shipping events |
| `verdict` | string | `review_verdict` |
| `text` | string | human-readable detail (question, reply, URL, state) |
| `actor` | string | always; `agent-manager`, a reviewer id, or the `--actor` given |

Compatibility: fields are only ever added. Renaming or removing a field, or
changing its type, bumps `v`. Consumers should ignore unknown fields and kinds.

## Kinds

| Kind | When |
|---|---|
| `lane_started` | a lane (or a resumed attempt) starts; `text` = harness · branch · scope |
| `lane_done` | a lane ends; `text` = `done\|failed\|cancelled: <last activity>` |
| `waiting_operator` | a lane asks a question, or a tier 2 change needs approval; `text` = the exact question |
| `operator_reply` | `reply` answered a lane; `text` = `Q: <question>\nA: <verbatim reply>` |
| `review_verdict` | `review` recorded `accept`, `revise`, or `reject`; `actor` = reviewer |
| `pr_opened` | `ship` opened or found the PR; `text` = URL |
| `automerge_armed` | `ship` enabled auto-merge |
| `merged` | the change reached the base branch; `sha` = merge commit |
| `reverted` | sent by a revert workflow or watcher with `emit` |
| `blocked` | the run stopped for a reason other than a question |
| `cancelled` | the run was cancelled |
| `run_closed` | the run reached a terminal state; `text` = the state |

Run-derived events are computed from `status.json` changes, so every writer
(supervisor, `reply`, `ship`, `wait`) produces them the same way.

## Sinks

```ini
# ~/.agent-manager/config.env
AGENT_MANAGER_EVENT_SINKS='["node /path/to/my-sink.mjs"]'
```

Each sink command (run through the shell) gets one event per invocation: the
exact line written to the log, on stdin. Sinks are fire-and-forget:

- 5 second timeout, then killed
- a non-zero exit or timeout is logged once per sink per process, on stderr
- a sink failure never fails a run, a status write, or `emit`

The file log is the only built-in sink. A sink that needs delivery guarantees
should keep its own outbox, or re-read `<runsRoot>/events.jsonl` to fill gaps.

## Emitting from outside a run

Threads that are not inside an agent-manager run (a plain coding session
opening its own PR, a revert workflow, a scheduled watcher) log the same events:

```bash
agent-manager emit pr_opened --repo my-app --pr 42 --tier 1 --text https://github.com/org/my-app/pull/42
agent-manager emit reverted --repo my-app --sha 1a2b3c --text "main red after 1a2b3c; revert PR #57" --actor revert-bot
```

## Waiting on events

```bash
agent-manager wait <runId>                 # next event for one run
agent-manager wait --kinds waiting_operator,merged   # next matching event from any run
```

`wait` prints the event and exits (`3` on `--timeout-sec`). Run it as a
background command; the harness wakes the thread when it exits. While a run's
PRs wait on auto-merge, `wait` also checks GitHub every minute, so the merge
itself becomes a `merged` event.
