import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-master-return-"));
process.env.AGENT_MANAGER_DEV_ROOT = root;
process.env.AGENT_MANAGER_RUNS_ROOT = join(root, "runs");

const {
  buildMasterHandoff,
  dispatchMasterReturn,
  masterHandoffPath,
  masterReturnPrompt,
  masterReturnSummary,
  readMasterReturn,
  resolveMasterReturn,
  shouldReturnToMaster,
  writeMasterReturn,
} = await import("../src/master-return.mjs?master-return-test");

test.after(() => rmSync(root, { recursive: true, force: true }));

function actionablePayload(overrides = {}) {
  return {
    reason: "state_change",
    runId: "run-return",
    state: "delivery_review_pending",
    cadence: {
      stage: "workers_complete",
      transition: "AUTO_CONTINUE",
      nextAction: "Post Run Outcome and present Delivery Review Pass 1.",
      operatorInputRequired: [],
      template: "Run outcome + Delivery Review · Pass 1",
    },
    ...overrides,
  };
}

test("Master return auto-detects Codex, Claude Code, and Cursor host signals", () => {
  const codex = resolveMasterReturn({
    env: { CODEX_THREAD_ID: "thread-test-1" },
  });
  assert.equal(codex.host, "codex");
  assert.equal(codex.mode, "direct");
  assert.equal(codex.sessionId, "thread-test-1");
  assert.equal(codex.source, "CODEX_THREAD_ID");

  const claude = resolveMasterReturn({
    env: { CLAUDE_CODE_SESSION_ID: "claude-session-1" },
  });
  assert.equal(claude.host, "claude");
  assert.equal(claude.mode, "direct");
  assert.equal(claude.sessionId, "claude-session-1");
  assert.equal(claude.source, "CLAUDE_CODE_SESSION_ID");

  const cursor = resolveMasterReturn({ env: { CURSOR_AGENT: "1" } });
  assert.equal(cursor.host, "cursor");
  assert.equal(cursor.mode, "signal");
  assert.equal("sessionId" in cursor, false);
  assert.equal(cursor.source, "CURSOR_AGENT");

  assert.equal(resolveMasterReturn({
    env: { CODEX_THREAD_ID: "thread-test-1", AGENT_MANAGER_TEST_MODE: "1" },
  }), null);

  const explicit = resolveMasterReturn({
    host: "codex",
    sessionId: "thread-explicit",
    env: { AGENT_MANAGER_TEST_MODE: "1" },
  });
  assert.equal(explicit.source, "cli");
  assert.equal(explicit.mode, "direct");
  const cursorDirect = resolveMasterReturn({
    host: "cursor",
    sessionId: "cursor-chat",
    env: { AGENT_MANAGER_TEST_MODE: "1" },
  });
  assert.equal(cursorDirect.mode, "direct");
  const cursorSignal = resolveMasterReturn({
    host: "cursor",
    env: { AGENT_MANAGER_TEST_MODE: "1" },
  });
  assert.equal(cursorSignal.mode, "signal");
  assert.throws(
    () => resolveMasterReturn({ host: "other", sessionId: "one", env: {} }),
    /unsupported master return host/,
  );
  assert.throws(
    () => resolveMasterReturn({ host: "codex", env: {} }),
    /requires a session id/,
  );
});

test("master return summaries and handoffs never expose the session id", () => {
  const channel = resolveMasterReturn({
    host: "codex",
    sessionId: "private-thread-id",
    env: {},
  });
  const summary = masterReturnSummary(channel);
  assert.equal(summary.host, "codex");
  assert.equal(summary.mode, "direct");
  assert.equal("sessionId" in summary, false);

  const handoff = buildMasterHandoff("run-return", actionablePayload());
  const prompt = masterReturnPrompt(handoff);
  assert.match(prompt, /AUTO_CONTINUE/);
  assert.match(prompt, /Delivery Review Pass 1/);
  assert.doesNotMatch(JSON.stringify(handoff), /private-thread-id/);
  assert.doesNotMatch(prompt, /private-thread-id/);
});

for (const host of ["codex", "claude", "cursor"]) {
  test(`actionable completion returns to the ${host} Master session regardless of lane harness`, async () => {
    const runId = `run-return-${host}`;
    const channel = resolveMasterReturn({
      host,
      sessionId: `${host}-session`,
      env: {},
    });
    writeMasterReturn(runId, channel);

    let invocation = null;
    const executor = async (options) => {
      invocation = options;
      return { exitCode: 0, lastActivity: "turn.completed" };
    };
    const result = await dispatchMasterReturn(
      runId,
      actionablePayload({
        runId,
        lanes: [
          { id: "one", harness: "claude" },
          { id: "two", harness: "codex" },
        ],
      }),
      { repoRoot: root },
      {
        executeCodex: executor,
        executeClaude: executor,
        executeCursor: executor,
      },
    );

    assert.equal(result.delivered, true);
    assert.equal(invocation.channel.host, host);
    assert.equal(invocation.channel.sessionId, `${host}-session`);
    assert.equal(invocation.handoff.cadence.stage, "workers_complete");
    assert.equal(readMasterReturn(runId).state, "delivered");
    assert.equal(readMasterReturn(runId).attempts, 1);
    assert.ok(existsSync(masterHandoffPath(runId)));
    const storedHandoff = JSON.parse(readFileSync(masterHandoffPath(runId), "utf8"));
    assert.equal(storedHandoff.runId, runId);
    assert.equal("sessionId" in storedHandoff, false);
  });
}

test("Cursor IDE signal mode persists the handoff without claiming direct delivery", async () => {
  const runId = "run-cursor-signal";
  writeMasterReturn(runId, resolveMasterReturn({ host: "cursor", env: {} }));
  let called = false;
  const result = await dispatchMasterReturn(
    runId,
    actionablePayload({ runId }),
    { repoRoot: root },
    { executeCursor: async () => { called = true; return { exitCode: 0 }; } },
  );
  assert.equal(result.delivered, false);
  assert.equal(result.signaled, true);
  assert.equal(called, false);
  assert.equal(readMasterReturn(runId).state, "signal_ready");
  assert.ok(readMasterReturn(runId).lastSignaledAt);
  assert.ok(existsSync(masterHandoffPath(runId)));
});

test("routine progress does not resume Master Dev", async () => {
  const runId = "run-routine";
  writeMasterReturn(runId, resolveMasterReturn({
    host: "codex",
    sessionId: "thread-routine",
    env: {},
  }));
  let called = false;
  const result = await dispatchMasterReturn(
    runId,
    actionablePayload({
      reason: "heartbeat",
      state: "running",
      cadence: { stage: "run_active", transition: "AUTO_CONTINUE" },
    }),
    { repoRoot: root },
    { executeCodex: async () => { called = true; return { exitCode: 0 }; } },
  );
  assert.equal(result.skipped, true);
  assert.equal(called, false);
  assert.equal(shouldReturnToMaster(actionablePayload({ reason: "heartbeat" })), true);
  assert.equal(shouldReturnToMaster(actionablePayload({ reason: "needs_input" })), true);
  assert.equal(shouldReturnToMaster(actionablePayload({ reason: "terminal" })), true);
});

test("failed direct delivery is persisted for diagnosis", async () => {
  const runId = "run-failed-return";
  writeMasterReturn(runId, resolveMasterReturn({
    host: "codex",
    sessionId: "thread-failed",
    env: {},
  }));
  const result = await dispatchMasterReturn(
    runId,
    actionablePayload({ runId }),
    { repoRoot: root },
    { executeCodex: async () => ({ exitCode: 1, lastActivity: "session is active" }) },
  );
  assert.equal(result.delivered, false);
  assert.match(result.error, /session is active/);
  assert.equal(readMasterReturn(runId).state, "failed");
});
