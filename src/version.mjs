import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
