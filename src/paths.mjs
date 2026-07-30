import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace root used to resolve `workflow.repo` as a sibling folder. */
export const DEV_ROOT = process.env.AGENT_MANAGER_DEV_ROOT || cwd();

/** Run telemetry root (`status.json`, lane logs, heartbeats). */
export const RUNS_ROOT =
  process.env.AGENT_MANAGER_RUNS_ROOT || join(homedir(), ".agent-manager", "runs");

/** Claims CLI — bundled by default; override for a shared fleet registry. */
export const CLAIM_BIN =
  process.env.AGENT_MANAGER_CLAIM_BIN || join(PACKAGE_ROOT, "tools", "claim.mjs");

export function runDir(runId) {
  return join(RUNS_ROOT, runId);
}

export function repoPath(repoName) {
  return join(DEV_ROOT, repoName);
}
