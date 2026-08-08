import { listBrainIntents } from "./brain.mjs";
import {
  GoalModelError,
  inspectGoalGraph,
  listGoalArtifactLinks,
  listGoals,
} from "./goals.mjs";
import { BRAIN_ROOT } from "./paths.mjs";

export const GOAL_PROGRESS_SCHEMA = "agent-manager.goal-progress.v1";

const EFFECTIVE_STATE_PRECEDENCE = Object.freeze([
  "blocked",
  "active",
  "pending_delivery",
  "planned",
  "cancelled",
  "delivered",
]);

const RUN_STATE_CONTRIBUTIONS = Object.freeze({
  admitted: "active",
  running: "active",
  shipping: "active",
  needs_input: "blocked",
  blocked: "blocked",
  failed: "blocked",
  rejected: "blocked",
  pending_delivery: "pending_delivery",
  reviewed: "delivered",
  merged: "delivered",
  released: "delivered",
  cancelled: "cancelled",
  abandoned: "cancelled",
});

function compareStrings(left, right) {
  const a = String(left);
  const b = String(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function increment(counts, state) {
  counts[state] = (counts[state] || 0) + 1;
}

function normalizedGoalState(state) {
  if (state === "superseded") return "superseded";
  if (state === "blocked") return "blocked";
  if (state === "active") return "active";
  if (state === "delivered") return "delivered";
  if (state === "cancelled") return "cancelled";
  return "planned";
}

function normalizedArtifactState(state) {
  if (state === "superseded") return "superseded";
  if (["blocked", "active", "pending_delivery", "delivered", "cancelled"].includes(state)) {
    return state;
  }
  return "planned";
}

function normalizedRunState(state) {
  return RUN_STATE_CONTRIBUTIONS[state] || "planned";
}

function pickEffectiveState(states) {
  for (const state of EFFECTIVE_STATE_PRECEDENCE) {
    if (states.includes(state)) return state;
  }
  return "planned";
}

function runIdentity(run, index) {
  return String(run.runId || run.docId || run.id || `run-${index}`);
}

function evidenceIdentity(item) {
  return `${item.kind}\u0000${item.id}\u0000${item.goalId}`;
}

function sortEvidence(left, right) {
  return compareStrings(evidenceIdentity(left), evidenceIdentity(right));
}

function emptyStateCounts() {
  return {
    planned: 0,
    active: 0,
    blocked: 0,
    pending_delivery: 0,
    delivered: 0,
    superseded: 0,
    cancelled: 0,
  };
}

function graphError(issue, issues) {
  return new GoalModelError(
    issue.code,
    `goal graph integrity check failed: ${issue.code}`,
    { issue, issues },
  );
}

/**
 * Compute one goal subtree without reading or mutating the brain.
 *
 * Superseded goal branches and artifact links do not contribute to effective
 * state or the completed-leaf ratio. Every other signal is evaluated using the
 * exported precedence order. This keeps the result deterministic and leaves a
 * complete evidence trail for operator and UI surfaces.
 */
export function computeGoalProgress(goalId, {
  goals = [],
  artifactLinks = [],
  runIntents = [],
} = {}) {
  const validation = inspectGoalGraph({ goals, artifactLinks });
  if (!validation.valid) throw graphError(validation.issues[0], validation.issues);

  const byId = new Map(goals.map((goal) => [goal.id, goal]));
  const selected = byId.get(goalId);
  if (!selected) {
    throw new GoalModelError("GOAL_NOT_FOUND", `goal not found: ${goalId}`, { goalId });
  }

  const childrenByParent = new Map();
  for (const goal of goals) {
    if (!goal.parentId) continue;
    const children = childrenByParent.get(goal.parentId) || [];
    children.push(goal);
    childrenByParent.set(goal.parentId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => compareStrings(left.id, right.id));
  }

  const artifactsByGoal = new Map();
  for (const link of [...artifactLinks].sort((left, right) => compareStrings(left.id, right.id))) {
    const links = artifactsByGoal.get(link.goalId) || [];
    links.push(link);
    artifactsByGoal.set(link.goalId, links);
  }

  const runsByGoal = new Map();
  [...runIntents]
    .map((run, index) => ({ run, id: runIdentity(run, index) }))
    .sort((left, right) => compareStrings(left.id, right.id))
    .forEach(({ run, id }) => {
      for (const ref of [...new Set(run.goalRefs || [])].sort(compareStrings)) {
        if (!byId.has(ref)) continue;
        const attached = runsByGoal.get(ref) || [];
        attached.push({ ...run, progressId: id });
        runsByGoal.set(ref, attached);
      }
    });

  const nodeById = new Map();

  function computeNode(goal, excludedByAncestor = false) {
    const selfSuperseded = goal.lifecycle === "superseded";
    const excluded = excludedByAncestor || selfSuperseded;
    const childNodes = (childrenByParent.get(goal.id) || [])
      .map((child) => computeNode(child, excluded));
    const directArtifacts = artifactsByGoal.get(goal.id) || [];
    const directRuns = runsByGoal.get(goal.id) || [];
    const directEvidence = [
      {
        kind: "goal",
        id: goal.id,
        goalId: goal.id,
        state: goal.lifecycle,
        contribution: normalizedGoalState(goal.lifecycle),
        excluded,
      },
      ...directArtifacts.map((link) => ({
        kind: "artifact",
        id: link.id,
        goalId: goal.id,
        state: link.state,
        contribution: normalizedArtifactState(link.state),
        excluded: excluded || link.state === "superseded",
        artifactType: link.artifactType,
        artifactRef: link.artifactRef,
        relationship: link.relationship,
        label: link.label || null,
      })),
      ...directRuns.map((run) => ({
        kind: "run",
        id: run.progressId,
        goalId: goal.id,
        state: String(run.state || "unknown"),
        contribution: normalizedRunState(run.state),
        excluded,
        phase: run.phase || null,
        title: run.title || null,
      })),
    ];

    let effectiveState;
    let decisiveEvidence;
    if (excluded) {
      effectiveState = "superseded";
      decisiveEvidence = directEvidence.filter((item) => item.kind === "goal");
    } else {
      const candidates = [
        ...directEvidence.filter((item) => !item.excluded),
        ...childNodes
          .filter((child) => !child.excluded)
          .map((child) => ({
            kind: "descendant",
            id: child.goalId,
            goalId: child.goalId,
            state: child.effectiveState,
            contribution: child.effectiveState,
            excluded: false,
          })),
      ];
      effectiveState = pickEffectiveState(candidates.map((item) => item.contribution));
      decisiveEvidence = candidates.filter((item) => item.contribution === effectiveState);
    }

    const includedChildren = childNodes.filter((child) => !child.excluded);
    const node = {
      goalId: goal.id,
      title: goal.title,
      parentId: goal.parentId || null,
      storedLifecycle: goal.lifecycle,
      effectiveState,
      excluded,
      leaf: !excluded && includedChildren.length === 0,
      children: childNodes.map((child) => child.goalId),
      decisiveEvidence: decisiveEvidence.sort(sortEvidence),
      directEvidence: directEvidence.sort(sortEvidence),
    };
    nodeById.set(goal.id, node);
    return node;
  }

  const rootNode = computeNode(selected);
  const subtreeGoalIds = [];
  (function collect(node) {
    subtreeGoalIds.push(node.goalId);
    for (const childId of node.children) collect(nodeById.get(childId));
  }(rootNode));

  const subtreeNodes = subtreeGoalIds.map((id) => nodeById.get(id));
  const includedNodes = subtreeNodes.filter((node) => !node.excluded);
  const leaves = includedNodes.filter((node) => node.leaf);
  const completedLeaves = leaves.filter((node) => node.effectiveState === "delivered");
  const includedGoalIds = new Set(includedNodes.map((node) => node.goalId));

  const includedArtifacts = artifactLinks
    .filter((link) => includedGoalIds.has(link.goalId) && link.state !== "superseded")
    .sort((left, right) => compareStrings(left.id, right.id));
  const allSubtreeArtifacts = artifactLinks.filter((link) => subtreeGoalIds.includes(link.goalId));

  const allSubtreeRuns = new Map();
  for (const node of subtreeNodes) {
    for (const item of node.directEvidence.filter((evidence) => evidence.kind === "run")) {
      if (!allSubtreeRuns.has(item.id)) allSubtreeRuns.set(item.id, item);
    }
  }

  const uniqueRuns = new Map();
  for (const node of includedNodes) {
    for (const item of node.directEvidence.filter((evidence) => evidence.kind === "run")) {
      if (!uniqueRuns.has(item.id)) uniqueRuns.set(item.id, item);
    }
  }

  const goalStoredCounts = emptyStateCounts();
  const goalEffectiveCounts = emptyStateCounts();
  const artifactStateCounts = emptyStateCounts();
  const runStateCounts = emptyStateCounts();
  const runContributionCounts = emptyStateCounts();
  for (const node of includedNodes) {
    increment(goalStoredCounts, node.storedLifecycle);
    increment(goalEffectiveCounts, node.effectiveState);
  }
  for (const link of includedArtifacts) increment(artifactStateCounts, link.state);
  for (const evidence of uniqueRuns.values()) {
    increment(runStateCounts, evidence.state);
    increment(runContributionCounts, evidence.contribution);
  }

  const evidence = subtreeNodes
    .flatMap((node) => node.directEvidence)
    .sort(sortEvidence);
  const decisiveEvidence = rootNode.decisiveEvidence.sort(sortEvidence);
  const denominator = leaves.length;
  const numerator = completedLeaves.length;

  return {
    schema: GOAL_PROGRESS_SCHEMA,
    goalId: selected.id,
    title: selected.title,
    storedLifecycle: selected.lifecycle,
    effectiveState: rootNode.effectiveState,
    completedLeafRatio: {
      label: "completed-leaf ratio",
      numerator,
      denominator,
      value: denominator ? numerator / denominator : null,
    },
    counts: {
      goals: {
        total: subtreeNodes.length,
        included: includedNodes.length,
        leaves: denominator,
        completedLeaves: numerator,
        excludedSuperseded: subtreeNodes.length - includedNodes.length,
        byStoredLifecycle: goalStoredCounts,
        byEffectiveState: goalEffectiveCounts,
      },
      artifacts: {
        total: allSubtreeArtifacts.length,
        included: includedArtifacts.length,
        excludedSuperseded: allSubtreeArtifacts.length - includedArtifacts.length,
        byState: artifactStateCounts,
      },
      runs: {
        total: allSubtreeRuns.size,
        included: uniqueRuns.size,
        excludedSuperseded: allSubtreeRuns.size - uniqueRuns.size,
        byState: runStateCounts,
        byContribution: runContributionCounts,
      },
    },
    basis: {
      precedence: [...EFFECTIVE_STATE_PRECEDENCE],
      decisiveState: rootNode.effectiveState,
      decisiveEvidence,
    },
    evidence,
    goals: subtreeNodes.map((node) => ({
      goalId: node.goalId,
      title: node.title,
      parentId: node.parentId,
      storedLifecycle: node.storedLifecycle,
      effectiveState: node.effectiveState,
      excluded: node.excluded,
      leaf: node.leaf,
      children: node.children,
    })),
  };
}

export async function getGoalProgress(goalId, { root = BRAIN_ROOT } = {}) {
  const [goals, artifactLinks, runIntents] = await Promise.all([
    listGoals({ root }),
    listGoalArtifactLinks({ root }),
    listBrainIntents({ root }),
  ]);
  return computeGoalProgress(goalId, { goals, artifactLinks, runIntents });
}
