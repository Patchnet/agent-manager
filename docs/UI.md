# Dashboard (`agent-manager ui`)

**Optional. Read-only. Localhost. No daemon.**

A small web view over the same run telemetry the terminal boards read. It is a
convenience for the moments a browser beats a TUI — a wide goal graph, a long
event history, a second monitor left open while lanes run — and nothing more.

## Quickstart

```bash
# once: build the single-page app (its own dependency tree, not the CLI's)
cd ui
npm install
npm run build

# then, from the repository root
agent-manager ui
```

The command prints the URL it bound and opens a browser. `Ctrl-C` stops the
server; nothing is left running.

If `ui/dist` has not been built, `agent-manager ui` does **not** fail. It serves
the API plus a page telling you the two commands above, so a fresh clone still
gets a working `/api/runs`.

### Options

| Flag | Default | Notes |
|---|---|---|
| `--port <n>` | `4317` | `0` binds a free port |
| `--host <addr>` | `127.0.0.1` | loopback addresses only |
| `--no-open` | — | do not launch a browser |
| `--json` | — | print the bound address as JSON, then keep serving |

## The architecture boundary

This is the line the dashboard does not cross:

> **The CLI is the product. The dashboard is optional read-only glass over the
> telemetry contract.**

Concretely:

- **Read-only.** Every route is a reader. The server answers `GET` and `HEAD`
  and rejects every other method with `405`. There is no endpoint that can
  start, reply to, ship, or cancel a run — those are CLI verbs, and they stay
  CLI verbs. If a control seems to belong in the dashboard, it belongs in
  `agent-manager` first.
- **No daemon.** The server exists only while the command is in the foreground.
  Nothing is installed, nothing is scheduled, nothing survives `Ctrl-C`.
- **Localhost only.** It binds a loopback address and refuses anything else —
  `--host 0.0.0.0` is a hard error, not a warning. There is no authentication
  because there is nothing to authenticate: the socket never leaves the
  machine. That is only true while the bind is loopback, which is why the
  refusal is not configurable.
- **No new core dependencies.** The server is `node:http` and nothing else. The
  SPA has its own `package.json` under `ui/`; the CLI never imports from it and
  works identically whether or not it was built.
- **No telemetry leaves the machine.** The dashboard reads local files and
  serves them to a local browser. Nothing is uploaded anywhere.

Because both surfaces read the same `status.json` files through the same
modules the terminal boards use, the dashboard cannot disagree with
`agent-manager fleet` — and cannot move a run into a state the CLI did not put
it in.

## Views

**Runs.** Runs waiting on a human are lifted out of the table into cards at the
top — a blocked run is a different kind of object from a running one, and
finding it should take zero scanning. The table below shows live runs (settled
ones collapse behind a toggle), with lane pips, state chips, and short run ids.
Selecting a row opens a detail pane with lanes, delivery, ship state, the full
copyable run id, and the event history.

**Goals.** Goal roots grouped by repo, each with a completed-leaf progress bar,
a state chip, and the temporal context the TUI shows: age since created, time
since last touched, and a `stale` chip on open goals untouched for 14+ days.
Expanding a root reveals its children (planned ones stay behind a `+N planned`
count) and a history strip: created date, what last touched it, and the recent
runs that referenced it.

**Tokens.** The same window semantics as `agent-manager tokens`: `ALL LOGGED`
alongside `TODAY` and `LAST 7D`, plus by-model and by-repo breakdowns. The
footnote is repeated here on purpose — these numbers are spend already
incurred, not a remaining balance. Subscription plans do not expose quota.

## API

Served under `/api`, JSON except where noted:

| Route | Returns |
|---|---|
| `GET /api/health` | viewer version, telemetry root, whether `ui/dist` is built |
| `GET /api/runs` | run board summaries (`agent-manager.fleet.v1`) |
| `GET /api/runs/<runId>` | full `status.json` plus recent events |
| `GET /api/goals` | goal graph with progress and temporal context |
| `GET /api/tokens` | usage windows and by-model / by-repo breakdowns |
| `GET /api/events` | `text/event-stream` of live updates |

`/api/events` emits a `hello` frame, an immediate `runs` frame, and a further
`runs` frame whenever the runs root changes. Changes are detected with a cheap
fingerprint over each `status.json` (size and mtime), so an atomic status
rewrite that fires several filesystem events still produces one client event.
An OS watcher accelerates the common case; a poll is the actual contract,
because recursive watching is unavailable or unreliable on some platforms.

Missing data degrades rather than failing: with no brain initialised,
`/api/goals` returns `available: false` and an explanation, and the Goals view
renders its own empty state.

## Developing the UI

```bash
cd ui
npm run dev     # http://127.0.0.1:5173, proxies /api to the running server
```

Keep `agent-manager ui` running in another terminal — the Vite dev server only
serves the front end.

`ui/dist` and `ui/node_modules` are gitignored; only SPA source is tracked.

## Design notes

The dashboard follows the same restraint contract as the terminal boards: one
accent family (signal blue) means *live*, ember means *this wants you*, and
everything settled falls back to warm gray. Run ids are truncated to their
8-character suffix everywhere a human reads them, and shown in full only in the
detail pane, where copy/paste is the point. The Patchnet mark is drawn as
inline SVG — a 3×3 grid of rounded squares sharing the palette of the terminal
logomark asset — so the favicon needs no binary file in the repository.
