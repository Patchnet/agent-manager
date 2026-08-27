import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { BRAIN_ROOT, BRAIN_ROOT_SOURCE, RUNS_ROOT, RUNS_ROOT_SOURCE } from "./paths.mjs";
import { isTerminalState } from "./status.mjs";
import { currentVersionInfo } from "./version.mjs";
import {
  buildGoalsSnapshot,
  enrichSelectedGoal,
  formatGoalsBoard,
  visibleGoalRows,
} from "./goals-board.mjs";
import { buildCoreSnapshot, CORE_FEED_PAGE_SIZE, formatCoreBoard } from "./core-board.mjs";
import { buildTokensSnapshot, formatTokensBoard } from "./tokens.mjs";
import {
  classificationForRecord,
  normalizeClassification,
} from "./run-classification.mjs";

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_LIMIT = 12;
const DEFAULT_EVENT_LIMIT = 8;
const LOG_TAIL_BYTES = 256 * 1_024;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ESC = String.fromCodePoint(27);
const SPLASH_MS = 900;
const SPLASH_MIN_WIDTH = 60;
const SPLASH_MIN_ROWS = 20;
const LOGOMARK_PATH = fileURLToPath(new URL("../assets/patch-mark.txt", import.meta.url));

/** Compact stand-in for the mark, used inline in every board header. */
export const LOGOMARK_GLYPH = "▦";
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export const FLEET_VIEWS = Object.freeze(["runs", "goals", "core", "tokens"]);

export function fleetUsage() {
  return [
    "agent-manager fleet - live terminal operations board",
    "",
    "Usage:",
    "  agent-manager fleet [runId] [options]",
    "",
    "Options:",
    "  --active             show active and attention-needed runs only",
    "  --since <duration>   include recent terminal runs (default: 24h)",
    "  --repo <name>        filter by repository",
    "  --classification <kind>  filter by operational, benchmark, demo, retry, recovery, or unknown",
    "  --runs-root <path>   override the configured telemetry root",
    "  --limit <n>          maximum runs on screen (default: 12)",
    "  --interval <sec>     telemetry refresh interval (default: 1)",
    "  --view <name>        start on runs | goals | core | tokens (default: runs)",
    "  --stream             append state and worker updates instead of redrawing",
    "  --once               print one snapshot and exit",
    "  --json               print one machine-readable snapshot and exit",
    "  --no-color           disable ANSI colors",
    "  --no-effects         disable animation and alternate-screen rendering",
    "  --no-splash          skip the startup logomark",
    "  -h, --help           show this help",
    "",
    "Live tabs: 1/f Runs · 2/g Goals · 3/c Core · 4/t Tokens · Tab cycle",
    "Live keys: ↑/↓ or j/k select · r refresh · q quit",
    "  Runs   a  toggle the active-only filter",
    "  Goals  o  open-only filter · x show planned children",
    "  Core   n/p  page the run-intent feed",
  ].join("\n");
}

export function formatViewerTabBar(activeView = "runs", { color = false, width = 120 } = {}) {
  const labels = [
    { id: "runs", key: "1", label: "Runs" },
    { id: "goals", key: "2", label: "Goals" },
    { id: "core", key: "3", label: "Core" },
    { id: "tokens", key: "4", label: "Tokens" },
  ];
  const parts = labels.map((tab) => {
    const selected = tab.id === activeView;
    const text = `${tab.key}:${tab.label}`;
    return selected
      ? style(color, "bold", "bgCyan", "black", ` ${text} `)
      : style(color, "gray", ` ${text} `);
  });
  const hint = style(color, "gray", "Tab cycle · q quit");
  const bar = `${parts.join(style(color, "dim", "│"))}  ${hint}`;
  const rule = style(color, "gray", "─".repeat(Math.max(72, (width || 120) - 2)));
  return `${bar}\n${rule}`;
}

function normalizeFleetView(value) {
  const view = String(value || "runs").trim().toLowerCase();
  if (!FLEET_VIEWS.includes(view)) {
    throw new Error(`--view must be one of: ${FLEET_VIEWS.join(", ")}`);
  }
  return view;
}

export function parseDuration(value) {
  if (value === "all") return Infinity;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/i.exec(String(value || "").trim());
  if (!match) throw new Error("duration must look like 30m, 24h, 7d, or all");
  const amount = Number(match[1]);
  const units = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return amount * units[match[2].toLowerCase()];
}

export function parseFleetArgs(argv = []) {
  const options = {
    runId: null,
    activeOnly: false,
    sinceMs: DEFAULT_SINCE_MS,
    repo: null,
    classification: null,
    runsRoot: null,
    limit: DEFAULT_LIMIT,
    eventLimit: DEFAULT_EVENT_LIMIT,
    intervalMs: DEFAULT_INTERVAL_MS,
    view: "runs",
    stream: false,
    once: false,
    json: false,
    color: process.env.NO_COLOR === undefined,
    effects: true,
    splash: true,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--active") options.activeOnly = true;
    else if (arg === "--since") options.sinceMs = parseDuration(nextValue());
    else if (arg === "--repo") options.repo = nextValue();
    else if (arg === "--classification") {
      options.classification = normalizeClassification(nextValue(), {
        allowUnknown: true,
        label: "--classification",
      });
    }
    else if (arg === "--runs-root") options.runsRoot = resolve(nextValue());
    else if (arg === "--limit") options.limit = positiveInteger(nextValue(), "--limit");
    else if (arg === "--interval") {
      const seconds = Number(nextValue());
      if (!Number.isFinite(seconds) || seconds < 0.2) {
        throw new Error("--interval must be at least 0.2 seconds");
      }
      options.intervalMs = Math.round(seconds * 1_000);
    } else if (arg === "--view") options.view = normalizeFleetView(nextValue());
    else if (arg === "--stream") options.stream = true;
    else if (arg === "--once") options.once = true;
    else if (arg === "--json") {
      options.json = true;
      options.once = true;
    } else if (arg === "--no-color") options.color = false;
    else if (arg === "--no-effects") options.effects = false;
    else if (arg === "--no-splash") options.splash = false;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg.startsWith("-")) throw new Error(`unknown fleet option: ${arg}`);
    else if (!options.runId) options.runId = arg;
    else throw new Error(`unexpected fleet argument: ${arg}`);
  }

  if (options.json && options.stream) {
    throw new Error("--json and --stream cannot be combined; use --once --json or --stream");
  }
  return options;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function safeJsonLines(path) {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function readTail(path, maxBytes = LOG_TAIL_BYTES) {
  if (!path || !existsSync(path)) return "";
  let fd;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, maxBytes);
    const offset = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, offset);
    let text = buffer.toString("utf8");
    if (offset > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
    return text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function parseHarnessLog(text) {
  const signal = { summary: null, tool: null };
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    const item = event.item;
    if (!signal.summary && item?.type === "agent_message" && item.text) {
      signal.summary = cleanText(item.text, 260);
    }
    if (!signal.summary && event.type === "assistant" && Array.isArray(event.message?.content)) {
      const part = event.message.content.find((entry) => entry?.type === "text" && entry.text);
      if (part) signal.summary = cleanText(part.text, 260);
    }
    if (!signal.summary && event.type === "result" && typeof event.result === "string") {
      signal.summary = cleanText(event.result, 260);
    }
    if (!signal.tool && item?.type === "command_execution") {
      signal.tool = describeCommand(item.command, item.exit_code, item.status);
    }
    if (!signal.tool && event.type === "assistant" && Array.isArray(event.message?.content)) {
      const part = event.message.content.find((entry) => entry?.type === "tool_use");
      if (part) signal.tool = describeTool(part.name);
    }
    if (signal.summary && signal.tool) break;
  }
  return signal;
}

function describeTool(name) {
  const value = String(name || "tool").replace(/[_-]+/g, " ");
  return `using ${value}`;
}

export function describeCommand(command, exitCode = null, status = null) {
  const text = stripAnsi(String(command || "")).toLowerCase();
  const failed = exitCode !== null && Number(exitCode) !== 0 || status === "failed";
  if (/npm test|pnpm test|node --test|vitest|jest|pytest|cargo test/.test(text)) {
    return failed ? "tests failed" : status === "completed" ? "tests passed" : "running tests";
  }
  if (/typecheck|tsc\b|mypy|pyright/.test(text)) {
    return failed ? "typecheck failed" : status === "completed" ? "typecheck passed" : "running typecheck";
  }
  if (/npm ci|npm install|pnpm install|yarn install/.test(text)) return "installing dependencies";
  if (/apply_patch|\*\*\* begin patch|file_change/.test(text)) return "editing files";
  if (/git diff|git status|git show/.test(text)) return "reviewing changes";
  if (/rg\b|select-string|get-content|findstr|grep\b/.test(text)) return "inspecting code";
  if (/gh pr|gh run|github/.test(text)) return "checking GitHub";
  return failed ? "command failed" : "running a command";
}

function stripAnsi(value) {
  return String(value || "").replace(ANSI_RE, "");
}

function cleanText(value, max = 180) {
  const cleaned = stripAnsi(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^#+\s*/, "")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > max ? cleaned.slice(0, Math.max(0, max - 1)) + "…" : cleaned;
}

function meaningfulActivity(value) {
  const text = cleanText(value, 260);
  if (!text) return null;
  if (/^(cmd:|turn\.|thread\.|item\.|tool:|result:)/i.test(text)) return null;
  if (/\*\*\* begin patch|apply_patch/i.test(text)) return null;
  return text;
}

function laneSignal(lane) {
  const parsed = parseHarnessLog(readTail(lane.logPath));
  const waiting = lane.waitingFor?.length
    ? `waiting for ${lane.waitingFor.join(", ")}`
    : lane.queueReason || null;
  const summary = lane.needsInput?.prompt
    ? cleanText(lane.needsInput.prompt, 260)
    : meaningfulActivity(lane.lastActivity) || parsed.summary || waiting || defaultLaneSummary(lane.state);
  return { summary, tool: parsed.tool };
}

function defaultLaneSummary(state) {
  const messages = {
    queued: "queued for a worker",
    "dependency-waiting": "waiting for dependencies",
    running: "worker is active",
    blocked: "operator input required",
    done: "work completed",
    failed: "worker failed",
    cancelled: "work cancelled",
  };
  return messages[state] || state || "unknown";
}

function statusTimestamp(status) {
  return Date.parse(status.updatedAt || status.endedAt || status.startedAt || 0) || 0;
}

const FLEET_TERMINAL_STATES = new Set([
  "done",
  "reviewed",
  "merged",
  "released",
  "rejected",
  "failed",
  "cancelled",
]);

function isFleetTerminalState(state) {
  return FLEET_TERMINAL_STATES.has(state) || isTerminalState(state);
}

function runBlocker(status, lanes) {
  const lane = lanes.find((entry) => entry.needsInput?.prompt);
  if (lane) {
    return { scope: "lane", id: lane.id, prompt: cleanText(lane.needsInput.prompt, 500) };
  }
  for (const [scope, phase] of [["integrate", status.integrate], ["ship", status.ship]]) {
    const prompt = phase?.needsInput?.prompt || phase?.error;
    if (prompt) return { scope, id: scope, prompt: cleanText(prompt, 500) };
  }
  return null;
}

function attentionRank(status) {
  if (status.state === "blocked" || status.lanes?.some((lane) => lane.needsInput) || status.integrate?.needsInput || status.ship?.needsInput) return 0;
  if (["delivery_review_pending", "correction_pending", "ship_gate_pending", "release_pending"].includes(status.state)) return 1;
  if (status.state === "shipping") return 2;
  if (!isFleetTerminalState(status.state)) return 3;
  if (["failed", "cancelled", "rejected"].includes(status.state)) return 4;
  return 5;
}

function ticketFor(status) {
  return status.planning?.planRef || status.planning?.sourceRefs?.[0] || status.workflow?.split(/[\\/]/).pop() || "unplanned";
}

function summarizeLanes(lanes = []) {
  const counts = {
    total: lanes.length,
    done: 0,
    active: 0,
    blocked: 0,
    waiting: 0,
    failed: 0,
    settled: 0,
  };
  for (const lane of lanes) {
    if (lane.state === "done") counts.done += 1;
    if (lane.state === "running") counts.active += 1;
    if (lane.state === "blocked") counts.blocked += 1;
    if (["queued", "dependency-waiting"].includes(lane.state)) counts.waiting += 1;
    if (lane.state === "failed") counts.failed += 1;
    if (["done", "failed", "cancelled"].includes(lane.state)) counts.settled += 1;
  }
  return counts;
}

function normalizeRun(status) {
  const lanes = (status.lanes || []).map((lane) => {
    const signal = laneSignal(lane);
    return {
      id: lane.id,
      state: lane.state,
      harness: lane.harness || null,
      modelRequested: lane.modelRequested || null,
      modelObserved: lane.modelObserved || null,
      elapsedSec: lane.elapsedSec ?? 0,
      summary: signal.summary,
      tool: signal.tool,
      waitingFor: lane.waitingFor || [],
      needsInput: lane.needsInput || null,
      exitCode: lane.exitCode ?? null,
    };
  });
  const blocker = runBlocker(status, lanes);
  const shortId = shortRunId(status.runId);
  const repoShorthand = status.identity?.repoShorthand || basename(status.repoRoot || status.repo || "repo");
  const subject = status.identity?.subject || ticketFor(status);
  const displayTitle = status.identity?.displayTitle || `[AM ${shortId}] ${repoShorthand} · ${subject}`;
  const classification = classificationForRecord(status);
  const lineage = status.lineage?.parentRunId ? {
    parentRunId: status.lineage.parentRunId,
    relationship: status.lineage.relationship || classification,
  } : null;
  const classificationLabel = lineage
    ? `${classification}←${shortRunId(lineage.parentRunId).slice(-6)}`
    : classification;
  return {
    runId: status.runId,
    shortId,
    repo: status.repo || "-",
    ticket: ticketFor(status),
    identity: status.identity || null,
    displayTitle,
    repoShorthand,
    subject,
    rowSubject: `[${classificationLabel}] ${subject}`,
    classification,
    lineage,
    manager: status.identity?.manager || { harness: null, model: null, modelSource: "unavailable", threadTitle: null },
    agentManagerVersion: status.agentManager?.version || null,
    state: status.state,
    startedAt: status.startedAt || null,
    updatedAt: status.updatedAt || null,
    endedAt: status.endedAt || null,
    targetDevFlow: status.target_dev_flow || null,
    laneCounts: summarizeLanes(lanes),
    lanes,
    deliveryState: status.delivery?.state || null,
    reviewState: status.delivery?.review?.state || null,
    shipState: status.ship?.state || null,
    shipPhase: status.ship?.phase || null,
    ship: status.ship ? {
      state: status.ship.state || null,
      phase: status.ship.phase || null,
      approve: status.ship.approve || null,
      targetId: status.ship.targetId || null,
      version: status.ship.version || null,
      plannedTag: status.ship.plannedTag || null,
      prUrl: status.ship.prUrl || null,
      lastActivity: status.ship.lastActivity || null,
      steps: status.ship.steps || [],
      checks: status.ship.checks || [],
      ci: status.ship.ci || null,
    } : null,
    reconciliation: status.reconciliation || null,
    blocker,
    needsInput: Boolean(blocker),
  };
}

function shortRunId(runId) {
  const match = /^run-\d{8}-\d{6}-(.+)$/.exec(String(runId || ""));
  return match ? match[1].slice(-8) : String(runId || "-").slice(-8);
}

function laneModel(lane) {
  if (lane.modelObserved) {
    return lane.modelRequested && lane.modelRequested !== lane.modelObserved
      ? `${lane.modelObserved} (requested ${lane.modelRequested})`
      : lane.modelObserved;
  }
  return lane.modelRequested ? `${lane.modelRequested} · unverified` : "default · unverified";
}

export function buildFleetSnapshot(options = {}, dependencies = {}) {
  const runsRoot = options.runsRoot || dependencies.runsRoot || RUNS_ROOT;
  const runsRootSource = options.runsRoot
    ? "command-line"
    : dependencies.runsRootSource || (dependencies.runsRoot ? "caller" : RUNS_ROOT_SOURCE);
  const now = dependencies.now || (() => Date.now());
  const version = dependencies.version || currentVersionInfo();
  const config = {
    runId: null,
    activeOnly: false,
    sinceMs: DEFAULT_SINCE_MS,
    repo: null,
    classification: null,
    limit: DEFAULT_LIMIT,
    eventLimit: DEFAULT_EVENT_LIMIT,
    ...options,
  };
  const currentTime = now();
  const statuses = [];
  if (existsSync(runsRoot)) {
    for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(entry.name)) continue;
      const status = safeJson(join(runsRoot, entry.name, "status.json"));
      if (!status?.runId) continue;
      const active = !isFleetTerminalState(status.state);
      if (config.runId && status.runId !== config.runId) continue;
      if (config.repo && status.repo !== config.repo) continue;
      if (config.classification && classificationForRecord(status) !== config.classification) continue;
      if (config.activeOnly && !active) continue;
      if (!active && Number.isFinite(config.sinceMs) && currentTime - statusTimestamp(status) > config.sinceMs) continue;
      statuses.push(status);
    }
  }

  statuses.sort((left, right) => attentionRank(left) - attentionRank(right) || statusTimestamp(right) - statusTimestamp(left));
  const allRuns = statuses.map(normalizeRun);
  const runs = allRuns.slice(0, config.limit);
  const events = [];
  for (const run of runs) {
    const eventPath = join(runsRoot, run.runId, "events.jsonl");
    const runEvents = safeJsonLines(eventPath);
    let previous = null;
    for (const event of runEvents) {
      if (!event?.at) continue;
      if (!previous || previous.state !== event.state) {
        events.push({ at: event.at, runId: run.runId, shortId: run.shortId, kind: "run", text: `run → ${event.state}` });
      }
      const previousLanes = new Map((previous?.lanes || []).map((lane) => [lane.id, lane]));
      for (const lane of event.lanes || []) {
        const before = previousLanes.get(lane.id);
        if (!before || before.state !== lane.state || (!before.needsInput && lane.needsInput)) {
          events.push({
            at: event.at,
            runId: run.runId,
            shortId: run.shortId,
            kind: lane.needsInput ? "needs_input" : "lane",
            text: `${lane.id} → ${lane.needsInput ? "needs input" : lane.state}`,
          });
        }
      }
      if (previous?.ship?.phase !== event.ship?.phase && event.ship?.phase) {
        events.push({ at: event.at, runId: run.runId, shortId: run.shortId, kind: "ship", text: `shipping → ${event.ship.phase}` });
      }
      previous = event;
    }
  }
  events.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));

  return {
    schema: "agent-manager.fleet.v1",
    viewer: version,
    telemetry: {
      runsRoot: resolve(runsRoot),
      source: runsRootSource,
    },
    at: new Date(currentTime).toISOString(),
    filters: {
      classification: config.classification || null,
    },
    counts: {
      visible: runs.length,
      total: allRuns.length,
      active: allRuns.filter((run) => !isFleetTerminalState(run.state)).length,
      blocked: allRuns.filter((run) => run.state === "blocked" || run.needsInput).length,
      review: allRuns.filter((run) => ["delivery_review_pending", "correction_pending", "ship_gate_pending"].includes(run.state)).length,
      shipping: allRuns.filter((run) => run.state === "shipping").length,
    },
    runs,
    recentEvents: events.slice(0, config.eventLimit),
  };
}

// The board deliberately spends only four tones: cyan for motion, yellow for
// "waiting on you", red for failure, gray for anything settled. Reaching for
// another entry in this table means adding a competitor for the operator's
// attention — retune a call site instead.
const COLORS = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  inverse: "\u001b[7m",
  cyan: "\u001b[36m",
  brightCyan: "\u001b[96m",
  blue: "\u001b[94m",
  magenta: "\u001b[95m",
  green: "\u001b[92m",
  yellow: "\u001b[93m",
  red: "\u001b[91m",
  gray: "\u001b[90m",
  white: "\u001b[97m",
  bgYellow: "\u001b[43m",
  bgCyan: "\u001b[46m",
  black: "\u001b[30m",
};

function style(enabled, ...codes) {
  const text = codes.pop();
  return enabled ? codes.map((code) => COLORS[code] || code).join("") + text + COLORS.reset : text;
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function truncate(value, width) {
  const text = cleanText(value, 10_000) || "-";
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : text.slice(0, width - 1) + "…";
}

function pad(value, width, align = "left") {
  const text = truncate(value, width);
  const missing = Math.max(0, width - visibleLength(text));
  return align === "right" ? " ".repeat(missing) + text : text + " ".repeat(missing);
}

/**
 * Read the committed logomark asset.
 *
 * The asset carries both the palette (as `# key = #rrggbb` comments) and the
 * grid, so the mark can be retouched without editing this renderer. A missing
 * or malformed asset is not an error: the splash is simply skipped.
 */
export function loadLogomark(path = LOGOMARK_PATH) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const palette = {};
  const grid = [];
  for (const line of text.split(/\r?\n/)) {
    const swatch = /^#\s+([a-z])\s*=\s*#([0-9a-fA-F]{6})\b/.exec(line);
    if (swatch) {
      palette[swatch[1]] = swatch[2];
      continue;
    }
    if (line.startsWith("#") || !line.trim()) continue;
    grid.push(line.replace(/\s+$/, ""));
  }
  if (!grid.length) return null;
  return { grid, palette, width: Math.max(...grid.map((row) => row.length)) };
}

function truecolor(hex) {
  const value = Number.parseInt(hex, 16);
  return `${ESC}[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
}

/** Paint the grid as full blocks, collapsing runs of one colour into one escape. */
export function renderLogomark(mark, { color = false, indent = 2 } = {}) {
  if (!mark?.grid?.length) return [];
  const prefix = " ".repeat(Math.max(0, indent));
  return mark.grid.map((row) => {
    let line = prefix;
    let index = 0;
    while (index < row.length) {
      const key = row[index];
      let run = 1;
      while (row[index + run] === key) run += 1;
      const blocks = "█".repeat(run);
      const hex = mark.palette[key];
      if (key === ".") line += " ".repeat(run);
      else if (color && hex) line += `${truecolor(hex)}${blocks}${ESC}[0m`;
      else line += blocks;
      index += run;
    }
    return line.replace(/\s+$/, "");
  });
}

export function formatSplash(mark, { color = false, version = "unknown" } = {}) {
  return [
    "",
    ...renderLogomark(mark, { color, indent: 2 }),
    "",
    `  ${style(color, "bold", "AGENT MANAGER")} ${style(color, "gray", `v${version}`)}`,
    style(color, "gray", "  multi-lane supervision · reading telemetry…"),
    "",
    style(color, "dim", "  any key to skip"),
  ].join("\n");
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3_600) return `${Math.floor(value / 60)}m${String(Math.round(value % 60)).padStart(2, "0")}s`;
  if (value < 86_400) return `${Math.floor(value / 3_600)}h${String(Math.floor(value % 3_600 / 60)).padStart(2, "0")}m`;
  return `${Math.floor(value / 86_400)}d${String(Math.floor(value % 86_400 / 3_600)).padStart(2, "0")}h`;
}

function runAge(run, at) {
  const start = Date.parse(run.startedAt || 0);
  const end = Date.parse(run.endedAt || at || 0);
  return start && end ? Math.max(0, (end - start) / 1_000) : 0;
}

function clockTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "--:--:--"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/**
 * Hierarchy through restraint.
 *
 * Cyan means "in motion", yellow means "this is waiting on you", red is kept
 * for outright failure, and everything that has settled goes gray. Success is
 * carried by the ✓ glyph rather than a competing colour.
 */
function statePresentation(state, frame = 0) {
  const presentations = {
    running: [SPINNER[frame % SPINNER.length], "RUNNING", "brightCyan"],
    blocked: ["!", "NEEDS INPUT", "yellow"],
    delivery_review_pending: ["◆", "DELIVERY REVIEW", "yellow"],
    correction_pending: ["◆", "CORRECTION", "yellow"],
    ship_gate_pending: ["◆", "SHIP GATE", "yellow"],
    shipping: [SPINNER[frame % SPINNER.length], "SHIPPING", "brightCyan"],
    release_pending: ["◆", "RELEASE GATE", "yellow"],
    reviewed: ["✓", "REVIEWED", "gray"],
    merged: ["✓", "MERGED", "gray"],
    released: ["✓", "RELEASED", "gray"],
    rejected: ["×", "REJECTED", "red"],
    failed: ["×", "FAILED", "red"],
    cancelled: ["×", "CANCELLED", "gray"],
    queued: ["○", "QUEUED", "gray"],
    "dependency-waiting": ["○", "WAITING", "gray"],
    done: ["✓", "DONE", "gray"],
  };
  return presentations[state] || ["·", String(state || "UNKNOWN").toUpperCase(), "white"];
}

function progressBar(counts, width, frame, color) {
  const total = Math.max(1, counts.total || 0);
  const settled = Math.min(total, counts.settled || 0);
  const filled = Math.round(settled / total * width);
  const active = counts.active > 0 && filled < width;
  let bar = "━".repeat(filled);
  if (active) bar += frame % 2 === 0 ? "╸" : "╺";
  bar += "─".repeat(Math.max(0, width - visibleLength(bar)));
  return style(color, counts.blocked ? "yellow" : counts.failed ? "red" : "brightCyan", bar);
}

function wrapText(value, width, maxLines = 3) {
  const words = String(value || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + word.length + 1 <= width) line += " " + word;
    else {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[lines.length - 1] = truncate(lines[lines.length - 1], Math.max(1, width - 1)) + "…";
  }
  return lines;
}

function changedRunIds(previous, next) {
  if (!previous) return new Set();
  const before = new Map(previous.runs.map((run) => [run.runId, JSON.stringify({
    state: run.state,
    lanes: run.lanes.map((lane) => [lane.id, lane.state, lane.summary, lane.modelObserved]),
  })]));
  return new Set(next.runs.filter((run) => before.get(run.runId) !== JSON.stringify({
    state: run.state,
    lanes: run.lanes.map((lane) => [lane.id, lane.state, lane.summary, lane.modelObserved]),
  })).map((run) => run.runId));
}

function gradientTitle(text, color) {
  if (!color) return text;
  const palette = ["brightCyan", "cyan"];
  return [...text].map((character, index) => style(true, palette[Math.floor(index / 7) % palette.length], character)).join("");
}

export function formatFleetBoard(snapshot, {
  width = 120,
  frame = 0,
  color = false,
  effects = false,
  selectedRunId = null,
  previousSnapshot = null,
  interactive = false,
  activeOnly = false,
} = {}) {
  const terminalWidth = Math.max(72, width || 120);
  const contentWidth = terminalWidth - 2;
  const lines = [];
  const changed = changedRunIds(previousSnapshot, snapshot);
  const selected = snapshot.runs.find((run) => run.runId === selectedRunId) || snapshot.runs[0] || null;
  const pulseCode = effects && frame % 8 < 4 ? "bold" : "white";
  const title = gradientTitle("AGENT MANAGER", color);
  const badges = [
    style(color, snapshot.counts.active ? "brightCyan" : "gray", `active ${snapshot.counts.active}`),
    style(color, snapshot.counts.blocked ? "yellow" : "gray", `blocked ${snapshot.counts.blocked}`),
    style(color, snapshot.counts.review ? "yellow" : "gray", `review ${snapshot.counts.review}`),
    style(color, snapshot.counts.shipping ? "brightCyan" : "gray", `shipping ${snapshot.counts.shipping}`),
  ].join(style(color, "gray", " · "));
  const frameIcon = snapshot.counts.active ? SPINNER[frame % SPINNER.length] : " ";
  const viewerVersion = snapshot.viewer?.runtimeVersion || "unknown";
  lines.push(`${style(color, pulseCode, frameIcon)} ${style(color, "brightCyan", LOGOMARK_GLYPH)} ${style(color, "bold", title)} ${style(color, "gray", `v${viewerVersion} · FLEET`)}  ${badges}`);
  if (snapshot.telemetry?.runsRoot) {
    lines.push(style(color, "gray", `Telemetry: ${snapshot.telemetry.runsRoot} [${snapshot.telemetry.source || "unknown"}]`));
  }
  if (snapshot.viewer?.restartRequired) {
    lines.push(style(color, "bgYellow", "black", "bold", ` UPDATE INSTALLED v${snapshot.viewer.installedVersion} · press q, then restart Fleet `));
  }
  lines.push(style(color, "gray", "─".repeat(contentWidth)));

  if (!snapshot.runs.length) {
    lines.push("");
    lines.push(style(color, "yellow", "  No runs match the current filters."));
    lines.push("");
    lines.push(style(color, "gray", `  Waiting for telemetry under ${snapshot.telemetry?.runsRoot || "$AGENT_MANAGER_RUNS_ROOT"}…`));
    return lines.join("\n");
  }

  const wide = terminalWidth >= 108;
  const runWidth = 9;
  const stateWidth = 17;
  const lanesWidth = 16;
  const ageWidth = 8;
  const repoWidth = wide ? 16 : 0;
  const fixed = 2 + runWidth + stateWidth + lanesWidth + ageWidth + (wide ? repoWidth + 1 : 0) + 5;
  const ticketWidth = Math.max(18, contentWidth - fixed);
  const header = [
    "  ",
    pad("RUN / SUBJECT", ticketWidth),
    wide ? pad("REPO", repoWidth) : null,
    pad("RUN", runWidth),
    pad("STATE", stateWidth),
    pad("LANES", lanesWidth),
    pad("AGE", ageWidth, "right"),
  ].filter((value) => value !== null).join(" ");
  lines.push(style(color, "gray", header));

  for (const run of snapshot.runs) {
    const isSelected = selected?.runId === run.runId;
    const [icon, stateLabel, stateColor] = statePresentation(run.state, frame);
    const rowStateLabel = run.state === "shipping" && run.shipPhase
      ? `SHIP · ${run.shipPhase.toUpperCase()}`
      : stateLabel;
    const changedMark = changed.has(run.runId) ? style(color, "yellow", "◆") : icon;
    const lanes = `${progressBar(run.laneCounts, 8, frame, color)} ${run.laneCounts.done}/${run.laneCounts.total}`;
    const fields = [
      isSelected ? style(color, "brightCyan", "›") : " ",
      pad(run.rowSubject || run.subject, ticketWidth),
      wide ? pad(run.repoShorthand, repoWidth) : null,
      pad(run.shortId, runWidth),
      pad(`${changedMark} ${rowStateLabel}`, stateWidth),
      pad(lanes, lanesWidth),
      pad(formatDuration(runAge(run, snapshot.at)), ageWidth, "right"),
    ].filter((value) => value !== null);
    let row = fields.join(" ");
    if (isSelected) row = style(color, "bold", row);
    else if (isFleetTerminalState(run.state)) row = style(color, "dim", row);
    else row = style(color, stateColor, row);
    lines.push(row);
  }

  if (selected) {
    lines.push("");
    lines.push(`${style(color, "bold", "RUN DETAILS")} ${style(color, "brightCyan", truncate(selected.displayTitle, Math.max(20, contentWidth - 14)))}`);
    lines.push(style(color, "gray", `  Repository ${selected.repoShorthand} · Plan ${selected.ticket} · Run ${selected.runId}`));
    lines.push(style(color, "gray", `  Classification ${selected.classification}${selected.lineage ? ` · Parent ${selected.lineage.parentRunId} (${selected.lineage.relationship})` : ""}`));
    const runEngineVersion = selected.agentManagerVersion
      ? `v${selected.agentManagerVersion}`
      : "legacy/unrecorded";
    lines.push(style(color, "gray", `  Run engine ${runEngineVersion} · Viewer v${viewerVersion}`));
    const managerHarness = selected.manager?.harness || "unavailable";
    const managerModel = selected.manager?.model
      ? `${selected.manager.model} · ${selected.manager.modelSource || "declared"}`
      : "unavailable";
    lines.push(`  ${style(color, "gray", "Manager Harness")} ${managerHarness}  ${style(color, "gray", "· Manager Model")} ${managerModel}`);
    if (selected.manager?.threadTitle) {
      lines.push(style(color, "gray", `  Host thread ${truncate(selected.manager.threadTitle, Math.max(20, contentWidth - 14))}`));
    }
    const laneIdWidth = Math.min(32, Math.max(20, Math.floor(contentWidth * 0.28)));
    const laneStateWidth = 13;
    const laneElapsedWidth = 8;
    const expandedColumns = contentWidth >= 104;
    const harnessWidth = 12;
    const modelWidth = 24;
    lines.push(style(color, "gray", expandedColumns
      ? `  ${pad("LANE", laneIdWidth)} ${pad("HARNESS", harnessWidth)} ${pad("MODEL", modelWidth)} ${pad("STATE", laneStateWidth)} ${pad("ELAPSED", laneElapsedWidth)}`
      : `  ${pad("LANE", laneIdWidth)} ${pad("STATE", laneStateWidth)} ${pad("ELAPSED", laneElapsedWidth)}`));
    for (const lane of selected.lanes) {
      const [icon, label, laneColor] = statePresentation(lane.state, frame);
      const activity = lane.tool && lane.state === "running"
        ? `${lane.summary} · ${lane.tool}`
        : lane.summary;
      const row = expandedColumns
        ? `  ${pad(lane.id, laneIdWidth)} ${pad(lane.harness || "-", harnessWidth)} ${pad(laneModel(lane), modelWidth)} ${pad(`${icon} ${label}`, laneStateWidth)} ${pad(formatDuration(lane.elapsedSec), laneElapsedWidth)}`
        : `  ${pad(lane.id, laneIdWidth)} ${pad(`${icon} ${label}`, laneStateWidth)} ${pad(formatDuration(lane.elapsedSec), laneElapsedWidth)}`;
      lines.push(style(color, laneColor, row));
      if (!expandedColumns) lines.push(style(color, "gray", `      ${lane.harness || "-"} · ${laneModel(lane)}`));
      lines.push(style(color, "gray", `      Update ${truncate(activity, Math.max(20, contentWidth - 13))}`));
    }

    if (selected.ship) {
      const ship = selected.ship;
      lines.push("");
      lines.push(`${style(color, "bold", "SHIPPING PROGRESS")} ${style(color, "brightCyan", String(ship.phase || "preflight").toUpperCase())}`);
      lines.push(style(color, "gray", `  ${ship.lastActivity || "waiting for ship telemetry"}`));
      if (ship.prUrl) lines.push(style(color, "gray", `  PR ${ship.prUrl}`));
      if (ship.targetId || ship.version || ship.plannedTag) {
        lines.push(style(color, "gray", `  Target ${ship.targetId || "single"} · Version ${ship.version || "n/a"} · Tag ${ship.plannedTag || "n/a"}`));
      }
      if (ship.steps.length) {
        const progress = ship.steps.map((item) => {
          const icon = item.state === "done" ? "✓" : item.state === "skipped" ? "−" : item.state === "running" ? "●" : "○";
          return `${icon} ${item.name}`;
        }).join("  →  ");
        for (const line of wrapText(progress, Math.max(30, contentWidth - 4), 3)) {
          lines.push(style(color, "brightCyan", `  ${line}`));
        }
      }
      const actionRuns = ship.ci?.runs || [];
      const checks = actionRuns.length ? actionRuns : ship.checks;
      if (checks.length) {
        const heading = actionRuns.length ? "GITHUB ACTIONS" : "GITHUB CHECKS";
        const completed = checks.filter((item) => item.status === "completed" || item.conclusion).length;
        lines.push(style(color, "bold", `${heading} ${completed}/${checks.length} complete`));
        for (const item of checks.slice(0, 6)) {
          const name = item.workflow || item.name || `run ${item.id || "?"}`;
          const result = item.conclusion || item.status || "pending";
          lines.push(style(color, result === "success" ? "gray" : /fail|cancel|timed/.test(result) ? "red" : "yellow", `  ${name} · ${result}`));
        }
      }
    }

    const blocker = selected.blocker;
    if (blocker?.prompt) {
      lines.push("");
      lines.push(style(color, "bgYellow", "black", "bold", ` NEEDS INPUT · ${blocker.id} `));
      for (const line of wrapText(blocker.prompt, Math.max(30, contentWidth - 4), 3)) {
        lines.push(style(color, "yellow", `  ${line}`));
      }
      const action = blocker.scope === "lane"
        ? `reply: agent-manager reply ${selected.runId} ${blocker.id} --message "…"`
        : `inspect: agent-manager status ${selected.runId}`;
      lines.push(style(color, "gray", `  ${action}`));
    }
  }

  if (snapshot.recentEvents.length) {
    lines.push("");
    lines.push(style(color, "bold", "RECENT TRANSITIONS"));
    for (const event of snapshot.recentEvents) {
      const eventColor = event.kind === "needs_input" ? "yellow" : event.kind === "ship" ? "brightCyan" : "gray";
      lines.push(`${style(color, "gray", clockTime(event.at))}  ${style(color, "cyan", event.shortId)}  ${style(color, eventColor, truncate(event.text, Math.max(20, contentWidth - 22)))}`);
    }
  }

  lines.push("");
  const scopeFilter = activeOnly ? style(color, "brightCyan", "ACTIVE ONLY") : "active + recent";
  const classificationFilter = snapshot.filters?.classification
    ? ` · classification ${snapshot.filters.classification}`
    : "";
  const controls = interactive
    ? "↑/↓ or j/k select · a filter · r refresh · q quit"
    : "Ctrl+C to stop";
  lines.push(`${style(color, "gray", controls)}  ${style(color, "gray", "·")}  ${scopeFilter}${classificationFilter}  ${style(color, "gray", `· refresh ${clockTime(snapshot.at)}`)}`);
  return lines.join("\n");
}

export function diffFleetSnapshots(previous, next) {
  if (!previous) {
    return next.runs.map((run) => ({
      at: next.at,
      kind: "run_seen",
      runId: run.runId,
      shortId: run.shortId,
      text: `${run.ticket} · ${run.state} · ${run.laneCounts.done}/${run.laneCounts.total} lanes`,
    }));
  }
  const changes = [];
  const beforeRuns = new Map(previous.runs.map((run) => [run.runId, run]));
  for (const run of next.runs) {
    const before = beforeRuns.get(run.runId);
    if (!before) {
      changes.push({ at: next.at, kind: "run_started", runId: run.runId, shortId: run.shortId, text: `${run.ticket} · run discovered` });
      continue;
    }
    if (run.state !== before.state) {
      changes.push({ at: next.at, kind: run.state === "blocked" ? "needs_input" : "run_state", runId: run.runId, shortId: run.shortId, text: `run → ${run.state}` });
    }
    const beforeLanes = new Map(before.lanes.map((lane) => [lane.id, lane]));
    for (const lane of run.lanes) {
      const priorLane = beforeLanes.get(lane.id);
      if (!priorLane) {
        changes.push({ at: next.at, kind: "lane_started", runId: run.runId, shortId: run.shortId, text: `${lane.id} → ${lane.state}` });
      } else if (lane.state !== priorLane.state || Boolean(lane.needsInput) !== Boolean(priorLane.needsInput)) {
        changes.push({ at: next.at, kind: lane.needsInput ? "needs_input" : "lane_state", runId: run.runId, shortId: run.shortId, text: `${lane.id} → ${lane.needsInput ? "needs input" : lane.state}` });
      } else if (lane.summary && lane.summary !== priorLane.summary && lane.state === "running") {
        changes.push({ at: next.at, kind: "worker_update", runId: run.runId, shortId: run.shortId, text: `${lane.id}: ${lane.summary}` });
      } else if (lane.modelObserved && lane.modelObserved !== priorLane.modelObserved) {
        changes.push({ at: next.at, kind: "worker_model", runId: run.runId, shortId: run.shortId, text: `${lane.id}: model ${lane.modelObserved}` });
      }
    }
  }
  return changes;
}

export function formatFleetStreamEvent(event, { color = false } = {}) {
  const eventColor = event.kind === "needs_input"
    ? "yellow"
    : event.kind === "worker_update"
      ? "brightCyan"
      : /failed|cancelled|rejected/.test(event.text)
        ? "red"
        : "gray";
  return `${style(color, "gray", clockTime(event.at))}  ${style(color, "cyan", event.shortId)}  ${style(color, eventColor, event.text)}`;
}

export async function runFleet(options = {}, {
  runsRoot = null,
  runsRootSource = null,
  output = process.stdout,
  input = process.stdin,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxTicks = Infinity,
} = {}) {
  const config = {
    activeOnly: false,
    sinceMs: DEFAULT_SINCE_MS,
    repo: null,
    limit: DEFAULT_LIMIT,
    eventLimit: DEFAULT_EVENT_LIMIT,
    intervalMs: DEFAULT_INTERVAL_MS,
    stream: false,
    once: false,
    json: false,
    color: process.env.NO_COLOR === undefined,
    effects: true,
    splash: true,
    ...options,
  };
  const isTty = Boolean(output.isTTY);
  const effectiveRunsRoot = config.runsRoot || runsRoot || RUNS_ROOT;
  const effectiveRunsRootSource = config.runsRoot
    ? "command-line"
    : runsRootSource || (runsRoot ? "caller" : RUNS_ROOT_SOURCE);
  const takeSnapshot = () => buildFleetSnapshot(config, {
    runsRoot: effectiveRunsRoot,
    runsRootSource: effectiveRunsRootSource,
    now,
  });
  const writeLine = (value) => output.write(String(value) + "\n");

  if (config.once || (!isTty && !config.stream)) {
    const snapshot = takeSnapshot();
    if (config.json) writeLine(JSON.stringify(snapshot));
    else writeLine(formatFleetBoard(snapshot, { width: output.columns || 120, color: config.color && isTty, effects: false, activeOnly: config.activeOnly }));
    return snapshot;
  }

  if (config.stream) {
    let previous = null;
    let ticks = 0;
    while (ticks < maxTicks) {
      ticks += 1;
      const snapshot = takeSnapshot();
      for (const event of diffFleetSnapshots(previous, snapshot)) {
        writeLine(formatFleetStreamEvent(event, { color: config.color && isTty }));
      }
      previous = snapshot;
      await sleep(config.intervalMs);
    }
    return previous;
  }

  return runInteractiveFleet(config, {
    runsRoot: effectiveRunsRoot,
    runsRootSource: effectiveRunsRootSource,
    output,
    input,
    now,
    sleep,
    maxTicks,
  });
}

async function runInteractiveFleet(config, { runsRoot, runsRootSource, output, input, now, sleep, maxTicks }) {
  const VIEW_TTL_MS = {
    runs: Math.max(250, config.intervalMs || DEFAULT_INTERVAL_MS),
    goals: 10_000,
    core: 10_000,
    tokens: 30_000,
  };
  let stopped = false;
  let needsPaint = true;
  let selectedRunId = config.runId || null;
  let selectedRunIndex = 0;
  let selectedGoalId = null;
  let selectedGoalIndex = 0;
  let goalProgressGoalId = null;
  let goalsOpenOnly = true;
  let goalsExpandPlanned = false;
  let corePage = 1;
  let activeOnly = config.activeOnly;
  let view = normalizeFleetView(config.view || "runs");
  let runsSnapshot = null;
  let previousRunsSnapshot = null;
  let goalsSnapshot = null;
  let goalProgress = null;
  let coreSnapshot = null;
  let tokensSnapshot = null;
  let tokensLoading = false;
  const cacheAt = { runs: 0, goals: 0, core: 0, tokens: 0 };
  const forceReload = { runs: true, goals: true, core: true, tokens: true };
  let frame = 0;
  let ticks = 0;
  const effects = config.effects && Boolean(output.isTTY);
  const color = config.color && Boolean(output.isTTY);
  const interactive = Boolean(input.isTTY && typeof input.setRawMode === "function");
  const writeRaw = (value) => output.write(String(value));
  const width = () => output.columns || 120;
  const logomark = loadLogomark();
  const splashAllowed = config.splash !== false
    && effects
    && Boolean(logomark)
    && width() >= SPLASH_MIN_WIDTH
    && (output.rows || SPLASH_MIN_ROWS) >= SPLASH_MIN_ROWS;
  let splashUntil = splashAllowed ? now() + SPLASH_MS : 0;
  const splashActive = () => Boolean(splashUntil) && now() < splashUntil;

  const refreshRunSelection = () => {
    if (!runsSnapshot?.runs.length) {
      selectedRunId = null;
      selectedRunIndex = 0;
      return;
    }
    const existing = runsSnapshot.runs.findIndex((run) => run.runId === selectedRunId);
    if (existing >= 0) selectedRunIndex = existing;
    else selectedRunIndex = Math.min(selectedRunIndex, runsSnapshot.runs.length - 1);
    selectedRunId = runsSnapshot.runs[selectedRunIndex]?.runId || null;
  };

  // Rows depend on the current selection (children expand under the selected
  // root), so they are projected on demand rather than cached in the snapshot.
  const goalRows = () => (goalsSnapshot
    ? visibleGoalRows(goalsSnapshot, {
      openOnly: goalsOpenOnly,
      selectedGoalId,
      expandPlanned: goalsExpandPlanned,
    })
    : []);

  const syncGoalSelection = () => {
    const rows = goalRows();
    if (!rows.length) {
      selectedGoalId = null;
      selectedGoalIndex = 0;
      return;
    }
    const existing = rows.findIndex((row) => row.goal.id === selectedGoalId);
    if (existing >= 0) selectedGoalIndex = existing;
    else selectedGoalIndex = Math.min(selectedGoalIndex, rows.length - 1);
    selectedGoalId = rows[selectedGoalIndex]?.goal.id || null;
  };

  const moveGoalSelection = (delta) => {
    const rows = goalRows();
    if (!rows.length) return;
    const current = rows.findIndex((row) => row.goal.id === selectedGoalId);
    const next = Math.min(rows.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta));
    selectedGoalIndex = next;
    selectedGoalId = rows[next].goal.id;
    needsPaint = true;
  };

  const setView = (nextView) => {
    const resolved = normalizeFleetView(nextView);
    if (resolved === view) return;
    view = resolved;
    needsPaint = true;
  };

  const keypress = (_text, key = {}) => {
    if (key.ctrl && key.name === "c" || key.name === "q") {
      stopped = true;
      return;
    }
    if (splashUntil) {
      splashUntil = 0;
      needsPaint = true;
    }
    if (key.name === "tab") {
      const index = FLEET_VIEWS.indexOf(view);
      setView(FLEET_VIEWS[(index + 1) % FLEET_VIEWS.length]);
      return;
    }
    if (key.name === "1" || key.name === "f") { setView("runs"); return; }
    if (key.name === "2" || key.name === "g") { setView("goals"); return; }
    if (key.name === "3" || key.name === "c") { setView("core"); return; }
    if (key.name === "4" || key.name === "t") { setView("tokens"); return; }
    if (key.name === "r") {
      forceReload[view] = true;
      needsPaint = true;
      return;
    }
    if (view === "runs") {
      if (["down", "j"].includes(key.name) && runsSnapshot?.runs.length) {
        selectedRunIndex = Math.min(runsSnapshot.runs.length - 1, selectedRunIndex + 1);
        selectedRunId = runsSnapshot.runs[selectedRunIndex].runId;
        needsPaint = true;
      } else if (["up", "k"].includes(key.name) && runsSnapshot?.runs.length) {
        selectedRunIndex = Math.max(0, selectedRunIndex - 1);
        selectedRunId = runsSnapshot.runs[selectedRunIndex].runId;
        needsPaint = true;
      } else if (key.name === "a") {
        activeOnly = !activeOnly;
        forceReload.runs = true;
        needsPaint = true;
      }
      return;
    }
    if (view === "goals") {
      if (["down", "j"].includes(key.name)) moveGoalSelection(1);
      else if (["up", "k"].includes(key.name)) moveGoalSelection(-1);
      else if (key.name === "o") {
        goalsOpenOnly = !goalsOpenOnly;
        syncGoalSelection();
        needsPaint = true;
      } else if (key.name === "x") {
        goalsExpandPlanned = !goalsExpandPlanned;
        needsPaint = true;
      }
      return;
    }
    if (view === "core") {
      const pages = coreSnapshot
        ? Math.max(1, Math.ceil(coreSnapshot.feed.length / CORE_FEED_PAGE_SIZE))
        : 1;
      if (key.name === "n") {
        corePage = Math.min(pages, corePage + 1);
        needsPaint = true;
      } else if (key.name === "p") {
        corePage = Math.max(1, corePage - 1);
        needsPaint = true;
      }
    }
  };
  const stop = () => { stopped = true; };

  const interruptibleSleep = async (ms) => {
    const step = 40;
    let left = Math.max(0, ms);
    while (left > 0 && !stopped && !needsPaint && !forceReload[view] && !(splashUntil && !splashActive())) {
      const slice = Math.min(step, left);
      await sleep(slice);
      left -= slice;
    }
  };

  const ensureViewData = async (time) => {
    const ttl = VIEW_TTL_MS[view] || 1_000;
    const listStale = forceReload[view] || !cacheAt[view] || (time - cacheAt[view]) >= ttl;
    let changed = false;

    if (view === "runs") {
      if (!listStale) return false;
      previousRunsSnapshot = runsSnapshot;
      runsSnapshot = buildFleetSnapshot({ ...config, activeOnly }, { runsRoot, runsRootSource, now: () => time });
      refreshRunSelection();
      cacheAt.runs = time;
      forceReload.runs = false;
      return true;
    }

    if (view === "goals") {
      if (listStale) {
        goalsSnapshot = await buildGoalsSnapshot({
          root: BRAIN_ROOT,
          rootSource: BRAIN_ROOT_SOURCE,
          limit: config.limit,
          now: time,
        });
        cacheAt.goals = time;
        forceReload.goals = false;
        changed = true;
      }
      syncGoalSelection();
      if (selectedGoalId && selectedGoalId !== goalProgressGoalId) {
        goalProgress = await enrichSelectedGoal(selectedGoalId, { root: BRAIN_ROOT });
        goalProgressGoalId = selectedGoalId;
        changed = true;
      } else if (!selectedGoalId && goalProgressGoalId) {
        goalProgress = null;
        goalProgressGoalId = null;
        changed = true;
      }
      return changed;
    }

    if (view === "core") {
      if (!listStale) return false;
      coreSnapshot = await buildCoreSnapshot({
        root: BRAIN_ROOT,
        rootSource: BRAIN_ROOT_SOURCE,
        limit: config.limit,
        now: time,
      });
      const corePages = Math.max(1, Math.ceil(coreSnapshot.feed.length / CORE_FEED_PAGE_SIZE));
      corePage = Math.min(corePage, corePages);
      cacheAt.core = time;
      forceReload.core = false;
      return true;
    }

    if (!listStale) return false;
    // Tokens: first open can be slow; UI already showed a loading frame.
    if (!tokensSnapshot) tokensLoading = true;
    tokensSnapshot = buildTokensSnapshot({
      sinceMs: 7 * 24 * 60 * 60 * 1_000,
      now: time,
    });
    tokensLoading = false;
    cacheAt.tokens = time;
    forceReload.tokens = false;
    return true;
  };

  const paint = () => {
    if (splashActive()) {
      const splash = formatSplash(logomark, {
        color,
        version: currentVersionInfo().runtimeVersion || "unknown",
      });
      writeRaw(`${ESC}[H${ESC}[2J${splash}`);
      frame += 1;
      needsPaint = false;
      return;
    }
    const tabBar = formatViewerTabBar(view, { color, width: width() });
    let board = "";
    if (view === "runs") {
      board = runsSnapshot
        ? formatFleetBoard(runsSnapshot, {
          width: width(),
          frame,
          color,
          effects,
          selectedRunId,
          previousSnapshot: previousRunsSnapshot,
          interactive,
          activeOnly,
        })
        : style(color, "gray", "  Loading runs…");
    } else if (view === "goals") {
      board = goalsSnapshot
        ? formatGoalsBoard(goalsSnapshot, {
          width: width(),
          color,
          selectedGoalId,
          progress: goalProgress,
          openOnly: goalsOpenOnly,
          expandPlanned: goalsExpandPlanned,
        })
        : style(color, "gray", "  Loading goals…");
    } else if (view === "core") {
      board = coreSnapshot
        ? formatCoreBoard(coreSnapshot, { width: width(), color, page: corePage })
        : style(color, "gray", "  Loading core knowledge graph…");
    } else if (tokensSnapshot) {
      board = formatTokensBoard(tokensSnapshot, {
        color,
        limit: config.limit,
      });
      if (tokensLoading) {
        board = `${style(color, "yellow", "  Refreshing token usage…")}\n${board}`;
      }
    } else {
      board = style(color, "yellow", "  Loading token usage (first open can take a few seconds)…");
    }
    writeRaw(`\u001b[H\u001b[2J${tabBar}\n${board}`);
    frame += 1;
    needsPaint = false;
  };

  try {
    if (effects) writeRaw("\u001b[?1049h\u001b[?25l");
    if (interactive) {
      readline.emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      input.on("keypress", keypress);
    }
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    while (!stopped && ticks < maxTicks) {
      ticks += 1;
      const time = now();
      const activeView = view;

      if (splashUntil && !splashActive()) {
        splashUntil = 0;
        needsPaint = true;
      }

      // Paint cached tab immediately on switch; refresh heavy data afterward.
      if (needsPaint) paint();

      const hadWork = await ensureViewData(time);
      if (stopped) break;
      if (view !== activeView) {
        needsPaint = true;
        continue;
      }
      if (hadWork || needsPaint) paint();

      const sleepMs = view === "runs" && effects ? 120 : 250;
      await interruptibleSleep(sleepMs);
    }
    return runsSnapshot;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (interactive) {
      input.removeListener("keypress", keypress);
      input.setRawMode(false);
      input.pause();
    }
    if (effects) writeRaw("\u001b[?25h\u001b[?1049l");
    else writeRaw("\n");
  }
}
