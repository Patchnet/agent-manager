import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnClaude, resumeClaude } from "../src/harness/claude.mjs";
import { checkHarnessOptions } from "../src/preflight.mjs";
import { normalizeHarnessOptions, parseEffort } from "../src/harness/options.mjs";
import { buildCodexArgs } from "../src/harness/codex.mjs";
import { buildHarnessEnv } from "../src/environment.mjs";
import { inspectSupervision } from "../src/supervision.mjs";
import { costForRecord, pricingFor } from "../src/token-usage.mjs";
import { createDeliveryStatus, recordReviewDecision, recordReviewPresentation } from "../src/delivery.mjs";

test("harness options preserve omission and reject unsupported combinations", () => {
  assert.deepEqual(normalizeHarnessOptions(undefined, "codex"), {});
  assert.throws(() => normalizeHarnessOptions({ effort: "none" }, "codex", "gpt-6-astra"), /does not support/);
  assert.throws(() => normalizeHarnessOptions({ effort: "minimal" }, "claude"), /does not support/);
  assert.throws(() => normalizeHarnessOptions({ profile: "../outside" }, "codex"), /simple profile/);
  assert.throws(() => normalizeHarnessOptions({ profile: "work" }, "claude"), /only supported/);
  assert.throws(() => normalizeHarnessOptions({ effort: "high" }, "cursor"), /not supported/);
  assert.throws(() => normalizeHarnessOptions({ bypass: true }, "codex"), /unknown/);
  assert.equal(parseEffort({ payload: { reasoning_effort: "high" } }), "high");
  assert.equal(parseEffort({ type: "assistant", text: "high" }), null);
  const env = buildHarnessEnv([], { CLAUDE_CODE_EFFORT_LEVEL: "medium", SECRET_EXAMPLE: "not-forwarded" });
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, "medium");
  assert.equal(env.SECRET_EXAMPLE, undefined);
});

test("Codex binds effort and profile before resume without changing permissions", () => {
  for (const resumeSessionId of [null, "session"]) {
    const args = buildCodexArgs({ cwd: "/repo", platform: "linux", env: {}, resumeSessionId,
      harnessOptions: { effort: "high", profile: "work" }, model: "gpt-6-astra" });
    assert.deepEqual(args.slice(0, 5), ["exec", "--profile", "work", "-c", 'model_reasoning_effort="high"']);
    assert.ok(args.includes("workspace-write"));
    assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
    if (resumeSessionId) assert.ok(args.indexOf("--profile") < args.indexOf("resume"));
  }
});

test("quiet work gets grace, recovers on output, and cannot outrun its deadline", () => {
  const policy = { stall_timeout_sec: 10, stall_grace_sec: 20, max_runtime_sec: 60 };
  const check = (now, lastByteAt = 0) => inspectSupervision({ startedAt: 0, lastByteAt, policy, now });
  assert.equal(check(9999).state, "active");
  assert.equal(check(10000).state, "quiet");
  assert.equal(check(29999).action, "continue");
  assert.equal(check(30000).reason, "silence_timeout");
  assert.equal(check(30000, 29999).state, "active");
  assert.equal(check(60000, 60000).reason, "runtime_deadline");
  assert.equal(inspectSupervision({ startedAt: 0, lastByteAt: 9000000, now: 9000000 }).action, "continue");
  assert.equal(inspectSupervision({ startedAt: 0, lastByteAt: 0,
    policy: { ...policy, stall_grace_sec: 0 }, now: 10000 }).action, "cancel");
});

test("pricing distinguishes Fable cache rates and Astra context tiers", () => {
  const env = {};
  const price = (model, fields) => costForRecord({ model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...fields }, { env });
  assert.equal(price("claude-fable-5-1", { cacheRead: 1000000 }), 0.25);
  assert.equal(price("claude-fable-5", { cacheRead: 1000000 }), 1);
  assert.equal(price("gpt-6-astra", { input: 272000 }), 2.72);
  assert.equal(price("gpt-6-astra", { input: 272001, output: 1000 }), 5.51502);
  assert.equal(price("gpt-6-astra", { cacheWrite: 1000 }), 0.0125);
  assert.equal(price("gpt-5.6-sol", { input: 1000, output: 1000 }), 0.024);
  assert.equal(pricingFor("gpt-5-future", { env }), null);
});

test("opt-in correction budget permits sequential review and bounds retries", () => {
  const status = { delivery: createDeliveryStatus({ delivery: { review_budget: { max_corrections: 2, max_elapsed_sec: 60 } } }, []) };
  const decide = (pass, verdict, at, notes) => recordReviewDecision(status, { pass, verdict, at, notes, reviewer: "operator" });
  decide(1, "revise", "2026-09-05T00:00:00Z");
  assert.throws(() => decide(3, "accept", "2026-09-05T00:00:01Z"), /requires a recorded pass 2/);
  recordReviewPresentation(status, { pass: 2 });
  assert.throws(() => decide(2, "revise", "2026-09-05T00:00:02Z"), /requires notes/);
  decide(2, "revise", "2026-09-05T00:00:02Z", "Tests pass; finish missing behavior.");
  assert.throws(() => decide(3, "revise", "2026-09-05T00:00:03Z", "more"), /budget exhausted/);
  decide(3, "accept", "2026-09-05T00:05:00Z");
  assert.equal(status.state, "reviewed");
  assert.throws(() => decide(3, "accept", "2026-09-05T00:05:01Z"), /already has/);
});

test("expired correction time permits disposition but not another retry", () => {
  const status = { delivery: createDeliveryStatus({ delivery: { review_budget: { max_corrections: 3, max_elapsed_sec: 60 } } }, []) };
  recordReviewDecision(status, { pass: 1, verdict: "revise", reviewer: "operator", at: "2026-09-05T00:00:00Z" });
  assert.throws(() => recordReviewDecision(status, { pass: 2, verdict: "revise", reviewer: "operator", notes: "progress", at: "2026-09-05T00:01:00Z" }), /budget exhausted/);
  recordReviewDecision(status, { pass: 2, verdict: "reject", reviewer: "operator", at: "2026-09-05T00:01:00Z" });
  assert.equal(status.state, "rejected");
});

test("Claude start/resume pass explicit effort and preserve inherited effort when omitted", async () => {
  const root = mkdtempSync(join(tmpdir(), "am-effort-contract-"));
  try {
    const cli = join(root, "fixture.mjs");
    writeFileSync(cli, `
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(process.env.FIXTURE_OLD ? '--model' : '--model --effort --profile --config');
} else {
  process.stdin.resume();
  process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', session_id: 'fixture',
    args, effort: process.env.CLAUDE_CODE_EFFORT_LEVEL, result: 'ok' })));
}
`);
    const launcher = join(root, process.platform === "win32" ? "fixture.cmd" : "fixture.sh");
    writeFileSync(launcher, process.platform === "win32"
      ? `@echo off\r\nnode "${cli}" %*\r\n`
      : `#!/bin/sh\nexec node "${cli}" "$@"\n`);
    if (process.platform !== "win32") chmodSync(launcher, 0o755);
    const env = { ...process.env, CLAUDE_BIN: launcher, CLAUDE_CODE_EFFORT_LEVEL: "low" };
    for (const [i, resume] of [false, true].entries()) {
      for (const [j, effort] of [undefined, "high"].entries()) {
        const laneDir = join(root, `lane-${i}-${j}`);
        mkdirSync(laneDir);
        const events = [];
        const handle = (resume ? resumeClaude : spawnClaude)({ cwd: root, laneDir, prompt: "fixture",
          sessionId: "fixture", env, harnessOptions: effort ? { effort } : {},
          onEvent: (event) => events.push(event) });
        assert.equal((await handle.done).exitCode, 0);
        assert.equal(events[0].effort, effort || "low");
        assert.equal(events[0].args.includes("--effort"), Boolean(effort));
        assert.ok(events[0].args.includes("acceptEdits"));
      }
    }
    assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, "low", "explicit lanes must not mutate parent defaults");
    assert.equal(checkHarnessOptions(launcher, "claude", [{ effort: "high" }], { env }).ok, true);
    assert.equal(checkHarnessOptions(launcher, "claude", [{ effort: "high" }], { env: { ...env, FIXTURE_OLD: "1" } }).ok, false);
    assert.equal(checkHarnessOptions(launcher, "claude", [{}]), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
