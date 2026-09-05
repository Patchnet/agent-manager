import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

// Local session-log token accounting. Reads harness session logs (read-only),
// normalizes per-message usage records, and prices them from the rate table
// below. Nothing leaves the machine; no log content beyond usage/model/cwd
// metadata is retained.
//
// Providers are pluggable: every log format is a descriptor with an id, a
// resolvable root, and a read() that returns normalized usage records. Claude
// Code and Codex ship as built-ins; anything else can be added with an env
// var (generic JSONL) or registerTokenProvider() (custom parser).

export const CLAUDE_LOGS_ROOT_ENV = "AGENT_MANAGER_CLAUDE_LOGS_ROOT";
export const CODEX_LOGS_ROOT_ENV = "AGENT_MANAGER_CODEX_LOGS_ROOT";
export const JSONL_LOGS_ROOT_ENV = "AGENT_MANAGER_TOKEN_LOGS_ROOT";
export const TOKEN_PROVIDERS_ENV = "AGENT_MANAGER_TOKEN_PROVIDERS";
export const TOKEN_PRICING_ENV = "AGENT_MANAGER_TOKEN_PRICING";

export const DEFAULT_CLAUDE_LOGS_ROOT = join(homedir(), ".claude", "projects");
export const DEFAULT_CODEX_LOGS_ROOT = join(homedir(), ".codex", "sessions");
export const DEFAULT_JSONL_LOGS_ROOT = join(homedir(), ".agent-manager", "token-logs");

// USD per million tokens, Standard API estimates (not subscription invoices).
// Model-specific rates verified 2026-09-05 at developers.openai.com/api/docs/pricing
// and platform.claude.com/docs/en/models/fable-5-1/overview.
// Legacy family estimates below retain their historical rates; update as they
// change, or extend at runtime with registerModelPricing() / a pricing file
// pointed at by AGENT_MANAGER_TOKEN_PRICING.
export const PRICING = [
  { family: "gpt-6-astra", test: /^gpt-6-astra(?:$|-\d{4}-\d{2}-\d{2}$)/, inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWrite5mPerM: 12.5, cacheWrite1hPerM: 12.5, longContextThreshold: 272000, verifiedAt: "2026-09-05" },
  { family: "gpt-5.6-sol", test: /^gpt-5\.6(?:-sol)?(?:$|-\d{4}-\d{2}-\d{2}$)/, inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.4, cacheWrite5mPerM: 5, cacheWrite1hPerM: 5, longContextThreshold: 272000, verifiedAt: "2026-09-05" },
  { family: "gpt-5.6-terra", test: /^gpt-5\.6-terra(?:$|-\d{4}-\d{2}-\d{2}$)/, inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.2, cacheWrite5mPerM: 2.5, cacheWrite1hPerM: 2.5, longContextThreshold: 272000, verifiedAt: "2026-09-05" },
  { family: "gpt-5.6-luna", test: /^gpt-5\.6-luna(?:$|-\d{4}-\d{2}-\d{2}$)/, inputPerM: 0.2, outputPerM: 1.2, cacheReadPerM: 0.02, cacheWrite5mPerM: 0.25, cacheWrite1hPerM: 0.25, longContextThreshold: 272000, verifiedAt: "2026-09-05" },
  { family: "claude-fable-5-1", test: /^claude-fable-5-1(?:$|-\d{8}$)/, inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, cacheWrite5mPerM: 12.5, cacheWrite1hPerM: 20, verifiedAt: "2026-09-05" },
  { family: "claude-fable/mythos", test: /^claude-(fable|mythos)/, inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWrite5mPerM: 12.5, cacheWrite1hPerM: 20 },
  { family: "claude-opus", test: /^claude-opus/, inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 },
  { family: "claude-sonnet", test: /^claude-sonnet/, inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWrite5mPerM: 3.75, cacheWrite1hPerM: 6 },
  { family: "claude-haiku", test: /^claude-haiku/, inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWrite5mPerM: 1.25, cacheWrite1hPerM: 2 },
  { family: "gpt-5", test: /^gpt-5(?:$|-\d{4}-\d{2}-\d{2}$)/, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125, cacheWrite5mPerM: 0, cacheWrite1hPerM: 0 },
];

function rate(entry, key, origin) {
  const value = entry[key];
  if (value === undefined || value === null) return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${origin}: ${key} must be a non-negative number`);
  }
  return number;
}

function normalizePricingEntry(entry, origin) {
  if (!entry || typeof entry !== "object") throw new Error(`${origin}: pricing entry must be an object`);
  const family = String(entry.family || "").trim();
  if (!family) throw new Error(`${origin}: pricing entry needs a family`);
  const pattern = entry.test ?? entry.match ?? null;
  let test;
  if (pattern instanceof RegExp) test = pattern;
  else if (typeof pattern === "string" && pattern.trim()) test = new RegExp(pattern);
  else test = new RegExp(`^${family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  return {
    family,
    test,
    inputPerM: rate(entry, "inputPerM", origin),
    outputPerM: rate(entry, "outputPerM", origin),
    cacheReadPerM: rate(entry, "cacheReadPerM", origin),
    cacheWrite5mPerM: rate(entry, "cacheWrite5mPerM", origin),
    cacheWrite1hPerM: rate(entry, "cacheWrite1hPerM", origin),
    longContextThreshold: rate(entry, "longContextThreshold", origin) || null,
  };
}

const registeredPricing = [];
let pricingFileCache = { key: null, entries: [] };

// Register (or replace, by family) a pricing row for the current process.
// Takes precedence over the built-in table so a host can correct a rate
// without editing this file.
export function registerModelPricing(entry) {
  const normalized = normalizePricingEntry(entry, "registerModelPricing");
  const index = registeredPricing.findIndex((existing) => existing.family === normalized.family);
  if (index >= 0) registeredPricing[index] = normalized;
  else registeredPricing.unshift(normalized);
  return normalized;
}

export function resetModelPricing() {
  registeredPricing.length = 0;
  pricingFileCache = { key: null, entries: [] };
}

// AGENT_MANAGER_TOKEN_PRICING points at a JSON file: either an array of
// pricing rows or { "models": [...] }. A malformed file is ignored rather
// than allowed to break the board — the affected models simply stay unpriced.
function pricingFromFile(env) {
  const path = env?.[TOKEN_PRICING_ENV];
  if (!path) {
    pricingFileCache = { key: null, entries: [] };
    return [];
  }
  let stamp = "missing";
  try {
    stamp = String(statSync(path).mtimeMs);
  } catch { /* re-read on every call while the file is absent */ }
  const key = `${path}:${stamp}`;
  if (key === pricingFileCache.key) return pricingFileCache.entries;
  let entries = [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : [];
    entries = rows.map((row) => normalizePricingEntry(row, TOKEN_PRICING_ENV));
  } catch {
    entries = [];
  }
  pricingFileCache = { key, entries };
  return entries;
}

export function listModelPricing({ env = process.env } = {}) {
  return [...registeredPricing, ...pricingFromFile(env), ...PRICING];
}

export function pricingFor(model, { env = process.env } = {}) {
  if (!model) return null;
  return listModelPricing({ env }).find((entry) => entry.test.test(model)) || null;
}

export function costForRecord(record, { env = process.env } = {}) {
  const pricing = pricingFor(record.model, { env });
  if (!pricing) return null;
  const write5m = record.cacheWrite5m ?? record.cacheWrite ?? 0;
  const write1h = record.cacheWrite1h ?? 0;
  const totalInput = (record.input || 0) + (record.cacheRead || 0) + write5m + write1h;
  const long = pricing.longContextThreshold && totalInput > pricing.longContextThreshold;
  return (
    ((record.input || 0) * pricing.inputPerM
    + (record.cacheRead || 0) * pricing.cacheReadPerM
    + write5m * pricing.cacheWrite5mPerM
    + write1h * pricing.cacheWrite1hPerM) * (long ? 2 : 1)
    + (record.output || 0) * pricing.outputPerM * (long ? 1.5 : 1)
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

function pickNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Unix seconds vs milliseconds: 1e12 ms is the year 2001, so anything
    // smaller is a seconds-resolution stamp.
    return value < 1e12 ? value * 1_000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

// One usage event per line. Accepts agent-manager's normalized field names and
// the two common wire shapes: Anthropic-style (input_tokens excludes cache
// reads) and OpenAI-style (prompt_tokens includes them).
function normalizeUsageEntry(entry, { source, path }) {
  if (!entry || typeof entry !== "object") return null;
  const usage = entry.usage && typeof entry.usage === "object" ? entry.usage : entry;
  const ts = parseTimestamp(entry.ts ?? entry.timestamp ?? entry.time ?? entry.created_at ?? entry.created);
  if (!Number.isFinite(ts)) return null;

  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const cacheRead = pickNumber(usage.cacheRead, usage.cache_read_input_tokens, usage.cached_input_tokens, details.cached_tokens) ?? 0;
  const cacheWrite = pickNumber(usage.cacheWrite, usage.cache_creation_input_tokens, usage.cache_write_input_tokens) ?? 0;
  const exclusiveInput = pickNumber(usage.input, usage.input_tokens);
  const inclusiveInput = pickNumber(usage.prompt_tokens);
  const input = exclusiveInput ?? (inclusiveInput === null ? 0 : Math.max(0, inclusiveInput - cacheRead));
  const output = pickNumber(usage.output, usage.output_tokens, usage.completion_tokens) ?? 0;
  if (!input && !output && !cacheRead && !cacheWrite) return null;

  return {
    ts,
    source,
    model: entry.model || usage.model || entry.response?.model || null,
    cwd: entry.cwd || entry.repo || entry.project || null,
    sessionId: entry.sessionId || entry.session_id || entry.id || basename(path, ".jsonl"),
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite5m: pickNumber(usage.cacheWrite5m, usage.cache_creation?.ephemeral_5m_input_tokens),
    cacheWrite1h: pickNumber(usage.cacheWrite1h, usage.cache_creation?.ephemeral_1h_input_tokens),
  };
}

// Generic JSONL provider — the extension path for harnesses without a bespoke
// adapter. Point a root at a folder of *.jsonl usage events (nested folders
// are walked) and they land on the board like any built-in source.
export function readJsonlUsage({ root, sinceMs = Infinity, now = Date.now(), source = "jsonl" } = {}) {
  const records = [];
  const files = root && existsSync(root) ? recentFiles(root, sinceMs, now) : [];
  for (const path of files) {
    for (const entry of safeJsonLines(path)) {
      const record = normalizeUsageEntry(entry, { source, path });
      if (!record || !withinWindow(record.ts, sinceMs, now)) continue;
      records.push(record);
    }
  }
  return records;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;

export function defineTokenProvider({ id, label, envVar = null, defaultRoot = null, format = "custom", optional = false, read } = {}) {
  const providerId = String(id ?? "").trim();
  if (!PROVIDER_ID.test(providerId)) {
    throw new Error(`token provider id must be lowercase kebab-case (got ${JSON.stringify(id ?? null)})`);
  }
  if (typeof read !== "function") {
    throw new Error(`token provider ${providerId} needs a read({ root, sinceMs, now }) function`);
  }
  return {
    id: providerId,
    label: String(label || providerId),
    envVar: envVar || null,
    defaultRoot: defaultRoot || null,
    format,
    optional: Boolean(optional),
    read,
  };
}

// Convenience factory for the generic JSONL format — the usual way to add a
// harness: give it an id, a root, and it reports under its own source name.
export function defineJsonlTokenProvider({ id, label, envVar = null, defaultRoot = null, optional = false } = {}) {
  const source = String(id ?? "").trim();
  return defineTokenProvider({
    id,
    label,
    envVar,
    defaultRoot,
    optional,
    format: "jsonl",
    read: (options = {}) => readJsonlUsage({ ...options, source }),
  });
}

export const BUILTIN_TOKEN_PROVIDERS = [
  defineTokenProvider({
    id: "claude",
    label: "Claude Code",
    envVar: CLAUDE_LOGS_ROOT_ENV,
    defaultRoot: DEFAULT_CLAUDE_LOGS_ROOT,
    format: "claude-code",
    read: readClaudeUsage,
  }),
  defineTokenProvider({
    id: "codex",
    label: "Codex CLI",
    envVar: CODEX_LOGS_ROOT_ENV,
    defaultRoot: DEFAULT_CODEX_LOGS_ROOT,
    format: "codex",
    read: readCodexUsage,
  }),
  // Opt-in: hidden from the board until the root exists or is configured.
  defineJsonlTokenProvider({
    id: "jsonl",
    label: "Generic JSONL",
    envVar: JSONL_LOGS_ROOT_ENV,
    defaultRoot: DEFAULT_JSONL_LOGS_ROOT,
    optional: true,
  }),
];

const registeredProviders = [];

// Register (or replace, by id) a provider for the current process. Hosts that
// embed agent-manager use this for formats that need a real parser.
export function registerTokenProvider(provider) {
  const normalized = defineTokenProvider(provider || {});
  const index = registeredProviders.findIndex((existing) => existing.id === normalized.id);
  if (index >= 0) registeredProviders[index] = normalized;
  else registeredProviders.push(normalized);
  return normalized;
}

export function resetTokenProviders() {
  registeredProviders.length = 0;
}

// AGENT_MANAGER_TOKEN_PROVIDERS declares extra generic-JSONL providers without
// code: "gemini=/path/to/logs;my-agent=/other/path" or a JSON object
// {"gemini": "/path"} / {"gemini": {"root": "/path", "label": "Gemini CLI"}}.
// Semicolon-separated so Windows drive letters and POSIX paths both survive.
export function parseProviderSpecs(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  if (raw.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${TOKEN_PROVIDERS_ENV}: invalid JSON`);
    }
    return Object.entries(parsed).map(([id, spec]) => (
      typeof spec === "string"
        ? { id, root: spec, label: null }
        : { id, root: spec?.root ?? null, label: spec?.label ?? null }
    ));
  }
  return raw.split(";").map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => {
    const at = chunk.indexOf("=");
    if (at < 1) throw new Error(`${TOKEN_PROVIDERS_ENV}: entries look like <id>=<path>, separated by ";"`);
    return { id: chunk.slice(0, at).trim(), root: chunk.slice(at + 1).trim(), label: null };
  });
}

function providersFromEnv(env, warnings) {
  let specs;
  try {
    specs = parseProviderSpecs(env?.[TOKEN_PROVIDERS_ENV]);
  } catch (error) {
    warnings?.push(error.message);
    return [];
  }
  const providers = [];
  for (const spec of specs) {
    if (!spec.root) {
      warnings?.push(`${TOKEN_PROVIDERS_ENV}: provider ${spec.id} has no root`);
      continue;
    }
    try {
      providers.push(defineJsonlTokenProvider({
        id: spec.id,
        label: spec.label || spec.id,
        defaultRoot: resolve(spec.root),
      }));
    } catch (error) {
      warnings?.push(`${TOKEN_PROVIDERS_ENV}: ${error.message}`);
    }
  }
  return providers;
}

// Built-ins first, then env-declared, then code-registered; later definitions
// replace earlier ones with the same id but keep the original slot order.
export function listTokenProviders({ env = process.env, warnings = null } = {}) {
  const byId = new Map();
  for (const provider of [...BUILTIN_TOKEN_PROVIDERS, ...providersFromEnv(env, warnings), ...registeredProviders]) {
    byId.set(provider.id, provider);
  }
  return [...byId.values()];
}

// Explicit override wins, then the provider's env var, then its default root.
export function resolveProviderRoot(provider, { roots = {}, env = process.env } = {}) {
  const override = roots?.[provider.id];
  if (override) return override;
  const fromEnv = provider.envVar ? env?.[provider.envVar] : null;
  if (fromEnv) return fromEnv;
  return provider.defaultRoot || null;
}

export function collectTokenUsage({
  sinceMs = Infinity,
  now = Date.now(),
  env = process.env,
  roots = {},
  providers = null,
  // Back-compat aliases for the two original built-ins.
  claudeRoot = null,
  codexRoot = null,
} = {}) {
  const warnings = [];
  const overrides = { ...roots };
  if (claudeRoot) overrides.claude = claudeRoot;
  if (codexRoot) overrides.codex = codexRoot;

  const known = listTokenProviders({ env, warnings });
  let selected = known;
  if (providers?.length) {
    selected = [];
    for (const wanted of providers) {
      if (wanted && typeof wanted === "object" && typeof wanted.read === "function") {
        selected.push(defineTokenProvider(wanted));
        continue;
      }
      const id = String(wanted ?? "").trim();
      const found = known.find((provider) => provider.id === id);
      if (found) selected.push(found);
      else warnings.push(`unknown token provider: ${id || "(empty)"}`);
    }
  }

  const records = [];
  const sources = [];
  for (const provider of selected) {
    const root = resolveProviderRoot(provider, { roots: overrides, env });
    const available = Boolean(root) && existsSync(root);
    let providerRecords = [];
    if (available) {
      try {
        providerRecords = provider.read({ root, sinceMs, now }) || [];
      } catch (error) {
        warnings.push(`${provider.id}: ${error.message}`);
      }
    }
    sources.push({
      id: provider.id,
      name: provider.id,
      label: provider.label,
      format: provider.format,
      optional: provider.optional,
      root: root || "(not configured)",
      available,
      records: providerRecords.length,
    });
    records.push(...providerRecords);
  }
  records.sort((left, right) => left.ts - right.ts);
  return { records, sources, warnings };
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
