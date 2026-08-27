# Run classification, lineage, and stale records

Every new run records one `classification` value. Use the value to separate
production evidence from evaluations, walkthroughs, and follow-up attempts.

| Classification | Use it for |
|---|---|
| `operational` | Normal production work. This is the default for ordinary and Director-generated workflows. |
| `benchmark` | A controlled evaluation or A/B measurement. Keep the tested conditions in the planning record. |
| `demo` | A demonstration or training run. `agent-manager demo` always uses this value. |
| `retry` | A new attempt that repeats an earlier local run. |
| `recovery` | A new run that continues or salvages work from an earlier local run. It may use a newer base commit. |

Set the purpose in the workflow:

```yaml
classification: benchmark
```

The launch flag can set or override it:

```text
agent-manager run agent-manager.yaml --detach --classification benchmark
```

New retry and recovery runs require a local parent from the same canonical Git
repository. They do not cancel, close, supersede, or otherwise change the
parent.

```yaml
classification: retry
parent_run_id: run-20260827-120000-example
```

```text
agent-manager run agent-manager.yaml --detach \
  --classification recovery \
  --parent-run run-20260827-120000-example
```

Other classifications cannot declare a parent. Agent Manager validates the
classification and lineage before it creates the new run directory, run
intent, claims, or worktrees. Older records without `classification` remain
readable as `unknown`; they are not rewritten as operational work.

## Fleet filtering and measurement

Fleet shows the classification on each run row. Retry and recovery rows also
show their parent compactly. Filter every Fleet output mode with the same
option:

```text
agent-manager fleet --classification operational
agent-manager fleet --classification benchmark --once
agent-manager fleet --classification unknown --stream
agent-manager fleet --classification operational --json
```

Without the filter, Fleet continues to show all classifications. A filter only
changes the view; it never changes stored status. For measurements, select the
intended population explicitly. For example, use `benchmark` for controlled
test results and do not mix `demo`, `retry`, `recovery`, or legacy `unknown`
records into an operational success rate.

Classification makes the evidence attributable. It does not determine whether
a run succeeded. Worker completion means only that lane work stopped. Delivery
Review readiness means the work is ready for independent evaluation. Neither
is delivery success; use the final reviewed and shipped evidence required by
the delivery contract.

## Stale preview, cancellation, and cleanup

Preview old records before changing anything:

```text
agent-manager cleanup --stale --dry-run
agent-manager cleanup --stale --dry-run --json
```

The preview separates terminal cleanup candidates from old nonterminal runs
that require operator attention. It does not delete files, release claims,
remove worktrees, cancel work, rewrite status, or update timestamps.

- **Preview** is read-only. Use it to decide what needs attention.
- **Cancellation** ends a recoverable nonterminal run explicitly. Inspect the
  run before cancelling it.
- **Cleanup** removes eligible run-side resources after the run reaches an
  overall terminal state. Stale cleanup never cleans or cancels a nonterminal
  run automatically.

The JSON preview reports each run ID, state, classification, age in seconds,
reason, category, and recommended action.
