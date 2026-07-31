import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import YAML from "yaml";
import { DEFAULT_MAX_CONCURRENCY, MAX_LANES } from "./constants.mjs";
import { normalizePlanning, planningPrompt } from "./planning.mjs";
import { assertPathInside, assertSafeSlug, repoPath } from "./paths.mjs";
import {
  normalizeScopePath,
  scopeConflictWitness,
  scopesMayOverlap,
} from "./scope.mjs";

const TOP_LEVEL_KEYS = new Set([
  "repo", "lanes", "feed", "target_dev_flow", "harness_default", "model_default",
  "integrate", "policy", "claim_mode", "remote", "base_ref", "env_allowlist",
  "max_concurrency", "scope_overrides", "verification",
  "planning",
]);
const LANE_KEYS = new Set([
  "id", "harness", "model", "scope", "prompt", "prompt_file", "fake", "depends_on",
]);
const SCOPE_OVERRIDE_KEYS = new Set(["path", "lanes", "owner", "reason", "access"]);
const VERIFICATION_KEYS = new Set(["commands", "timeout_sec"]);
const VERIFICATION_COMMAND_KEYS = new Set(["command", "args"]);
const POLICY_KEYS = new Set([
  "allow_commit", "allow_pr", "dangerously_skip_permissions", "permission_mode",
  "stall_timeout_sec", "poll_interval_ms",
]);
const HARNESSES = new Set(["claude", "codex", "fake"]);
const PERMISSION_MODES = new Set(["acceptEdits", "readOnly", "read-only", "read_only", "workspace-write"]);
const CLAIM_MODES = new Set(["auto", "off", "required"]);

export function loadWorkflow(filePath, {
  repoOverride = null,
  planningContextOverride = null,
} = {}) {
  const abs = resolve(filePath);
  if (!existsSync(abs)) throw new Error(`workflow not found: ${abs}`);
  const raw = readFileSync(abs, "utf8");
  let doc;
  try {
    doc = extname(abs).toLowerCase() === ".json" ? JSON.parse(raw) : YAML.parse(raw);
  } catch (error) {
    throw new Error(`workflow parse failed: ${error.message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("workflow must be a mapping");
  }
  assertKnownKeys(doc, TOP_LEVEL_KEYS, "workflow");

  const repoValue = repoOverride || doc.repo;
  if (typeof repoValue !== "string" || !repoValue.trim()) {
    throw new Error("workflow.repo is required and must be a non-empty path");
  }
  const repoRoot = resolveRepo(repoValue, abs, Boolean(repoOverride));
  if (!existsSync(repoRoot)) throw new Error(`repo not found: ${repoRoot}`);

  if (!Array.isArray(doc.lanes) || doc.lanes.length === 0) {
    throw new Error("workflow.lanes must be a non-empty array");
  }
  if (doc.lanes.length > MAX_LANES) {
    throw new Error(`workflow.lanes supports at most ${MAX_LANES} lanes`);
  }

  const harnessDefault = normalizeHarness(doc.harness_default || "claude", "workflow.harness_default");
  const ids = new Set();
  const lanes = doc.lanes.map((lane, index) => normalizeLane(lane, index, repoRoot, harnessDefault, ids));
  validateDependencies(lanes);
  const scopeOverrides = normalizeScopeOverrides(doc.scope_overrides, lanes);
  const sequentialOverlaps = applyScopeOwnership(lanes, scopeOverrides);
  const policy = normalizePolicy(doc.policy);
  const feed = normalizeFeed(doc.feed, basename(repoRoot));
  const claimMode = doc.claim_mode || "auto";
  if (!CLAIM_MODES.has(claimMode)) {
    throw new Error("workflow.claim_mode must be auto, off, or required");
  }
  const remote = validateRemote(doc.remote || "origin");
  const baseRef = validateGitRef(doc.base_ref || "HEAD", "workflow.base_ref");
  const envAllowlist = normalizeEnvAllowlist(doc.env_allowlist);
  const maxConcurrency = boundedInteger(
    doc.max_concurrency,
    Math.min(DEFAULT_MAX_CONCURRENCY, lanes.length),
    1,
    MAX_LANES,
    "workflow.max_concurrency",
  );
  const verification = normalizeVerification(doc.verification);
  const planning = normalizePlanning(doc.planning, {
    repoRoot,
    contextOverridePath: planningContextOverride,
  });

  assertBoolean(doc.integrate, "workflow.integrate", { optional: true });
  if (doc.model_default !== undefined && !isNonEmptyString(doc.model_default)) {
    throw new Error("workflow.model_default must be a non-empty string");
  }
  if (doc.target_dev_flow !== undefined && !isNonEmptyString(doc.target_dev_flow)) {
    throw new Error("workflow.target_dev_flow must be a non-empty string");
  }

  const targetDevFlow = doc.target_dev_flow || readTargetDevFlow(repoRoot) || "simple";
  return {
    ...doc,
    lanes,
    absPath: abs,
    repo: repoValue,
    repoRoot,
    harness_default: harnessDefault,
    target_dev_flow: targetDevFlow,
    integrate: doc.integrate === true,
    claim_mode: claimMode,
    max_concurrency: maxConcurrency,
    scope_overrides: scopeOverrides,
    sequential_overlaps: sequentialOverlaps,
    verification,
    planning,
    remote,
    base_ref: baseRef,
    env_allowlist: envAllowlist,
    feed,
    policy,
  };
}

function normalizeLane(input, index, repoRoot, harnessDefault, ids) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`workflow.lanes[${index}] must be a mapping`);
  }
  assertKnownKeys(input, LANE_KEYS, `workflow.lanes[${index}]`);
  const id = assertSafeSlug(input.id, `workflow.lanes[${index}].id`);
  if (ids.has(id)) throw new Error(`duplicate lane id: ${id}`);
  ids.add(id);
  const harness = normalizeHarness(input.harness || harnessDefault, `lane ${id}.harness`);
  if (!input.prompt && !input.prompt_file) {
    throw new Error(`lane ${id}: prompt or prompt_file required`);
  }
  if (input.prompt !== undefined && !isNonEmptyString(input.prompt)) {
    throw new Error(`lane ${id}.prompt must be a non-empty string`);
  }
  let promptFile = null;
  if (input.prompt_file !== undefined) {
    if (!isNonEmptyString(input.prompt_file) || isAbsolute(input.prompt_file)) {
      throw new Error(`lane ${id}.prompt_file must be a relative path inside the repo`);
    }
    promptFile = assertPathInside(repoRoot, resolve(repoRoot, input.prompt_file), `lane ${id}.prompt_file`);
    if (!existsSync(promptFile)) throw new Error(`lane ${id}.prompt_file not found: ${promptFile}`);
  }
  const scope = normalizeScope(input.scope, id);
  if (input.model !== undefined && !isNonEmptyString(input.model)) {
    throw new Error(`lane ${id}.model must be a non-empty string`);
  }
  if (input.fake !== undefined && (harness !== "fake" || !isMapping(input.fake))) {
    throw new Error(`lane ${id}.fake is only valid as a mapping for the fake harness`);
  }
  const dependsOn = normalizeDependencies(input.depends_on, id);
  return {
    ...input,
    id,
    harness,
    scope,
    depends_on: dependsOn,
    read_only: [],
    prompt_file: input.prompt_file || undefined,
    _promptFile: promptFile,
  };
}

function normalizeScope(input, laneId) {
  const values = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  const scopes = values.map((value) => String(value).trim()).filter(Boolean);
  if (!scopes.length) throw new Error(`lane ${laneId}.scope must contain at least one path pattern`);
  for (const scope of scopes) {
    const normalized = normalizeScopePath(scope);
    if (isAbsolute(scope) || normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error(`lane ${laneId}.scope must stay inside the repository: ${scope}`);
    }
    if (/\0|[\r\n]/.test(scope)) throw new Error(`lane ${laneId}.scope contains invalid characters`);
  }
  return scopes;
}

function normalizeDependencies(input, laneId) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error(`lane ${laneId}.depends_on must be an array`);
  return [...new Set(input.map((value) => {
    if (!isNonEmptyString(value)) throw new Error(`lane ${laneId}.depends_on contains an invalid lane id`);
    return assertSafeSlug(value, `lane ${laneId}.depends_on`);
  }))];
}

function validateDependencies(lanes) {
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  for (const lane of lanes) {
    for (const dependency of lane.depends_on) {
      if (dependency === lane.id) throw new Error(`lane ${lane.id} cannot depend on itself`);
      if (!byId.has(dependency)) {
        throw new Error(`lane ${lane.id}.depends_on references unknown lane: ${dependency}`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (laneId, path = []) => {
    if (visiting.has(laneId)) {
      throw new Error(`workflow lane dependency cycle: ${[...path, laneId].join(" -> ")}`);
    }
    if (visited.has(laneId)) return;
    visiting.add(laneId);
    for (const dependency of byId.get(laneId).depends_on) visit(dependency, [...path, laneId]);
    visiting.delete(laneId);
    visited.add(laneId);
  };
  for (const lane of lanes) visit(lane.id);
}

export function laneDependsOn(lanes, laneId, dependencyId) {
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  const visited = new Set();
  const visit = (currentId) => {
    if (currentId === dependencyId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const current = byId.get(currentId);
    return (current?.depends_on || current?.dependsOn || []).some(visit);
  };
  return visit(laneId);
}

export function lanesAreSequential(lanes, leftId, rightId) {
  return laneDependsOn(lanes, leftId, rightId) ||
    laneDependsOn(lanes, rightId, leftId);
}

function normalizeScopeOverrides(input, lanes) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("workflow.scope_overrides must be an array");
  const laneIds = new Set(lanes.map((lane) => lane.id));
  return input.map((raw, index) => {
    if (!isMapping(raw)) throw new Error(`workflow.scope_overrides[${index}] must be a mapping`);
    assertKnownKeys(raw, SCOPE_OVERRIDE_KEYS, `workflow.scope_overrides[${index}]`);
    const path = normalizeScope(raw.path, `scope override ${index}`)[0];
    if (!Array.isArray(raw.lanes) || raw.lanes.length < 2) {
      throw new Error(`workflow.scope_overrides[${index}].lanes must contain at least two lane ids`);
    }
    const participants = [...new Set(raw.lanes.map((laneId) => {
      if (!isNonEmptyString(laneId) || !laneIds.has(laneId)) {
        throw new Error(`workflow.scope_overrides[${index}] references unknown lane: ${laneId}`);
      }
      return laneId;
    }))];
    if (!isNonEmptyString(raw.owner) || !participants.includes(raw.owner)) {
      throw new Error(`workflow.scope_overrides[${index}].owner must be one of its lanes`);
    }
    if (!isNonEmptyString(raw.reason)) {
      throw new Error(`workflow.scope_overrides[${index}].reason is required`);
    }
    if (raw.access !== undefined && !isMapping(raw.access)) {
      throw new Error(`workflow.scope_overrides[${index}].access must be a mapping`);
    }
    const access = {};
    for (const laneId of participants) {
      const value = raw.access?.[laneId] || (laneId === raw.owner ? "write" : "read-only");
      if (!["write", "read-only"].includes(value)) {
        throw new Error(`workflow.scope_overrides[${index}].access.${laneId} must be write or read-only`);
      }
      if (laneId === raw.owner && value !== "write") {
        throw new Error(`workflow.scope_overrides[${index}] owner must retain write access`);
      }
      if (laneId !== raw.owner && value !== "read-only") {
        throw new Error(`workflow.scope_overrides[${index}] permits only one writable owner`);
      }
      access[laneId] = value;
    }
    for (const laneId of Object.keys(raw.access || {})) {
      if (!participants.includes(laneId)) {
        throw new Error(`workflow.scope_overrides[${index}].access references a non-participant: ${laneId}`);
      }
    }
    return {
      path,
      lanes: participants,
      owner: raw.owner,
      reason: raw.reason.trim(),
      access,
    };
  });
}

function applyScopeOwnership(lanes, overrides) {
  const conflicts = [];
  const sequentialOverlaps = [];
  for (let leftIndex = 0; leftIndex < lanes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < lanes.length; rightIndex += 1) {
      const leftLane = lanes[leftIndex];
      const rightLane = lanes[rightIndex];
      for (const leftScope of leftLane.scope) {
        for (const rightScope of rightLane.scope) {
          if (!scopesMayOverlap(leftScope, rightScope)) continue;
          const override = overrides.find((item) =>
            item.lanes.includes(leftLane.id) &&
            item.lanes.includes(rightLane.id) &&
            scopesMayOverlap(item.path, leftScope) &&
            scopesMayOverlap(item.path, rightScope) &&
            [normalizeScopePath(leftScope), normalizeScopePath(rightScope)].includes(
              normalizeScopePath(item.path),
            ),
          );
          if (!override) {
            if (lanesAreSequential(lanes, leftLane.id, rightLane.id)) {
              sequentialOverlaps.push({
                lanes: [leftLane.id, rightLane.id],
                path: scopeConflictWitness(leftScope, rightScope),
                reason: "ordered by depends_on",
              });
              continue;
            }
            conflicts.push({
              left: leftLane.id,
              right: rightLane.id,
              path: scopeConflictWitness(leftScope, rightScope),
            });
            continue;
          }
          for (const lane of [leftLane, rightLane]) {
            if (lane.id !== override.owner && !lane.read_only.includes(override.path)) {
              lane.read_only.push(override.path);
            }
          }
        }
      }
    }
  }
  if (conflicts.length) {
    const details = conflicts
      .map((item) => `lane "${item.left}" and lane "${item.right}" overlap at "${item.path}"`)
      .join("; ");
    throw new Error(`workflow has overlapping write scopes: ${details}`);
  }
  return sequentialOverlaps;
}

function normalizeVerification(input) {
  if (input === undefined) return { commands: [], timeout_sec: 900 };
  if (!isMapping(input)) throw new Error("workflow.verification must be a mapping");
  assertKnownKeys(input, VERIFICATION_KEYS, "workflow.verification");
  if (!Array.isArray(input.commands) || input.commands.length === 0) {
    throw new Error("workflow.verification.commands must be a non-empty array");
  }
  const commands = input.commands.map((raw, index) => {
    if (!isMapping(raw)) {
      throw new Error(`workflow.verification.commands[${index}] must be a mapping`);
    }
    assertKnownKeys(raw, VERIFICATION_COMMAND_KEYS, `workflow.verification.commands[${index}]`);
    if (!isNonEmptyString(raw.command) || /[\\/\s\r\n\0]/.test(raw.command)) {
      throw new Error(`workflow.verification.commands[${index}].command must be a bare executable name`);
    }
    if (raw.args !== undefined && !Array.isArray(raw.args)) {
      throw new Error(`workflow.verification.commands[${index}].args must be an array`);
    }
    const args = (raw.args || []).map((arg) => {
      if (typeof arg !== "string" || /[\r\n\0]/.test(arg)) {
        throw new Error(`workflow.verification.commands[${index}].args contains an invalid value`);
      }
      return arg;
    });
    return { command: raw.command, args };
  });
  return {
    commands,
    timeout_sec: boundedInteger(
      input.timeout_sec,
      900,
      1,
      86_400,
      "workflow.verification.timeout_sec",
    ),
  };
}

function normalizePolicy(input) {
  if (input !== undefined && !isMapping(input)) throw new Error("workflow.policy must be a mapping");
  const raw = input || {};
  assertKnownKeys(raw, POLICY_KEYS, "workflow.policy");
  assertBoolean(raw.allow_commit, "workflow.policy.allow_commit", { optional: true });
  assertBoolean(raw.allow_pr, "workflow.policy.allow_pr", { optional: true });
  assertBoolean(raw.dangerously_skip_permissions, "workflow.policy.dangerously_skip_permissions", { optional: true });
  const permissionMode = raw.permission_mode || "acceptEdits";
  if (!PERMISSION_MODES.has(permissionMode)) {
    throw new Error(`workflow.policy.permission_mode is invalid: ${permissionMode}`);
  }
  return {
    allow_commit: raw.allow_commit === true,
    allow_pr: raw.allow_pr === true,
    dangerously_skip_permissions: raw.dangerously_skip_permissions === true,
    permission_mode: permissionMode,
    stall_timeout_sec: boundedNumber(raw.stall_timeout_sec, 600, 5, 86_400, "workflow.policy.stall_timeout_sec"),
    poll_interval_ms: boundedNumber(raw.poll_interval_ms, 2_000, 100, 60_000, "workflow.policy.poll_interval_ms"),
  };
}

function normalizeFeed(input, repo) {
  if (input !== undefined && !isMapping(input)) throw new Error("workflow.feed must be a mapping");
  const raw = input || {};
  assertKnownKeys(raw, new Set(["enabled", "baseUrl", "topic"]), "workflow.feed");
  assertBoolean(raw.enabled, "workflow.feed.enabled", { optional: true });
  const baseUrl = raw.baseUrl || process.env.AGENT_FEED_BASE_URL || "http://localhost:8787";
  const topic = raw.topic || process.env.AGENT_FEED_TOPIC || "agent-manager/" + repo;
  if (!isNonEmptyString(baseUrl)) throw new Error("workflow.feed.baseUrl must be a non-empty URL");
  if (!isNonEmptyString(topic)) throw new Error("workflow.feed.topic must be a non-empty string");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("workflow.feed.baseUrl must be an http(s) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("workflow.feed.baseUrl must use http or https");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("workflow.feed.baseUrl must not embed credentials, query parameters, or fragments");
  }
  return { enabled: raw.enabled === true, baseUrl: baseUrl.replace(/\/+$/, ""), topic };
}

function normalizeEnvAllowlist(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("workflow.env_allowlist must be an array of environment variable names");
  return [...new Set(input.map((name) => {
    if (typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new Error(`invalid environment variable name in workflow.env_allowlist: ${name}`);
    }
    return name;
  }))];
}

function resolveRepo(value, workflowPath, wasOverride) {
  const trimmed = value.trim();
  if (wasOverride) return resolve(trimmed);
  if (trimmed === ".") return dirname(workflowPath);
  if (trimmed.startsWith("./") || trimmed.startsWith(".\\") || trimmed.startsWith("../") || trimmed.startsWith("..\\")) {
    return resolve(dirname(workflowPath), trimmed);
  }
  return repoPath(trimmed);
}

function readTargetDevFlow(repoRoot) {
  const path = resolve(repoRoot, "Version.md");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!block) return null;
  const flow = block[1].match(/^dev_flow:\s*([a-zA-Z0-9_-]+)/m);
  return flow ? flow[1] : null;
}

export function lanePrompt(lane, workflow) {
  let body = lane.prompt || "";
  if (lane._promptFile) body = readFileSync(lane._promptFile, "utf8");
  const policyBlock = `
## agent-manager policy (mandatory)
- Stay inside scope: ${lane.scope.join(", ")}
- Treat these paths as read-only: ${lane.read_only.length ? lane.read_only.join(", ") : "(none)"}
- Dependencies already integrated into this worktree: ${lane.depends_on.length ? lane.depends_on.join(", ") : "(none)"}
- Work only in this worktree / branch. Do not switch repos.
- Do NOT commit, push, merge, tag, or bump versions unless policy explicitly permits it.
- Target repo dev_flow: ${workflow.target_dev_flow}
- If blocked on a product or architecture decision, write needs-input.json in the supplied lane directory with { "type":"question", "prompt":"...", "blocking":true } and stop.
- Prefer finishing a thin slice over expanding scope.
`.trim();
  const sharedPlanning = planningPrompt(workflow.planning);
  return `${sharedPlanning}\n\n## Lane assignment\n${body.trim()}\n\n${policyBlock}\n`;
}

export function assertDangerousPermissionApproval(workflow, approved = false) {
  if (workflow.policy.dangerously_skip_permissions && !approved && process.env.AGENT_MANAGER_ALLOW_DANGEROUS_PERMISSIONS !== "1") {
    throw new Error("dangerous permission bypass requires --allow-dangerous-permissions or AGENT_MANAGER_ALLOW_DANGEROUS_PERMISSIONS=1");
  }
}

export function validateGitRef(value, label = "git ref") {
  if (!isNonEmptyString(value) || value.length > 240 || /[\s~^:?*[\\\x00-\x1f\x7f]/.test(value) || value.includes("..") || value.includes("@{") || value.endsWith(".") || value.endsWith("/") || value.startsWith("/")) {
    throw new Error(`${label} is not a safe Git ref: ${value}`);
  }
  return value;
}

function validateRemote(value) {
  if (!isNonEmptyString(value) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new Error(`workflow.remote is invalid: ${value}`);
  }
  return value;
}

function normalizeHarness(value, label) {
  if (typeof value !== "string" || !HARNESSES.has(value)) {
    throw new Error(`${label} must be one of: ${[...HARNESSES].join(", ")}`);
  }
  return value;
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function assertBoolean(value, label, { optional = false } = {}) {
  if (value === undefined && optional) return;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
}

function boundedNumber(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number from ${min} to ${max}`);
  }
  return value;
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function isMapping(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
