import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import YAML from "yaml";
import { BRAIN_ROOT } from "./paths.mjs";
import { normalizeScopePath, scopesMayOverlap } from "./scope.mjs";

export const BRAIN_SCHEMA_VERSION = 2;
const EDIT_LEASE_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_WAIT_MS = 10_000;

export const GOAL_LIFECYCLES = Object.freeze([
  "planned",
  "active",
  "blocked",
  "delivered",
  "superseded",
  "cancelled",
]);

export const ARTIFACT_TYPES = Object.freeze([
  "fup",
  "decision",
  "plan",
  "bug",
  "pr",
  "release",
  "other",
]);

export const ARTIFACT_RELATIONSHIPS = Object.freeze([
  "supports",
  "blocks",
  "delivers",
  "tracks",
  "relates",
]);

export const ARTIFACT_STATES = Object.freeze([
  "unknown",
  "planned",
  "active",
  "blocked",
  "pending_delivery",
  "delivered",
  "superseded",
  "cancelled",
]);

const REGISTRY_V1 = {
  types: {
    run_intent: {
      path: "run-intents/",
      id_prefix: "ari",
      schema: "run_intent.v1",
    },
  },
};

const REGISTRY = {
  types: {
    ...REGISTRY_V1.types,
    goal: {
      path: "goals/",
      id_prefix: "goal",
      schema: "goal.v1",
    },
    artifact_link: {
      path: "artifact-links/",
      id_prefix: "glink",
      schema: "artifact_link.v1",
    },
  },
};

const RUN_INTENT_SCHEMA = {
  type: "run_intent",
  version: 1,
  required: [
    "doc_id",
    "title",
    "run_id",
    "repo_key",
    "repo_label",
    "state",
    "phase",
    "scopes",
    "started_at",
    "heartbeat_at",
    "lease_expires_at",
  ],
  fields: {
    title: { type: "string", index: true },
    run_id: { type: "string", index: true },
    repo_key: { type: "string", index: true },
    repo_label: { type: "string", index: true },
    repo_identity_source: { type: "enum", values: ["remote", "path"], index: true },
    state: {
      type: "enum",
      values: [
        "admitted",
        "running",
        "needs_input",
        "pending_delivery",
        "shipping",
        "reviewed",
        "merged",
        "released",
        "rejected",
        "failed",
        "cancelled",
        "abandoned",
      ],
      index: true,
    },
    phase: { type: "enum", values: ["editing", "delivery", "terminal"], index: true },
    scopes: { type: "list", item_type: "string", index: true },
    plan_ref: { type: "string", index: true },
    goal_refs: { type: "list", item_type: "string", index: true },
    related_runs: { type: "list", item_type: "string" },
    delivery_dependencies: { type: "list", item_type: "string" },
    manager_harness: { type: "string", index: true },
    manager_session: { type: "string", index: true },
    base_commit: { type: "string", index: true },
    started_at: { type: "date", format: "YYYY-MM-DD", store_precision: "second", index: true },
    heartbeat_at: { type: "date", format: "YYYY-MM-DD", store_precision: "second", index: true },
    lease_expires_at: { type: "date", format: "YYYY-MM-DD", store_precision: "second", index: true },
    ended_at: { type: "date", format: "YYYY-MM-DD", store_precision: "second", index: true },
  },
};

const GOAL_SCHEMA = {
  type: "goal",
  version: 1,
  required: [
    "doc_id",
    "title",
    "lifecycle",
    "dependencies",
    "success_criteria",
    "created_at",
    "updated_at",
  ],
  fields: {
    title: { type: "string", index: true, max_length: 240, multiline: false },
    lifecycle: { type: "enum", values: GOAL_LIFECYCLES, index: true },
    parent_goal: { type: "ref", target: "goal", index: true },
    dependencies: { type: "list", item_type: "ref", target: "goal", index: true },
    outcome: { type: "string", multiline: true },
    success_criteria: { type: "list", item_type: "string" },
    external_source_refs: { type: "list", item_type: "string", index: true },
    created_at: { type: "date", format: "YYYY-MM-DD", store_precision: "second", index: true },
    updated_at: { type: "date", format: "YYYY-MM-DD", store_precision: "second", index: true },
  },
};

const ARTIFACT_LINK_SCHEMA = {
  type: "artifact_link",
  version: 1,
  required: [
    "doc_id",
    "title",
    "goal_id",
    "artifact_type",
    "artifact_ref",
    "relationship",
    "state",
    "created_at",
    "updated_at",
  ],
  fields: {
    title: { type: "string", index: true, max_length: 300, multiline: false },
    goal_id: { type: "ref", target: "goal", index: true },
    artifact_type: { type: "enum", values: ARTIFACT_TYPES, index: true },
    artifact_ref: { type: "string", index: true, max_length: 500, multiline: false },
    relationship: { type: "enum", values: ARTIFACT_RELATIONSHIPS, index: true },
    state: { type: "enum", values: ARTIFACT_STATES, index: true },
    label: { type: "string", index: true, max_length: 240, multiline: false },
    created_at: { type: "date", format: "YYYY-MM-DD", store_precision: "second", index: true },
    updated_at: { type: "date", format: "YYYY-MM-DD", store_precision: "second", index: true },
  },
};

export class BrainConflictError extends Error {
  constructor(repoLabel, conflicts) {
    const detail = conflicts
      .map((item) => `${item.runId} (${item.scopes.join(", ")})`)
      .join("; ");
    super(`Agent Manager admission blocked for ${repoLabel}; overlapping active run intent: ${detail}`);
    this.name = "BrainConflictError";
    this.code = "RUN_INTENT_CONFLICT";
    this.conflicts = conflicts;
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function atomicWrite(path, value) {
  try {
    writeFileSync(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function replaceWrite(path, value) {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    if (!existsSync(path) || !["EEXIST", "EPERM"].includes(error?.code)) throw error;
    rmSync(path, { force: true });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function normalizedJson(value) {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizedJson(item)]),
    );
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(normalizedJson(left)) === JSON.stringify(normalizedJson(right));
}

function assertCompatibleRegistration(registry, type, expected) {
  const actual = registry?.types?.[type];
  if (!actual) throw new Error(`Agent Manager brain registry is missing ${type}`);
  for (const field of ["path", "id_prefix", "schema"]) {
    if (actual[field] !== expected[field]) {
      throw new Error(`Agent Manager brain registry has an incompatible ${type} registration`);
    }
  }
}

function assertCompatibleSchema(schema, expected, label) {
  if (schema?.type !== expected.type || schema?.version !== expected.version) {
    throw new Error(`Agent Manager brain has an incompatible ${label} schema version`);
  }
  if (!sameValue(schema.required, expected.required)) {
    throw new Error(`Agent Manager brain ${label} required fields are incompatible`);
  }
  for (const [field, definition] of Object.entries(expected.fields)) {
    if (!sameValue(schema.fields?.[field], definition)) {
      throw new Error(`Agent Manager brain ${label} field is incompatible: ${field}`);
    }
  }
}

async function withBrainLock(name, operation, { root = BRAIN_ROOT } = {}) {
  const lockRoot = join(root, ".locks");
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(lockRoot, `${name}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stale = (() => {
        try {
          return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
        } catch {
          return false;
        }
      })();
      if (stale) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for Agent Manager brain lock: ${name}`);
      await sleep(50);
    }
  }
  try {
    return await operation();
  } finally {
    try { closeSync(fd); } catch { /* best effort */ }
    rmSync(lockPath, { force: true });
  }
}

export async function ensureBrain({ root = BRAIN_ROOT } = {}) {
  return withBrainLock("schema", async () => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "_registry"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "_schema"), { recursive: true, mode: 0o700 });
    const markerPath = join(root, ".agent-manager-brain.json");
    let previousVersion = null;
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      previousVersion = marker.schemaVersion;
      if (![1, BRAIN_SCHEMA_VERSION].includes(previousVersion)) {
        throw new Error(
          `unsupported Agent Manager brain schema ${marker.schemaVersion}; expected 1 or ${BRAIN_SCHEMA_VERSION}`,
        );
      }
      const expectedMarkerSchema = previousVersion === 1
        ? "agent-manager.brain.v1"
        : "agent-manager.brain.v2";
      if (marker.schema !== expectedMarkerSchema || marker.historyMode !== "feed") {
        throw new Error("Agent Manager brain marker is incompatible with Git-free feed mode");
      }
    }
    const registryPath = join(root, "_registry", "object_types.yaml");
    const schemaDefinitions = new Map([
      ["run_intent.v1", RUN_INTENT_SCHEMA],
      ["goal.v1", GOAL_SCHEMA],
      ["artifact_link.v1", ARTIFACT_LINK_SCHEMA],
    ]);
    let registry;
    if (existsSync(registryPath)) {
      registry = YAML.parse(readFileSync(registryPath, "utf8"));
      assertCompatibleRegistration(registry, "run_intent", REGISTRY_V1.types.run_intent);
      for (const type of ["goal", "artifact_link"]) {
        if (registry?.types?.[type]) assertCompatibleRegistration(registry, type, REGISTRY.types[type]);
      }
    }
    for (const [name, definition] of schemaDefinitions) {
      const schemaPath = join(root, "_schema", `${name}.yaml`);
      if (existsSync(schemaPath)) {
        assertCompatibleSchema(YAML.parse(readFileSync(schemaPath, "utf8")), definition, definition.type);
      }
    }
    for (const [name, definition] of schemaDefinitions) {
      atomicWrite(join(root, "_schema", `${name}.yaml`), YAML.stringify(definition));
    }

    if (registry) {
      const migrated = {
        ...registry,
        types: { ...registry.types, ...REGISTRY.types },
      };
      if (!sameValue(registry, migrated)) replaceWrite(registryPath, YAML.stringify(migrated));
      registry = migrated;
    } else {
      atomicWrite(registryPath, YAML.stringify(REGISTRY));
      registry = REGISTRY;
    }

    for (const [type, registration] of Object.entries(REGISTRY.types)) {
      assertCompatibleRegistration(registry, type, registration);
    }
    for (const [name, definition] of schemaDefinitions) {
      const schema = YAML.parse(readFileSync(join(root, "_schema", `${name}.yaml`), "utf8"));
      assertCompatibleSchema(schema, definition, definition.type);
    }

    const marker = JSON.stringify({
      schema: "agent-manager.brain.v2",
      schemaVersion: BRAIN_SCHEMA_VERSION,
      historyMode: "feed",
    }, null, 2) + "\n";
    if (previousVersion !== BRAIN_SCHEMA_VERSION) replaceWrite(markerPath, marker);
    return {
      root,
      schemaVersion: BRAIN_SCHEMA_VERSION,
      migratedFrom: previousVersion === 1 ? 1 : null,
      historyMode: "feed",
    };
  }, { root });
}

export function unwrapBrainResult(result, action) {
  if (result?.ok) return result.value;
  const errors = result?.errors || [];
  const message = errors.map((item) => `${item.code}: ${item.message}`).join("; ") || "unknown MAADB error";
  throw new Error(`${action} failed: ${message}`);
}

const unwrap = unwrapBrainResult;

async function openBrain(root = BRAIN_ROOT) {
  await ensureBrain({ root });
  let imported;
  try {
    imported = await import("@maadb/core");
  } catch (error) {
    throw new Error(`MAADB runtime is unavailable; install @maadb/core@0.14.0 or newer: ${error.message}`);
  }
  const engine = new imported.MaadEngine();
  unwrapBrainResult(await engine.init(root, {
    semantic: false,
    history: {
      effectiveMode: "feed",
      configuredMode: "feed",
      modeSource: "project",
      options: {},
      advisories: [],
    },
  }), "initialize Agent Manager brain");
  return engine;
}

export async function useBrain(operation, { root = BRAIN_ROOT, lock = null } = {}) {
  const execute = async () => {
    const engine = await openBrain(root);
    try {
      return await operation(engine);
    } finally {
      await engine.close();
    }
  };
  return lock ? withBrainLock(lock, execute, { root }) : execute();
}

function normalizeRemote(value) {
  let remote = String(value || "").trim();
  if (!remote) return null;
  const scp = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/.exec(remote);
  if (scp && !remote.includes("://") && !/^[a-zA-Z]:[\\/]/.test(remote)) {
    remote = `ssh://${scp[1]}/${scp[2]}`;
  }
  try {
    const url = new URL(remote);
    const host = url.hostname.toLowerCase();
    const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return `${host}/${path}`.toLowerCase();
  } catch {
    return remote.replace(/\\/g, "/").replace(/\.git$/i, "").toLowerCase();
  }
}

export function canonicalRepoIdentity(repoRoot, { remote = "origin" } = {}) {
  const root = realpathSync(resolve(repoRoot));
  let remoteValue = null;
  try {
    remoteValue = execFileSync(
      "git",
      ["-C", root, "config", "--get", `remote.${remote}.url`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    // A path identity still gives deterministic coordination on this machine.
  }
  const normalizedRemote = normalizeRemote(remoteValue);
  const source = normalizedRemote ? "remote" : "path";
  const identity = normalizedRemote || root.replace(/\\/g, "/").toLowerCase();
  return {
    key: `repo-${sha256(identity).slice(0, 24)}`,
    label: basename(root),
    source,
  };
}

function intentDocId(runId) {
  return `ari-${String(runId).replace(/^run-/, "")}`;
}

function uniqueScopes(lanes) {
  return [...new Set((lanes || []).flatMap((lane) => {
    const values = Array.isArray(lane.scope) ? lane.scope : String(lane.scope || "").split(",");
    return values.map(normalizeScopePath).filter(Boolean);
  }))].sort();
}

function frontmatterToIntent(document) {
  const value = document.frontmatter || {};
  const list = (field) => Array.isArray(value[field]) ? value[field].map(String) : [];
  return {
    docId: document.docId,
    runId: String(value.run_id || ""),
    title: String(value.title || value.run_id || document.docId),
    repoKey: String(value.repo_key || ""),
    repoLabel: String(value.repo_label || ""),
    state: String(value.state || ""),
    phase: String(value.phase || ""),
    scopes: list("scopes"),
    planRef: value.plan_ref ? String(value.plan_ref) : null,
    goalRefs: list("goal_refs"),
    relatedRuns: list("related_runs"),
    deliveryDependencies: list("delivery_dependencies"),
    heartbeatAt: value.heartbeat_at ? String(value.heartbeat_at) : null,
    leaseExpiresAt: value.lease_expires_at ? String(value.lease_expires_at) : null,
    startedAt: value.started_at ? String(value.started_at) : null,
    endedAt: value.ended_at ? String(value.ended_at) : null,
  };
}

async function queryRepoIntents(engine, repoKey) {
  const found = unwrap(engine.findDocuments({
    docType: "run_intent",
    filters: { repo_key: repoKey },
    fields: ["run_id", "state", "phase"],
    limit: 500,
  }), "query run intents");
  const records = [];
  for (const match of found.results) {
    records.push(frontmatterToIntent(unwrap(
      await engine.getDocument(match.docId, "hot"),
      `read run intent ${match.docId}`,
    )));
  }
  return records;
}

function overlaps(left, right) {
  return left.some((a) => right.some((b) => scopesMayOverlap(a, b)));
}

function awarenessContext({ current, activeRelated, deliveryDependencies }) {
  const lines = [
    "## Agent Manager cross-run awareness",
    "This is the frozen MAADB admission snapshot for this run.",
    `- Current intent: ${current.runId} (${current.scopes.join(", ")})`,
    `- Active related runs: ${activeRelated.length || "none"}`,
    `- Pending delivery dependencies: ${deliveryDependencies.length || "none"}`,
  ];
  for (const item of activeRelated) {
    lines.push(`  - ${item.runId}: ${item.state}; scope ${item.scopes.join(", ")}`);
  }
  for (const item of deliveryDependencies) {
    lines.push(`  - ${item.runId}: ${item.state}; overlapping delivery scope ${item.scopes.join(", ")}`);
  }
  lines.push(
    "- Do not expand into related run scopes. Treat pending-delivery runs as dependencies, not editable source.",
  );
  return lines.join("\n");
}

export async function admitRun({
  runId,
  repoRoot,
  remote = "origin",
  title = null,
  lanes = [],
  planRef = null,
  goalRefs = [],
  managerHarness = null,
  managerSession = null,
  baseCommit = null,
  now = new Date(),
  root = BRAIN_ROOT,
} = {}) {
  const repo = canonicalRepoIdentity(repoRoot, { remote });
  const scopes = uniqueScopes(lanes);
  if (!scopes.length) throw new Error("Agent Manager brain admission requires at least one lane scope");
  return withBrainLock(`admit-${repo.key}`, async () => {
    const engine = await openBrain(root);
    try {
      const existing = await queryRepoIntents(engine, repo.key);
      const nowMs = now.getTime();
      for (const item of existing.filter((candidate) => candidate.phase === "editing")) {
        if (Date.parse(item.leaseExpiresAt || "") > nowMs) continue;
        unwrap(await engine.updateDocument(item.docId, {
          state: "abandoned",
          phase: "terminal",
          ended_at: now.toISOString(),
          heartbeat_at: now.toISOString(),
        }), `expire stale run intent ${item.runId}`);
        item.state = "abandoned";
        item.phase = "terminal";
      }
      const activeRelated = existing.filter((item) => item.phase === "editing");
      const conflicts = activeRelated.filter((item) => overlaps(scopes, item.scopes));
      if (conflicts.length) throw new BrainConflictError(repo.label, conflicts);
      const deliveryDependencies = existing.filter(
        (item) => item.phase === "delivery" && overlaps(scopes, item.scopes),
      );
      const startedAt = now.toISOString();
      const leaseExpiresAt = new Date(nowMs + EDIT_LEASE_MS).toISOString();
      const current = { runId, scopes };
      const context = awarenessContext({ current, activeRelated, deliveryDependencies });
      const fields = {
        title: title || runId,
        run_id: runId,
        repo_key: repo.key,
        repo_label: repo.label,
        repo_identity_source: repo.source,
        state: "admitted",
        phase: "editing",
        scopes,
        related_runs: activeRelated.map((item) => item.runId),
        delivery_dependencies: deliveryDependencies.map((item) => item.runId),
        started_at: startedAt,
        heartbeat_at: startedAt,
        lease_expires_at: leaseExpiresAt,
        ...(planRef ? { plan_ref: planRef } : {}),
        ...(goalRefs.length ? { goal_refs: goalRefs } : {}),
        ...(managerHarness ? { manager_harness: managerHarness } : {}),
        ...(managerSession ? { manager_session: managerSession } : {}),
        ...(baseCommit ? { base_commit: baseCommit } : {}),
      };
      const created = unwrap(await engine.createDocument(
        "run_intent",
        fields,
        context,
        intentDocId(runId),
      ), "create run intent");
      return {
        schema: "agent-manager.awareness.v1",
        enabled: true,
        state: "admitted",
        historyMode: "feed",
        brainRoot: root,
        intentId: created.docId,
        runId,
        repoKey: repo.key,
        repoLabel: repo.label,
        repoIdentitySource: repo.source,
        scopes,
        activeRelated,
        deliveryDependencies,
        admittedAt: startedAt,
        leaseExpiresAt,
        context,
        contextDigest: sha256(context),
      };
    } finally {
      await engine.close();
    }
  }, { root });
}

function phaseForStatus(status) {
  const state = status?.state;
  if (["delivery_review_pending", "correction_pending", "ship_gate_pending", "shipping", "release_pending"].includes(state)) {
    return "delivery";
  }
  if (["reviewed", "merged", "released", "rejected", "failed", "cancelled", "abandoned"].includes(state)) {
    return "terminal";
  }
  if (state === "blocked" && (
    status?.ship ||
    ["review_pending", "correction_pending", "ship_gate_pending", "shipping", "blocked", "targets_pending", "release_pending"]
      .includes(status?.delivery?.state)
  )) return "delivery";
  return "editing";
}

function brainStateForStatus(status, phase) {
  const state = status?.state;
  const values = new Set([
    "shipping", "reviewed", "merged", "released", "rejected", "failed", "cancelled", "abandoned",
  ]);
  if (values.has(state)) return state;
  if (state === "blocked") return "needs_input";
  if (phase === "delivery") return "pending_delivery";
  return "running";
}

export async function syncBrainStatus(status, { root = BRAIN_ROOT, now = new Date() } = {}) {
  if (!status?.awareness?.intentId) return null;
  const requestedPhase = phaseForStatus(status);
  return withBrainLock(`intent-${sha256(status.awareness.intentId).slice(0, 24)}`, async () => {
    const engine = await openBrain(root);
    try {
      const current = frontmatterToIntent(unwrap(
        await engine.getDocument(status.awareness.intentId, "hot"),
        `read run intent ${status.runId}`,
      ));
      const phaseRank = { editing: 0, delivery: 1, terminal: 2 };
      if (phaseRank[requestedPhase] < phaseRank[current.phase]) {
        status.awareness.state = current.state;
        status.awareness.phase = current.phase;
        return { skipped: true, reason: "phase-regression", currentPhase: current.phase };
      }
      const brainState = brainStateForStatus(status, requestedPhase);
      const fields = {
        state: brainState,
        phase: requestedPhase,
        heartbeat_at: now.toISOString(),
      };
      if (requestedPhase === "editing") {
        fields.lease_expires_at = new Date(now.getTime() + EDIT_LEASE_MS).toISOString();
      }
      if (requestedPhase === "terminal") fields.ended_at = status.endedAt || now.toISOString();
      const updated = unwrap(
        await engine.updateDocument(status.awareness.intentId, fields),
        `update run intent ${status.runId}`,
      );
      status.awareness.state = brainState;
      status.awareness.phase = requestedPhase;
      status.awareness.heartbeatAt = fields.heartbeat_at;
      if (fields.lease_expires_at) status.awareness.leaseExpiresAt = fields.lease_expires_at;
      return updated;
    } finally {
      await engine.close();
    }
  }, { root });
}

export async function listBrainIntents({ repoRoot = null, remote = "origin", root = BRAIN_ROOT } = {}) {
  const engine = await openBrain(root);
  try {
    let matches;
    if (repoRoot) {
      const repo = canonicalRepoIdentity(repoRoot, { remote });
      matches = await queryRepoIntents(engine, repo.key);
    } else {
      const found = unwrap(engine.findDocuments({ docType: "run_intent", limit: 500 }), "list run intents");
      matches = [];
      for (const item of found.results) {
        matches.push(frontmatterToIntent(unwrap(
          await engine.getDocument(item.docId, "hot"),
          `read run intent ${item.docId}`,
        )));
      }
    }
    return matches.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  } finally {
    await engine.close();
  }
}

export function formatBrainIntents(intents, { root = BRAIN_ROOT } = {}) {
  const lines = [`brain: ${root}`, `history mode: feed`, `run intents: ${intents.length}`];
  for (const item of intents) {
    lines.push(`${item.runId}  ${item.phase}/${item.state}  ${item.repoLabel}  ${item.scopes.join(", ")}`);
  }
  return lines.join("\n");
}
