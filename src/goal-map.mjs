import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { listBrainIntents } from "./brain.mjs";
import { computeGoalProgress } from "./goal-progress.mjs";
import { listGoalArtifactLinks, listGoals } from "./goals.mjs";
import { BRAIN_ROOT } from "./paths.mjs";

export const GOAL_MAP_SCHEMA = "agent-manager.goal-map.v1";
export const GOAL_MAP_EXPORT_SCHEMA = "agent-manager.goal-map-export.v1";

const SAFE_STATES = new Set([
  "active", "blocked", "cancelled", "delivered", "pending_delivery", "planned", "superseded",
]);

function compareStrings(left, right) {
  const a = String(left);
  const b = String(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function runId(run, index) {
  return String(run.runId || run.docId || run.id || `run-${index}`);
}

function runContribution(state) {
  if (["needs_input", "blocked", "failed", "rejected"].includes(state)) return "blocked";
  if (["admitted", "running", "shipping"].includes(state)) return "active";
  if (state === "pending_delivery") return "pending_delivery";
  if (["reviewed", "merged", "released"].includes(state)) return "delivered";
  if (["cancelled", "abandoned"].includes(state)) return "cancelled";
  return "planned";
}

/** Escape stored values before placing them in HTML text or attributes. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

/** Build a deterministic, serializable view model without reading the brain. */
export function buildGoalMapData(goalId, {
  goals = [],
  artifactLinks = [],
  runIntents = [],
} = {}) {
  const progress = computeGoalProgress(goalId, { goals, artifactLinks, runIntents });
  const subtreeIds = new Set(progress.goals.map((goal) => goal.goalId));
  const fullGoals = new Map(goals.map((goal) => [goal.id, goal]));
  const mapGoals = progress.goals.map((summary) => {
    const detail = fullGoals.get(summary.goalId);
    const nodeProgress = computeGoalProgress(summary.goalId, { goals, artifactLinks, runIntents });
    return {
      ...detail,
      effectiveState: summary.effectiveState,
      excluded: summary.excluded,
      leaf: summary.leaf,
      children: [...summary.children],
      completedLeafRatio: nodeProgress.completedLeafRatio,
    };
  });

  const evidenceByArtifact = new Map(
    progress.evidence
      .filter((item) => item.kind === "artifact")
      .map((item) => [item.id, item]),
  );
  const mapArtifacts = artifactLinks
    .filter((link) => subtreeIds.has(link.goalId))
    .sort((left, right) => compareStrings(left.id, right.id))
    .map((link) => ({
      ...link,
      contribution: evidenceByArtifact.get(link.id)?.contribution || "planned",
      excluded: evidenceByArtifact.get(link.id)?.excluded || false,
    }));

  const progressRunEvidence = progress.evidence.filter((item) => item.kind === "run");
  const mapRuns = runIntents
    .map((run, index) => ({ run, id: runId(run, index) }))
    .filter(({ run }) => (run.goalRefs || []).some((ref) => subtreeIds.has(ref)))
    .sort((left, right) => compareStrings(left.id, right.id))
    .map(({ run, id }) => {
      const attachedGoalIds = [...new Set(run.goalRefs || [])]
        .filter((ref) => subtreeIds.has(ref))
        .sort(compareStrings);
      const matchingEvidence = progressRunEvidence.filter((item) => item.id === id);
      return {
        id,
        title: run.title || null,
        state: String(run.state || "unknown"),
        phase: run.phase || null,
        goalIds: attachedGoalIds,
        contribution: matchingEvidence[0]?.contribution || runContribution(run.state),
        excluded: matchingEvidence.length > 0 && matchingEvidence.every((item) => item.excluded),
      };
    });

  return {
    schema: GOAL_MAP_SCHEMA,
    goalId: progress.goalId,
    title: progress.title,
    effectiveState: progress.effectiveState,
    completedLeafRatio: progress.completedLeafRatio,
    counts: progress.counts,
    basis: progress.basis,
    goals: mapGoals,
    artifactLinks: mapArtifacts,
    runs: mapRuns,
    blockers: progress.evidence.filter((item) => !item.excluded && item.contribution === "blocked"),
    activeRuns: mapRuns.filter((run) => (
      !run.excluded && ["active", "blocked", "pending_delivery"].includes(run.contribution)
    )),
    deliveredEvidence: progress.evidence.filter((item) => (
      !item.excluded && item.contribution === "delivered"
    )),
  };
}

export async function getGoalMapData(goalId, { root = BRAIN_ROOT } = {}) {
  const [goals, artifactLinks, runIntents] = await Promise.all([
    listGoals({ root }),
    listGoalArtifactLinks({ root }),
    listBrainIntents({ root }),
  ]);
  return buildGoalMapData(goalId, { goals, artifactLinks, runIntents });
}

function stateClass(state) {
  return SAFE_STATES.has(state) ? state : "planned";
}

function stateLabel(state) {
  return String(state || "unknown").replaceAll("_", " ");
}

function pill(state, label = stateLabel(state)) {
  return `<span class="pill state-${stateClass(state)}">${escapeHtml(label)}</span>`;
}

function ratioText(ratio) {
  return `${ratio.numerator} / ${ratio.denominator}`;
}

function evidenceLabel(item) {
  if (item.kind === "artifact") {
    return `${item.artifactType}: ${item.label || item.artifactRef} (${item.relationship})`;
  }
  if (item.kind === "run") return `Run ${item.id}${item.title ? `: ${item.title}` : ""}`;
  if (item.kind === "descendant") return `Descendant goal ${item.id}`;
  return `Goal ${item.id}`;
}

function renderEvidence(items, emptyMessage) {
  if (!items.length) return `<p class="empty">${escapeHtml(emptyMessage)}</p>`;
  return `<ul class="evidence-list">${items.map((item) => `
    <li>
      <div><strong>${escapeHtml(evidenceLabel(item))}</strong>${pill(item.contribution)}</div>
      <small>${escapeHtml(item.goalId)} · stored state: ${escapeHtml(item.state)}</small>
    </li>`).join("")}
  </ul>`;
}

function renderGoalTree(data) {
  const byId = new Map(data.goals.map((goal) => [goal.id, goal]));
  function node(goal) {
    const ratio = goal.completedLeafRatio;
    const details = [
      goal.outcome ? `<p><strong>Outcome</strong><br>${escapeHtml(goal.outcome)}</p>` : "",
      goal.dependencies?.length
        ? `<p><strong>Dependencies</strong><br>${goal.dependencies.map(escapeHtml).join(", ")}</p>`
        : "",
      goal.successCriteria?.length
        ? `<div><strong>Success criteria</strong><ul class="criteria">${goal.successCriteria.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
        : "",
    ].filter(Boolean).join("");
    const children = goal.children.map((id) => byId.get(id)).filter(Boolean);
    return `<li>
      <article class="goal-card${goal.excluded ? " excluded" : ""}">
        <div class="card-heading">
          <div><p class="eyebrow">${escapeHtml(goal.id)}</p><h3>${escapeHtml(goal.title)}</h3></div>
          ${pill(goal.effectiveState)}
        </div>
        <p class="metadata">Stored: ${escapeHtml(goal.lifecycle)} · ${escapeHtml(ratio.label)}: ${escapeHtml(ratioText(ratio))}</p>
        ${details || '<p class="empty">No outcome, dependencies, or success criteria recorded.</p>'}
      </article>
      ${children.length ? `<ul>${children.map(node).join("")}</ul>` : ""}
    </li>`;
  }
  return `<ul class="goal-tree">${node(byId.get(data.goalId))}</ul>`;
}

function renderRuns(runs) {
  if (!runs.length) return '<p class="empty">No active, blocked, or pending-delivery runs are attached.</p>';
  return `<div class="card-grid">${runs.map((run) => `<article class="compact-card">
    <div class="card-heading"><h3>${escapeHtml(run.title || run.id)}</h3>${pill(run.contribution)}</div>
    <p class="metadata">${escapeHtml(run.id)} · state: ${escapeHtml(run.state)}${run.phase ? ` · phase: ${escapeHtml(run.phase)}` : ""}</p>
    <p>Goals: ${run.goalIds.map(escapeHtml).join(", ")}</p>
  </article>`).join("")}</div>`;
}

function renderArtifacts(links) {
  if (!links.length) return '<p class="empty">No artifacts are linked to this goal tree.</p>';
  return `<div class="card-grid">${links.map((link) => `<article class="compact-card${link.excluded ? " excluded" : ""}">
    <div class="card-heading"><h3>${escapeHtml(link.label || link.artifactRef)}</h3>${pill(link.contribution)}</div>
    <p class="metadata">${escapeHtml(link.artifactType)} · ${escapeHtml(link.relationship)} · ${escapeHtml(link.goalId)}</p>
    <p class="reference">${escapeHtml(link.artifactRef)}</p>
  </article>`).join("")}</div>`;
}

/** Render a complete offline document. No stored value is emitted without escaping. */
export function renderGoalMapHtml(data) {
  const ratio = data.completedLeafRatio;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(data.title)} · Goal map</title>
  <style>
    :root { color-scheme: dark; --bg:#07111f; --panel:#101d2e; --panel-2:#15263a; --text:#f5f7fb; --muted:#aebed1; --line:#31445c; --accent:#72d7c4; --shadow:0 18px 50px rgba(0,0,0,.28); }
    * { box-sizing:border-box; }
    html { background:var(--bg); }
    body { margin:0; color:var(--text); background:radial-gradient(circle at 85% 0%,#153d53 0,transparent 35rem),var(--bg); font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
    header,main,footer { width:min(1180px,calc(100% - 2rem)); margin-inline:auto; }
    header { padding:4.5rem 0 2.25rem; }
    h1,h2,h3,p { margin-top:0; }
    h1 { max-width:850px; margin-bottom:.6rem; font-size:clamp(2.2rem,6vw,4.75rem); line-height:1.02; letter-spacing:-.045em; }
    h2 { margin-bottom:1.1rem; font-size:clamp(1.4rem,3vw,2rem); }
    h3 { margin-bottom:0; font-size:1.05rem; }
    .eyebrow { margin-bottom:.35rem; color:var(--accent); font-size:.78rem; font-weight:750; letter-spacing:.12em; text-transform:uppercase; overflow-wrap:anywhere; }
    .lede { max-width:780px; color:var(--muted); font-size:1.1rem; }
    .summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:.8rem; margin:1.5rem 0 2rem; }
    .metric,.goal-card,.compact-card,.section-panel { border:1px solid var(--line); border-radius:18px; background:linear-gradient(145deg,rgba(21,38,58,.96),rgba(12,25,41,.96)); box-shadow:var(--shadow); }
    .metric { padding:1rem 1.1rem; }
    .metric span { display:block; color:var(--muted); font-size:.78rem; text-transform:uppercase; letter-spacing:.08em; }
    .metric strong { display:block; margin-top:.28rem; font-size:1.35rem; overflow-wrap:anywhere; }
    .section-panel { margin:0 0 1rem; padding:clamp(1rem,3vw,1.6rem); }
    .section-note,.metadata,.empty,small { color:var(--muted); }
    .card-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.8rem; }
    .goal-card,.compact-card { padding:1rem 1.1rem; }
    .card-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; }
    .metadata { margin:.55rem 0 .8rem; font-size:.88rem; overflow-wrap:anywhere; }
    .pill { flex:none; display:inline-flex; align-items:center; border:1px solid currentColor; border-radius:999px; padding:.2rem .55rem; font-size:.72rem; font-weight:750; letter-spacing:.04em; text-transform:uppercase; }
    .state-delivered { color:#7de7ad; }.state-active { color:#74d9ff; }.state-blocked { color:#ff9e9e; }.state-pending_delivery { color:#ffd479; }.state-planned { color:#c5cde0; }.state-cancelled,.state-superseded { color:#aeb3bd; }
    .goal-tree,.goal-tree ul,.evidence-list,.criteria { list-style:none; margin:0; padding:0; }
    .goal-tree ul { margin:.75rem 0 0 1rem; padding-left:1.25rem; border-left:2px solid var(--line); }
    .goal-tree li + li { margin-top:.75rem; }
    .criteria { margin-top:.35rem; }
    .criteria li { position:relative; padding-left:1rem; }
    .criteria li::before { position:absolute; left:0; color:var(--accent); content:"✓"; }
    .evidence-list li { display:flex; justify-content:space-between; gap:1rem; padding:.8rem 0; border-top:1px solid var(--line); }
    .evidence-list li:first-child { border-top:0; padding-top:0; }
    .evidence-list li > div { display:flex; align-items:center; gap:.6rem; }
    .excluded { opacity:.62; }
    .reference { margin-bottom:0; overflow-wrap:anywhere; font-family:ui-monospace,"Cascadia Code",monospace; font-size:.88rem; }
    footer { padding:1rem 0 3rem; color:var(--muted); font-size:.86rem; }
    .goal-card,.compact-card { transition:transform .16s ease,border-color .16s ease; }
    .goal-card:hover,.compact-card:hover { transform:translateY(-2px); border-color:#50708f; }
    @media (max-width:760px) { header { padding-top:2.5rem; }.summary,.card-grid { grid-template-columns:1fr; }.evidence-list li { display:block; }.evidence-list small { display:block; margin-top:.3rem; }.goal-tree ul { margin-left:.25rem; padding-left:.75rem; } }
    @media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto !important; transition:none !important; animation:none !important; } }
  </style>
</head>
<body>
  <header>
    <p class="eyebrow">Agent Manager · Goal map</p>
    <h1>${escapeHtml(data.title)}</h1>
    <p class="lede">A local, evidence-based view of <strong>${escapeHtml(data.goalId)}</strong>. Progress is derived from goal, artifact, and run states; it is not an estimated percentage.</p>
    <div class="summary" aria-label="Goal summary">
      <div class="metric"><span>Effective state</span><strong>${escapeHtml(stateLabel(data.effectiveState))}</strong></div>
      <div class="metric"><span>${escapeHtml(ratio.label)}</span><strong>${escapeHtml(ratioText(ratio))}</strong></div>
      <div class="metric"><span>Goals in tree</span><strong>${escapeHtml(data.counts.goals.included)} included</strong></div>
      <div class="metric"><span>Evidence records</span><strong>${escapeHtml(data.counts.artifacts.included + data.counts.runs.included)} linked</strong></div>
    </div>
  </header>
  <main>
    <section class="section-panel" aria-labelledby="blockers-heading"><h2 id="blockers-heading">Blockers</h2>${renderEvidence(data.blockers, "No blocking evidence is present in this goal tree.")}</section>
    <section class="section-panel" aria-labelledby="runs-heading"><h2 id="runs-heading">Runs in motion</h2><p class="section-note">Active, blocked, and pending-delivery run intents attached to this tree.</p>${renderRuns(data.activeRuns)}</section>
    <section class="section-panel" aria-labelledby="goals-heading"><h2 id="goals-heading">Goal tree</h2>${renderGoalTree(data)}</section>
    <section class="section-panel" aria-labelledby="artifacts-heading"><h2 id="artifacts-heading">Linked artifacts</h2>${renderArtifacts(data.artifactLinks)}</section>
    <section class="section-panel" aria-labelledby="delivered-heading"><h2 id="delivered-heading">Delivered evidence</h2>${renderEvidence(data.deliveredEvidence, "No delivered evidence is recorded in this goal tree.")}</section>
  </main>
  <footer>Completed-leaf ratio: ${escapeHtml(ratio.numerator)} delivered leaves out of ${escapeHtml(ratio.denominator)} included leaves. Superseded branches are excluded. Effective-state precedence: ${escapeHtml(data.basis.precedence.join(" → "))}.</footer>
</body>
</html>
`;
}

export async function exportGoalMap(goalId, {
  root = BRAIN_ROOT,
  outputPath = null,
  cwd = process.cwd(),
} = {}) {
  const data = await getGoalMapData(goalId, { root });
  const target = resolve(cwd, outputPath || `${data.goalId}-map.html`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, renderGoalMapHtml(data), { encoding: "utf8", mode: 0o600 });
  return {
    schema: GOAL_MAP_EXPORT_SCHEMA,
    goalId: data.goalId,
    effectiveState: data.effectiveState,
    completedLeafRatio: data.completedLeafRatio,
    outputPath: target,
  };
}
