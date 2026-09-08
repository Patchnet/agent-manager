import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PACKAGE_JSON_PATH = join(packageRoot, "package.json");

export function readInstalledVersion(path = PACKAGE_JSON_PATH) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")).version;
    return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

export const AGENT_MANAGER_VERSION = readInstalledVersion() || "unknown";

export function sourceIdentity(root = packageRoot) {
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (resolve(git("rev-parse", "--show-toplevel")) !== resolve(root)) return { commit: null, dirty: null };
    return { commit: git("rev-parse", "HEAD"), dirty: Boolean(git("status", "--porcelain", "--untracked-files=no")) };
  } catch { return { commit: null, dirty: null }; }
}

// Capture at process startup so long-lived supervisors cannot relabel themselves.
export const ENGINE_IDENTITY = { version: AGENT_MANAGER_VERSION, ...sourceIdentity() };

export function currentVersionInfo({
  runtimeVersion = AGENT_MANAGER_VERSION,
  installedVersion = readInstalledVersion(),
} = {}) {
  const installed = installedVersion || runtimeVersion;
  const restartRequired = runtimeVersion !== "unknown"
    && installed !== "unknown"
    && runtimeVersion !== installed;
  return {
    runtimeVersion,
    installedVersion: installed,
    restartRequired,
    notice: restartRequired
      ? `Agent Manager files are v${installed}; quit and restart this viewer to replace runtime v${runtimeVersion}.`
      : null,
  };
}
