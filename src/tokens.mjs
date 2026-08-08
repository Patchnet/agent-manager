import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  aggregateUsage,
  collectTokenUsage,
  listTokenProviders,
  resolveProviderRoot,
  usageTotals,
} from "./token-usage.mjs";
import { currentVersionInfo } from "./version.mjs";

// Tokens telemetry page — renders local harness token usage as a fleet-style
// terminal board. Sources come from the pluggable providers in
// token-usage.mjs. Read-only; nothing is uploaded anywhere.

const DEFAULT_SINCE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_LIMIT = 12;
const DEFAULT_INTERVAL_MS = 60_000;

export function tokensUsage() {
  return [
    "agent-manager tokens - local token usage telemetry",
    "",
    "Reads harness session logs on this machine through pluggable providers",
    "(built in: claude, codex, jsonl), aggregates token usage, and prices it",
    "from a rate table.",
    "",
    "Usage:",
    "  agent-manager tokens [options]",
    "",
    "Options:",
    "  --since <duration>       usage window (default: 7d; also 30m, 24h, all)",
    "  --by <grouping>          extra table: day | model | repo | source (default: summary)",
    "  --limit <n>              maximum rows per table (default: 12)",
    "  --watch                  redraw on an interval instead of printing once",
    "  --interval <sec>         watch refresh interval (default: 60)",
    "  --providers <ids>        comma-separated providers to read (default: all)",
    "  --provider-root <id=dir> override one provider's logs root (repeatable)",
    "  --claude-root <dir>      alias for --provider-root claude=<dir>",
    "  --codex-root <dir>       alias for --provider-root codex=<dir>",
    "  --list-providers         print the resolved provider table and exit",
    "  --json                   print a machine-readable snapshot and exit",
    "  --no-color               disable ANSI colors",
    "  -h, --help               show this help",
    "",
    "Environment:",
    "  AGENT_MANAGER_CLAUDE_LOGS_ROOT  Claude Code logs root",
    "  AGENT_MANAGER_CODEX_LOGS_ROOT   Codex logs root",
    "  AGENT_MANAGER_TOKEN_LOGS_ROOT   generic JSONL logs root",
    "  AGENT_MANAGER_TOKEN_PROVIDERS   extra JSONL providers: \"gemini=/path;my-agent=/path\"",
    "  AGENT_MANAGER_TOKEN_PRICING     JSON file of extra model pricing rows",
  ].join("\n");
}

export function parseTokensDuration(value) {
  if (value === "all") return Infinity;
  const match = /^(\d+(?:\.\d+)?)(m|h|d|w)$/i.exec(String(value || "").trim());
  if (!match) throw new Error("duration must look like 30m, 24h, 7d, or all");
  const units = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}

export function parseTokensArgs(argv = []) {
  const options = {
    sinceMs: DEFAULT_SINCE_MS,
    by: null,
    limit: DEFAULT_LIMIT,
    watch: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    providerRoots: {},
    providers: null,
    listProviders: false,
    json: false,
    color: process.env.NO_COLOR === undefined,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--since") options.sinceMs = parseTokensDuration(nextValue());
    else if (arg === "--by") {
      const by = nextValue();
      if (!["day", "model", "repo", "source"].includes(by)) {
        throw new Error("--by must be day, model, repo, or source");
      }
      options.by = by;
    } else if (arg === "--limit") {
      const limit = Number(nextValue());
      if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
      options.limit = limit;
    } else if (arg === "--watch") options.watch = true;
    else if (arg === "--interval") {
      const seconds = Number(nextValue());
      if (!Number.isFinite(seconds) || seconds < 5) throw new Error("--interval must be at least 5 seconds");
      options.intervalMs = Math.round(seconds * 1_000);
    } else if (arg === "--claude-root") options.providerRoots.claude = resolve(nextValue());
    else if (arg === "--codex-root") options.providerRoots.codex = resolve(nextValue());
    else if (arg === "--provider-root") {
      const spec = nextValue();
      const at = spec.indexOf("=");
      if (at < 1) throw new Error("--provider-root looks like <provider>=<dir>");
      options.providerRoots[spec.slice(0, at).trim()] = resolve(spec.slice(at + 1).trim());
    } else if (arg === "--providers") {
      const ids = nextValue().split(",").map((id) => id.trim()).filter(Boolean);
      if (!ids.length) throw new Error("--providers needs at least one provider id");
      options.providers = ids;
    } else if (arg === "--list-providers") options.listProviders = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-color") options.color = false;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown tokens option: ${arg}`);
  }
  if (options.json && options.watch) throw new Error("--json and --watch cannot be combined");
  return options;
}

// Root overrides are keyed by provider id. `claudeRoot` / `codexRoot` remain
// accepted for callers written against the two-source version.
export function providerRootOverrides(options = {}) {
  const roots = { ...(options.providerRoots || {}) };
  if (options.claudeRoot) roots.claude = options.claudeRoot;
  if (options.codexRoot) roots.codex = options.codexRoot;
  return roots;
}

export function buildTokensSnapshot(options = {}) {
  const now = options.now ?? Date.now();
  const collectOptions = { sinceMs: options.sinceMs ?? DEFAULT_SINCE_MS, now };
  const roots = providerRootOverrides(options);
  if (Object.keys(roots).length) collectOptions.roots = roots;
  if (options.providers?.length) collectOptions.providers = options.providers;
  if (options.env) collectOptions.env = options.env;
  const { records, sources, warnings } = collectTokenUsage(collectOptions);
  return {
    schema: "agent-manager.tokens.v1",
    viewer: currentVersionInfo(),
    at: new Date(now).toISOString(),
    sinceMs: collectOptions.sinceMs,
    sources,
    warnings,
    totals: usageTotals(records),
    byDay: aggregateUsage(records, { by: "day" }),
    byModel: aggregateUsage(records, { by: "model" }),
    byRepo: aggregateUsage(records, { by: "repo" }),
    bySource: aggregateUsage(records, { by: "source" }),
  };
}

const COLORS = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  brightCyan: "\u001b[96m",
  green: "\u001b[92m",
  yellow: "\u001b[93m",
  gray: "\u001b[90m",
  white: "\u001b[97m",
};

function style(enabled, ...codes) {
  const text = codes.pop();
  return enabled ? codes.map((code) => COLORS[code] || code).join("") + text + COLORS.reset : text;
}

function pad(value, width, align = "left") {
  let text = String(value ?? "-");
  if (text.length > width) text = width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
  const missing = Math.max(0, width - text.length);
  return align === "right" ? " ".repeat(missing) + text : text + " ".repeat(missing);
}

export function formatTokenCount(value) {
  const count = Number(value || 0);
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
  if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 2 : 1)}M`;
  return `${(count / 1_000_000_000).toFixed(2)}B`;
}

export function formatCost(value) {
  const cost = Number(value || 0);
  if (cost === 0) return "$0";
  if (cost < 0.01) return "<$0.01";
  if (cost < 100) return `$${cost.toFixed(2)}`;
  return `$${Math.round(cost).toLocaleString("en-US")}`;
}

function formatWindow(sinceMs) {
  if (!Number.isFinite(sinceMs)) return "all time";
  if (sinceMs % 86_400_000 === 0) return `last ${sinceMs / 86_400_000}d`;
  if (sinceMs % 3_600_000 === 0) return `last ${sinceMs / 3_600_000}h`;
  return `last ${Math.round(sinceMs / 60_000)}m`;
}

const DAY_MS = 86_400_000;
const HEATMAP_MAX_WEEKS = 26;

// Contribution-style heatmap grid: columns are weeks (Monday-aligned, UTC),
// rows are weekdays. Cell level 0-4 scales each day's total tokens against
// the busiest day in view.
export function buildDailyHeatmap(byDay, { now = Date.now(), maxWeeks = HEATMAP_MAX_WEEKS } = {}) {
  const totals = new Map();
  for (const row of byDay) {
    totals.set(row.key, row.input + row.output + row.cacheRead + row.cacheWrite);
  }
  if (!totals.size) return null;

  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const mondayOf = (ts) => ts - ((new Date(ts).getUTCDay() + 6) % 7) * DAY_MS;
  const earliest = Date.parse([...totals.keys()].sort()[0]);
  // Cap after Monday alignment so the grid never exceeds maxWeeks columns.
  const start = Math.max(mondayOf(earliest), mondayOf(today) - (maxWeeks - 1) * 7 * DAY_MS);

  const max = Math.max(...totals.values());
  const weeks = [];
  for (let weekStart = start; weekStart <= today; weekStart += 7 * DAY_MS) {
    const days = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const ts = weekStart + offset * DAY_MS;
      if (ts > today) {
        days.push(null); // future day
        continue;
      }
      const key = new Date(ts).toISOString().slice(0, 10);
      const total = totals.get(key) || 0;
      const level = total === 0 || max === 0 ? 0 : Math.max(1, Math.ceil((total / max) * 4));
      days.push({ date: key, total, level });
    }
    weeks.push(days);
  }
  return { weeks, max, from: new Date(start).toISOString().slice(0, 10) };
}

const HEAT_LEVEL_CHARS = [" ·", "░░", "▒▒", "▓▓", "██"];
// 256-color green ramp; level 0 renders as a dim dot.
const HEAT_LEVEL_COLORS = ["\u001b[38;5;238m", "\u001b[38;5;22m", "\u001b[38;5;28m", "\u001b[38;5;40m", "\u001b[38;5;46m"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];

export function formatHeatmap(heatmap, { color = false } = {}) {
  if (!heatmap || !heatmap.weeks.length) return [];
  const lines = [];
  lines.push(style(color, "bold", "DAILY HEAT"));

  // Month header: labels start at the first week of each month and may span
  // adjacent 2-char columns; skip a label when it would collide with the last.
  // +2 tail so a label starting in the final column isn't clipped mid-word.
  const monthChars = Array.from({ length: 4 + heatmap.weeks.length * 2 + 2 }, () => " ");
  let previousMonth = null;
  let labelEnd = 0;
  heatmap.weeks.forEach((week, weekIndex) => {
    const firstDay = week.find(Boolean);
    if (!firstDay) return;
    const month = Number(firstDay.date.slice(5, 7)) - 1;
    if (month === previousMonth) return;
    previousMonth = month;
    const position = 4 + weekIndex * 2;
    if (position < labelEnd) return;
    const label = MONTHS[month];
    for (let index = 0; index < label.length && position + index < monthChars.length; index += 1) {
      monthChars[position + index] = label[index];
    }
    labelEnd = position + label.length + 1;
  });
  lines.push(style(color, "gray", monthChars.join("").replace(/\s+$/, "")));

  for (let weekday = 0; weekday < 7; weekday += 1) {
    let row = pad(WEEKDAY_LABELS[weekday], 4);
    for (const week of heatmap.weeks) {
      const day = week[weekday];
      if (!day) {
        row += "  ";
        continue;
      }
      const cell = day.level === 0 ? HEAT_LEVEL_CHARS[0] : HEAT_LEVEL_CHARS[day.level];
      row += color ? `${HEAT_LEVEL_COLORS[day.level]}${day.level === 0 ? cell : "██"}${COLORS.reset}` : cell;
    }
    lines.push(row);
  }

  const legendCells = [1, 2, 3, 4]
    .map((level) => (color ? `${HEAT_LEVEL_COLORS[level]}██${COLORS.reset}` : HEAT_LEVEL_CHARS[level]))
    .join("");
  lines.push(style(color, "gray", `    less ${legendCells} more · total tokens/day · peak ${formatTokenCount(heatmap.max)}`));
  return lines;
}

function usageTable(title, rows, { keyHeader, keyWidth, limit, color }) {
  const lines = [];
  const shown = rows.slice(rows.length > limit && keyHeader === "DAY" ? rows.length - limit : 0, keyHeader === "DAY" ? undefined : limit);
  lines.push(style(color, "bold", title));
  const header = [
    pad(keyHeader, keyWidth),
    pad("INPUT", 9, "right"),
    pad("OUTPUT", 9, "right"),
    pad("CACHE-R", 9, "right"),
    pad("CACHE-W", 9, "right"),
    pad("MSGS", 7, "right"),
    pad("COST", 10, "right"),
  ].join(" ");
  lines.push(style(color, "gray", `  ${header}`));
  if (!shown.length) {
    lines.push(style(color, "dim", "  (no usage in window)"));
    return lines;
  }
  for (const row of shown) {
    const costLabel = row.unpriced ? `${formatCost(row.cost)}*` : formatCost(row.cost);
    lines.push(`  ${[
      pad(row.key, keyWidth),
      pad(formatTokenCount(row.input), 9, "right"),
      pad(formatTokenCount(row.output), 9, "right"),
      pad(formatTokenCount(row.cacheRead), 9, "right"),
      pad(formatTokenCount(row.cacheWrite), 9, "right"),
      pad(String(row.records), 7, "right"),
      pad(costLabel, 10, "right"),
    ].join(" ")}`);
  }
  if (rows.length > shown.length) {
    lines.push(style(color, "dim", `  … ${rows.length - shown.length} more rows (raise --limit)`));
  }
  return lines;
}

export function formatTokensBoard(snapshot, { color = false, limit = DEFAULT_LIMIT, by = null } = {}) {
  const lines = [];
  const version = snapshot.viewer?.runtimeVersion || "unknown";
  lines.push(`${style(color, "bold", "◆ AGENT MANAGER")} ${style(color, "gray", `v${version} · TOKENS`)}  ${style(color, "brightCyan", formatWindow(snapshot.sinceMs))} ${style(color, "gray", `· as of ${snapshot.at}`)}`);
  // Opt-in providers stay off the board until their root exists, so an unused
  // extension point never reads as a misconfiguration.
  for (const source of snapshot.sources) {
    if (source.optional && !source.available) continue;
    const status = source.available ? `${source.records} messages` : "not found";
    lines.push(style(color, source.available ? "gray" : "yellow", `  ${pad(source.label || source.name, 14)} ${source.root} [${status}]`));
  }
  for (const warning of snapshot.warnings || []) {
    lines.push(style(color, "yellow", `  ! ${warning}`));
  }
  lines.push(style(color, "gray", "─".repeat(88)));
  const totals = snapshot.totals;
  lines.push([
    style(color, "bold", "TOTALS"),
    style(color, "white", `input ${formatTokenCount(totals.input)}`),
    style(color, "white", `output ${formatTokenCount(totals.output)}`),
    style(color, "gray", `cache-r ${formatTokenCount(totals.cacheRead)}`),
    style(color, "gray", `cache-w ${formatTokenCount(totals.cacheWrite)}`),
    style(color, "green", `est ${formatCost(totals.cost)}`),
  ].join("  "));
  if (totals.unpriced) {
    lines.push(style(color, "yellow", `  * ${totals.unpriced} messages from unpriced models excluded from cost — add rates via AGENT_MANAGER_TOKEN_PRICING`));
  }
  const heatmap = buildDailyHeatmap(snapshot.byDay, { now: Date.parse(snapshot.at) });
  if (heatmap) {
    lines.push("");
    lines.push(...formatHeatmap(heatmap, { color }));
  }
  lines.push("");
  lines.push(...usageTable("BY DAY", snapshot.byDay, { keyHeader: "DAY", keyWidth: 12, limit, color }));
  lines.push("");
  lines.push(...usageTable("BY MODEL", snapshot.byModel, { keyHeader: "MODEL", keyWidth: 24, limit, color }));
  if (by === "repo" || by === "source") {
    const rows = by === "repo" ? snapshot.byRepo : snapshot.bySource;
    lines.push("");
    lines.push(...usageTable(`BY ${by.toUpperCase()}`, rows, { keyHeader: by.toUpperCase(), keyWidth: 24, limit, color }));
  } else if (by === "day" || by === "model") {
    // Already shown above; nothing extra to add.
  } else {
    lines.push("");
    lines.push(...usageTable("BY REPO", snapshot.byRepo, { keyHeader: "REPO", keyWidth: 24, limit, color }));
  }
  return lines.join("\n");
}

// `--list-providers`: what would be read, where from, and whether it resolves.
// The origin column is the answer to "why is this provider pointing there".
export function buildProvidersSnapshot(options = {}) {
  const env = options.env || process.env;
  const roots = providerRootOverrides(options);
  const warnings = [];
  const wanted = options.providers?.length ? new Set(options.providers) : null;
  const providers = listTokenProviders({ env, warnings }).map((provider) => {
    const root = resolveProviderRoot(provider, { roots, env });
    let origin = "default";
    if (roots[provider.id]) origin = "flag";
    else if (provider.envVar && env?.[provider.envVar]) origin = `env:${provider.envVar}`;
    else if (!provider.defaultRoot) origin = "unset";
    return {
      id: provider.id,
      label: provider.label,
      format: provider.format,
      optional: provider.optional,
      selected: !wanted || wanted.has(provider.id),
      root: root || "(not configured)",
      origin,
      available: Boolean(root) && existsSync(root),
    };
  });
  for (const id of wanted || []) {
    if (!providers.some((provider) => provider.id === id)) warnings.push(`unknown token provider: ${id}`);
  }
  return { schema: "agent-manager.token-providers.v1", providers, warnings };
}

export function formatProvidersTable(snapshot, { color = false } = {}) {
  const lines = [style(color, "bold", "TOKEN PROVIDERS")];
  lines.push(style(color, "gray", `  ${[
    pad("ID", 14),
    pad("FORMAT", 12),
    pad("ORIGIN", 34),
    pad("ROOT", 48),
    pad("STATE", 14),
  ].join(" ")}`));
  for (const provider of snapshot.providers) {
    const state = [provider.available ? "found" : "not found"];
    if (!provider.selected) state.push("skipped");
    lines.push(`  ${[
      pad(provider.id, 14),
      pad(provider.format, 12),
      pad(provider.origin, 34),
      pad(provider.root, 48),
      pad(state.join("/"), 14),
    ].join(" ")}`);
  }
  for (const warning of snapshot.warnings) lines.push(style(color, "yellow", `  ! ${warning}`));
  lines.push(style(color, "dim", "  add providers with AGENT_MANAGER_TOKEN_PROVIDERS=\"<id>=<dir>;…\" or registerTokenProvider()"));
  return lines.join("\n");
}

export async function runTokens(options) {
  if (options.listProviders) {
    const snapshot = buildProvidersSnapshot(options);
    console.log(options.json ? JSON.stringify(snapshot) : formatProvidersTable(snapshot, { color: options.color }));
    return;
  }
  const render = () => {
    const snapshot = buildTokensSnapshot(options);
    if (options.json) {
      console.log(JSON.stringify(snapshot));
      return;
    }
    console.log(formatTokensBoard(snapshot, { color: options.color, limit: options.limit, by: options.by }));
  };
  render();
  if (!options.watch) return;
  await new Promise((resolvePromise) => {
    const timer = setInterval(() => {
      console.clear();
      render();
      console.log(style(options.color, "gray", `\nRefreshing every ${Math.round(options.intervalMs / 1_000)}s — Ctrl+C to exit`));
    }, options.intervalMs);
    const stop = () => {
      clearInterval(timer);
      resolvePromise();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
