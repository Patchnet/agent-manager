import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// Local session-log token accounting. Reads harness session logs (read-only),
// normalizes per-message usage records, and prices them from the static table
// below. Nothing leaves the machine; no log content beyond usage/model/cwd
// metadata is retained.

export const DEFAULT_CLAUDE_LOGS_ROOT = join(homedir(), ".claude", "projects");
export const DEFAULT_CODEX_LOGS_ROOT = join(homedir(), ".codex", "sessions");

// USD per million tokens. Cache economics: Anthropic bills cache reads at
// 0.1x input, 5m-TTL cache writes at 1.25x, 1h-TTL writes at 2x. OpenAI bills
// cached input at a flat discounted rate and does not charge cache writes.
// Verified against provider pricing 2026-08-07 — update rates here as they change.
export const PRICING = [
  { family: "claude-fable/mythos", test: /^claude-(fable|mythos)/, inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWrite5mPerM: 12.5, cacheWrite1hPerM: 20 },
  { family: "claude-opus", test: /^claude-opus/, inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 },
  { family: "claude-sonnet", test: /^claude-sonnet/, inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWrite5mPerM: 3.75, cacheWrite1hPerM: 6 },
  { family: "claude-haiku", test: /^claude-haiku/, inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWrite5mPerM: 1.25, cacheWrite1hPerM: 2 },
  { family: "gpt-5", test: /^gpt-5/, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125, cacheWrite5mPerM: 0, cacheWrite1hPerM: 0 },
];

export function pricingFor(model) {
  if (!model) return null;
  return PRICING.find((entry) => entry.test.test(model)) || null;
}

export function costForRecord(record) {
  const pricing = pricingFor(record.model);
  if (!pricing) return null;
  const write5m = record.cacheWrite5m ?? record.cacheWrite;
  const write1h = record.cacheWrite1h ?? 0;
  return (
    record.input * pricing.inputPerM
    + record.output * pricing.outputPerM
    + record.cacheRead * pricing.cacheReadPerM
    + write5m * pricing.cacheWrite5mPerM
    + write1h * pricing.cacheWrite1hPerM
  ) / 1_000_000;
}

function listFilesRecursive(root, extension, results = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) listFilesRecursive(path, extension, results);
    else if (entry.isFile() && entry.name.endsWith(extension)) results.push(path);
  }
  return results;
}

function recentFiles(root, sinceMs, now) {
  const cutoff = Number.isFinite(sinceMs) ? now - sinceMs : 0;
  return listFilesRecursive(root, ".jsonl").filter((path) => {
    try {
      return statSync(path).mtimeMs >= cutoff;
    } catch {
      return false;
    }
  });
}

function safeJsonLines(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const parsed = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch { /* skip malformed lines */ }
  }
  return parsed;
}

function withinWindow(timestamp, sinceMs, now) {
  if (!Number.isFinite(sinceMs)) return Number.isFinite(timestamp);
  return Number.isFinite(timestamp) && timestamp >= now - sinceMs;
}

// Claude Code: ~/.claude/projects/<project>/<session>.jsonl — one JSON object
// per line; assistant turns carry message.usage. Streaming can repeat a
// message id across lines, so dedupe on requestId/message.id keeping the last
// (most complete) usage snapshot.
export function readClaudeUsage({ root = DEFAULT_CLAUDE_LOGS_ROOT, sinceMs = Infinity, now = Date.now() } = {}) {
  const byKey = new Map();
  const files = existsSync(root) ? recentFiles(root, sinceMs, now) : [];
  for (const path of files) {
    for (const entry of safeJsonLines(path)) {
      const usage = entry?.message?.usage;
      if (entry?.type !== "assistant" || !usage) continue;
      const model = entry.message.model || null;
      if (!model || model === "<synthetic>") continue;
      const timestamp = Date.parse(entry.timestamp || "");
      if (!withinWindow(timestamp, sinceMs, now)) continue;
      const cacheWrite5m = usage.cache_creation?.ephemeral_5m_input_tokens;
      const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens;
      const key = `${path}:${entry.requestId || entry.message.id || `${timestamp}`}`;
      byKey.set(key, {
        ts: timestamp,
        source: "claude",
        model,
        cwd: entry.cwd || null,
        sessionId: entry.sessionId || basename(path, ".jsonl"),
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheWrite: usage.cache_creation_input_tokens || 0,
        cacheWrite5m: cacheWrite5m ?? null,
        cacheWrite1h: cacheWrite1h ?? null,
      });
    }
  }
  return [...byKey.values()];
}

// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — event_msg/token_count
// entries carry cumulative and per-turn usage; turn_context carries the model.
// Codex input_tokens INCLUDES cached_input_tokens, so uncached input is the
// difference. output_tokens already includes reasoning tokens.
export function readCodexUsage({ root = DEFAULT_CODEX_LOGS_ROOT, sinceMs = Infinity, now = Date.now() } = {}) {
  const records = [];
  const files = existsSync(root) ? recentFiles(root, sinceMs, now) : [];
  for (const path of files) {
    let model = null;
    let cwd = null;
    let sessionId = basename(path, ".jsonl");
    for (const entry of safeJsonLines(path)) {
      const payload = entry?.payload;
      if (!payload) continue;
      if (entry.type === "session_meta") {
        cwd = payload.cwd || cwd;
        sessionId = payload.session_id || payload.id || sessionId;
        if (payload.model) model = payload.model;
      } else if (entry.type === "turn_context") {
        if (payload.model) model = payload.model;
        if (payload.cwd) cwd = payload.cwd;
      } else if (entry.type === "event_msg" && payload.type === "token_count") {
        const usage = payload.info?.last_token_usage;
        if (!usage) continue;
        const timestamp = Date.parse(entry.timestamp || "");
        if (!withinWindow(timestamp, sinceMs, now)) continue;
        const cached = usage.cached_input_tokens || 0;
        records.push({
          ts: timestamp,
          source: "codex",
          model,
          cwd,
          sessionId,
          input: Math.max(0, (usage.input_tokens || 0) - cached),
          output: usage.output_tokens || 0,
          cacheRead: cached,
          cacheWrite: usage.cache_write_input_tokens || 0,
          cacheWrite5m: null,
          cacheWrite1h: null,
        });
      }
    }
  }
  return records;
}

export function collectTokenUsage({
  sinceMs = Infinity,
  now = Date.now(),
  claudeRoot = process.env.AGENT_MANAGER_CLAUDE_LOGS_ROOT || DEFAULT_CLAUDE_LOGS_ROOT,
  codexRoot = process.env.AGENT_MANAGER_CODEX_LOGS_ROOT || DEFAULT_CODEX_LOGS_ROOT,
} = {}) {
  const sources = [
    { name: "claude", root: claudeRoot, available: existsSync(claudeRoot), reader: readClaudeUsage },
    { name: "codex", root: codexRoot, available: existsSync(codexRoot), reader: readCodexUsage },
  ];
  const records = [];
  for (const source of sources) {
    const sourceRecords = source.available ? source.reader({ root: source.root, sinceMs, now }) : [];
    source.records = sourceRecords.length;
    delete source.reader;
    records.push(...sourceRecords);
  }
  records.sort((left, right) => left.ts - right.ts);
  return { records, sources };
}

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

const GROUPERS = {
  day: (record) => dayKey(record.ts),
  model: (record) => record.model || "unknown",
  repo: (record) => (record.cwd ? basename(record.cwd) : "unknown"),
  source: (record) => record.source,
};

export function aggregateUsage(records, { by = "day" } = {}) {
  const grouper = GROUPERS[by];
  if (!grouper) throw new Error(`unknown grouping: ${by} (expected day, model, repo, or source)`);
  const rows = new Map();
  for (const record of records) {
    const key = grouper(record);
    let row = rows.get(key);
    if (!row) {
      row = { key, records: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 };
      rows.set(key, row);
    }
    row.records += 1;
    row.input += record.input;
    row.output += record.output;
    row.cacheRead += record.cacheRead;
    row.cacheWrite += record.cacheWrite;
    const cost = costForRecord(record);
    if (cost === null) row.unpriced += 1;
    else row.cost += cost;
  }
  const sorted = [...rows.values()];
  if (by === "day") sorted.sort((left, right) => left.key.localeCompare(right.key));
  else sorted.sort((left, right) => right.cost - left.cost || right.output - left.output);
  return sorted;
}

export function usageTotals(records) {
  const totals = { records: records.length, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 };
  for (const record of records) {
    totals.input += record.input;
    totals.output += record.output;
    totals.cacheRead += record.cacheRead;
    totals.cacheWrite += record.cacheWrite;
    const cost = costForRecord(record);
    if (cost === null) totals.unpriced += 1;
    else totals.cost += cost;
  }
  return totals;
}
