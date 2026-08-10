import { listBrainIntents } from "./brain.mjs";
import { computeGoalProgress, getGoalProgress } from "./goal-progress.mjs";
import { inspectGoalGraph, listGoalArtifactLinks, listGoals } from "./goals.mjs";
import { BRAIN_ROOT, BRAIN_ROOT_SOURCE } from "./paths.mjs";
import { currentVersionInfo } from "./version.mjs";

export const GOALS_BOARD_SCHEMA = "agent-manager.goals-board.v2";

const DAY_MS = 86_400_000;
export const STALE_AFTER_MS = 14 * DAY_MS;
const UNASSIGNED_REPO = "unassigned";

const CSI = String.fromCodePoint(27) + "[";
const SGR = {
  reset: 0,
  bold: 1,
  dim: 2,
  gray: 90,
  cyan: 36,
  yellow: 93,
  white: 97,
  brightCyan: 96,
};

// One accent family carries "this is live"; everything settled falls back to
// gray so the eye lands on the work that still needs the operator.
const TONE_COLOR = {
  live: "brightCyan",
  attention: "yellow",
  muted: "gray",
  settled: "gray",
};

const STATE_TONE = {
  blocked: "attention",
  pending_delivery: "attention",
  active: "live",
  planned: "muted",
  delivered: "settled",
  cancelled: "settled",
  superseded: "settled",
};

const TERMINAL_STATES = new Set(["delivered", "cancelled", "superseded"]);
const STALE_ELIGIBLE_STATES = new Set(["planned", "active", "blocked"]);

function style(enabled, ...codes) {
  const text = codes.pop();
  if (!enabled) return text;
  const prefix = codes.map((code) => `${CSI}${SGR[code] ?? 0}m`).join("");
  return `${prefix}${text}${CSI}${SGR.reset}m`;
}

function pad(value, width, align = "left") {
  let text = String(value ?? "-");
  if (text.length > width) text = width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
  const missing = " ".repeat(Math.max(0, width - text.length));
  return align === "right" ? missing + text : text + missing;
}

function compareStrings(left, right) {
  return String(left).localeCompare(String(right));
}

function parseTime(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDate(value) {
  const parsed = parseTime(value);
  return parsed ? new Date(parsed).toISOString().slice(0, 10) : "unknown";
}

/** Compact relative age: 45m, 3h, 6d, 5w, 8mo, 2y. */
export function humanizeAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(ms / DAY_MS);
  if (days < 14) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** A run id is only useful to a reader as its unique suffix. */
export function shortRunId(value) {
  const text = String(value || "-");
  const match = /^run-\d{8}-\d{6}-(.+)$/.exec(text);
  return match ? match[1].slice(-8) : text.slice(-8);
}

function goalLabel(goalId) {
  return String(goalId || "").replace(/^goal-/, "") || "-";
}

export function progressBar(numerator, denominator, width = 8) {
  if (!denominator) return "·".repeat(width);
  const ratio = Math.max(0, Math.min(1, numerator / denominator));
  const filled = Math.min(width, Math.round(ratio * width));
  return "━".repeat(filled) + "─".repeat(Math.max(0, width - filled));
}

function stateColor(state) {
  return TONE_COLOR[STATE_TONE[state] || "muted"] || "gray";
}

function stateLabel(state) {
  return String(state || "unknown").replace(/_/g, " ").toUpperCase();
}

function collectDescendants(goalId, childrenByParent) {
  const found = [];
  const queue = [...(childrenByParent.get(goalId) || [])];
  while (queue.length) {
    const goal = queue.shift();
    found.push(goal);
    queue.push(...(childrenByParent.get(goal.id) || []));
  }
  return found;
}

function pickRepo(intents) {
  const counts = new Map();
  for (const intent of intents) {
    const label = String(intent.repoLabel || "").trim();
    if (!label) continue;
    const current = counts.get(label) || { count: 0, latest: 0 };
    counts.set(label, {
      count: current.count + 1,
      latest: Math.max(current.latest, parseTime(intent.startedAt)),
    });
  }
  const ranked = [...counts.entries()].sort((left, right) => (
    right[1].latest - left[1].latest
    || right[1].count - left[1].count
    || compareStrings(left[0], right[0])
  ));
  return ranked.length ? ranked[0][0] : UNASSIGNED_REPO;
}

/**
 * Build the goals view model from graph data that has already been read.
 *
 * Kept pure so the board can be exercised without a brain on disk. Progress
 * reuses the shared completed-leaf computation; when the stored graph fails its
 * integrity check the snapshot degrades to stored lifecycles rather than
 * throwing the Goals tab away.
 */
export function composeGoalsSnapshot({
  goals = [],
  artifactLinks = [],
  runIntents = [],
  root = BRAIN_ROOT,
  rootSource = BRAIN_ROOT_SOURCE,
  limit = 24,
  now = Date.now(),
  viewer = null,
} = {}) {
  const childrenByParent = new Map();
  for (const goal of goals) {
    if (!goal.parentId) continue;
    const siblings = childrenByParent.get(goal.parentId) || [];
    siblings.push(goal);
    childrenByParent.set(goal.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((left, right) => compareStrings(left.id, right.id));
  }

  const intentsByGoal = new Map();
  for (const intent of runIntents) {
    for (const goalId of intent.goalRefs || []) {
      const attached = intentsByGoal.get(goalId) || [];
      attached.push(intent);
      intentsByGoal.set(goalId, attached);
    }
  }

  const degraded = !inspectGoalGraph({ goals, artifactLinks }).valid;
  const progressFor = (goal) => {
    if (!degraded) {
      try {
        const computed = computeGoalProgress(goal.id, { goals, artifactLinks, runIntents });
        return {
          numerator: computed.completedLeafRatio.numerator,
          denominator: computed.completedLeafRatio.denominator,
          value: computed.completedLeafRatio.value,
          effectiveState: computed.effectiveState,
        };
      } catch {
        // fall through to the stored lifecycle
      }
    }
    return { numerator: 0, denominator: 0, value: null, effectiveState: goal.lifecycle };
  };

  const describeGoal = (goal) => {
    const progress = progressFor(goal);
    const subtree = [goal, ...collectDescendants(goal.id, childrenByParent)];
    const intents = [...new Set(subtree.flatMap((item) => intentsByGoal.get(item.id) || []))]
      .sort((left, right) => parseTime(right.startedAt) - parseTime(left.startedAt)
        || compareStrings(right.runId, left.runId));

    const goalTouchedAt = subtree.reduce((latest, item) => Math.max(
      latest,
      parseTime(item.updatedAt),
      parseTime(item.createdAt),
    ), 0);
    const latestIntent = intents[0] || null;
    const intentTouchedAt = parseTime(latestIntent?.startedAt);
    const touchedAt = Math.max(goalTouchedAt, intentTouchedAt);
    const touchedBy = latestIntent && intentTouchedAt >= goalTouchedAt
      ? { kind: "run", label: `run ${shortRunId(latestIntent.runId)}`, runId: latestIntent.runId }
      : { kind: "goal", label: "goal edit", runId: null };

    const createdAt = parseTime(goal.createdAt);
    const open = !TERMINAL_STATES.has(progress.effectiveState);
    const stale = STALE_ELIGIBLE_STATES.has(progress.effectiveState)
      && touchedAt > 0
      && (now - touchedAt) >= STALE_AFTER_MS;

    return {
      goal,
      progress,
      effectiveState: progress.effectiveState,
      open,
      planned: progress.effectiveState === "planned",
      stale,
      repo: pickRepo(intents),
      createdAt: createdAt ? new Date(createdAt).toISOString() : null,
      ageMs: createdAt ? Math.max(0, now - createdAt) : null,
      touchedAt: touchedAt ? new Date(touchedAt).toISOString() : null,
      touchedMs: touchedAt ? Math.max(0, now - touchedAt) : null,
      touchedBy,
      runs: intents.slice(0, 3).map((intent) => ({
        runId: intent.runId,
        shortId: shortRunId(intent.runId),
        title: intent.title || null,
        repoLabel: intent.repoLabel || null,
        state: intent.state || "unknown",
        phase: intent.phase || "unknown",
        startedAt: intent.startedAt || null,
      })),
      runCount: intents.length,
    };
  };

  const rootEntries = goals
    .filter((goal) => !goal.parentId)
    .map((goal) => {
      const entry = describeGoal(goal);
      const children = (childrenByParent.get(goal.id) || []).map(describeGoal);
      return {
        ...entry,
        children,
        plannedChildren: children.filter((child) => child.planned).length,
      };
    })
    .sort((left, right) => Number(right.open) - Number(left.open)
      || parseTime(right.touchedAt) - parseTime(left.touchedAt)
      || compareStrings(left.goal.id, right.goal.id));

  const visibleRoots = rootEntries.slice(0, limit);
  const grouped = new Map();
  for (const entry of visibleRoots) {
    const group = grouped.get(entry.repo) || { repo: entry.repo, roots: [], rank: 0 };
    group.roots.push(entry);
    if (entry.open) group.rank = Math.max(group.rank, parseTime(entry.touchedAt));
    grouped.set(entry.repo, group);
  }
  const groups = [...grouped.values()].sort((left, right) => (
    Number(left.repo === UNASSIGNED_REPO) - Number(right.repo === UNASSIGNED_REPO)
    || right.rank - left.rank
    || compareStrings(left.repo, right.repo)
  ));

  const snapshot = {
    schema: GOALS_BOARD_SCHEMA,
    viewer: viewer || currentVersionInfo(),
    brain: { root, source: rootSource },
    at: new Date(now).toISOString(),
    degraded,
    counts: {
      roots: rootEntries.length,
      total: goals.length,
      open: rootEntries.filter((entry) => entry.open).length,
      stale: rootEntries.filter((entry) => entry.stale).length,
      hidden: Math.max(0, rootEntries.length - visibleRoots.length),
    },
    groups: groups.map((group) => ({ repo: group.repo, roots: group.roots })),
  };
  snapshot.rows = visibleGoalRows(snapshot);
  return snapshot;
}

export async function buildGoalsSnapshot({
  root = BRAIN_ROOT,
  rootSource = BRAIN_ROOT_SOURCE,
  limit = 24,
  now = Date.now(),
} = {}) {
  const [goals, artifactLinks, runIntents] = await Promise.all([
    listGoals({ root }),
    listGoalArtifactLinks({ root }),
    listBrainIntents({ root }),
  ]);
  return composeGoalsSnapshot({ goals, artifactLinks, runIntents, root, rootSource, limit, now });
}

/**
 * Project the snapshot into the selectable row list.
 *
 * Roots only by default: children appear for the selected root, and planned
 * children stay collapsed behind a `+N planned` count until they are expanded.
 */
export function visibleGoalRows(snapshot, {
  openOnly = true,
  selectedGoalId = null,
  expandPlanned = false,
} = {}) {
  const rows = [];
  for (const group of snapshot.groups || []) {
    for (const entry of group.roots) {
      if (openOnly && !entry.open) continue;
      rows.push({ kind: "root", group: group.repo, depth: 0, goal: entry.goal, entry });
      if (entry.goal.id !== selectedGoalId) continue;
      for (const child of entry.children) {
        if (child.planned && !expandPlanned) continue;
        rows.push({ kind: "child", group: group.repo, depth: 1, goal: child.goal, entry: child });
      }
    }
  }
  return rows;
}

export async function enrichSelectedGoal(goalId, { root = BRAIN_ROOT } = {}) {
  if (!goalId) return null;
  try {
    return await getGoalProgress(goalId, { root });
  } catch {
    return null;
  }
}

function emptyBoard(lines, color) {
  lines.push("");
  lines.push(style(color, "yellow", "  No goals yet."));
  lines.push("");
  lines.push(style(color, "white", "  In your harness chat, say:"));
  lines.push(style(color, "cyan", '  "Use agent-manager for <repo>. Here is the wave dump: …"'));
  lines.push(style(color, "gray", "  The agent should create a parent goal + children before launching lanes."));
  lines.push("");
  lines.push(style(color, "gray", "  Or create one yourself:"));
  lines.push(style(color, "gray", "  agent-manager goal create --title \"My wave\" --lifecycle active"));
  lines.push("");
  return lines.join("\n");
}

function detailPane(lines, entry, progress, { color, contentWidth }) {
  lines.push(style(color, "gray", "─".repeat(contentWidth)));
  lines.push([
    style(color, "bold", "SELECTED"),
    style(color, stateColor(entry.effectiveState), stateLabel(entry.effectiveState)),
    style(color, "gray", entry.goal.id),
  ].join("  "));
  lines.push(`  ${style(color, "white", entry.goal.title)}`);

  const ratio = entry.progress;
  lines.push([
    `  ${style(color, "gray", "Progress")}`,
    style(color, ratio.denominator ? stateColor(entry.effectiveState) : "gray", progressBar(ratio.numerator, ratio.denominator, 12)),
    style(color, "gray", ratio.denominator
      ? `${ratio.numerator}/${ratio.denominator} leaves delivered`
      : "no leaf goals yet"),
  ].join(" "));

  const created = entry.createdAt
    ? `${isoDate(entry.createdAt)} (${humanizeAge(entry.ageMs)} ago)`
    : "unknown";
  const touched = entry.touchedAt
    ? `${humanizeAge(entry.touchedMs)} ago by ${entry.touchedBy.label}`
    : "never";
  lines.push(`  ${style(color, "gray", "History ")} created ${created} · last touched ${touched}`);

  if (entry.runs.length) {
    lines.push(`  ${style(color, "gray", "Runs    ")} ${style(color, "gray", `last ${entry.runs.length} of ${entry.runCount}`)}`);
    for (const run of entry.runs) {
      lines.push([
        `    ${style(color, "cyan", pad(run.shortId, 10))}`,
        style(color, "gray", pad(`${run.phase}/${run.state}`, 22)),
        style(color, "gray", pad(run.repoLabel || "-", 18)),
        style(color, "gray", run.startedAt ? isoDate(run.startedAt) : "-"),
      ].join(" "));
    }
  } else {
    lines.push(`  ${style(color, "gray", "Runs    ")} ${style(color, "gray", "no run intents reference this goal yet")}`);
  }

  if (progress?.basis?.decisiveEvidence?.length) {
    const decisive = progress.basis.decisiveEvidence
      .slice(0, 3)
      .map((item) => `${item.kind}:${item.kind === "run" ? shortRunId(item.id) : goalLabel(item.id)}`)
      .join(" · ");
    lines.push(style(color, "gray", `  Because  ${progress.effectiveState} from ${decisive}`));
  }
}

export function formatGoalsBoard(snapshot, {
  color = false,
  selectedGoalId = null,
  progress = null,
  width = 120,
  openOnly = true,
  expandPlanned = false,
} = {}) {
  const terminalWidth = Math.max(72, width || 120);
  const contentWidth = terminalWidth - 2;
  const lines = [];
  const version = snapshot.viewer?.runtimeVersion || "unknown";
  const counts = snapshot.counts;

  lines.push([
    `${style(color, "brightCyan", "▦")} ${style(color, "bold", "AGENT MANAGER")}`,
    style(color, "gray", `v${version} · GOALS`),
    ` ${style(color, "brightCyan", `${counts.open} open`)}`,
    style(color, "gray", `· ${counts.roots} roots · ${counts.total} goals`),
    counts.stale ? style(color, "yellow", `· ${counts.stale} stale`) : "",
  ].filter(Boolean).join(" "));
  if (snapshot.brain?.root) {
    lines.push(style(color, "gray", `Brain: ${snapshot.brain.root} [${snapshot.brain.source || "unknown"}]`));
  }
  if (snapshot.degraded) {
    lines.push(style(color, "yellow", "Goal graph failed its integrity check — showing stored lifecycles only."));
  }
  lines.push(style(color, "gray", "─".repeat(contentWidth)));

  if (!counts.total) return emptyBoard(lines, color);

  const rows = visibleGoalRows(snapshot, { openOnly, selectedGoalId, expandPlanned });
  if (!rows.length) {
    lines.push("");
    lines.push(style(color, "yellow", "  No open goal roots."));
    lines.push(style(color, "gray", "  Press o to include delivered and cancelled roots."));
    lines.push("");
    return lines.join("\n");
  }

  const stateWidth = 16;
  const barWidth = 8;
  const ratioWidth = 7;
  const ageWidth = 5;
  const touchedWidth = 8;
  const chipWidth = 5;
  const titleWidth = Math.max(
    24,
    contentWidth - (2 + stateWidth + barWidth + 1 + ratioWidth + ageWidth + touchedWidth + chipWidth + 6),
  );

  // The leading field is the one-character selection marker, so the header
  // pads to the same single column.
  lines.push(style(color, "gray", [
    " ",
    pad("GOAL", titleWidth),
    pad("STATE", stateWidth),
    pad("PROGRESS", barWidth + 1 + ratioWidth),
    pad("AGE", ageWidth, "right"),
    pad("TOUCHED", touchedWidth, "right"),
  ].join(" ")));

  let currentGroup = null;
  for (const row of rows) {
    if (row.group !== currentGroup) {
      currentGroup = row.group;
      lines.push(style(color, "gray", currentGroup));
    }
    const entry = row.entry;
    const selected = row.goal.id === selectedGoalId;
    const indent = row.depth ? "└ " : "";
    const ratio = entry.progress;
    const line = [
      selected ? "›" : " ",
      pad(`${indent}${row.goal.title}`, titleWidth),
      pad(stateLabel(entry.effectiveState), stateWidth),
      `${progressBar(ratio.numerator, ratio.denominator, barWidth)} ${pad(ratio.denominator ? `${ratio.numerator}/${ratio.denominator}` : "—", ratioWidth)}`,
      pad(entry.ageMs === null ? "-" : humanizeAge(entry.ageMs), ageWidth, "right"),
      pad(entry.touchedMs === null ? "-" : humanizeAge(entry.touchedMs), touchedWidth, "right"),
      pad(entry.stale ? "stale" : "", chipWidth),
    ].join(" ").trimEnd();

    if (selected) lines.push(style(color, "bold", "brightCyan", line));
    else if (!entry.open) lines.push(style(color, "dim", line));
    else lines.push(style(color, stateColor(entry.effectiveState), line));

    if (row.kind === "root" && selected && entry.plannedChildren && !expandPlanned) {
      lines.push(style(color, "gray", `    └ +${entry.plannedChildren} planned  (x to expand)`));
    }
  }

  if (counts.hidden) {
    lines.push(style(color, "gray", `  +${counts.hidden} more roots (raise --limit)`));
  }

  const selectedRow = rows.find((row) => row.goal.id === selectedGoalId);
  if (selectedRow) detailPane(lines, selectedRow.entry, progress, { color, contentWidth });

  lines.push("");
  const filter = openOnly
    ? style(color, "brightCyan", "OPEN ONLY")
    : style(color, "gray", "all roots");
  const keys = "  ↑/↓ or j/k select · o filter · x planned children · r refresh · Tab switch view · q quit";
  lines.push(`${style(color, "gray", keys)}  ${filter}`);
  return lines.join("\n");
}
