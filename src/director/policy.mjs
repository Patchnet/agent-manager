import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { matchesScope, normalizeScopePath, scopePrefix } from "../scope.mjs";
import {
  assertKnownKeys,
  assertMapping,
  boundedInteger,
  nonEmptyString,
  readDocument,
  sha256,
  stableValue,
  stringArray,
} from "./util.mjs";

const POLICY_KEYS = new Set(["schema", "repository", "director", "autopilot", "workers"]);
const REPOSITORY_KEYS = new Set(["path", "base_ref"]);
const DIRECTOR_KEYS = new Set(["harness", "model", "reasoning"]);
const WORKERS_KEYS = new Set(["harness_default", "model_default"]);
const AUTOPILOT_KEYS = new Set([
  "enabled", "mode", "source_filter", "allowed_actions", "allowed_paths",
  "forbidden_risks", "risk_exceptions", "max_items_per_cycle", "max_concurrency",
  "correction_limit", "on_blocker",
]);
const RISK_EXCEPTION_KEYS = new Set(["risk", "require_labels", "allowed_paths"]);
const PR_ONLY_ACTIONS = new Set(["plan", "run", "review", "commit", "push", "open-pr"]);
const FORBIDDEN_ACTIONS = new Set(["merge", "tag", "release", "auto-merge", "dangerous-permissions"]);
const REASONING_LEVELS = new Set(["low", "medium", "high", "xhigh"]);
const WORKER_HARNESSES = new Set(["claude", "codex", "cursor", "fake"]);

function resolveRepository(pathValue, policyPath, repoOverride) {
  const value = repoOverride || pathValue;
  const base = repoOverride ? process.cwd() : dirname(policyPath);
  const repoRoot = resolve(isAbsolute(value) ? value : resolve(base, value));
  if (!existsSync(repoRoot)) throw new Error(`Director policy repository not found: ${repoRoot}`);
  return repoRoot;
}

function policyPaths(value, label) {
  return stringArray(value, label, { minimum: 1 })
    .map((path, index) => {
      const normalized = normalizeScopePath(path);
      if (
        !normalized || normalized === "." || normalized.startsWith("/")
        || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")
      ) {
        throw new Error(`${label}[${index}] must be a repository-relative path or glob`);
      }
      return normalized;
    });
}

function pathCoveredByAllowlist(path, allowedPaths) {
  const normalized = normalizeScopePath(path);
  if (/[?*[]/.test(normalized)) {
    if (allowedPaths.includes(normalized)) return true;
    const requestedPrefix = scopePrefix(normalized);
    return allowedPaths.some((allowed) => {
      const normalizedAllowed = normalizeScopePath(allowed);
      if (!normalizedAllowed.endsWith("/**")) return false;
      const allowedPrefix = scopePrefix(normalizedAllowed);
      return requestedPrefix === allowedPrefix || requestedPrefix.startsWith(`${allowedPrefix}/`);
    });
  }
  return allowedPaths.some((allowed) => matchesScope(normalized, allowed));
}

function normalizeRiskExceptions(value, policyAllowedPaths) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Director policy.autopilot.risk_exceptions must be an array");
  }
  const exceptions = value.map((entry, index) => {
    const label = `Director policy.autopilot.risk_exceptions[${index}]`;
    assertMapping(entry, label);
    assertKnownKeys(entry, RISK_EXCEPTION_KEYS, label);
    const allowedPaths = policyPaths(entry.allowed_paths, `${label}.allowed_paths`).sort();
    for (const path of allowedPaths) {
      if (!pathCoveredByAllowlist(path, policyAllowedPaths)) {
        throw new Error(
          `${label}.allowed_paths must be covered by autopilot.allowed_paths (outside policy: ${path})`,
        );
      }
    }
    return {
      risk: nonEmptyString(entry.risk, `${label}.risk`),
      require_labels: stringArray(entry.require_labels, `${label}.require_labels`, { minimum: 1 }).sort(),
      allowed_paths: allowedPaths,
    };
  });
  return exceptions.sort((left, right) =>
    left.risk.localeCompare(right.risk)
    || left.require_labels.join(",").localeCompare(right.require_labels.join(",")));
}

function normalizeWorkers(value) {
  if (value === undefined) return { harness_default: "claude" };
  const workers = assertMapping(value, "Director policy.workers");
  assertKnownKeys(workers, WORKERS_KEYS, "Director policy.workers");
  const harnessDefault = workers.harness_default === undefined
    ? "claude"
    : nonEmptyString(workers.harness_default, "Director policy.workers.harness_default");
  if (!WORKER_HARNESSES.has(harnessDefault)) {
    throw new Error(
      `Director policy.workers.harness_default must be one of: ${[...WORKER_HARNESSES].join(", ")}`,
    );
  }
  const modelDefault = workers.model_default === undefined
    ? undefined
    : nonEmptyString(workers.model_default, "Director policy.workers.model_default");
  return modelDefault === undefined
    ? { harness_default: harnessDefault }
    : { harness_default: harnessDefault, model_default: modelDefault };
}

export function normalizeDirectorPolicy(document, { policyPath, repoOverride = null } = {}) {
  assertMapping(document, "Director policy");
  assertKnownKeys(document, POLICY_KEYS, "Director policy");
  if (document.schema !== "agent-manager.director-policy.v1") {
    throw new Error("Director policy schema must be agent-manager.director-policy.v1");
  }

  const repository = assertMapping(document.repository, "Director policy.repository");
  assertKnownKeys(repository, REPOSITORY_KEYS, "Director policy.repository");
  const repositoryPath = nonEmptyString(repository.path, "Director policy.repository.path");
  const baseRef = repository.base_ref === undefined
    ? "HEAD"
    : nonEmptyString(repository.base_ref, "Director policy.repository.base_ref");

  const director = assertMapping(document.director, "Director policy.director");
  assertKnownKeys(director, DIRECTOR_KEYS, "Director policy.director");
  const identity = {
    harness: nonEmptyString(director.harness, "Director policy.director.harness"),
    model: nonEmptyString(director.model, "Director policy.director.model"),
    reasoning: nonEmptyString(director.reasoning, "Director policy.director.reasoning"),
  };
  if (!REASONING_LEVELS.has(identity.reasoning)) {
    throw new Error("Director policy.director.reasoning must be low, medium, high, or xhigh");
  }

  const autopilot = assertMapping(document.autopilot, "Director policy.autopilot");
  assertKnownKeys(autopilot, AUTOPILOT_KEYS, "Director policy.autopilot");
  if (autopilot.enabled !== true) throw new Error("Director policy.autopilot.enabled must be true");
  if (autopilot.mode !== "pr-only") {
    throw new Error("Director Phase 1 supports only Director policy.autopilot.mode=pr-only");
  }
  const allowedActions = stringArray(autopilot.allowed_actions, "Director policy.autopilot.allowed_actions");
  const unsafe = allowedActions.filter((action) => FORBIDDEN_ACTIONS.has(action) || !PR_ONLY_ACTIONS.has(action));
  if (unsafe.length) {
    throw new Error(`Director pr-only policy forbids action${unsafe.length === 1 ? "" : "s"}: ${unsafe.join(", ")}`);
  }
  for (const required of ["plan", "run", "review"]) {
    if (!allowedActions.includes(required)) {
      throw new Error(`Director pr-only policy must allow ${required}`);
    }
  }
  if (autopilot.on_blocker !== "quarantine-and-continue") {
    throw new Error("Director Phase 1 requires autopilot.on_blocker=quarantine-and-continue");
  }

  const allowedPaths = policyPaths(autopilot.allowed_paths, "Director policy.autopilot.allowed_paths").sort();
  const riskExceptions = normalizeRiskExceptions(autopilot.risk_exceptions, allowedPaths);
  const workers = normalizeWorkers(document.workers);

  const normalizedDocument = stableValue({
    schema: document.schema,
    repository: { path: repositoryPath, base_ref: baseRef },
    director: identity,
    workers,
    autopilot: {
      enabled: true,
      mode: "pr-only",
      source_filter: nonEmptyString(autopilot.source_filter, "Director policy.autopilot.source_filter"),
      allowed_actions: [...allowedActions].sort(),
      allowed_paths: allowedPaths,
      forbidden_risks: stringArray(autopilot.forbidden_risks, "Director policy.autopilot.forbidden_risks").sort(),
      risk_exceptions: riskExceptions,
      max_items_per_cycle: boundedInteger(autopilot.max_items_per_cycle, 1, 20, "Director policy.autopilot.max_items_per_cycle"),
      max_concurrency: boundedInteger(autopilot.max_concurrency, 1, 5, "Director policy.autopilot.max_concurrency"),
      correction_limit: boundedInteger(autopilot.correction_limit, 0, 1, "Director policy.autopilot.correction_limit"),
      on_blocker: autopilot.on_blocker,
    },
  });

  return {
    ...normalizedDocument,
    absPath: policyPath,
    repoRoot: resolveRepository(repositoryPath, policyPath, repoOverride),
    digest: sha256(normalizedDocument),
  };
}

export function loadDirectorPolicy(filePath, options = {}) {
  if (!filePath) throw new Error("Director policy is required; pass --policy <file>");
  const { path, value } = readDocument(filePath, "Director policy");
  return normalizeDirectorPolicy(value, { ...options, policyPath: path });
}

export { pathCoveredByAllowlist };
