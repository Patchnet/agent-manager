# Fleet — the live terminal board

`agent-manager fleet` is the operator's window onto every run the supervisor
knows about. It reads telemetry and the local knowledge store; it never writes
to either, so it is safe to leave open next to a working session.

```bash
agent-manager fleet                 # interactive board
agent-manager fleet --once          # one snapshot, then exit
agent-manager fleet --json          # machine-readable snapshot
agent-manager fleet --view goals    # start on a specific tab
```

## Design rules

The board follows one rule above all others: **the eye must find what needs you
first.**

- **One accent family.** Cyan means *in motion* (running, shipping). Yellow
  means *waiting on you* (needs input, delivery review, ship gate). Red is
  reserved for outright failure. Everything that has settled — reviewed,
  merged, released, done, cancelled — renders gray or dim. Success is carried
  by the `✓` glyph, not by a colour competing for attention.
- **IDs earn their length.** Run ids are truncated to their 8-character suffix
  everywhere a human reads them. The full id appears only where you would copy
  it: the run details pane and the command hints under a blocker.
- **Meaning over data.** Progress bars, state chips and relative times instead
  of raw trees and dumps.
- **Graceful degradation.** Narrow terminals drop optional columns, `--no-color`
  removes every escape sequence, and `--no-effects` disables animation and the
  alternate screen.

## Tabs

| Key | Tab | What it answers |
|---|---|---|
| `1` / `f` | Runs | What are my lanes doing right now? |
| `2` / `g` | Goals | Where was I, and what is drifting? |
| `3` / `c` | Core | How do goals and runs actually connect? |
| `4` / `t` | Tokens | What has this cost? |

`Tab` cycles. `r` refreshes the current tab. `q` quits.

### Runs

Attention-ranked: blocked runs first, then gates, then shipping, then everything
still active, then recent terminal runs. `↑`/`↓` (or `j`/`k`) select a run; the
details pane below shows lanes, harness and model, shipping progress, GitHub
Actions results, and any blocking prompt with the exact reply command.

`a` toggles the active-only filter.

### Goals

Roots only by default, grouped by the repository their runs targeted. Each root
carries a completed-leaf progress bar, a state chip, and two temporal columns:

| Column | Meaning |
|---|---|
| `AGE` | Time since the goal was created. |
| `TOUCHED` | Time since the most recent of: an edit to the goal or any of its descendants, or the start of a run intent referencing them. |

Times are compact — `45m`, `3h`, `6d`, `5w`, `8mo`. An open goal (planned,
active or blocked) with no touch for **14 days or more** gets a dim `stale`
chip. That is a visual signal only; nothing about the goal's lifecycle changes.

Open roots sort most-recently-touched first, so the tab reads as "where was I"
rather than as an unordered inventory.

| Key | Effect |
|---|---|
| `↑`/`↓`, `j`/`k` | Move the selection |
| `o` | Toggle the open-only filter (delivered and cancelled roots render dim when shown) |
| `x` | Expand the planned children collapsed behind `+N planned` |

Children appear only under the selected root. Planned children stay collapsed
behind a `+N planned` count until `x` expands them, so a wave with a dozen
not-yet-started lanes stays one line until you ask for the detail.

The detail pane for the selected goal shows its progress, when it was created,
when it was last touched and by what, and the last three run intents that
referenced it with their outcomes.

If the stored goal graph fails its integrity check, the tab does not disappear:
it prints a warning and falls back to stored lifecycles.

### Core

Two clearly separated regions:

1. **Goal map** — every goal root with its effective state, completed-leaf
   progress, and linkage counts (children, artifact links, runs), plus a `gaps`
   line counting runs with no `goal_refs` and goals with no links or runs.
2. **Run intents** — a paginated feed of run intents, newest first, with aligned
   columns and the run-to-goal link on the same line. `n` and `p` page through
   it.

### Tokens

See `docs/OPERATOR.md` for the token board and what its windows mean.

## The logomark

Fleet shows the Patchnet mark twice: once as a startup splash, and as a compact
`▦` glyph in every board header.

The art lives in **`assets/patch-mark.txt`** as a plain-text grid with its
palette declared in the file's own comment header:

```
#   d = #2a2620   deep warm charcoal
#   b = #3da8dc   signal blue
#   o = #d97757   ember
#   . = transparent
```

`loadLogomark()` parses that file and `renderLogomark()` paints it with full
blocks at render time. There is no image-processing dependency and no binary
asset in the repository — to retouch the mark, edit the grid, not the renderer.

The splash is skipped when:

- `--no-splash` is passed;
- `--no-effects` is passed, or the output is not a TTY;
- the terminal is narrower than 60 columns or shorter than 20 rows;
- the asset cannot be read.

It also disappears the moment you press any key, and never lasts longer than
about a second.

> **Packaging note:** `assets/` is not yet listed in the `files` array of the
> root `package.json`. Until it is, an installed copy of the package will skip
> the splash (the header glyph is unaffected, and nothing errors). Add
> `"assets/"` to that array when publishing.

## Related

- `docs/OPERATOR.md` — running lanes, replying to blockers, shipping
- `docs/GOAL-MODEL.md` — what goals, artifact links and run intents mean
