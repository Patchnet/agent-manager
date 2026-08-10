import { useState } from "react";
import { Bar, Chip } from "../components/Chip.jsx";
import { useApi } from "../lib/api.js";
import { humanizeAge, isoDate, stateTone } from "../lib/format.js";

// Mirrors the TUI Goals tab: roots only, grouped by repo, children on demand,
// planned children collapsed behind a count, and the temporal context
// (age / last touched / stale) that answers "where was I?".

function barTone(state) {
  const tone = stateTone(state);
  return tone === "attention" ? "attention" : tone === "settled" ? "settled" : "live";
}

function GoalHistory({ entry }) {
  return (
    <div className="goal-history">
      <div>
        created {entry.createdAt ? isoDate(entry.createdAt) : "unknown"}
        {entry.ageMs != null ? ` (${humanizeAge(entry.ageMs)} ago)` : ""}
        {" · last touched "}
        {entry.touchedAt
          ? `${humanizeAge(entry.touchedMs)} ago by ${entry.touchedBy?.label || "unknown"}`
          : "never"}
      </div>
      {entry.runs?.length ? (
        <div className="runs">
          <span className="subtle">
            last {entry.runs.length} of {entry.runCount} linked run
            {entry.runCount === 1 ? "" : "s"}
          </span>
          {entry.runs.map((run) => (
            <span className="run-line" key={run.runId}>
              <span className="mono-id">{run.shortId}</span>
              <span>
                {run.phase}/{run.state}
              </span>
              <span>{run.repoLabel || "-"}</span>
              <span>{run.startedAt ? isoDate(run.startedAt) : "-"}</span>
            </span>
          ))}
        </div>
      ) : (
        <div className="subtle" style={{ marginTop: ".35rem" }}>
          No run intents reference this goal yet.
        </div>
      )}
    </div>
  );
}

function GoalRoot({ entry, expanded, onToggle }) {
  const [showPlanned, setShowPlanned] = useState(false);
  const visibleChildren = (entry.children || []).filter(
    (child) => showPlanned || !child.planned,
  );

  return (
    <div className="goal-root" data-open={entry.open}>
      <button type="button" className="goal-line" onClick={onToggle}>
        <Chip state={entry.effectiveState} pulse />
        <span className="goal-title">{entry.goal.title}</span>
        {entry.stale ? <Chip tone="muted">stale</Chip> : null}
        <Bar
          numerator={entry.progress.numerator}
          denominator={entry.progress.denominator}
          tone={barTone(entry.effectiveState)}
        />
        <span className="ratio">
          {entry.progress.denominator
            ? `${entry.progress.numerator}/${entry.progress.denominator}`
            : "—"}
        </span>
        <span className="age" title="age since created">
          {entry.ageMs != null ? humanizeAge(entry.ageMs) : "-"}
        </span>
        <span className="age" title="time since last touched">
          {entry.touchedMs != null ? humanizeAge(entry.touchedMs) : "-"}
        </span>
      </button>

      {expanded ? (
        <>
          {visibleChildren.length || entry.plannedChildren ? (
            <div className="goal-children">
              {visibleChildren.map((child) => (
                <div className="goal-child" key={child.goal.id}>
                  <Chip state={child.effectiveState} />
                  <span className="goal-title">{child.goal.title}</span>
                  {child.stale ? <Chip tone="muted">stale</Chip> : null}
                  <Bar
                    numerator={child.progress.numerator}
                    denominator={child.progress.denominator}
                    tone={barTone(child.effectiveState)}
                  />
                  <span className="age">
                    {child.touchedMs != null ? humanizeAge(child.touchedMs) : "-"}
                  </span>
                </div>
              ))}
              {entry.plannedChildren && !showPlanned ? (
                <button
                  type="button"
                  className="planned-toggle"
                  onClick={() => setShowPlanned(true)}
                >
                  +{entry.plannedChildren} planned
                </button>
              ) : null}
              {showPlanned ? (
                <button
                  type="button"
                  className="planned-toggle"
                  onClick={() => setShowPlanned(false)}
                >
                  hide planned
                </button>
              ) : null}
            </div>
          ) : null}
          <GoalHistory entry={entry} />
        </>
      ) : null}
    </div>
  );
}

export function GoalsView({ revision }) {
  const { data, error, loading } = useApi("/api/goals", revision);
  const [expanded, setExpanded] = useState(null);
  const [openOnly, setOpenOnly] = useState(true);

  if (loading && !data) return <div className="subtle">Reading the goal graph…</div>;
  if (error) return <div className="error-banner">{error}</div>;

  if (data && data.available === false) {
    return (
      <div className="empty">
        <strong>No goal graph available</strong>
        {data.error || "The brain has not been initialised on this machine."}
        <div style={{ marginTop: ".75rem" }}>
          <code>agent-manager brain init</code>
        </div>
      </div>
    );
  }

  const groups = (data?.groups || [])
    .map((group) => ({
      ...group,
      roots: openOnly ? group.roots.filter((entry) => entry.open) : group.roots,
    }))
    .filter((group) => group.roots.length);

  return (
    <>
      <div className="section-head">
        <h2>Goals</h2>
        <span className="hint">
          {data?.counts?.open ?? 0} open · {data?.counts?.roots ?? 0} roots ·{" "}
          {data?.counts?.stale ?? 0} stale
        </span>
        <button
          type="button"
          className="tab"
          style={{ marginLeft: "auto" }}
          onClick={() => setOpenOnly((value) => !value)}
        >
          {openOnly ? "show all" : "open only"}
        </button>
      </div>

      {data?.degraded ? (
        <div className="error-banner">
          Goal graph failed its integrity check — showing stored lifecycles only.
        </div>
      ) : null}

      {groups.length ? (
        groups.map((group) => (
          <div className="goal-group" key={group.repo}>
            <h3>{group.repo}</h3>
            {group.roots.map((entry) => (
              <GoalRoot
                key={entry.goal.id}
                entry={entry}
                expanded={expanded === entry.goal.id}
                onToggle={() =>
                  setExpanded(expanded === entry.goal.id ? null : entry.goal.id)
                }
              />
            ))}
          </div>
        ))
      ) : (
        <div className="empty">
          <strong>No goals to show</strong>
          {openOnly ? "Nothing open — switch to “show all”." : "Create one with agent-manager goal create."}
        </div>
      )}
    </>
  );
}
