const TERMINAL_STATES = new Set(["merged", "released", "rejected", "failed", "cancelled"]);

export const OPERATOR_TRANSITIONS = Object.freeze({
  AUTO_CONTINUE: "AUTO_CONTINUE",
  WAIT_OPERATOR: "WAIT_OPERATOR",
  TERMINAL: "TERMINAL",
});

export function deriveOperatorCadence(status, { wakeReason = "state_change" } = {}) {
  if (!status) {
    return cadence("unknown", OPERATOR_TRANSITIONS.WAIT_OPERATOR,
      "Locate or supply the run status before continuing.", ["runId or status path"], "Run board");
  }

  if (TERMINAL_STATES.has(status.state)) {
    return cadence(
      `delivery_${status.state}`,
      OPERATOR_TRANSITIONS.TERMINAL,
      "Post the final evidence-backed outcome, complete source-system closeout, and stop watching.",
      [],
      "Final outcome",
    );
  }

  if (status.ship?.needsInput) {
    return cadence(
      "shipping_blocked",
      OPERATOR_TRANSITIONS.WAIT_OPERATOR,
      "Present the PR Manager Ship escalation and wait; do not bypass the blocker.",
      status.ship.needsInput.options || ["operator direction"],
      "PR Manager · Ship escalation",
    );
  }

  const blockedLane = (status.lanes || []).find((lane) => lane.state === "blocked" || lane.needsInput);
  if (blockedLane) {
    return cadence(
      "lane_blocked",
      OPERATOR_TRANSITIONS.WAIT_OPERATOR,
      `Present the ${blockedLane.id} lane question and wait while independent lanes continue.`,
      blockedLane.needsInput?.options || ["operator answer"],
      "Agent Manager · Escalation",
    );
  }

  if (status.state === "blocked") {
    return cadence(
      "delivery_blocked",
      OPERATOR_TRANSITIONS.WAIT_OPERATOR,
      "Present the integration or delivery blocker with actionable options and wait.",
      status.integrate?.needsInput?.options || ["operator direction"],
      "Agent Manager · Escalation",
    );
  }

  const review = status.delivery?.review;
  if (review?.state === "awaiting_operator") {
    const pass = review.latestPass || 1;
    return cadence(
      `delivery_review_pass_${pass}`,
      OPERATOR_TRANSITIONS.WAIT_OPERATOR,
      `Wait for the operator's Delivery Review Pass ${pass} verdict, then persist it before continuing.`,
      pass === 2
        ? ["accept", "accept-with-notes", "reject"]
        : ["accept", "accept-with-notes", "revise", "relaunch", "reject"],
      `Agent Manager · Delivery Review · Pass ${pass}`,
    );
  }

  switch (status.state) {
    case "delivery_review_pending":
      return cadence(
        "workers_complete",
        OPERATOR_TRANSITIONS.AUTO_CONTINUE,
        "Post Run Outcome, verify the delivered work, then present Delivery Review Pass 1 before ending the turn.",
        [],
        "Run outcome + Delivery Review · Pass 1",
      );
    case "correction_pending":
      return cadence(
        "correction_required",
        OPERATOR_TRANSITIONS.AUTO_CONTINUE,
        "Launch the one authorized correction with exact gaps, rearm monitoring, and post the Correction kickoff.",
        [],
        "Agent Manager · Correction kickoff",
      );
    case "ship_gate_pending":
      if (wakeReason === "heartbeat") {
        return cadence(
          "ship_gate_decision",
          OPERATOR_TRANSITIONS.WAIT_OPERATOR,
          "Wait for the exact Ship Gate approval already presented.",
          ["through-pr", "all", "reject"],
          "Ship Gate",
        );
      }
      return cadence(
        "ship_gate_ready",
        OPERATOR_TRANSITIONS.AUTO_CONTINUE,
        "Persist the accepted review if needed, present the matching Ship Gate, and then wait for exact shipping authority.",
        [],
        "Ship Gate",
      );
    case "release_pending":
      if (wakeReason === "heartbeat") {
        return cadence(
          "release_decision",
          OPERATOR_TRANSITIONS.WAIT_OPERATOR,
          "Wait for the release Ship Gate decision already presented.",
          ["all", "reject"],
          "Ship Gate · Release",
        );
      }
      return cadence(
        "release_gate_ready",
        OPERATOR_TRANSITIONS.AUTO_CONTINUE,
        "Present the final release Ship Gate with all merge evidence, then wait for approval.",
        [],
        "Ship Gate · Release",
      );
    case "shipping":
      return cadence(
        "shipping_active",
        OPERATOR_TRANSITIONS.AUTO_CONTINUE,
        "Keep PR Manager detached, monitor telemetry, and report only heartbeat, meaningful progress, blocker, or outcome.",
        [],
        "PR Manager · Ship board",
      );
    case "running":
    case "workers_done":
    default:
      return cadence(
        "run_active",
        OPERATOR_TRANSITIONS.AUTO_CONTINUE,
        "Keep the run detached, monitor telemetry, and advance automatically on the next state change.",
        [],
        "Agent Manager · Run board",
      );
  }
}

function cadence(stage, transition, nextAction, operatorInputRequired, template) {
  return {
    schema: "agent-manager.operator-cadence.v1",
    stage,
    transition,
    nextAction,
    operatorInputRequired,
    template,
  };
}
