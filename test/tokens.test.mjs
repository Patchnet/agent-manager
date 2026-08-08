import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-tokens-"));
const claudeRoot = join(root, "claude-projects");
const codexRoot = join(root, "codex-sessions");
mkdirSync(join(claudeRoot, "C--dev-example"), { recursive: true });
mkdirSync(join(codexRoot, "2026", "08", "07"), { recursive: true });

const {
  aggregateUsage,
  collectTokenUsage,
  costForRecord,
  pricingFor,
  readClaudeUsage,
  readCodexUsage,
  usageTotals,
} = await import("../src/token-usage.mjs?tokens-test");
const {
  buildDailyHeatmap,
  buildTokensSnapshot,
  formatCost,
  formatHeatmap,
  formatTokenCount,
  formatTokensBoard,
  parseTokensArgs,
  parseTokensDuration,
} = await import("../src/tokens.mjs?tokens-test");

test.after(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-08-07T12:00:00.000Z");

function claudeLine(overrides = {}) {
  return JSON.stringify({
    type: "assistant",
    cwd: "C:\\dev\\example",
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
      payload: { session_id: "codex-fixture", cwd: "C:\\dev\\example", model_provider: "openai" },
    }),
    JSON.stringify({
      timestamp: "2026-08-07T09:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6", cwd: "C:\\dev\\example" },
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

test("pricingFor matches model families and rejects unknowns", () => {
  assert.equal(pricingFor("claude-opus-5").family, "claude-opus");
  assert.equal(pricingFor("claude-sonnet-4-6").family, "claude-sonnet");
  assert.equal(pricingFor("claude-fable-5").family, "claude-fable/mythos");
  assert.equal(pricingFor("gpt-5.6-sol").family, "gpt-5");
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
  const { records, sources } = collectTokenUsage({ sinceMs: Infinity, now: NOW, claudeRoot, codexRoot });
  assert.equal(records.length, 4);
  assert.deepEqual(sources.map((source) => [source.name, source.available, source.records]), [
    ["claude", true, 3],
    ["codex", true, 1],
  ]);
  const missing = collectTokenUsage({ sinceMs: Infinity, now: NOW, claudeRoot: join(root, "nope"), codexRoot });
  assert.equal(missing.sources[0].available, false);
  assert.equal(missing.sources[0].records, 0);
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

test("buildTokensSnapshot and formatTokensBoard render a stable board", () => {
  const snapshot = buildTokensSnapshot({ sinceMs: Infinity, now: NOW, claudeRoot, codexRoot });
  assert.equal(snapshot.schema, "agent-manager.tokens.v1");
  assert.equal(snapshot.totals.records, 4);
  assert.ok(snapshot.byModel.length >= 3);

  const board = formatTokensBoard(snapshot, { color: false, limit: 12 });
  assert.match(board, /TOKENS/);
  assert.match(board, /TOTALS/);
  assert.match(board, /BY DAY/);
  assert.match(board, /BY MODEL/);
  assert.match(board, /claude-opus-5/);
  assert.match(board, /gpt-5\.6/);
  assert.doesNotMatch(board, /\u001b\[/, "no ANSI codes with color disabled");

  const repoBoard = formatTokensBoard(snapshot, { color: false, limit: 12, by: "source" });
  assert.match(repoBoard, /BY SOURCE/);
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
