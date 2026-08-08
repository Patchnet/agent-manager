import { currentVersionInfo } from "./version.mjs";
import { BRAIN_ROOT, BRAIN_ROOT_SOURCE } from "./paths.mjs";
import { listGoals } from "./goals.mjs";
import { getGoalProgress, formatGoalProgress } from "./goal-progress.mjs";

const COLORS = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  brightCyan: "\u001b[96m",
  green: "\u001b[92m",
  yellow: "\u001b[93m",
  magenta: "\u001b[95m",
  gray: "\u001b[90m",
  white: "\u001b[97m",
  blue: "\u001b[34m",
  red: "\u001b[91m",
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

const STATE_STYLE = {
  blocked: "yellow",
  active: "brightCyan",
  pending_delivery: "magenta",
  planned: "gray",
  delivered: "green",
  cancelled: "red",
  superseded: "dim",
};

export async function buildGoalsSnapshot({
  root = BRAIN_ROOT,
  rootSource = BRAIN_ROOT_SOURCE,
  limit = 24,
} = {}) {
  const roots = await listGoals({ root, parentId: null });
  const all = await listGoals({ root });
  const byParent = new Map();
  for (const goal of all) {
    const key = goal.parentId || "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(goal);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  const rows = [];
  for (const rootGoal of roots.slice(0, limit)) {
    rows.push({ goal: rootGoal, depth: 0 });
    const children = byParent.get(rootGoal.id) || [];
    for (const child of children.slice(0, Math.max(0, limit - rows.length))) {
      rows.push({ goal: child, depth: 1 });
      if (rows.length >= limit) break;
    }
    if (rows.length >= limit) break;
  }
  return {
    schema: "agent-manager.goals-board.v1",
    viewer: currentVersionInfo(),
    brain: { root, source: rootSource },
    at: new Date().toISOString(),
    counts: {
      roots: roots.length,
      total: all.length,
    },
    rows,
  };
}

export async function enrichSelectedGoal(goalId, { root = BRAIN_ROOT } = {}) {
  if (!goalId) return null;
  try {
    return await getGoalProgress(goalId, { root });
  } catch {
    return null;
  }
}

export function formatGoalsBoard(snapshot, {
  color = false,
  selectedGoalId = null,
  progress = null,
  width = 120,
} = {}) {
  const terminalWidth = Math.max(72, width || 120);
  const contentWidth = terminalWidth - 2;
  const lines = [];
  const version = snapshot.viewer?.runtimeVersion || "unknown";
  lines.push(`${style(color, "bold", "◆ AGENT MANAGER")} ${style(color, "gray", `v${version} · GOALS`)}  ${style(color, "brightCyan", `${snapshot.counts.roots} roots`)} ${style(color, "gray", `· ${snapshot.counts.total} total`)}`);
  if (snapshot.brain?.root) {
    lines.push(style(color, "gray", `Brain: ${snapshot.brain.root} [${snapshot.brain.source || "unknown"}]`));
  }
  lines.push(style(color, "gray", "─".repeat(contentWidth)));

  if (!snapshot.rows.length) {
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

  lines.push(`  ${pad("GOAL", 28)} ${pad("STATE", 16)} TITLE`);
  for (const row of snapshot.rows) {
    const selected = row.goal.id === selectedGoalId;
    const indent = row.depth ? "  └ " : "";
    const stateColor = STATE_STYLE[row.goal.lifecycle] || "gray";
    const marker = selected ? "›" : " ";
    const line = `${marker}${indent}${pad(row.goal.id, 28 - indent.length)} ${pad(row.goal.lifecycle, 16)} ${row.goal.title}`;
    lines.push(selected ? style(color, "bold", "brightCyan", line) : style(color, stateColor === "dim" ? "gray" : stateColor, line));
  }

  if (progress) {
    lines.push(style(color, "gray", "─".repeat(contentWidth)));
    lines.push(style(color, "bold", "SELECTED GOAL"));
    for (const line of formatGoalProgress(progress).split("\n")) {
      lines.push(`  ${line}`);
    }
  } else if (selectedGoalId) {
    lines.push(style(color, "gray", "─".repeat(contentWidth)));
    lines.push(style(color, "gray", `  Selected ${selectedGoalId}`));
  }

  lines.push("");
  lines.push(style(color, "gray", "  Keys: ↑/↓ or j/k select · r refresh · 1/2/3/4 or Tab switch view · q quit"));
  return lines.join("\n");
}
