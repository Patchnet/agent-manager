import {
  ARTIFACT_RELATIONSHIPS,
  ARTIFACT_STATES,
  ARTIFACT_TYPES,
  GOAL_LIFECYCLES,
  unwrapBrainResult,
  useBrain,
} from "./brain.mjs";
import { BRAIN_ROOT } from "./paths.mjs";

export {
  ARTIFACT_RELATIONSHIPS,
  ARTIFACT_STATES,
  ARTIFACT_TYPES,
  GOAL_LIFECYCLES,
};

const GOAL_PAGE_SIZE = 500;
const GOAL_ID_PATTERN = /^goal-[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const LINK_ID_PATTERN = /^glink-[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export class GoalModelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GoalModelError";
    this.code = code;
    this.details = details;
  }
}

function timestamp(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function stringList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new GoalModelError("INVALID_GOAL_INPUT", `${field} must be an array of strings`, { field });
  }
  return value.map((item) => {
    const normalized = String(item).trim();
    if (!normalized) {
      throw new GoalModelError("INVALID_GOAL_INPUT", `${field} cannot contain an empty value`, { field });
    }
    return normalized;
  });
}

function uniqueSorted(value, field) {
  return [...new Set(stringList(value, field))].sort();
}

function dependencyList(value) {
  const dependencies = stringList(value, "dependencies");
  if (new Set(dependencies).size !== dependencies.length) {
    throw new GoalModelError(
      "DUPLICATE_DEPENDENCY",
      "dependencies cannot contain duplicate goal IDs",
      { field: "dependencies" },
    );
  }
  return dependencies.sort();
}

function requiredString(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new GoalModelError("INVALID_GOAL_INPUT", `${field} is required`, { field });
  }
  return normalized;
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new GoalModelError(
      "INVALID_GOAL_INPUT",
      `${field} must be one of: ${allowed.join(", ")}`,
      { field, value },
    );
  }
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value || {}).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new GoalModelError(
      "INVALID_GOAL_INPUT",
      `${label} contains unsupported fields: ${unknown.join(", ")}`,
      { fields: unknown },
    );
  }
}

function assertId(value, pattern, field, prefix) {
  if (!pattern.test(value) || value.length > 128 || value.includes("..")) {
    throw new GoalModelError(
      "INVALID_GOAL_ID",
      `${field} must start with "${prefix}-" and contain only safe ID characters`,
      { field, value },
    );
  }
}

// Truncation can land mid-word, so the trailing-dash strip has to come after
// the slice: `.slice(0, 64)` first minted ids ending in "-", which the document
// id pattern rejects.
function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "") || "untitled";
}

function availableId(prefix, label, existingIds) {
  const base = `${prefix}-${slug(label)}`;
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function toGoal(document) {
  const value = document.frontmatter || {};
  return {
    id: String(document.docId),
    title: String(value.title || document.docId),
    lifecycle: String(value.lifecycle || "planned"),
    parentId: value.parent_goal ? String(value.parent_goal) : null,
    dependencies: Array.isArray(value.dependencies) ? value.dependencies.map(String) : [],
    outcome: value.outcome ? String(value.outcome) : null,
    successCriteria: Array.isArray(value.success_criteria) ? value.success_criteria.map(String) : [],
    externalSourceRefs: Array.isArray(value.external_source_refs)
      ? value.external_source_refs.map(String)
      : [],
    createdAt: timestamp(value.created_at),
    updatedAt: timestamp(value.updated_at),
    version: document.version ?? null,
  };
}

function toArtifactLink(document) {
  const value = document.frontmatter || {};
  return {
    id: String(document.docId),
    goalId: String(value.goal_id || ""),
    artifactType: String(value.artifact_type || ""),
    artifactRef: String(value.artifact_ref || ""),
    relationship: String(value.relationship || ""),
    state: String(value.state || "unknown"),
    label: value.label ? String(value.label) : null,
    createdAt: timestamp(value.created_at),
    updatedAt: timestamp(value.updated_at),
    version: document.version ?? null,
  };
}

async function listDocuments(engine, docType, convert) {
  const records = [];
  let offset = 0;
  let total = 0;
  do {
    const found = unwrapBrainResult(
      engine.findDocuments({
        docType,
        limit: GOAL_PAGE_SIZE,
        offset,
        sortBy: "doc_id",
        sortOrder: "asc",
      }),
      `list ${docType} documents`,
    );
    total = found.total;
    for (const match of found.results) {
      records.push(convert(unwrapBrainResult(
        await engine.getDocument(match.docId, "hot"),
        `read ${docType} ${match.docId}`,
      )));
    }
    offset += found.results.length;
    if (!found.results.length) break;
  } while (offset < total);
  if (records.length !== total) {
    throw new GoalModelError(
      "GOAL_READ_INCOMPLETE",
      `expected ${total} ${docType} documents but read ${records.length}`,
      { docType, expected: total, actual: records.length },
    );
  }
  return records.sort((left, right) => left.id.localeCompare(right.id));
}

async function readGraph(engine) {
  const [goals, artifactLinks] = await Promise.all([
    listDocuments(engine, "goal", toGoal),
    listDocuments(engine, "artifact_link", toArtifactLink),
  ]);
  return { goals, artifactLinks };
}

function cycleIssues(goals, field, code) {
  const byId = new Map(goals.map((goal) => [goal.id, goal]));
  const state = new Map();
  const stack = [];
  const issues = [];
  const seenCycles = new Set();

  function visit(id) {
    const currentState = state.get(id) || 0;
    if (currentState === 2) return;
    if (currentState === 1) {
      const start = stack.indexOf(id);
      const path = [...stack.slice(start), id];
      const members = [...new Set(path.slice(0, -1))].sort();
      const key = members.join("|");
      if (!seenCycles.has(key)) {
        seenCycles.add(key);
        issues.push({ code, goalId: id, path });
      }
      return;
    }
    state.set(id, 1);
    stack.push(id);
    const goal = byId.get(id);
    const references = field === "parentId"
      ? (goal?.parentId ? [goal.parentId] : [])
      : (goal?.dependencies || []);
    for (const reference of references) {
      if (byId.has(reference)) visit(reference);
    }
    stack.pop();
    state.set(id, 2);
  }

  for (const goal of goals) visit(goal.id);
  return issues;
}

export function inspectGoalGraph({ goals = [], artifactLinks = [] } = {}) {
  const issues = [];
  const byId = new Map(goals.map((goal) => [goal.id, goal]));
  for (const goal of goals) {
    if (goal.parentId === goal.id) {
      issues.push({ code: "SELF_PARENT", goalId: goal.id });
    } else if (goal.parentId && !byId.has(goal.parentId)) {
      issues.push({ code: "MISSING_PARENT", goalId: goal.id, reference: goal.parentId });
    }
    const seenDependencies = new Set();
    for (const dependency of goal.dependencies || []) {
      if (dependency === goal.id) {
        issues.push({ code: "SELF_DEPENDENCY", goalId: goal.id });
      } else if (!byId.has(dependency)) {
        issues.push({ code: "MISSING_DEPENDENCY", goalId: goal.id, reference: dependency });
      }
      if (seenDependencies.has(dependency)) {
        issues.push({ code: "DUPLICATE_DEPENDENCY", goalId: goal.id, reference: dependency });
      }
      seenDependencies.add(dependency);
    }
  }
  issues.push(...cycleIssues(goals, "parentId", "HIERARCHY_CYCLE"));
  issues.push(...cycleIssues(goals, "dependencies", "DEPENDENCY_CYCLE"));
  const artifactRelationships = new Map();
  for (const link of artifactLinks) {
    if (!byId.has(link.goalId)) {
      issues.push({ code: "MISSING_LINKED_GOAL", linkId: link.id, reference: link.goalId });
    }
    const key = [link.goalId, link.artifactType, link.artifactRef, link.relationship].join("\u0000");
    if (artifactRelationships.has(key)) {
      issues.push({
        code: "DUPLICATE_ARTIFACT_LINK",
        linkId: link.id,
        reference: artifactRelationships.get(key),
      });
    } else {
      artifactRelationships.set(key, link.id);
    }
  }
  return { valid: issues.length === 0, issues };
}

function assertValidGraph(graph) {
  const validation = inspectGoalGraph(graph);
  if (validation.valid) return;
  const issue = validation.issues[0];
  throw new GoalModelError(
    issue.code,
    `goal graph integrity check failed: ${issue.code}`,
    { issue, issues: validation.issues },
  );
}

function normalizeGoalId(value, field = "goalId") {
  const id = requiredString(value, field);
  assertId(id, GOAL_ID_PATTERN, field, "goal");
  return id;
}

function normalizeLinkId(value, field = "linkId") {
  const id = requiredString(value, field);
  assertId(id, LINK_ID_PATTERN, field, "glink");
  return id;
}

export async function createGoal(input, { root = BRAIN_ROOT, now = new Date() } = {}) {
  assertKnownKeys(input, [
    "id", "goalId", "title", "lifecycle", "parentId", "dependencies", "outcome",
    "successCriteria", "externalSourceRefs",
  ], "goal");
  const title = requiredString(input?.title, "title");
  const lifecycle = String(input?.lifecycle || "planned");
  assertEnum(lifecycle, GOAL_LIFECYCLES, "lifecycle");
  const createdAt = now.toISOString();

  return useBrain(async (engine) => {
    const graph = await readGraph(engine);
    assertValidGraph(graph);
    const requestedId = input?.id ?? input?.goalId;
    const id = requestedId
      ? normalizeGoalId(requestedId)
      : availableId("goal", title, new Set(graph.goals.map((goal) => goal.id)));
    const parentId = optionalString(input?.parentId);
    if (parentId) normalizeGoalId(parentId, "parentId");
    const dependencies = dependencyList(input?.dependencies);
    dependencies.forEach((dependency) => normalizeGoalId(dependency, "dependencies"));
    const prospective = {
      id,
      title,
      lifecycle,
      parentId,
      dependencies,
      outcome: optionalString(input?.outcome),
      successCriteria: stringList(input?.successCriteria, "successCriteria"),
      externalSourceRefs: uniqueSorted(input?.externalSourceRefs, "externalSourceRefs"),
      createdAt,
      updatedAt: createdAt,
      version: 1,
    };
    assertValidGraph({ ...graph, goals: [...graph.goals, prospective] });
    const fields = {
      title,
      lifecycle,
      dependencies,
      success_criteria: prospective.successCriteria,
      created_at: createdAt,
      updated_at: createdAt,
      ...(parentId ? { parent_goal: parentId } : {}),
      ...(prospective.outcome ? { outcome: prospective.outcome } : {}),
      ...(prospective.externalSourceRefs.length
        ? { external_source_refs: prospective.externalSourceRefs }
        : {}),
    };
    const created = unwrapBrainResult(
      await engine.createDocument("goal", fields, undefined, id),
      `create goal ${id}`,
    );
    return toGoal(unwrapBrainResult(await engine.getDocument(created.docId, "hot"), `read goal ${id}`));
  }, { root, lock: "goal-graph" });
}

export async function updateGoal(goalId, patch, { root = BRAIN_ROOT, now = new Date() } = {}) {
  const id = normalizeGoalId(goalId);
  assertKnownKeys(patch, [
    "title", "lifecycle", "parentId", "dependencies", "outcome", "successCriteria",
    "externalSourceRefs",
  ], "goal patch");
  if (!Object.keys(patch || {}).length) {
    throw new GoalModelError("INVALID_GOAL_INPUT", "goal patch must contain at least one field");
  }

  return useBrain(async (engine) => {
    const graph = await readGraph(engine);
    assertValidGraph(graph);
    const current = graph.goals.find((goal) => goal.id === id);
    if (!current) throw new GoalModelError("GOAL_NOT_FOUND", `goal not found: ${id}`, { goalId: id });
    const next = { ...current, updatedAt: now.toISOString() };
    const fields = { updated_at: next.updatedAt };
    if (Object.hasOwn(patch, "title")) {
      next.title = requiredString(patch.title, "title");
      fields.title = next.title;
    }
    if (Object.hasOwn(patch, "lifecycle")) {
      next.lifecycle = String(patch.lifecycle);
      assertEnum(next.lifecycle, GOAL_LIFECYCLES, "lifecycle");
      fields.lifecycle = next.lifecycle;
    }
    if (Object.hasOwn(patch, "parentId")) {
      next.parentId = optionalString(patch.parentId);
      if (next.parentId) normalizeGoalId(next.parentId, "parentId");
      fields.parent_goal = next.parentId || undefined;
    }
    if (Object.hasOwn(patch, "dependencies")) {
      next.dependencies = dependencyList(patch.dependencies);
      next.dependencies.forEach((dependency) => normalizeGoalId(dependency, "dependencies"));
      fields.dependencies = next.dependencies;
    }
    if (Object.hasOwn(patch, "outcome")) {
      next.outcome = optionalString(patch.outcome);
      fields.outcome = next.outcome || undefined;
    }
    if (Object.hasOwn(patch, "successCriteria")) {
      next.successCriteria = stringList(patch.successCriteria, "successCriteria");
      fields.success_criteria = next.successCriteria;
    }
    if (Object.hasOwn(patch, "externalSourceRefs")) {
      next.externalSourceRefs = uniqueSorted(patch.externalSourceRefs, "externalSourceRefs");
      fields.external_source_refs = next.externalSourceRefs.length ? next.externalSourceRefs : undefined;
    }
    const prospectiveGoals = graph.goals.map((goal) => goal.id === id ? next : goal);
    assertValidGraph({ ...graph, goals: prospectiveGoals });
    unwrapBrainResult(await engine.updateDocument(id, fields), `update goal ${id}`);
    return toGoal(unwrapBrainResult(await engine.getDocument(id, "hot"), `read goal ${id}`));
  }, { root, lock: "goal-graph" });
}

export async function getGoal(goalId, { root = BRAIN_ROOT } = {}) {
  const id = normalizeGoalId(goalId);
  return useBrain(async (engine) => {
    const found = await engine.getDocument(id, "hot");
    if (!found?.ok && found?.errors?.some((error) => error.code === "FILE_NOT_FOUND")) {
      throw new GoalModelError("GOAL_NOT_FOUND", `goal not found: ${id}`, { goalId: id });
    }
    return toGoal(unwrapBrainResult(found, `read goal ${id}`));
  }, { root });
}

export async function listGoals({ root = BRAIN_ROOT, parentId = undefined } = {}) {
  if (parentId !== undefined && parentId !== null) normalizeGoalId(parentId, "parentId");
  return useBrain(async (engine) => {
    const goals = await listDocuments(engine, "goal", toGoal);
    return parentId === undefined
      ? goals
      : goals.filter((goal) => goal.parentId === (parentId || null));
  }, { root });
}

export async function assertGoalsExist(goalIds, { root = BRAIN_ROOT } = {}) {
  const ids = uniqueSorted(goalIds, "goalIds");
  ids.forEach((id) => normalizeGoalId(id));
  return useBrain(async (engine) => {
    const goals = await listDocuments(engine, "goal", toGoal);
    const found = new Map(goals.map((goal) => [goal.id, goal]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw new GoalModelError(
        "GOAL_NOT_FOUND",
        `local goals not found: ${missing.join(", ")}`,
        { goalIds: missing },
      );
    }
    return ids.map((id) => found.get(id));
  }, { root });
}

export async function linkGoalArtifact(input, { root = BRAIN_ROOT, now = new Date() } = {}) {
  assertKnownKeys(input, [
    "id", "linkId", "goalId", "artifactType", "artifactRef", "relationship", "state", "label",
  ], "artifact link");
  const goalId = normalizeGoalId(input?.goalId);
  const artifactType = String(input?.artifactType || "");
  const artifactRef = requiredString(input?.artifactRef, "artifactRef");
  const relationship = String(input?.relationship || "relates");
  const state = String(input?.state || "unknown");
  assertEnum(artifactType, ARTIFACT_TYPES, "artifactType");
  assertEnum(relationship, ARTIFACT_RELATIONSHIPS, "relationship");
  assertEnum(state, ARTIFACT_STATES, "state");
  const createdAt = now.toISOString();

  return useBrain(async (engine) => {
    const graph = await readGraph(engine);
    assertValidGraph(graph);
    if (!graph.goals.some((goal) => goal.id === goalId)) {
      throw new GoalModelError("GOAL_NOT_FOUND", `goal not found: ${goalId}`, { goalId });
    }
    const duplicate = graph.artifactLinks.find((link) => (
      link.goalId === goalId && link.artifactType === artifactType &&
      link.artifactRef === artifactRef && link.relationship === relationship
    ));
    if (duplicate) {
      throw new GoalModelError(
        "DUPLICATE_ARTIFACT_LINK",
        `artifact is already linked by ${duplicate.id}`,
        { linkId: duplicate.id },
      );
    }
    const requestedId = input?.id ?? input?.linkId;
    const id = requestedId
      ? normalizeLinkId(requestedId)
      : availableId(
        "glink",
        `${goalId} ${artifactType} ${artifactRef}`,
        new Set(graph.artifactLinks.map((link) => link.id)),
      );
    const label = optionalString(input?.label);
    const fields = {
      title: label || `${artifactType}: ${artifactRef}`,
      goal_id: goalId,
      artifact_type: artifactType,
      artifact_ref: artifactRef,
      relationship,
      state,
      created_at: createdAt,
      updated_at: createdAt,
      ...(label ? { label } : {}),
    };
    const created = unwrapBrainResult(
      await engine.createDocument("artifact_link", fields, undefined, id),
      `link artifact ${id}`,
    );
    return toArtifactLink(unwrapBrainResult(
      await engine.getDocument(created.docId, "hot"),
      `read artifact link ${id}`,
    ));
  }, { root, lock: "goal-graph" });
}

export async function updateArtifactLink(linkId, patch, { root = BRAIN_ROOT, now = new Date() } = {}) {
  const id = normalizeLinkId(linkId);
  assertKnownKeys(patch, ["goalId", "artifactType", "artifactRef", "relationship", "state", "label"], "artifact link patch");
  if (!Object.keys(patch || {}).length) {
    throw new GoalModelError("INVALID_GOAL_INPUT", "artifact link patch must contain at least one field");
  }
  return useBrain(async (engine) => {
    const graph = await readGraph(engine);
    assertValidGraph(graph);
    const current = graph.artifactLinks.find((link) => link.id === id);
    if (!current) {
      throw new GoalModelError("ARTIFACT_LINK_NOT_FOUND", `artifact link not found: ${id}`, { linkId: id });
    }
    const next = { ...current, ...patch, updatedAt: now.toISOString() };
    next.goalId = normalizeGoalId(next.goalId);
    next.artifactType = String(next.artifactType);
    next.artifactRef = requiredString(next.artifactRef, "artifactRef");
    next.relationship = String(next.relationship);
    next.state = String(next.state);
    next.label = optionalString(next.label);
    assertEnum(next.artifactType, ARTIFACT_TYPES, "artifactType");
    assertEnum(next.relationship, ARTIFACT_RELATIONSHIPS, "relationship");
    assertEnum(next.state, ARTIFACT_STATES, "state");
    assertValidGraph({
      goals: graph.goals,
      artifactLinks: graph.artifactLinks.map((link) => link.id === id ? next : link),
    });
    const fields = {
      goal_id: next.goalId,
      artifact_type: next.artifactType,
      artifact_ref: next.artifactRef,
      relationship: next.relationship,
      state: next.state,
      label: next.label || undefined,
      title: next.label || `${next.artifactType}: ${next.artifactRef}`,
      updated_at: next.updatedAt,
    };
    unwrapBrainResult(await engine.updateDocument(id, fields), `update artifact link ${id}`);
    return toArtifactLink(unwrapBrainResult(
      await engine.getDocument(id, "hot"),
      `read artifact link ${id}`,
    ));
  }, { root, lock: "goal-graph" });
}

export async function listGoalArtifactLinks({ root = BRAIN_ROOT, goalId = null } = {}) {
  if (goalId !== null) normalizeGoalId(goalId);
  return useBrain(async (engine) => {
    const links = await listDocuments(engine, "artifact_link", toArtifactLink);
    return goalId ? links.filter((link) => link.goalId === goalId) : links;
  }, { root });
}

export async function validateGoalGraph({ root = BRAIN_ROOT } = {}) {
  return useBrain(async (engine) => inspectGoalGraph(await readGraph(engine)), { root });
}
