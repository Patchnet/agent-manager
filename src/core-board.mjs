import { listBrainIntents } from "./brain.mjs";
import { computeGoalProgress } from "./goal-progress.mjs";
import { inspectGoalGraph, listGoalArtifactLinks, listGoals } from "./goals.mjs";
import { humanizeAge, progressBar, shortRunId } from "./goals-board.mjs";
import { BRAIN_ROOT, BRAIN_ROOT_SOURCE } from "./paths.mjs";
import { currentVersionInfo } from "./version.mjs";

export const CORE_BOARD_SCHEMA = "agent-manager.core-board.v2";
export const CORE_FEED_PAGE_SIZE = 10;

const FEED_CAP = 200;

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

// Same restraint as the Goals tab: the accent family means "live", settled
// rows fall back to gray.
const STATE_COLOR = {
  blocked: "yellow",
  pending_delivery: "yellow",
  active: "brightCyan",
  planned: "gray",
  delivered: "gray",
  cancelled: "gray",
  superseded: "gray",
};

const LIVE_RUN_STATES = new Set(["admitted", "running", "shipping"]);
const ATTENTION_RUN_STATES = new Set(["needs_input", "blocked", "failed", "rejected", "pending_delivery"]);

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

function parseTime(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function formatCountMap(counts, { limit = 5 } = {}) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => `${key} ${count}`)
    .join(" · ") || "none";
}

function goalLabel(goalId) {
  return String(goalId || "").replace(/^goal-/, "") || "-";
}

function stateLabel(state) {
  return String(state || "unknown").replace(/_/g, " ").toUpperCase();
}

function runStateColor(state) {
  if (ATTENTION_RUN_STATES.has(state)) return "yellow";
  if (LIVE_RUN_STATES.has(state)) return "brightCyan";
  return "gray";
}

export async function buildCoreSnapshot({
  root = BRAIN_ROOT,
  rootSource = BRAIN_ROOT_SOURCE,
  limit = 12,
  now = Date.now(),
} = {}) {
  const [goals, links, intents] = await Promise.all([
    listGoals({ root }),
    listGoalArtifactLinks({ root }),
    listBrainIntents({ root }),
  ]);
  return composeCoreSnapshot({ goals, artifactLinks: links, runIntents: intents, root, rootSource, limit, now });
}

/** Pure view model so the Core tab can be exercised without a brain on disk. */
export function composeCoreSnapshot({
  goals = [],
  artifactLinks = [],
  runIntents = [],
  root = BRAIN_ROOT,
  rootSource = BRAIN_ROOT_SOURCE,
  limit = 12,
  now = Date.now(),
  viewer = null,
} = {}) {
  const roots = goals.filter((goal) => !goal.parentId);
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
          effectiveState: computed.effectiveState,
        };
      } catch {
        // fall through to the stored lifecycle
      }
    }
    return { numerator: 0, denominator: 0, effectiveState: goal.lifecycle };
  };

  const orphanIntents = runIntents.filter((intent) => !(intent.goalRefs || []).length);
  const linkedGoalIds = new Set([
    ...artifactLinks.map((link) => link.goalId),
    ...runIntents.flatMap((intent) => intent.goalRefs || []),
  ]);
  const isolatedGoals = goals.filter((goal) => !linkedGoalIds.has(goal.id));

  const feed = [...runIntents]
    .sort((left, right) => parseTime(right.startedAt) - parseTime(left.startedAt)
      || String(right.runId).localeCompare(String(left.runId)))
    .slice(0, FEED_CAP)
    .map((intent) => ({
      runId: intent.runId,
      shortId: shortRunId(intent.runId),
      title: intent.title || null,
      repoLabel: intent.repoLabel || null,
      phase: intent.phase || "unknown",
      state: intent.state || "unknown",
      goalRefs: [...(intent.goalRefs || [])],
      startedAt: intent.startedAt || null,
      ageMs: parseTime(intent.startedAt) ? Math.max(0, now - parseTime(intent.startedAt)) : null,
    }));

  return {
    schema: CORE_BOARD_SCHEMA,
    viewer: viewer || currentVersionInfo(),
    knowledge: { root, source: rootSource },
    at: new Date(now).toISOString(),
    degraded,
    objectTypes: [
      { id: "goal", label: "goals", count: goals.length },
      { id: "artifact_link", label: "artifact links", count: artifactLinks.length },
      { id: "run_intent", label: "run intents", count: runIntents.length },
    ],
    counts: {
      goals: goals.length,
      roots: roots.length,
      links: artifactLinks.length,
      intents: runIntents.length,
      orphanIntents: orphanIntents.length,
      isolatedGoals: isolatedGoals.length,
      goalsByLifecycle: countBy(goals, (goal) => goal.lifecycle),
      linksByType: countBy(artifactLinks, (link) => link.artifactType),
      intentsByPhase: countBy(runIntents, (intent) => intent.phase),
      intentsByState: countBy(runIntents, (intent) => intent.state),
    },
    roots: roots
      .map((goal) => {
        const progress = progressFor(goal);
        return {
          id: goal.id,
          title: goal.title,
          lifecycle: goal.lifecycle,
          effectiveState: progress.effectiveState,
          completed: progress.numerator,
          leaves: progress.denominator,
          children: goals.filter((child) => child.parentId === goal.id).length,
          links: artifactLinks.filter((link) => link.goalId === goal.id).length,
          runs: (intentsByGoal.get(goal.id) || []).length,
        };
      })
      .slice(0, limit),
    feed,
    feedTotal: runIntents.length,
  };
}

export function formatCoreBoard(snapshot, {
  color = false,
  width = 120,
  page = 1,
  pageSize = CORE_FEED_PAGE_SIZE,
} = {}) {
  const terminalWidth = Math.max(72, width || 120);
  const contentWidth = terminalWidth - 2;
  const lines = [];
  const version = snapshot.viewer?.runtimeVersion || "unknown";
  const counts = snapshot.counts;

  lines.push([
    `${style(color, "brightCyan", "▦")} ${style(color, "bold", "AGENT MANAGER")}`,
    style(color, "gray", `v${version} · CORE`),
    ` ${style(color, "brightCyan", `${counts.goals} goals`)}`,
    style(color, "gray", `· ${counts.links} links · ${counts.intents} run intents`),
  ].join(" "));
  if (snapshot.knowledge?.root) {
    lines.push(style(color, "gray", `Knowledge root: ${snapshot.knowledge.root} [${snapshot.knowledge.source || "unknown"}]`));
  }
  if (snapshot.degraded) {
    lines.push(style(color, "yellow", "Goal graph failed its integrity check — showing stored lifecycles only."));
  }
  lines.push(style(color, "gray", "─".repeat(contentWidth)));

  // ── Region 1: the goal map ────────────────────────────────────────────────
  lines.push(`${style(color, "bold", "GOAL MAP")} ${style(color, "gray", `${counts.roots} roots · lifecycle ${formatCountMap(counts.goalsByLifecycle)}`)}`);
  if (!snapshot.roots.length) {
    lines.push(style(color, "gray", "  (none — use the Goals tab or ask the harness to create a wave goal)"));
  } else {
    const stateWidth = 16;
    const barWidth = 8;
    const ratioWidth = 7;
    const metaWidth = 20;
    const titleWidth = Math.max(24, contentWidth - (2 + stateWidth + barWidth + 1 + ratioWidth + metaWidth + 5));
    lines.push(style(color, "gray", [
      "  ",
      pad("GOAL", titleWidth),
      pad("STATE", stateWidth),
      pad("PROGRESS", barWidth + 1 + ratioWidth),
      "LINKAGE",
    ].join(" ")));
    for (const root of snapshot.roots) {
      const line = [
        "  ",
        pad(root.title, titleWidth),
        pad(stateLabel(root.effectiveState), stateWidth),
        `${progressBar(root.completed, root.leaves, barWidth)} ${pad(root.leaves ? `${root.completed}/${root.leaves}` : "—", ratioWidth)}`,
        pad(`ch ${root.children} · ln ${root.links} · run ${root.runs}`, metaWidth),
      ].join(" ").trimEnd();
      lines.push(style(color, STATE_COLOR[root.effectiveState] || "gray", line));
    }
  }
  if (counts.orphanIntents || counts.isolatedGoals) {
    lines.push(style(
      color,
      "yellow",
      `  gaps  ${counts.orphanIntents} runs without goal_refs · ${counts.isolatedGoals} goals with no links or runs`,
    ));
  }

  // ── Region 2: the run-intent feed ─────────────────────────────────────────
  lines.push("");
  lines.push(style(color, "gray", "─".repeat(contentWidth)));
  const size = Math.max(1, pageSize);
  const pages = Math.max(1, Math.ceil(snapshot.feed.length / size));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const start = (current - 1) * size;
  const slice = snapshot.feed.slice(start, start + size);

  lines.push([
    style(color, "bold", "RUN INTENTS"),
    style(color, "gray", `page ${current}/${pages} · ${snapshot.feedTotal} recorded`),
    style(color, "gray", "· n next · p prev"),
  ].join(" "));

  if (!slice.length) {
    lines.push(style(color, "gray", "  (none recorded in the knowledge store yet)"));
  } else {
    const runWidth = 10;
    const stateWidth = 20;
    const repoWidth = 18;
    const ageWidth = 6;
    const goalWidth = Math.max(16, contentWidth - (2 + runWidth + stateWidth + repoWidth + ageWidth + 5));
    lines.push(style(color, "gray", [
      "  ",
      pad("RUN", runWidth),
      pad("STATE", stateWidth),
      pad("REPO", repoWidth),
      pad("AGE", ageWidth, "right"),
      pad("GOAL", goalWidth),
    ].join(" ")));
    for (const intent of slice) {
      const goals = intent.goalRefs.map(goalLabel);
      const goalText = goals.length
        ? (goals.length > 1 ? `${goals[0]} +${goals.length - 1}` : goals[0])
        : "unlinked";
      const line = [
        "  ",
        pad(intent.shortId, runWidth),
        pad(`${intent.phase}/${intent.state}`, stateWidth),
        pad(intent.repoLabel || "-", repoWidth),
        pad(intent.ageMs === null ? "-" : humanizeAge(intent.ageMs), ageWidth, "right"),
        pad(goalText, goalWidth),
      ].join(" ").trimEnd();
      const tone = intent.goalRefs.length ? runStateColor(intent.state) : "yellow";
      lines.push(style(color, tone, line));
    }
  }

  lines.push("");
  lines.push(style(color, "gray", "  Keys: 1 Runs · 2 Goals · 3 Core · 4 Tokens · Tab cycle · n/p page · r refresh · q quit"));
  return lines.join("\n");
}
