import test from "node:test";
import assert from "node:assert/strict";
import { deriveOperatorCadence } from "../src/cadence.mjs";

function status(state, overrides = {}) {
  return {
    runId: "run-cadence",
    state,
    lanes: [],
    delivery: {
      state,
      review: { state: "not_started", latestPass: 0, history: [] },
      targets: [],
    },
    ...overrides,
  };
}

test("operator cadence advances worker completion into review before asking", () => {
  const result = deriveOperatorCadence(status("delivery_review_pending"));
  assert.equal(result.transition, "AUTO_CONTINUE");
  assert.equal(result.stage, "workers_complete");
  assert.match(result.nextAction, /present Delivery Review Pass 1/i);
  assert.deepEqual(result.operatorInputRequired, []);
});

test("operator cadence waits only after Delivery Review is presented", () => {
  const result = deriveOperatorCadence(status("delivery_review_pending", {
    delivery: {
      state: "review_pending",
      review: { state: "awaiting_operator", latestPass: 1, history: [] },
      targets: [],
    },
  }));
  assert.equal(result.transition, "WAIT_OPERATOR");
  assert.deepEqual(result.operatorInputRequired, [
    "accept", "accept-with-notes", "revise", "relaunch", "reject",
  ]);
});

test("operator cadence automatically advances corrections and accepted reviews", () => {
  assert.equal(deriveOperatorCadence(status("correction_pending")).transition, "AUTO_CONTINUE");
  assert.equal(deriveOperatorCadence(status("ship_gate_pending")).transition, "AUTO_CONTINUE");
  assert.equal(
    deriveOperatorCadence(status("ship_gate_pending"), { wakeReason: "heartbeat" }).transition,
    "WAIT_OPERATOR",
  );
});

test("operator cadence stops only at overall terminal delivery", () => {
  assert.equal(deriveOperatorCadence(status("shipping")).transition, "AUTO_CONTINUE");
  assert.equal(deriveOperatorCadence(status("reviewed")).transition, "TERMINAL");
  assert.equal(deriveOperatorCadence(status("released")).transition, "TERMINAL");
});

test("an explicit but unavailable conditional grant fails closed instead of falling back silently", () => {
  const result = deriveOperatorCadence(status("ship_gate_pending", {
    authorization: {
      schema: "agent-manager.authorization-summary.v1",
      state: "ready",
      valid: true,
      level: "through-pr",
      grantDigest: "a".repeat(64),
    },
  }));
  assert.equal(result.stage, "conditional_authority_blocked");
  assert.equal(result.transition, "WAIT_OPERATOR");
  assert.match(result.nextAction, /manual Ship Gate|new reviewed grant/i);
});
