import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import YAML from "yaml";
import { DEFAULT_MAX_CONCURRENCY, MAX_LANES } from "./constants.mjs";
import { normalizePlanning, planningPrompt } from "./planning.mjs";
import { assertPathInside, assertSafeSlug, repoPath } from "./paths.mjs";
import { detectRuntimeProfile, runtimePrompt } from "./runtime.mjs";
import {
  listScopedFiles,
  matchesScope,
  normalizeScopePath,
  resolveImportPath,
  scopeConflictWitness,
  scopesMayOverlap,
} from "./scope.mjs";

const TOP_LEVEL_KEYS = new Set([
  "repo", "lanes", "feed", "target_dev_flow", "harness_default", "model_default",
  "integrate", "policy", "claim_mode", "remote", "base_ref", "env_allowlist",
  "max_concurrency", "scope_overrides", "verification",
  "planning", "delivery", "title", "repo_shorthand", "goal_refs",
]);
const LANE_KEYS = new Set([
  "id", "harness", "model", "scope", "prompt", "prompt_file", "fake", "depends_on",
  "kind", "expected_outputs", "allow_no_changes", "permission_mode", "allowed_tools", "setup",
]);
const SCOPE_OVERRIDE_KEYS = new Set(["path", "lanes", "owner", "reason", "access"]);
const VERIFICATION_KEYS = new Set(["commands", "timeout_sec", "setup"]);
const COMMAND_PLAN_KEYS = new Set(["commands", "timeout_sec"]);
const VERIFICATION_COMMAND_KEYS = new Set(["command", "args"]);
const DELIVERY_KEYS = new Set(["mode", "targets", "release_required"]);
const DELIVERY_TARGET_KEYS = new Set(["id", "lane", "branch", "base", "pr"]);
const POLICY_KEYS = new Set([
  "allow_commit", "allow_pr", "dangerously_skip_permissions", "permission_mode",
  "stall_timeout_sec", "poll_interval_ms",
]);
const HARNESSES = new Set(["claude", "codex", "cursor", "fake"]);
const PERMISSION_MODES = new Set([
  "acceptEdits", "auto", "dontAsk", "readOnly", "read-only", "read_only", "workspace-write",
]);
const CLAUDE_PERMISSION_MODES = new Set([
  "acceptEdits", "auto", "dontAsk", "readOnly", "read-only", "read_only", "workspace-write",
]);
const CODEX_PERMISSION_MODES = new Set([
  "acceptEdits", "readOnly", "read-only", "read_only", "workspace-write",
]);
// Cursor has --mode plan and --auto-review, but no allowlist-only mode.
const CURSOR_PERMISSION_MODES = new Set([
  "acceptEdits", "auto", "readOnly", "read-only", "read_only", "workspace-write",
]);
const HARNESS_PERMISSION_MODES = new Map([
  ["claude", CLAUDE_PERMISSION_MODES],
  ["codex", CODEX_PERMISSION_MODES],
  ["cursor", CURSOR_PERMISSION_MODES],
]);
const CLAIM_MODES = new Set(["auto", "off", "required"]);
const READ_ONLY_PERMISSION_MODES = new Set(["readOnly", "read-only", "read_only"]);
// Claude prompts before shell commands under acceptEdits / workspace-write, and a
// detached worker cannot answer that prompt. Only these modes can actually run the
// git and gh commands a commit/PR policy claims to allow.
const CLAUDE_UNATTENDED_SHELL_MODES = new Set(["auto", "dontAsk"]);
// Writable Claude modes that take a default allowlist derived from the
// workflow's own verification commands. `dontAsk` is excluded on purpose: it
// requires a complete, explicit allowlist, and a derived one would silently
// under-grant it.
const SYNTHESIZED_ALLOWED_TOOL_MODES = new Set(["acceptEdits", "auto", "workspace-write"]);

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
  const policy = normalizePolicy(doc.policy);
  const ids = new Set();
  const lanes = doc.lanes.map((lane, index) =>
    normalizeLane(lane, index, repoRoot, harnessDefault, ids, policy));
  validateDependencies(lanes);
  assertShellPolicyCoherence(lanes, policy);
  const scopeOverrides = normalizeScopeOverrides(doc.scope_overrides, lanes);
  const sequentialOverlaps = applyScopeOwnership(lanes, scopeOverrides);
  const lintWarnings = collectLintWarnings(lanes, repoRoot);
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
  const verification = normalizeVerification(doc.verification, "workflow.verification", {
    allowSetup: true,
  });
  synthesizeAllowedTools(lanes, verification);
  const goalRefs = normalizeGoalRefs(doc.goal_refs);
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
  validateIdentityText(doc.title, "workflow.title", 160);
  validateIdentityText(doc.repo_shorthand, "workflow.repo_shorthand", 64);

  const targetDevFlow = doc.target_dev_flow || readTargetDevFlow(repoRoot) || "simple";
  const delivery = normalizeDelivery(doc.delivery, {
    lanes,
    policy,
    integrate: doc.integrate === true,
    baseRef,
    targetDevFlow,
  });
  const runtime = detectRuntimeProfile();
  const topology = analyzeDependencyTopology(lanes, maxConcurrency);
  return {
    ...doc,
    lanes,
    absPath: abs,
    repo: repoValue,
    repoRoot,
    harness_default: harnessDefault,
    target_dev_flow: targetDevFlow,
    runtime,
    integrate: doc.integrate === true,
    claim_mode: claimMode,
    max_concurrency: maxConcurrency,
    topology,
    scope_overrides: scopeOverrides,
    sequential_overlaps: sequentialOverlaps,
    lint_warnings: lintWarnings,
    verification,
    goal_refs: goalRefs,
    planning,
    delivery,
    remote,
    base_ref: baseRef,
    env_allowlist: envAllowlist,
    feed,
    policy,
  };
}

function normalizeGoalRefs(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("workflow.goal_refs must be an array");
  const refs = input.map((value, index) => {
    if (typeof value !== "string" || !/^goal-[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value) || value.length > 128 || value.includes("..")) {
      throw new Error(`workflow.goal_refs[${index}] must be a valid local goal ID`);
    }
    return value;
  });
  if (new Set(refs).size !== refs.length) {
    throw new Error("workflow.goal_refs must not contain duplicate goal IDs");
  }
  return [...refs].sort();
}

function normalizeDelivery(input, { lanes, policy, integrate, baseRef, targetDevFlow }) {
  if (input !== undefined && !isMapping(input)) {
    throw new Error("workflow.delivery must be a mapping");
  }
  const raw = input || {};
  assertKnownKeys(raw, DELIVERY_KEYS, "workflow.delivery");
  assertBoolean(raw.release_required, "workflow.delivery.release_required", { optional: true });
  const readOnly = ["readOnly", "read-only", "read_only"].includes(policy.permission_mode);
  if (raw.targets !== undefined && !Array.isArray(raw.targets)) {
    throw new Error("workflow.delivery.targets must be an array");
  }
  const deliverableLanes = lanes.filter((lane) =>
    lane.kind === "implementation" && lane.allow_no_changes !== true);
  const laneIds = new Set(deliverableLanes.map((lane) => lane.id));
  const targetIds = new Set();
  const mappedLanes = new Set();
  let targets = (raw.targets || []).map((target, index) => {
    if (!isMapping(target)) {
      throw new Error(`workflow.delivery.targets[${index}] must be a mapping`);
    }
    assertKnownKeys(target, DELIVERY_TARGET_KEYS, `workflow.delivery.targets[${index}]`);
    const id = assertSafeSlug(target.id, `workflow.delivery.targets[${index}].id`);
    if (targetIds.has(id)) throw new Error(`duplicate delivery target id: ${id}`);
    targetIds.add(id);
    const lane = assertSafeSlug(target.lane, `workflow.delivery.targets[${index}].lane`);
    if (!laneIds.has(lane)) {
      throw new Error(`delivery target ${id} must reference a change-producing implementation lane: ${lane}`);
    }
    if (mappedLanes.has(lane)) throw new Error(`lane ${lane} has more than one delivery target`);
    mappedLanes.add(lane);
    if (target.branch !== undefined) validateGitRef(target.branch, `delivery target ${id}.branch`);
    if (target.base !== undefined) validateGitRef(target.base, `delivery target ${id}.base`);
    if (target.pr !== undefined && !isNonEmptyString(String(target.pr))) {
      throw new Error(`delivery target ${id}.pr must be a pull request number or URL`);
    }
    return {
      id,
      lane,
      branch: target.branch || null,
      base: target.base || normalizeBaseRef(baseRef),
      pr: target.pr == null ? null : String(target.pr),
    };
  });

  if (!readOnly && !integrate && deliverableLanes.length > 1 && targets.length === 0) {
    throw new Error(
      "multi-lane writable workflows with integrate=false require workflow.delivery.targets for every lane",
    );
  }
  if (!readOnly && targetDevFlow === "simple" && !integrate && deliverableLanes.length > 1) {
    throw new Error("Simple Flow multi-lane writable workflows require integrate=true");
  }
  if (!readOnly && !integrate && deliverableLanes.length === 1 && targets.length === 0) {
    targets = [{
      id: deliverableLanes[0].id,
      lane: deliverableLanes[0].id,
      branch: null,
      base: normalizeBaseRef(baseRef),
      pr: null,
    }];
    mappedLanes.add(deliverableLanes[0].id);
  }
  if (!readOnly && !integrate && targets.length && mappedLanes.size !== deliverableLanes.length) {
    const missing = deliverableLanes.filter((lane) => !mappedLanes.has(lane.id)).map((lane) => lane.id);
    throw new Error(`workflow.delivery.targets must map every lane; missing: ${missing.join(", ")}`);
  }
  const inferredMode = readOnly || deliverableLanes.length === 0
    ? "review-only"
    : targets.length > 1 ? "train" : "single";
  const mode = raw.mode || inferredMode;
  if (!["single", "train", "review-only"].includes(mode)) {
    throw new Error("workflow.delivery.mode must be single, train, or review-only");
  }
  if (mode === "single" && targets.length > 1) {
    throw new Error("workflow.delivery.mode=single supports at most one target");
  }
  if (mode === "train" && targets.length < 2) {
    throw new Error("workflow.delivery.mode=train requires at least two targets");
  }
  if (readOnly && mode !== "review-only") {
    throw new Error("read-only workflows must use workflow.delivery.mode=review-only");
  }
  if (readOnly && targets.length) {
    throw new Error("read-only workflows cannot declare delivery targets");
  }
  if (readOnly && raw.release_required === true) {
    throw new Error("read-only workflows cannot require a release");
  }
  if (integrate && targets.length) {
    throw new Error("integrated workflows cannot declare lane delivery targets");
  }
  return {
    mode,
    targets,
    release_required: raw.release_required === true,
  };
}

function normalizeBaseRef(value) {
  const text = String(value || "HEAD");
  return text.startsWith("origin/") ? text.slice("origin/".length) : text;
}

function validateIdentityText(value, label, maxLength) {
  if (value === undefined) return;
  if (!isNonEmptyString(value)) throw new Error(`${label} must be a non-empty string`);
  if (value.trim().length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} contains unsupported characters or exceeds ${maxLength} characters`);
  }
}

function normalizeLane(input, index, repoRoot, harnessDefault, ids, policy) {
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
  const permissionMode = input.permission_mode || policy.permission_mode;
  const supportedModes = HARNESS_PERMISSION_MODES.get(harness) || CODEX_PERMISSION_MODES;
  if (!supportedModes.has(permissionMode)) {
    throw new Error(`lane ${id}.permission_mode ${permissionMode} is not supported by ${harness}`);
  }
  const allowedTools = normalizeAllowedTools(input.allowed_tools, id, harness, permissionMode);
  const setup = normalizeVerification(input.setup, `lane ${id}.setup`);
  const defaultKind = ["readOnly", "read-only", "read_only"].includes(permissionMode)
    ? "review"
    : "implementation";
  const kind = input.kind || defaultKind;
  if (!["implementation", "review"].includes(kind)) {
    throw new Error(`lane ${id}.kind must be implementation or review`);
  }
  assertBoolean(input.allow_no_changes, `lane ${id}.allow_no_changes`, { optional: true });
  const expectedOutputs = normalizeExpectedOutputs(input.expected_outputs, id, scope);
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
    kind,
    scope,
    expected_outputs: expectedOutputs,
    allow_no_changes: kind === "review" || input.allow_no_changes === true,
    permission_mode: permissionMode,
    allowed_tools: allowedTools,
    setup,
    depends_on: dependsOn,
    read_only: [],
    prompt_file: input.prompt_file || undefined,
    _promptFile: promptFile,
  };
}

/**
 * Claude prompts before every Bash command under `acceptEdits` and
 * `workspace-write`, and a detached worker has nobody to answer the prompt — so
 * a lane whose own prompt says "run npm test" was denied `npm` by default. The
 * workflow already declares which setup and test commands this work is verified
 * with; those commands are the honest default allowlist.
 *
 * The rule is derived, never guessed: one `Bash(<prefix>*)` per declared
 * verification command, where the prefix is the executable plus its leading
 * sub-command arguments (`npm test`, `npm run hygiene`). An explicit lane
 * `allowed_tools` always wins untouched, `dontAsk` still requires its own
 * complete allowlist, and non-Claude harnesses are not touched at all: Codex
 * governs execution through its sandbox mode, which has no per-command
 * allowlist to synthesize into.
 */
export function allowedToolRulesForVerification(commands = []) {
  const rules = [];
  for (const entry of commands) {
    const command = String(entry?.command || "").trim();
    if (!command) continue;
    const prefix = [command];
    for (const raw of entry.args || []) {
      // Stop at the first flag or anything needing quoting: the rule is a
      // command prefix, not a full command line.
      const arg = String(raw).trim();
      if (prefix.length >= 3 || !/^[A-Za-z0-9._:@/-]+$/.test(arg) || arg.startsWith("-")) break;
      prefix.push(arg);
    }
    rules.push(`Bash(${prefix.join(" ")}*)`);
  }
  return [...new Set(rules)];
}

export function synthesizeAllowedTools(lanes, verification) {
  const rules = allowedToolRulesForVerification([
    ...(verification?.setup?.commands || []),
    ...(verification?.commands || []),
  ]);
  for (const lane of lanes) {
    if (lane.harness !== "claude") continue;
    if (lane.allowed_tools.length) {
      lane.allowed_tools_source = "declared";
      continue;
    }
    if (!SYNTHESIZED_ALLOWED_TOOL_MODES.has(lane.permission_mode) || !rules.length) {
      lane.allowed_tools_source = "none";
      continue;
    }
    lane.allowed_tools = [...rules];
    lane.allowed_tools_source = "verification";
  }
  return lanes;
}

function normalizeAllowedTools(input, laneId, harness, permissionMode) {
  if (input === undefined) {
    if (harness === "claude" && permissionMode === "dontAsk") {
      throw new Error(`lane ${laneId}.allowed_tools is required for Claude dontAsk mode`);
    }
    return [];
  }
  if (harness !== "claude") {
    throw new Error(`lane ${laneId}.allowed_tools is only supported by the Claude harness`);
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`lane ${laneId}.allowed_tools must be a non-empty array`);
  }
  return [...new Set(input.map((value) => {
    if (!isNonEmptyString(value) || value.length > 240 || /[\r\n\0]/.test(value)) {
      throw new Error(`lane ${laneId}.allowed_tools contains an invalid tool rule`);
    }
    const rule = value.trim();
    if (/^(?:Bash|PowerShell)(?:\(\s*\*?\s*\))?$/i.test(rule)) {
      throw new Error(`lane ${laneId}.allowed_tools must not grant unrestricted shell execution: ${rule}`);
    }
    return rule;
  }))];
}

function normalizeExpectedOutputs(input, laneId, scope) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`lane ${laneId}.expected_outputs must be a non-empty array`);
  }
  const outputs = [...new Set(input.map((value) => normalizeScopePath(value)))];
  for (const output of outputs) {
    if (!output || isAbsolute(output) || output.split("/").includes("..") || /[?*[]/.test(output)) {
      throw new Error(`lane ${laneId}.expected_outputs must contain concrete repository file paths: ${output}`);
    }
    if (!scope.some((pattern) => matchesScope(output, pattern))) {
      throw new Error(
        `lane ${laneId} expected output ${output} is not covered by its scope (${scope.join(", ")})`,
      );
    }
  }
  return outputs;
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

/**
 * Reject a workflow whose policy says workers may commit or open pull requests while
 * its lanes run under a permission mode that denies the git and gh commands. Claude
 * prompts before shell commands under acceptEdits / workspace-write and a detached
 * worker cannot answer, so the policy would advertise an ability the harness refuses.
 * Fails at load instead of halfway through a detached run.
 */
export function assertShellPolicyCoherence(lanes, policy) {
  const claims = [
    policy.allow_commit === true ? "allow_commit" : null,
    policy.allow_pr === true ? "allow_pr" : null,
  ].filter(Boolean);
  if (!claims.length || policy.dangerously_skip_permissions === true) return lanes;
  const claimed = claims.map((name) => `workflow.policy.${name}=true`).join(" and ");
  const binaryFor = (name) => (name === "allow_commit" ? "git" : "gh");
  for (const lane of lanes) {
    if (lane.kind !== "implementation") continue;
    const mode = lane.permission_mode;
    if (READ_ONLY_PERMISSION_MODES.has(mode)) {
      throw new Error(
        `${claimed}, but implementation lane ${lane.id} runs read-only (permission_mode ${mode}); ` +
          `set ${claims.join("/")} to false or give the lane a writable permission mode`,
      );
    }
    if (lane.harness !== "claude") continue;
    if (!CLAUDE_UNATTENDED_SHELL_MODES.has(mode)) {
      throw new Error(
        `${claimed}, but Claude lane ${lane.id} uses permission_mode ${mode}, which prompts before ` +
          "git and gh commands and therefore denies them in a detached run; use permission_mode auto, " +
          `or dontAsk with allowed_tools that grant those commands, or set ${claims.join("/")} to false`,
      );
    }
    if (mode !== "dontAsk") continue;
    const missing = claims.filter((name) => !laneAllowsBinary(lane, binaryFor(name)));
    if (missing.length) {
      throw new Error(
        `${claimed}, but Claude lane ${lane.id} uses dontAsk without an allowed_tools rule for ` +
          `${missing.map(binaryFor).join(" and ")}; add the rule or set ` +
          `${missing.join("/")} to false`,
      );
    }
  }
  return lanes;
}

function laneAllowsBinary(lane, binary) {
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_-])${binary}(?![A-Za-z0-9_-])`);
  return (lane.allowed_tools || []).some((rule) => pattern.test(rule));
}

export function analyzeDependencyTopology(lanes, maxConcurrency = lanes.length) {
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  const memo = new Map();
  const depth = (lane) => {
    if (memo.has(lane.id)) return memo.get(lane.id);
    const dependencies = lane.depends_on || [];
    const value = dependencies.length
      ? 1 + Math.max(...dependencies.map((id) => depth(byId.get(id))))
      : 0;
    memo.set(lane.id, value);
    return value;
  };
  const levels = {};
  for (const lane of lanes) {
    const value = depth(lane);
    levels[value] = [...(levels[value] || []), lane.id];
  }
  const width = Math.max(0, ...Object.values(levels).map((ids) => ids.length));
  const effectiveParallelism = Math.min(maxConcurrency, width || 1);
  const fullySerialized = lanes.length > 1 && effectiveParallelism === 1;
  return {
    levels,
    criticalPathLanes: Object.keys(levels).length,
    theoreticalParallelism: width,
    effectiveParallelism,
    fullySerialized,
    recommendation: fullySerialized
      ? "This dependency graph is fully serialized; use one queued agent unless the scopes can be made independent."
      : null,
  };
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

// A lint that cannot read the tree still lets the workflow load: an advisory has no
// standing to fail a run that every hard validation already accepted.
function collectLintWarnings(lanes, repoRoot) {
  try {
    return lintCrossLaneImports(lanes, repoRoot);
  } catch {
    return [];
  }
}

// Source files worth reading for import edges. Everything else in a lane scope
// (fixtures, markdown, lockfiles) cannot express a code dependency this lint reads.
const LINT_SOURCE_EXTENSIONS = new Set([
  ".mjs", ".js", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx",
]);
const LINT_MAX_FILES_PER_LANE = 2_000;
const LINT_MAX_FILE_BYTES = 512 * 1_024;
// Best-effort specifier extraction. A parser would be exact, but this lint only
// raises advisories, so a missed edge costs nothing a reviewer was relying on.
const LINT_IMPORT_PATTERNS = [
  /(?:^|[\s;}])(?:import|export)\s+(?:[^'"();]*?\bfrom\s+)?["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']/g,
  /\brequire\s*\(\s*["']([^"'\n]+)["']/g,
];

/**
 * Advisory only: a lane whose files import from another writable lane's scope is
 * ordered by that seam whether or not the workflow says so. The chip-reopen lane
 * shipped green against a stale copy of its dependency and broke at the fold, which
 * a declared depends_on would have prevented. Never an error — the scan is a
 * best-effort read of the base tree and the operator owns the ordering call.
 */
export function lintCrossLaneImports(lanes, repoRoot) {
  const writable = lanes.filter((lane) =>
    lane.kind === "implementation" && !READ_ONLY_PERMISSION_MODES.has(lane.permission_mode));
  if (writable.length < 2) return [];
  const existsCache = new Map();
  const exists = (path) => {
    if (!existsCache.has(path)) existsCache.set(path, isRepoFile(repoRoot, path));
    return existsCache.get(path);
  };
  const warnings = [];
  for (const lane of writable) {
    const candidates = writable.filter((other) =>
      other.id !== lane.id && !laneDependsOn(lanes, lane.id, other.id));
    if (!candidates.length) continue;
    const crossings = new Map();
    for (const file of listScopedFiles(repoRoot, lane.scope, { limit: LINT_MAX_FILES_PER_LANE })) {
      if (!LINT_SOURCE_EXTENSIONS.has(extname(file).toLowerCase())) continue;
      const source = readLintSource(repoRoot, file);
      if (!source) continue;
      for (const { specifier, line } of extractImportSpecifiers(source)) {
        const target = resolveImportPath(file, specifier, exists);
        if (!target) continue;
        if (lane.scope.some((pattern) => matchesScope(target, pattern))) continue;
        const owner = candidates.find((other) =>
          other.scope.some((pattern) => matchesScope(target, pattern)));
        if (!owner) continue;
        const edges = crossings.get(owner.id) || [];
        if (!edges.some((edge) => edge.file === file && edge.target === target)) {
          edges.push({ file, line, specifier, target });
        }
        crossings.set(owner.id, edges);
      }
    }
    for (const [dependency, edges] of [...crossings].sort(([left], [right]) => left.localeCompare(right))) {
      const [first] = edges.sort((left, right) =>
        left.file.localeCompare(right.file) || left.line - right.line);
      const extra = edges.length - 1;
      warnings.push({
        type: "missing-depends-on",
        lane: lane.id,
        dependency,
        file: first.file,
        line: first.line,
        specifier: first.specifier,
        target: first.target,
        crossings: edges.length,
        message: `lane "${lane.id}" imports from lane "${dependency}" scope without depends_on: ` +
          `${first.file}:${first.line} imports "${first.specifier}" (${first.target})` +
          (extra ? ` and ${extra} more crossing import${extra > 1 ? "s" : ""}` : "") +
          `; add depends_on: [${dependency}] if ${lane.id} needs that work first`,
      });
    }
  }
  return warnings;
}

function isRepoFile(repoRoot, relativePath) {
  const abs = resolve(repoRoot, relativePath);
  if (!existsSync(abs)) return false;
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

function readLintSource(repoRoot, relativePath) {
  try {
    const abs = resolve(repoRoot, relativePath);
    if (statSync(abs).size > LINT_MAX_FILE_BYTES) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function extractImportSpecifiers(source) {
  const found = [];
  for (const pattern of LINT_IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match) {
      // The match opens on the boundary character before the keyword and a statement
      // can span lines, so the specifier's own offset is the line worth reporting.
      const offset = match.index + match[0].lastIndexOf(match[1]);
      found.push({ specifier: match[1], line: lineNumberAt(source, offset) });
      match = pattern.exec(source);
    }
  }
  return found;
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") line += 1;
  }
  return line;
}

function normalizeVerification(input, label = "workflow.verification", { allowSetup = false } = {}) {
  if (input === undefined) return { commands: [], timeout_sec: 900 };
  if (!isMapping(input)) throw new Error(`${label} must be a mapping`);
  assertKnownKeys(input, allowSetup ? VERIFICATION_KEYS : COMMAND_PLAN_KEYS, label);
  if (!Array.isArray(input.commands) || input.commands.length === 0) {
    throw new Error(`${label}.commands must be a non-empty array`);
  }
  const commands = input.commands.map((raw, index) => {
    if (!isMapping(raw)) {
      throw new Error(`${label}.commands[${index}] must be a mapping`);
    }
    assertKnownKeys(raw, VERIFICATION_COMMAND_KEYS, `${label}.commands[${index}]`);
    if (!isNonEmptyString(raw.command) || /[\\/\s\r\n\0]/.test(raw.command)) {
      throw new Error(`${label}.commands[${index}].command must be a bare executable name`);
    }
    if (raw.args !== undefined && !Array.isArray(raw.args)) {
      throw new Error(`${label}.commands[${index}].args must be an array`);
    }
    const args = (raw.args || []).map((arg) => {
      if (typeof arg !== "string" || /[\r\n\0]/.test(arg)) {
        throw new Error(`${label}.commands[${index}].args contains an invalid value`);
      }
      return arg;
    });
    return { command: raw.command, args };
  });
  const normalized = {
    commands,
    timeout_sec: boundedInteger(
      input.timeout_sec,
      900,
      1,
      86_400,
      `${label}.timeout_sec`,
    ),
  };
  if (allowSetup && input.setup !== undefined) {
    normalized.setup = normalizeVerification(input.setup, `${label}.setup`);
  }
  return normalized;
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
- Worker mode is active. Planning and source orientation are already complete; do not query the planning system or wait for another Go.
- Lane kind: ${lane.kind}
- Stay inside scope: ${lane.scope.join(", ")}
- Required output paths: ${lane.expected_outputs.length ? lane.expected_outputs.join(", ") : "(none declared)"}
- A successful process exit is not delivery. Implementation lanes must leave an in-scope change unless allow_no_changes was explicitly approved.
- Treat these paths as read-only: ${lane.read_only.length ? lane.read_only.join(", ") : "(none)"}
- Dependencies already integrated into this worktree: ${lane.depends_on.length ? lane.depends_on.join(", ") : "(none)"}
- Work only in this worktree / branch. Do not switch repos.
- Do NOT commit, push, merge, tag, or bump versions unless policy explicitly permits it.
- Target repo dev_flow: ${workflow.target_dev_flow}
- If blocked on a product or architecture decision, write needs-input.json in the supplied lane directory with { "type":"question", "prompt":"...", "blocking":true } and stop.
- Prefer finishing a thin slice over expanding scope.
`.trim();
  const sharedPlanning = planningPrompt(workflow.planning);
  const sharedAwareness = workflow.awareness?.context || "";
  const goalContext = workflow.goalContext?.context || "";
  const hostRuntime = runtimePrompt(workflow.runtime || detectRuntimeProfile());
  return `${sharedPlanning}\n\n${sharedAwareness}\n\n${goalContext}\n\n${hostRuntime}\n\n## Lane assignment\n${body.trim()}\n\n${policyBlock}\n`;
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
