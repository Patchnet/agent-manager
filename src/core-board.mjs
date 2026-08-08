import { listBrainIntents } from "./brain.mjs";
import { listGoalArtifactLinks, listGoals } from "./goals.mjs";
import { BRAIN_ROOT, BRAIN_ROOT_SOURCE } from "./paths.mjs";
import { currentVersionInfo } from "./version.mjs";

const COLORS = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  brightCyan: "\u001b[96m",
  green: "\u001b[92m",
  yellow: "\u001b[93m",
  magenta: "\u001b[95m",
  blue: "\u001b[94m",
  red: "\u001b[91m",
  gray: "\u001b[90m",
  white: "\u001b[97m",
};

function style(enabled, ...codes) {
  const text = codes.pop();
  return enabled ? codes.map((code) => COLORS[code] || code).join("") + text + COLORS.reset : text;
}

function pad(value, width) {
  let text = String(value ?? "-");
  if (text.length > width) text = width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
  return text + " ".repeat(Math.max(0, width - text.length));
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function formatCountMap(counts, { limit = 6 } = {}) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => `${key}:${count}`)
    .join(" · ") || "none";
}

function shortId(value, width = 18) {
  const text = String(value || "-");
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(1, width - 1))}…`;
}

function relationshipArrow(relationship) {
  if (relationship === "blocks") return "-X->";
  if (relationship === "delivers") return "==>";
  if (relationship === "supports") return "-~>";
  if (relationship === "tracks") return "-*>";
  return "--->";
}

export async function buildCoreSnapshot({
  root = BRAIN_ROOT,
  rootSource = BRAIN_ROOT_SOURCE,
  limit = 12,
} = {}) {
  const [goals, links, intents] = await Promise.all([
    listGoals({ root }),
    listGoalArtifactLinks({ root }),
    listBrainIntents({ root }),
  ]);

  const roots = goals.filter((goal) => !goal.parentId);
  const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
  const intentsByGoal = new Map();
  for (const intent of intents) {
    for (const goalId of intent.goalRefs || []) {
      if (!intentsByGoal.has(goalId)) intentsByGoal.set(goalId, []);
      intentsByGoal.get(goalId).push(intent);
    }
  }

  const endpoints = [];
  for (const link of links) {
    endpoints.push({
      kind: "artifact",
      left: link.goalId,
      leftTitle: goalsById.get(link.goalId)?.title || link.goalId,
      edge: relationshipArrow(link.relationship),
      relationship: link.relationship,
      right: `${link.artifactType}:${link.artifactRef}`,
      rightState: link.state,
      sortKey: `${link.goalId}\u0000${link.artifactType}\u0000${link.artifactRef}`,
    });
  }
  for (const intent of intents) {
    const refs = intent.goalRefs?.length ? intent.goalRefs : [null];
    for (const goalId of refs) {
      endpoints.push({
        kind: "run",
        left: goalId || "(unlinked)",
        leftTitle: goalId ? (goalsById.get(goalId)?.title || goalId) : "no goal_refs",
        edge: goalId ? "-run->" : "-run·",
        relationship: "run",
        right: intent.runId,
        rightState: `${intent.phase}/${intent.state}`,
        sortKey: `${goalId || "~"}\u0000run\u0000${intent.startedAt || ""}\u0000${intent.runId}`,
      });
    }
  }
  endpoints.sort((left, right) => String(left.sortKey).localeCompare(String(right.sortKey)));

  const orphanIntents = intents.filter((intent) => !(intent.goalRefs || []).length);
  const linkedGoalIds = new Set([
    ...links.map((link) => link.goalId),
    ...intents.flatMap((intent) => intent.goalRefs || []),
  ]);
  const isolatedGoals = goals.filter((goal) => !linkedGoalIds.has(goal.id));

  return {
    schema: "agent-manager.core-board.v1",
    viewer: currentVersionInfo(),
    knowledge: { root, source: rootSource },
    at: new Date().toISOString(),
    objectTypes: [
      { id: "goal", label: "goals", count: goals.length },
      { id: "artifact_link", label: "artifact links", count: links.length },
      { id: "run_intent", label: "run intents", count: intents.length },
    ],
    counts: {
      goals: goals.length,
      roots: roots.length,
      links: links.length,
      intents: intents.length,
      orphanIntents: orphanIntents.length,
      isolatedGoals: isolatedGoals.length,
      endpoints: endpoints.length,
      goalsByLifecycle: countBy(goals, (goal) => goal.lifecycle),
      linksByType: countBy(links, (link) => link.artifactType),
      linksByRelationship: countBy(links, (link) => link.relationship),
      intentsByPhase: countBy(intents, (intent) => intent.phase),
      intentsByState: countBy(intents, (intent) => intent.state),
    },
    roots: roots.slice(0, limit).map((goal) => ({
      id: goal.id,
      title: goal.title,
      lifecycle: goal.lifecycle,
      children: goals.filter((child) => child.parentId === goal.id).length,
      links: links.filter((link) => link.goalId === goal.id).length,
      runs: (intentsByGoal.get(goal.id) || []).length,
    })),
    endpoints: endpoints.slice(0, Math.max(limit, 16)),
    recentIntents: intents.slice(0, limit).map((intent) => ({
      runId: intent.runId,
      title: intent.title,
      repoLabel: intent.repoLabel,
      phase: intent.phase,
      state: intent.state,
      goalRefs: [...(intent.goalRefs || [])],
      startedAt: intent.startedAt,
    })),
  };
}

export function formatCoreBoard(snapshot, {
  color = false,
  width = 120,
} = {}) {
  const terminalWidth = Math.max(72, width || 120);
  const contentWidth = terminalWidth - 2;
  const lines = [];
  const version = snapshot.viewer?.runtimeVersion || "unknown";
  const types = snapshot.objectTypes.map((type) => `${type.count} ${type.label}`).join(" · ");

  lines.push(`${style(color, "bold", "◆ AGENT MANAGER")} ${style(color, "gray", `v${version} · CORE`)}  ${style(color, "brightCyan", types)}`);
  if (snapshot.knowledge?.root) {
    lines.push(style(color, "gray", `Knowledge root: ${snapshot.knowledge.root} [${snapshot.knowledge.source || "unknown"}]`));
  }
  lines.push(style(color, "gray", "─".repeat(contentWidth)));

  lines.push(style(color, "bold", "STORE"));
  lines.push(style(color, "gray", `  goals ${snapshot.counts.goals} (${snapshot.counts.roots} roots) · links ${snapshot.counts.links} · run intents ${snapshot.counts.intents}`));
  lines.push(style(color, "gray", `  lifecycle  ${formatCountMap(snapshot.counts.goalsByLifecycle)}`));
  lines.push(style(color, "gray", `  link types ${formatCountMap(snapshot.counts.linksByType)}`));
  lines.push(style(color, "gray", `  intent ph. ${formatCountMap(snapshot.counts.intentsByPhase)}`));
  if (snapshot.counts.orphanIntents || snapshot.counts.isolatedGoals) {
    lines.push(style(
      color,
      "yellow",
      `  gaps  ${snapshot.counts.orphanIntents} runs without goal_refs · ${snapshot.counts.isolatedGoals} goals with no links/runs`,
    ));
  }

  lines.push("");
  lines.push(style(color, "bold", "GRAPH ENDPOINTS"));
  if (!snapshot.endpoints.length) {
    lines.push(style(color, "yellow", "  No linked endpoints yet."));
    lines.push(style(color, "gray", "  Create goals, attach goal_refs on runs, or link artifacts to populate this graph."));
  } else {
    lines.push(style(color, "dim", `  ${pad("FROM", 22)}  EDGE   ${pad("TO", 34)}  STATE`));
    for (const endpoint of snapshot.endpoints) {
      const leftColor = endpoint.kind === "run" && endpoint.left === "(unlinked)" ? "yellow" : "cyan";
      const edgeColor = endpoint.relationship === "blocks" ? "red"
        : endpoint.relationship === "delivers" ? "green"
          : endpoint.kind === "run" ? "magenta"
            : "blue";
      lines.push([
        " ",
        style(color, leftColor, pad(shortId(endpoint.left, 22), 22)),
        style(color, edgeColor, pad(endpoint.edge, 6)),
        style(color, "white", pad(shortId(endpoint.right, 34), 34)),
        style(color, "gray", shortId(endpoint.rightState, 18)),
      ].join(" "));
    }
  }

  lines.push("");
  lines.push(style(color, "bold", "GOAL ROOTS"));
  if (!snapshot.roots.length) {
    lines.push(style(color, "gray", "  (none — use Goals tab or ask the harness to create a wave goal)"));
  } else {
    for (const root of snapshot.roots) {
      lines.push([
        style(color, "cyan", `  ${pad(root.id, 24)}`),
        style(color, "gray", pad(root.lifecycle, 12)),
        style(color, "white", shortId(root.title, 36)),
        style(color, "dim", `ch:${root.children} ln:${root.links} run:${root.runs}`),
      ].join(" "));
    }
  }

  lines.push("");
  lines.push(style(color, "bold", "RECENT RUN INTENTS"));
  if (!snapshot.recentIntents.length) {
    lines.push(style(color, "gray", "  (none recorded in the knowledge store yet)"));
  } else {
    for (const intent of snapshot.recentIntents) {
      const goalText = intent.goalRefs.length ? intent.goalRefs.join(",") : "unlinked";
      lines.push([
        style(color, "magenta", `  ${pad(shortId(intent.runId, 28), 28)}`),
        style(color, "gray", pad(`${intent.phase}/${intent.state}`, 22)),
        style(color, "white", pad(shortId(intent.repoLabel || "-", 16), 16)),
        style(color, intent.goalRefs.length ? "cyan" : "yellow", shortId(goalText, 24)),
      ].join(" "));
    }
  }

  lines.push("");
  lines.push(style(color, "gray", "  Keys: 1 Runs · 2 Goals · 3 Core · 4 Tokens · Tab cycle · r refresh · q quit"));
  return lines.join("\n");
}
