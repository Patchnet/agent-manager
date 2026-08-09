import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentManagerConfig } from "./config.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATH_CONFIG = resolveAgentManagerConfig();

/** Resolved configuration file backing these roots. */
export const CONFIG_PATH = PATH_CONFIG.configPath;

/**
 * Temp sandbox this process was redirected into, or `null` outside tests.
 * Set by `resolveAgentManagerConfig`; see `src/config.mjs`.
 */
export const TEST_SANDBOX_ROOT = PATH_CONFIG.testSandbox;

/** Path-lock metadata and any env/CLI overrides ignored in favor of user-config. */
export const PATH_LOCK = PATH_CONFIG.pathLock || { active: false, unlocked: true };
export const IGNORED_PATH_OVERRIDES = PATH_CONFIG.ignoredOverrides || [];

/** Workspace root used to resolve `workflow.repo` as a sibling folder. */
export const DEV_ROOT = PATH_CONFIG.values.AGENT_MANAGER_DEV_ROOT;
export const DEV_ROOT_SOURCE = PATH_CONFIG.sources.AGENT_MANAGER_DEV_ROOT;

/** Run telemetry root (`status.json`, lane logs, heartbeats). */
export const RUNS_ROOT = PATH_CONFIG.values.AGENT_MANAGER_RUNS_ROOT;
export const RUNS_ROOT_SOURCE = PATH_CONFIG.sources.AGENT_MANAGER_RUNS_ROOT;

/** Advisory claim registry root. */
export const CLAIMS_ROOT = PATH_CONFIG.values.AGENT_MANAGER_CLAIMS_ROOT;
export const CLAIMS_ROOT_SOURCE = PATH_CONFIG.sources.AGENT_MANAGER_CLAIMS_ROOT;

/** MAADB-backed semantic awareness root. */
export const BRAIN_ROOT = PATH_CONFIG.values.AGENT_MANAGER_BRAIN_ROOT;
export const BRAIN_ROOT_SOURCE = PATH_CONFIG.sources.AGENT_MANAGER_BRAIN_ROOT;

/** Claims CLI — bundled by default; override for a shared fleet registry. */
export const CLAIM_BIN =
  PATH_CONFIG.values.AGENT_MANAGER_CLAIM_BIN || join(PACKAGE_ROOT, "tools", "claim.mjs");

export function runDir(runId) {
  return containedPath(RUNS_ROOT, assertSafeSlug(runId, "run id"), "run directory");
}

export function repoPath(repoName) {
  if (typeof repoName !== "string" || !repoName.trim()) {
    throw new Error("repo must be a non-empty path");
  }
  const value = repoName.trim();
  if (value === ".") return resolve(DEV_ROOT);
  if (isAbsolute(value)) return resolve(value);
  return containedPath(DEV_ROOT, value, "repository");
}

export function assertSafeSlug(value, label = "value") {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) {
    throw new Error(`${label} must be a safe slug (1-80 letters, digits, dot, underscore, or dash)`);
  }
  if (value === "." || value === ".." || value.includes("..") || value.endsWith(".") || value.toLowerCase().endsWith(".lock")) {
    throw new Error(`${label} is not safe for paths and Git refs: ${value}`);
  }
  return value;
}

export function containedPath(root, child, label = "path") {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, child);
  const rel = relative(resolvedRoot, target);
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} escapes its configured root: ${target}`);
  }
  return target;
}

export function assertPathInside(root, target, label = "path", { allowRoot = false } = {}) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if ((!allowRoot && (!rel || rel === ".")) || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} escapes its configured root: ${resolvedTarget}`);
  }
  return resolvedTarget;
}
