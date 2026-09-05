import { createHash } from "node:crypto";

const RELATIONSHIPS = new Set(["advances", "dependency", "optional", "changes-goal", "unrelated"]);
const DECISIONS = new Set(["proposed", "continue", "defer", "amend", "separate", "replace"]);
const text = (value, name) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
};

export function goalContract(goal) {
  return { id: goal.id, title: goal.title, outcome: goal.outcome || null,
    successCriteria: goal.successCriteria || [] };
}

export function goalContractDigest(goal) {
  return createHash("sha256").update(JSON.stringify(goalContract(goal))).digest("hex");
}

// Relationship is a reasoned assessment supplied by the manager, never guessed
// from keywords. Recording it is an audit operation, not an authorization grant.
export function assessGoalRequest(goal, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("assessment must be an object");
  for (const key of Object.keys(input)) {
    if (!["request", "relationship", "criteria", "reason", "impact", "decision", "by", "authorityRef", "goalDigest"].includes(key)) {
      throw new Error(`unknown assessment field: ${key}`);
    }
  }
  const relationship = input.relationship;
  if (!RELATIONSHIPS.has(relationship)) throw new Error("invalid goal relationship");
  const criteria = input.criteria ?? [];
  if (!Array.isArray(criteria) || new Set(criteria).size !== criteria.length
    || criteria.some((criterion) => !goal.successCriteria.includes(criterion))) {
    throw new Error("assessment criteria must uniquely reference existing success criteria");
  }
  const aligned = ["advances", "dependency"].includes(relationship);
  if (aligned && !criteria.length) throw new Error("aligned work must identify the criterion it supports");
  const digest = goalContractDigest(goal);
  if (input.goalDigest && input.goalDigest !== digest) throw new Error("goal changed; reassess the request against the current goal");
  const decision = input.decision ?? "proposed";
  if (!DECISIONS.has(decision)) throw new Error("invalid goal request decision");
  if (decision === "continue" && !aligned) throw new Error("scope expansion requires amend, separate, replace, or defer; it cannot silently continue");
  if (decision !== "proposed") text(input.authorityRef, "authorityRef for the existing instruction or explicit decision");
  return {
    schema: "agent-manager.goal-assessment.v1", goalId: goal.id, goalDigest: digest,
    request: text(input.request, "request"), relationship, criteria,
    reason: text(input.reason, "reason"), impact: text(input.impact, "impact"),
    by: text(input.by, "by"), decision, authorityRef: input.authorityRef || null,
    recommendation: aligned ? "continue" : relationship === "unrelated" ? "separate" : "defer",
    transition: decision === "continue" ? "AUTO_CONTINUE"
      : decision === "proposed" ? "WAIT_OPERATOR" : "RECORDED",
    nextAction: decision === "continue" ? "Continue within existing authority and scope."
      : decision === "proposed" ? "Resolve the scope tradeoff; continue unrelated authorized work."
        : "Decision recorded; apply any authorized goal change separately before launching affected work.",
  };
}

export function goalEvidenceTemplate(status) {
  return (status.goalRefs || []).map((goalId) => {
    const goal = status.goals?.goals?.find((item) => item.id === goalId);
    return { goalId, goalDigest: goal ? goalContractDigest(goal) : null,
      criteria: (goal?.successCriteria || []).map((criterion) => ({ criterion, state: "not-addressed", evidence: "" })) };
  });
}

export function evaluateGoalEvidence(status, input) {
  const refs = status.goalRefs || [];
  if (!refs.length) return [];
  if (!Array.isArray(input) || input.length !== refs.length) throw new Error("goal evidence must cover every referenced goal exactly once");
  const seen = new Set();
  return input.map((entry) => {
    if (!entry || !refs.includes(entry.goalId) || seen.has(entry.goalId)) throw new Error("unknown or duplicate goal evidence");
    seen.add(entry.goalId);
    const goal = status.goals?.goals?.find((item) => item.id === entry.goalId);
    if (!goal) throw new Error(`frozen goal contract missing: ${entry.goalId}`);
    if (entry.goalDigest !== goalContractDigest(goal)) throw new Error(`goal evidence does not match frozen contract: ${entry.goalId}`);
    const criteria = goal.successCriteria || [];
    if (!criteria.length) throw new Error(`goal has no success criteria: ${entry.goalId}`);
    if (!Array.isArray(entry.criteria) || entry.criteria.length !== criteria.length) throw new Error(`evidence must assess every criterion: ${entry.goalId}`);
    const assessed = new Set();
    for (const row of entry.criteria) {
      if (!row || !criteria.includes(row.criterion) || assessed.has(row.criterion)) throw new Error("unknown or duplicate criterion evidence");
      assessed.add(row.criterion);
      if (!["met", "unmet", "not-addressed"].includes(row.state)) throw new Error("criterion state must be met, unmet, or not-addressed");
      text(row.evidence, "criterion evidence or explanation");
    }
    return { goalId: entry.goalId, goalDigest: entry.goalDigest, criteria: entry.criteria,
      outcome: entry.criteria.every((row) => row.state === "met") ? "fulfilled" : "partial" };
  });
}
