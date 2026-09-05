import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-tokens-"));
const claudeRoot = join(root, "claude-projects");
const codexRoot = join(root, "codex-sessions");
const jsonlRoot = join(root, "jsonl-usage");
const missingRoot = join(root, "not-a-directory");
mkdirSync(join(claudeRoot, "C--dev-example"), { recursive: true });
mkdirSync(join(codexRoot, "2026", "08", "07"), { recursive: true });
mkdirSync(join(jsonlRoot, "nested"), { recursive: true });

// Pin every provider that reads process.env to a fixture path so the suite
// never touches the developer's real harness logs.
process.env.AGENT_MANAGER_CLAUDE_LOGS_ROOT = claudeRoot;
process.env.AGENT_MANAGER_CODEX_LOGS_ROOT = codexRoot;
process.env.AGENT_MANAGER_TOKEN_LOGS_ROOT = missingRoot;
delete process.env.AGENT_MANAGER_TOKEN_PROVIDERS;
delete process.env.AGENT_MANAGER_TOKEN_PRICING;

const {
  aggregateUsage,
  collectTokenUsage,
  costForRecord,
  defineJsonlTokenProvider,
  defineTokenProvider,
  listTokenProviders,
  parseProviderSpecs,
  pricingFor,
  readClaudeUsage,
  readCodexUsage,
  readJsonlUsage,
  registerModelPricing,
  registerTokenProvider,
  resetModelPricing,
  resetTokenProviders,
  resolveProviderRoot,
  usageTotals,
} = await import("../src/token-usage.mjs?tokens-test");
const {
  buildDailyHeatmap,
  buildProvidersSnapshot,
  buildTokensSnapshot,
  formatCost,
  formatHeatmap,
  formatProvidersTable,
  formatTokenCount,
  formatTokensBoard,
  formatUsageWindows,
  parseTokensArgs,
  parseTokensDuration,
  summarizeUsageWindows,
} = await import("../src/tokens.mjs?tokens-test");

test.after(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-08-07T12:00:00.000Z");

// Forward slashes on purpose: path.basename treats "/" as a separator on both
// win32 and posix, so the BY REPO column resolves to "example" on either
// platform. A backslash-only fixture would only group correctly on Windows.
const FIXTURE_CWD = "/repos/example";

function claudeLine(overrides = {}) {
  return JSON.stringify({
    type: "assistant",
    cwd: FIXTURE_CWD,
    sessionId: "sess-fixture",
    timestamp: "2026-08-07T10:00:00.000Z",
    requestId: "req_1",
    message: {
      id: "msg_1",
      model: "claude-opus-5",
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 1_000,
        cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 },
      },
    },
    ...overrides,
  });
}

function codexLines() {
  return [
    JSON.stringify({
      timestamp: "2026-08-07T09:00:00.000Z",
      type: "session_meta",
      payload: { session_id: "codex-fixture", cwd: FIXTURE_CWD, model_provider: "openai" },
    }),
    JSON.stringify({
      timestamp: "2026-08-07T09:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6", cwd: FIXTURE_CWD },
    }),
    JSON.stringify({
      timestamp: "2026-08-07T09:00:30.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 10_000, cached_input_tokens: 9_000, cache_write_input_tokens: 0, output_tokens: 400, total_tokens: 10_400 },
          last_token_usage: { input_tokens: 10_000, cached_input_tokens: 9_000, cache_write_input_tokens: 0, output_tokens: 400, total_tokens: 10_400 },
        },
      },
    }),
  ].join("\n");
}

writeFileSync(join(claudeRoot, "C--dev-example", "session.jsonl"), [
  claudeLine(),
  // Duplicate requestId — streaming rewrite; only the last snapshot counts.
  claudeLine({ message: { id: "msg_1", model: "claude-opus-5", usage: { input_tokens: 100, output_tokens: 250, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 500 } } }),
  claudeLine({ requestId: "req_2", timestamp: "2026-08-06T10:00:00.000Z", message: { id: "msg_2", model: "claude-sonnet-5", usage: { input_tokens: 50, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  // Outside a 24h window when filtered.
  claudeLine({ requestId: "req_old", timestamp: "2026-07-01T10:00:00.000Z", message: { id: "msg_old", model: "claude-opus-5", usage: { input_tokens: 999, output_tokens: 999 } } }),
  // Synthetic + non-assistant lines are ignored.
  claudeLine({ message: { id: "msg_syn", model: "<synthetic>", usage: { input_tokens: 5, output_tokens: 5 } } }),
  JSON.stringify({ type: "user", message: { role: "user" } }),
  "not-json",
].join("\n"));

writeFileSync(join(codexRoot, "2026", "08", "07", "rollout-fixture.jsonl"), codexLines());

// Generic JSONL fixture: one Anthropic-shaped event, one OpenAI-shaped event,
// plus lines that must be dropped (no timestamp, no usage).
writeFileSync(join(jsonlRoot, "nested", "usage.jsonl"), [
  JSON.stringify({
    timestamp: "2026-08-07T11:00:00.000Z",
    model: "claude-haiku-4-5",
    cwd: FIXTURE_CWD,
    sessionId: "jsonl-fixture",
    usage: {
      input_tokens: 20,
      output_tokens: 30,
      cache_read_input_tokens: 40,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 40 },
      cache_creation_input_tokens: 50,
    },
  }),
  JSON.stringify({
    created: Math.floor(Date.parse("2026-08-07T08:00:00.000Z") / 1_000),
    model: "gpt-5.6",
    usage: { prompt_tokens: 1_000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 900 } },
  }),
  JSON.stringify({ model: "claude-opus-5", usage: { input_tokens: 5, output_tokens: 5 } }),
  JSON.stringify({ timestamp: "2026-08-07T11:30:00.000Z", model: "claude-opus-5" }),
  "not-json",
].join("\n"));

test("pricingFor matches model families and rejects unknowns", () => {
  assert.equal(pricingFor("claude-opus-5").family, "claude-opus");
  assert.equal(pricingFor("claude-sonnet-4-6").family, "claude-sonnet");
  assert.equal(pricingFor("claude-fable-5").family, "claude-fable/mythos");
  assert.equal(pricingFor("gpt-5.6-sol").family, "gpt-5.6-sol");
  assert.equal(pricingFor("mystery-model"), null);
  assert.equal(pricingFor(null), null);
});

test("costForRecord prices claude usage with cache TTL split", () => {
  const cost = costForRecord({
    model: "claude-opus-5",
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
    cacheWrite5m: 500_000,
    cacheWrite1h: 500_000,
  });
  // 5 + 25 + 0.5 + (0.5 * 6.25) + (0.5 * 10)
  assert.equal(cost, 5 + 25 + 0.5 + 3.125 + 5);
});

test("costForRecord falls back to 5m pricing without a TTL split and nulls unknown models", () => {
  const cost = costForRecord({ model: "claude-haiku-4-5", input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite5m: null, cacheWrite1h: null });
  assert.equal(cost, 1.25);
  assert.equal(costForRecord({ model: "mystery", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
});

test("readClaudeUsage parses assistant turns, dedupes requests, and windows by time", () => {
  const records = readClaudeUsage({ root: claudeRoot, sinceMs: Infinity, now: NOW });
  assert.equal(records.length, 3);
  const first = records.find((record) => record.sessionId === "sess-fixture" && record.model === "claude-opus-5" && record.output === 250);
  assert.ok(first, "deduped record keeps the last usage snapshot");
  assert.equal(first.cacheRead, 1_000);

  const windowed = readClaudeUsage({ root: claudeRoot, sinceMs: 36 * 3_600_000, now: NOW });
  assert.equal(windowed.length, 2, "old record filtered out by window");
});

test("readCodexUsage attributes model from turn_context and separates cached input", () => {
  const records = readCodexUsage({ root: codexRoot, sinceMs: Infinity, now: NOW });
  assert.equal(records.length, 1);
  assert.equal(records[0].model, "gpt-5.6");
  assert.equal(records[0].sessionId, "codex-fixture");
  assert.equal(records[0].input, 1_000, "uncached input = input_tokens - cached_input_tokens");
  assert.equal(records[0].cacheRead, 9_000);
  assert.equal(records[0].output, 400);
});

test("collectTokenUsage merges sources and reports availability", () => {
  const { records, sources, warnings } = collectTokenUsage({ sinceMs: Infinity, now: NOW, claudeRoot, codexRoot });
  assert.equal(records.length, 4);
  assert.deepEqual(warnings, []);
  assert.deepEqual(sources.map((source) => [source.id, source.available, source.records]), [
    ["claude", true, 3],
    ["codex", true, 1],
    ["jsonl", false, 0],
  ]);
  const missing = collectTokenUsage({ sinceMs: Infinity, now: NOW, claudeRoot: join(root, "nope"), codexRoot });
  assert.equal(missing.sources[0].available, false);
  assert.equal(missing.sources[0].records, 0);
});

test("collectTokenUsage restricts to requested providers and warns on unknown ids", () => {
  const { records, sources, warnings } = collectTokenUsage({
    sinceMs: Infinity,
    now: NOW,
    providers: ["codex", "nope"],
    roots: { codex: codexRoot },
  });
  assert.deepEqual(sources.map((source) => source.id), ["codex"]);
  assert.equal(records.length, 1);
  assert.deepEqual(warnings, ["unknown token provider: nope"]);
});

test("readJsonlUsage normalizes anthropic-style and openai-style events", () => {
  const records = readJsonlUsage({ root: jsonlRoot, sinceMs: Infinity, now: NOW });
  assert.equal(records.length, 2, "undated and usage-free lines are dropped");

  const anthropic = records.find((record) => record.model === "claude-haiku-4-5");
  assert.equal(anthropic.source, "jsonl");
  assert.equal(anthropic.sessionId, "jsonl-fixture");
  assert.equal(anthropic.input, 20, "input_tokens already excludes cache reads");
  assert.equal(anthropic.cacheRead, 40);
  assert.equal(anthropic.cacheWrite, 50);
  assert.equal(anthropic.cacheWrite1h, 40);

  const openai = records.find((record) => record.model === "gpt-5.6");
  assert.equal(openai.input, 100, "prompt_tokens includes cached tokens, so subtract them");
  assert.equal(openai.cacheRead, 900);
  assert.equal(openai.output, 100);
  assert.equal(openai.ts, Date.parse("2026-08-07T08:00:00.000Z"), "unix seconds are scaled to ms");

  const windowed = readJsonlUsage({ root: jsonlRoot, sinceMs: 2 * 3_600_000, now: NOW });
  assert.equal(windowed.length, 1, "08:00 event falls outside a 2h window ending at noon");
  assert.deepEqual(readJsonlUsage({ root: missingRoot, sinceMs: Infinity, now: NOW }), []);
});

test("jsonl provider is opt-in and reads its root once configured", () => {
  const { records, sources } = collectTokenUsage({
    sinceMs: Infinity,
    now: NOW,
    providers: ["jsonl"],
    roots: { jsonl: jsonlRoot },
  });
  assert.equal(records.length, 2);
  assert.equal(sources[0].optional, true);
  assert.equal(sources[0].format, "jsonl");
  assert.equal(sources[0].available, true);
});

test("defineTokenProvider validates ids and readers", () => {
  assert.throws(() => defineTokenProvider({ id: "Bad Id", read: () => [] }), /kebab-case/);
  assert.throws(() => defineTokenProvider({ id: "ok" }), /read\(/);
  const provider = defineJsonlTokenProvider({ id: "gemini", label: "Gemini CLI", defaultRoot: jsonlRoot });
  assert.equal(provider.format, "jsonl");
  assert.equal(provider.read({ root: jsonlRoot, sinceMs: Infinity, now: NOW })[0].source, "gemini");
});

test("registerTokenProvider adds a custom parser until it is reset", () => {
  try {
    registerTokenProvider({
      id: "mock",
      label: "Mock Harness",
      read: ({ root: readRoot }) => [{
        ts: NOW,
        source: "mock",
        model: "claude-sonnet-5",
        cwd: readRoot,
        sessionId: "mock-1",
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite5m: null,
        cacheWrite1h: null,
      }],
    });
    assert.ok(listTokenProviders().some((provider) => provider.id === "mock"));
    const { records, sources } = collectTokenUsage({
      sinceMs: Infinity,
      now: NOW,
      providers: ["mock"],
      roots: { mock: root },
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].source, "mock");
    assert.equal(sources[0].label, "Mock Harness");
  } finally {
    resetTokenProviders();
  }
  assert.ok(!listTokenProviders().some((provider) => provider.id === "mock"));
});

test("a throwing provider is reported as a warning instead of crashing the board", () => {
  try {
    registerTokenProvider({
      id: "broken",
      read: () => {
        throw new Error("log format changed");
      },
    });
    const { records, warnings } = collectTokenUsage({
      sinceMs: Infinity,
      now: NOW,
      providers: ["broken"],
      roots: { broken: root },
    });
    assert.deepEqual(records, []);
    assert.deepEqual(warnings, ["broken: log format changed"]);
  } finally {
    resetTokenProviders();
  }
});

test("parseProviderSpecs accepts list and JSON forms and rejects junk", () => {
  assert.deepEqual(parseProviderSpecs("gemini=/logs/gemini;my-agent=C:\\logs\\mine"), [
    { id: "gemini", root: "/logs/gemini", label: null },
    { id: "my-agent", root: "C:\\logs\\mine", label: null },
  ]);
  assert.deepEqual(parseProviderSpecs('{"gemini":{"root":"/logs","label":"Gemini CLI"}}'), [
    { id: "gemini", root: "/logs", label: "Gemini CLI" },
  ]);
  assert.deepEqual(parseProviderSpecs(""), []);
  assert.deepEqual(parseProviderSpecs(undefined), []);
  assert.throws(() => parseProviderSpecs("gemini"), /<id>=<path>/);
  assert.throws(() => parseProviderSpecs("{oops"), /invalid JSON/);
});

test("AGENT_MANAGER_TOKEN_PROVIDERS declares extra providers without code", () => {
  const env = { AGENT_MANAGER_TOKEN_PROVIDERS: `gemini=${jsonlRoot}` };
  const providers = listTokenProviders({ env });
  assert.ok(providers.some((provider) => provider.id === "gemini"));

  const { records, sources } = collectTokenUsage({ sinceMs: Infinity, now: NOW, env, providers: ["gemini"] });
  assert.equal(records.length, 2);
  assert.equal(records[0].source, "gemini");
  assert.equal(sources[0].root, jsonlRoot);

  const warned = collectTokenUsage({
    sinceMs: Infinity,
    now: NOW,
    env: { AGENT_MANAGER_TOKEN_PROVIDERS: "oops" },
    providers: ["claude"],
    roots: { claude: claudeRoot },
  });
  assert.match(warned.warnings[0], /<id>=<path>/);
  assert.equal(warned.records.length, 3, "a bad spec does not stop the healthy providers");
});

test("resolveProviderRoot prefers an override, then the env var, then the default", () => {
  const provider = defineJsonlTokenProvider({ id: "gemini", envVar: "GEMINI_LOGS", defaultRoot: "/default" });
  const env = { GEMINI_LOGS: "/from-env" };
  assert.equal(resolveProviderRoot(provider, { roots: { gemini: "/override" }, env }), "/override");
  assert.equal(resolveProviderRoot(provider, { env }), "/from-env");
  assert.equal(resolveProviderRoot(provider, { env: {} }), "/default");
  assert.equal(resolveProviderRoot(defineJsonlTokenProvider({ id: "bare" }), { env: {} }), null);
});

test("registerModelPricing and a pricing file price otherwise unknown models", () => {
  const record = { model: "gemini-3-pro", input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
  assert.equal(costForRecord(record), null);
  try {
    registerModelPricing({ family: "gemini-3", test: "^gemini-3", inputPerM: 2, outputPerM: 12 });
    assert.equal(pricingFor("gemini-3-pro").family, "gemini-3");
    assert.equal(costForRecord(record), 14);
  } finally {
    resetModelPricing();
  }
  assert.equal(costForRecord(record), null, "reset restores the built-in table");

  const pricingPath = join(root, "pricing.json");
  writeFileSync(pricingPath, JSON.stringify({ models: [{ family: "gemini-3", inputPerM: 1, outputPerM: 10 }] }));
  const env = { AGENT_MANAGER_TOKEN_PRICING: pricingPath };
  try {
    assert.equal(costForRecord(record, { env }), 11, "family is used as the model prefix when no test is given");
    assert.equal(costForRecord(record), null, "process env is untouched");

    const brokenPath = join(root, "pricing-broken.json");
    writeFileSync(brokenPath, "{ not json");
    assert.equal(
      costForRecord(record, { env: { AGENT_MANAGER_TOKEN_PRICING: brokenPath } }),
      null,
      "a malformed pricing file is ignored, not fatal",
    );
  } finally {
    resetModelPricing();
  }
});

test("aggregateUsage groups by day, model, repo, and source", () => {
  const { records } = collectTokenUsage({ sinceMs: Infinity, now: NOW, claudeRoot, codexRoot });
  const byDay = aggregateUsage(records, { by: "day" });
  assert.deepEqual(byDay.map((row) => row.key), ["2026-07-01", "2026-08-06", "2026-08-07"]);

  const byModel = aggregateUsage(records, { by: "model" });
  assert.ok(byModel.some((row) => row.key === "gpt-5.6"));
  assert.ok(byModel.some((row) => row.key === "claude-opus-5"));

  const byRepo = aggregateUsage(records, { by: "repo" });
  assert.ok(byRepo.some((row) => row.key === "example"));

  const bySource = aggregateUsage(records, { by: "source" });
  assert.deepEqual(new Set(bySource.map((row) => row.key)), new Set(["claude", "codex"]));

  assert.throws(() => aggregateUsage(records, { by: "nope" }), /unknown grouping/);
});

test("usageTotals sums records and counts unpriced models", () => {
  const totals = usageTotals([
    { model: "claude-opus-5", input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    { model: "mystery", input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  ]);
  assert.equal(totals.records, 2);
  assert.equal(totals.input, 11);
  assert.equal(totals.unpriced, 1);
  assert.ok(totals.cost > 0);
});

test("parseTokensDuration and parseTokensArgs validate options", () => {
  assert.equal(parseTokensDuration("24h"), 86_400_000);
  assert.equal(parseTokensDuration("all"), Infinity);
  assert.throws(() => parseTokensDuration("soon"), /duration/);

  const options = parseTokensArgs(["--since", "24h", "--by", "model", "--limit", "5", "--json"]);
  assert.equal(options.sinceMs, 86_400_000);
  assert.equal(options.by, "model");
  assert.equal(options.limit, 5);
  assert.equal(options.json, true);

  assert.throws(() => parseTokensArgs(["--by", "banana"]), /--by/);
  assert.throws(() => parseTokensArgs(["--json", "--watch"]), /cannot be combined/);
  assert.throws(() => parseTokensArgs(["--frobnicate"]), /unknown tokens option/);
});

test("parseTokensArgs collects provider roots and provider filters", () => {
  const options = parseTokensArgs([
    "--provider-root", `gemini=${jsonlRoot}`,
    "--claude-root", claudeRoot,
    "--providers", "claude, gemini",
    "--list-providers",
  ]);
  assert.equal(options.providerRoots.gemini, jsonlRoot);
  assert.equal(options.providerRoots.claude, claudeRoot);
  assert.deepEqual(options.providers, ["claude", "gemini"]);
  assert.equal(options.listProviders, true);

  assert.throws(() => parseTokensArgs(["--provider-root", "gemini"]), /<provider>=<dir>/);
  assert.throws(() => parseTokensArgs(["--providers", " , "]), /at least one provider id/);
});

test("buildProvidersSnapshot reports where each provider root came from", () => {
  const snapshot = buildProvidersSnapshot({
    env: { AGENT_MANAGER_CODEX_LOGS_ROOT: codexRoot, AGENT_MANAGER_TOKEN_PROVIDERS: `gemini=${jsonlRoot}` },
    providerRoots: { claude: claudeRoot },
    providers: ["claude", "gemini", "ghost"],
  });
  const byId = Object.fromEntries(snapshot.providers.map((provider) => [provider.id, provider]));
  assert.equal(byId.claude.origin, "flag");
  assert.equal(byId.claude.available, true);
  assert.equal(byId.codex.origin, "env:AGENT_MANAGER_CODEX_LOGS_ROOT");
  assert.equal(byId.codex.selected, false, "not requested via --providers");
  assert.equal(byId.jsonl.origin, "default");
  assert.equal(byId.gemini.root, jsonlRoot);
  assert.deepEqual(snapshot.warnings, ["unknown token provider: ghost"]);

  const table = formatProvidersTable(snapshot, { color: false });
  assert.match(table, /TOKEN PROVIDERS/);
  assert.match(table, /gemini/);
  assert.match(table, /! unknown token provider: ghost/);
});

test("board hides unconfigured opt-in providers and surfaces warnings", () => {
  const hidden = formatTokensBoard(
    buildTokensSnapshot({ sinceMs: Infinity, now: NOW, claudeRoot, codexRoot }),
    { color: false, limit: 12 },
  );
  assert.match(hidden, /Claude Code/);
  assert.doesNotMatch(hidden, /Generic JSONL/, "opt-in provider stays off the board until its root exists");

  const shown = formatTokensBoard(
    buildTokensSnapshot({ sinceMs: Infinity, now: NOW, providerRoots: { claude: claudeRoot, codex: codexRoot, jsonl: jsonlRoot } }),
    { color: false, limit: 12 },
  );
  assert.match(shown, /Generic JSONL/);

  const warned = formatTokensBoard(
    buildTokensSnapshot({ sinceMs: Infinity, now: NOW, providers: ["claude", "ghost"], providerRoots: { claude: claudeRoot } }),
    { color: false, limit: 12 },
  );
  assert.match(warned, /! unknown token provider: ghost/);
});

test("buildTokensSnapshot and formatTokensBoard render a stable board", () => {
  const snapshot = buildTokensSnapshot({ sinceMs: Infinity, now: NOW, claudeRoot, codexRoot });
  assert.equal(snapshot.schema, "agent-manager.tokens.v1");
  assert.equal(snapshot.totals.records, 4);
  assert.ok(snapshot.byModel.length >= 3);

  const board = formatTokensBoard(snapshot, { color: false, limit: 12 });
  assert.match(board, /TOKENS/);
  assert.match(board, /LOGGED USAGE/);
  assert.match(board, /BY DAY/);
  assert.match(board, /BY MODEL/);
  assert.match(board, /claude-opus-5/);
  assert.match(board, /gpt-5\.6/);
  assert.doesNotMatch(board, /\u001b\[/, "no ANSI codes with color disabled");

  const repoBoard = formatTokensBoard(snapshot, { color: false, limit: 12, by: "source" });
  assert.match(repoBoard, /BY SOURCE/);
});

const WINDOW_DAYS = [
  // NOW is 2026-08-07T12:00Z, so the 7d window opens on 2026-08-01.
  { key: "2026-07-01", records: 1, input: 1_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: 1, unpriced: 0 },
  { key: "2026-07-31", records: 1, input: 100, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.5, unpriced: 1 },
  { key: "2026-08-06", records: 2, input: 20, output: 2, cacheRead: 5, cacheWrite: 7, cost: 0.25, unpriced: 0 },
  { key: "2026-08-07", records: 3, input: 3, output: 4, cacheRead: 6, cacheWrite: 8, cost: 0.125, unpriced: 0 },
];

test("summarizeUsageWindows labels the all-logged row and adds today plus last-7d", () => {
  const summary = summarizeUsageWindows(WINDOW_DAYS, { now: NOW, sinceMs: Infinity });
  assert.equal(summary.earliest, "2026-07-01");
  assert.equal(summary.today, "2026-08-07");
  assert.equal(summary.weekStart, "2026-08-01");
  assert.deepEqual(summary.rows.map((row) => row.key), ["all", "today", "last7d"]);

  const [all, today, week] = summary.rows;
  assert.equal(all.label, "ALL LOGGED (since 2026-07-01)");
  assert.equal(all.input, 1_123);
  assert.equal(all.records, 7);
  assert.equal(all.unpriced, 1, "unpriced messages carry through the summary");

  assert.equal(today.label, "TODAY (2026-08-07 UTC)");
  assert.equal(today.input, 3);
  assert.equal(today.records, 3);

  assert.equal(week.label, "LAST 7D (2026-08-01 → 2026-08-07)");
  assert.equal(week.input, 23, "only 08-06 and 08-07 fall inside the rolling week");
  assert.equal(week.cost, 0.375);
});

test("summarizeUsageWindows omits a rolling row the collection window cannot cover", () => {
  const dayOnly = summarizeUsageWindows(WINDOW_DAYS, { now: NOW, sinceMs: 86_400_000 });
  assert.deepEqual(dayOnly.rows.map((row) => row.key), ["all", "today"], "a 24h read cannot report a 7d window");

  const tooShort = summarizeUsageWindows(WINDOW_DAYS, { now: NOW, sinceMs: 30 * 60_000 });
  assert.deepEqual(tooShort.rows.map((row) => row.key), ["all"], "a 30m read does not cover today either");

  assert.equal(summarizeUsageWindows([], { now: NOW }), null);
});

test("formatUsageWindows renders the summary rows and the semantics footnote", () => {
  const block = formatUsageWindows(summarizeUsageWindows(WINDOW_DAYS, { now: NOW, sinceMs: Infinity }), { color: false }).join("\n");
  assert.match(block, /LOGGED USAGE/);
  assert.match(block, /WINDOW/);
  assert.match(block, /ALL LOGGED \(since 2026-07-01\)/);
  assert.match(block, /TODAY \(2026-08-07 UTC\)/);
  assert.match(block, /LAST 7D \(2026-08-01 → 2026-08-07\)/);
  assert.match(block, /not a balance/);
  assert.doesNotMatch(block, /… \d+ more rows/, "summary rows are never truncated by --limit");

  const empty = formatUsageWindows(null, { color: false }).join("\n");
  assert.match(empty, /no usage in window/);
  assert.match(empty, /not a balance/);
});

test("formatTokensBoard replaces the old TOTALS row with the labelled windows", () => {
  const snapshot = buildTokensSnapshot({ sinceMs: Infinity, now: NOW, claudeRoot, codexRoot });
  assert.equal(snapshot.windows.earliest, "2026-07-01");
  assert.equal(snapshot.windows.rows[0].input, snapshot.totals.input, "all-logged matches the raw totals");

  const board = formatTokensBoard(snapshot, { color: false, limit: 12 });
  assert.match(board, /ALL LOGGED \(since 2026-07-01\)/);
  assert.match(board, /TODAY \(2026-08-07 UTC\)/);
  assert.match(board, /LAST 7D/);
  assert.doesNotMatch(board, /^TOTALS/m, "the ambiguous TOTALS row is gone");

  const dayBoard = formatTokensBoard(
    buildTokensSnapshot({ sinceMs: 86_400_000, now: NOW, claudeRoot, codexRoot }),
    { color: false, limit: 12 },
  );
  assert.match(dayBoard, /TODAY \(2026-08-07 UTC\)/);
  assert.doesNotMatch(dayBoard, /LAST 7D/, "a 24h read does not claim a 7d window");
});

test("buildDailyHeatmap builds a Monday-aligned grid with scaled levels", () => {
  // NOW is Friday 2026-08-07 UTC.
  const byDay = [
    { key: "2026-08-03", input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }, // Monday, light
    { key: "2026-08-06", input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 }, // Thursday, peak
    { key: "2026-07-28", input: 500, output: 0, cacheRead: 0, cacheWrite: 0 }, // previous Tuesday
  ];
  const heatmap = buildDailyHeatmap(byDay, { now: NOW });
  assert.equal(heatmap.weeks.length, 2, "two Monday-aligned week columns");
  assert.equal(heatmap.max, 1_000);
  assert.equal(heatmap.from, "2026-07-27", "grid starts on the Monday before the earliest day");

  const [firstWeek, lastWeek] = heatmap.weeks;
  assert.equal(firstWeek[1].date, "2026-07-28");
  assert.equal(firstWeek[1].level, 2, "500/1000 → level 2");
  assert.equal(lastWeek[0].level, 1, "100/1000 → level 1 (nonzero floors at 1)");
  assert.equal(lastWeek[3].level, 4, "peak day → level 4");
  assert.equal(lastWeek[2].level, 0, "day with no usage → level 0");
  assert.equal(lastWeek[5], null, "future Saturday is blank");
  assert.equal(lastWeek[6], null, "future Sunday is blank");

  assert.equal(buildDailyHeatmap([], { now: NOW }), null, "no data → no heatmap");
});

test("buildDailyHeatmap caps the grid at maxWeeks", () => {
  const byDay = [
    { key: "2025-01-01", input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
    { key: "2026-08-06", input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
  ];
  const heatmap = buildDailyHeatmap(byDay, { now: NOW, maxWeeks: 4 });
  assert.ok(heatmap.weeks.length <= 4, `expected <= 4 weeks, got ${heatmap.weeks.length}`);
});

test("formatHeatmap renders weekday rows, month labels, and a legend", () => {
  const byDay = [
    { key: "2026-06-10", input: 250, output: 0, cacheRead: 0, cacheWrite: 0 },
    { key: "2026-07-28", input: 500, output: 0, cacheRead: 0, cacheWrite: 0 },
    { key: "2026-08-06", input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 },
  ];
  const heatmap = buildDailyHeatmap(byDay, { now: NOW });
  const plain = formatHeatmap(heatmap, { color: false }).join("\n");
  assert.match(plain, /DAILY HEAT/);
  assert.match(plain, /Jun/);
  assert.match(plain, /Jul/);
  assert.match(plain, /Aug/);
  assert.match(plain, /Mon /);
  assert.match(plain, /Fri /);
  assert.match(plain, /less .*more/);
  assert.match(plain, /peak 1\.0k/);
  assert.doesNotMatch(plain, /\[/, "no ANSI without color");

  const colored = formatHeatmap(heatmap, { color: true }).join("\n");
  assert.match(colored, /\[38;5;46m/, "peak cell uses the brightest green");
});

test("formatHeatmap skips a month label that would collide in a narrow grid", () => {
  const byDay = [
    { key: "2026-07-28", input: 500, output: 0, cacheRead: 0, cacheWrite: 0 },
    { key: "2026-08-06", input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 },
  ];
  const plain = formatHeatmap(buildDailyHeatmap(byDay, { now: NOW }), { color: false }).join("\n");
  assert.match(plain, /Jul/);
  assert.doesNotMatch(plain, /Aug/, "second label dropped rather than overlapping in a 2-week grid");
});

test("formatTokensBoard includes the heatmap section when data exists", () => {
  const snapshot = buildTokensSnapshot({ sinceMs: Infinity, now: NOW, claudeRoot, codexRoot });
  const board = formatTokensBoard(snapshot, { color: false, limit: 12 });
  assert.match(board, /DAILY HEAT/);
});

test("formatters render human-readable counts and costs", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1_500), "1.5k");
  assert.equal(formatTokenCount(2_500_000), "2.50M");
  assert.equal(formatTokenCount(3_000_000_000), "3.00B");
  assert.equal(formatCost(0), "$0");
  assert.equal(formatCost(0.001), "<$0.01");
  assert.equal(formatCost(12.345), "$12.35");
  assert.equal(formatCost(1234), "$1,234");
});
