import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { normalizeScopePath } from "../scope.mjs";
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

const POLICY_KEYS = new Set(["schema", "repository", "director", "autopilot"]);
const REPOSITORY_KEYS = new Set(["path", "base_ref"]);
const DIRECTOR_KEYS = new Set(["harness", "model", "reasoning"]);
const AUTOPILOT_KEYS = new Set([
  "enabled", "mode", "source_filter", "allowed_actions", "allowed_paths",
  "forbidden_risks", "max_items_per_cycle", "max_concurrency",
  "correction_limit", "on_blocker",
]);
const PR_ONLY_ACTIONS = new Set(["plan", "run", "review", "commit", "push", "open-pr"]);
const FORBIDDEN_ACTIONS = new Set(["merge", "tag", "release", "auto-merge", "dangerous-permissions"]);
const REASONING_LEVELS = new Set(["low", "medium", "high", "xhigh"]);

function resolveRepository(pathValue, policyPath, repoOverride) {
  const value = repoOverride || pathValue;
  const base = repoOverride ? process.cwd() : dirname(policyPath);
  const repoRoot = resolve(isAbsolute(value) ? value : resolve(base, value));
  if (!existsSync(repoRoot)) throw new Error(`Director policy repository not found: ${repoRoot}`);
  return repoRoot;
}

function policyPaths(value) {
  return stringArray(value, "Director policy.autopilot.allowed_paths", { minimum: 1 })
    .map((path, index) => {
      const normalized = normalizeScopePath(path);
      if (
        !normalized || normalized === "." || normalized.startsWith("/")
        || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")
      ) {
        throw new Error(`Director policy.autopilot.allowed_paths[${index}] must be a repository-relative path or glob`);
      }
      return normalized;
    });
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

  const normalizedDocument = stableValue({
    schema: document.schema,
    repository: { path: repositoryPath, base_ref: baseRef },
    director: identity,
    autopilot: {
      enabled: true,
      mode: "pr-only",
      source_filter: nonEmptyString(autopilot.source_filter, "Director policy.autopilot.source_filter"),
      allowed_actions: [...allowedActions].sort(),
      allowed_paths: policyPaths(autopilot.allowed_paths).sort(),
      forbidden_risks: stringArray(autopilot.forbidden_risks, "Director policy.autopilot.forbidden_risks").sort(),
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
