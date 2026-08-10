import { useEffect, useMemo, useState } from "react";
import { Chip } from "../components/Chip.jsx";
import { useApi, useRunDetail } from "../lib/api.js";
import { clockTime, isSettled, shortRunId, since } from "../lib/format.js";

const LANE_PIP_STATE = {
  running: "running",
  queued: "queued",
  "dependency-waiting": "queued",
  blocked: "blocked",
  needs_input: "needs_input",
  failed: "failed",
  done: "done",
  completed: "done",
};

function LanePips({ lanes = [] }) {
  if (!lanes.length) return <span className="subtle">-</span>;
  return (
    <span className="lane-pips">
      {lanes.map((lane) => (
        <i
          key={lane.id}
          className="pip"
          data-state={lane.needsInput ? "needs_input" : LANE_PIP_STATE[lane.state] || "done"}
          title={`${lane.id}: ${lane.needsInput ? "needs input" : lane.state}`}
        />
      ))}
    </span>
  );
}

/**
 * Runs that have stopped and are waiting on a human.
 *
 * These are lifted out of the table entirely rather than sorted to the top: a
 * blocked run is a different kind of object from a running one, and the whole
 * point of the board is that it takes zero scanning to find them.
 */
function AttentionCards({ runs, onSelect }) {
  if (!runs.length) return null;
  return (
    <>
      <div className="section-head">
        <h2>Needs you</h2>
        <span className="hint">
          {runs.length} run{runs.length === 1 ? "" : "s"} stopped for input
        </span>
      </div>
      <div className="attention-grid">
        {runs.map((run) => (
          <button
            type="button"
            key={run.runId}
            className="attention-card"
            onClick={() => onSelect(run.runId)}
          >
            <span className="who">
              <Chip state={run.state} tone="attention" />
              <span className="mono-id" style={{ color: "inherit" }}>
                {run.shortId}
              </span>
              <span className="subtle">{run.repoShorthand}</span>
            </span>
            <p className="ask">{run.blocker?.prompt || run.subject}</p>
            <div className="meta">
              {run.blocker?.scope === "lane" ? `lane ${run.blocker.id} · ` : ""}
              waiting {since(run.updatedAt)}
              {" · "}
              <code>agent-manager reply {run.shortId} …</code>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

function DetailPane({ runId, revision, onClose }) {
  const { data, error } = useRunDetail(runId, revision);

  if (!runId) {
    return (
      <div className="card detail">
        <div className="empty" style={{ border: "none", padding: "1.5rem 0" }}>
          <strong>No run selected</strong>
          Pick a row to see lanes, delivery, and the event history.
        </div>
      </div>
    );
  }
  if (error) return <div className="card detail error-banner">{error}</div>;
  if (!data) return <div className="card detail subtle">Loading…</div>;

  const status = data.status || {};
  const events = [...(data.events || [])].reverse().slice(0, 40);

  return (
    <div className="card detail">
      <div className="section-head" style={{ justifyContent: "space-between" }}>
        <h2>Run detail</h2>
        <button type="button" className="tab" onClick={onClose}>
          close
        </button>
      </div>
      <h3>{status.identity?.displayTitle || shortRunId(status.runId)}</h3>
      {/* Full id here because this is the pane you copy from. */}
      <div className="full-id">{status.runId}</div>

      <dl className="kv">
        <dt>State</dt>
        <dd>
          <Chip state={status.state} pulse />
        </dd>
        <dt>Repo</dt>
        <dd>{status.repo || "-"}</dd>
        <dt>Workflow</dt>
        <dd className="subtle">{status.workflow || "-"}</dd>
        <dt>Started</dt>
        <dd className="subtle">
          {status.startedAt ? `${clockTime(status.startedAt)} · ${since(status.startedAt)} ago` : "-"}
        </dd>
        {status.delivery ? (
          <>
            <dt>Delivery</dt>
            <dd>
              <Chip state={status.delivery.state} />{" "}
              <span className="subtle">
                review {status.delivery.review?.state || "-"}
              </span>
            </dd>
          </>
        ) : null}
        {status.ship ? (
          <>
            <dt>Ship</dt>
            <dd>
              <Chip state={status.ship.state} />{" "}
              <span className="subtle">{status.ship.phase || ""}</span>
              {status.ship.prUrl ? (
                <>
                  {" "}
                  <a href={status.ship.prUrl} target="_blank" rel="noreferrer">
                    PR
                  </a>
                </>
              ) : null}
            </dd>
          </>
        ) : null}
        {status.goalRefs?.length ? (
          <>
            <dt>Goals</dt>
            <dd className="subtle">{status.goalRefs.join(", ")}</dd>
          </>
        ) : null}
      </dl>

      <div className="section-head">
        <h2>Lanes</h2>
      </div>
      {(status.lanes || []).map((lane) => (
        <div className="lane-row" key={lane.id}>
          <Chip state={lane.needsInput ? "needs_input" : lane.state} pulse />
          <span className="lane-name">{lane.id}</span>
          <span className="lane-summary">
            {lane.needsInput?.prompt || lane.lastActivity || lane.scope || ""}
          </span>
        </div>
      ))}

      <div className="section-head" style={{ marginTop: "1rem" }}>
        <h2>Events</h2>
        <span className="hint">most recent first</span>
      </div>
      <div className="event-feed">
        {events.length ? (
          events.map((event, index) => (
            <div className="event-row" key={`${event.at}-${index}`}>
              <time>{clockTime(event.at)}</time>
              <span>
                {event.type || "status"} → {event.state}
              </span>
            </div>
          ))
        ) : (
          <div className="subtle">No events recorded.</div>
        )}
      </div>
    </div>
  );
}

export function RunsView({ revision, live }) {
  const { data, error, loading } = useApi("/api/runs", revision);
  const [selected, setSelected] = useState(null);
  const [showSettled, setShowSettled] = useState(false);

  // Prefer the pushed summary for state flips so the board reacts immediately
  // even while the fuller payload is still in flight.
  const runs = useMemo(() => {
    const base = data?.runs || [];
    if (!live?.runs?.length) return base;
    const patch = new Map(live.runs.map((run) => [run.runId, run]));
    return base.map((run) => ({ ...run, ...(patch.get(run.runId) || {}) }));
  }, [data, live]);

  const attention = runs.filter((run) => run.needsInput || run.state === "blocked");
  const rest = runs.filter((run) => !attention.includes(run));
  const visible = showSettled ? rest : rest.filter((run) => !isSettled(run.state));
  const hidden = rest.length - visible.length;

  useEffect(() => {
    if (selected && !runs.some((run) => run.runId === selected)) setSelected(null);
  }, [runs, selected]);

  if (loading && !data) return <div className="subtle">Reading telemetry…</div>;

  return (
    <>
      {error ? <div className="error-banner">{error}</div> : null}
      <AttentionCards runs={attention} onSelect={setSelected} />

      <div className="split">
        <div>
          <div className="section-head">
            <h2>Runs</h2>
            <span className="hint">
              {data?.counts?.active ?? 0} active · {data?.counts?.total ?? 0} total
            </span>
            {hidden > 0 || showSettled ? (
              <button
                type="button"
                className="tab"
                style={{ marginLeft: "auto" }}
                onClick={() => setShowSettled((value) => !value)}
              >
                {showSettled ? "hide settled" : `show ${hidden} settled`}
              </button>
            ) : null}
          </div>

          {visible.length ? (
            <table className="run-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Repo</th>
                  <th>Subject</th>
                  <th>State</th>
                  <th>Lanes</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((run) => (
                  <tr
                    key={run.runId}
                    onClick={() => setSelected(run.runId === selected ? null : run.runId)}
                    data-settled={isSettled(run.state)}
                    data-selected={run.runId === selected}
                  >
                    <td className="mono-id">{run.shortId}</td>
                    <td className="subtle">{run.repoShorthand}</td>
                    <td className="title-cell">{run.subject || "-"}</td>
                    <td>
                      <Chip state={run.state} pulse />
                    </td>
                    <td>
                      <LanePips lanes={run.lanes} />
                    </td>
                    <td className="subtle">{since(run.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">
              <strong>{runs.length ? "Nothing active" : "No runs yet"}</strong>
              {runs.length
                ? "Every run in the window has settled."
                : "Start one with agent-manager run <workflow.yaml> --detach"}
            </div>
          )}
        </div>

        <DetailPane runId={selected} revision={revision} onClose={() => setSelected(null)} />
      </div>
    </>
  );
}
