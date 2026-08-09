import { accessSync, constants, existsSync } from "node:fs";
import { resolve } from "node:path";
import { RUNS_ROOT } from "./paths.mjs";
import { checkCommand } from "./preflight.mjs";
import { resolveClaudeBin } from "./harness/claude.mjs";
import { resolveCodexInstallation } from "./harness/codex.mjs";
import { resolveCursorBin } from "./harness/cursor.mjs";
import { harnessFailureRecommendation, harnessSetup } from "./harness/setup.mjs";
import { detectRuntimeProfile, formatRuntime } from "./runtime.mjs";
import { AGENT_MANAGER_VERSION } from "./version.mjs";

export function runDoctor({ repo = process.cwd() } = {}) {
  const root = resolve(repo);
  const runtime = detectRuntimeProfile();
  const codexInstallation = resolveCodexInstallation();
  const codexCommand = checkCommand(codexInstallation.command);
  if (codexInstallation.sandboxReady === false) {
    codexCommand.ok = false;
    codexCommand.error =
      "Windows Codex installation is missing codex-windows-sandbox-setup.exe";
    codexCommand.version = null;
  }
  const checks = [
    { name: "node", ok: Number(process.versions.node.split(".")[0]) >= 24, detail: process.version },
    asCheck("git", checkCommand("git")),
    { ...asCheck("npm (version checks)", checkCommand("npm")), optional: true, shipping: true },
    { ...asCheck("gh (shipping)", checkCommand("gh")), optional: true },
    asHarnessCheck("claude", checkCommand(resolveClaudeBin()), runtime),
    {
      ...asHarnessCheck("codex", codexCommand, runtime),
      installation: {
        source: codexInstallation.source,
        sandboxHelper: codexInstallation.sandboxHelper,
        sandboxReady: codexInstallation.sandboxReady,
      },
    },
    asHarnessCheck("cursor", checkCommand(resolveCursorBin()), runtime),
    { name: "repository", ok: existsSync(root), detail: root },
    writableCheck("runs root", RUNS_ROOT),
  ];
  const coreReady = checks.filter((check) => !check.optional).every((check) => check.ok);
  const harnessReady = checks.filter((check) => check.harness).some((check) => check.ok);
  return { schema: "agent-manager.doctor.v1", version: AGENT_MANAGER_VERSION, ok: coreReady && harnessReady, runtime, checks };
}

function asHarnessCheck(name, result, runtime) {
  const setup = harnessSetup(name, { platform: runtime.hostPlatform });
  return {
    ...asCheck(name, result),
    optional: true,
    harness: true,
    setup,
    recommendation: result.ok
      ? null
      : harnessFailureRecommendation(name, { platform: runtime.hostPlatform }),
  };
}

function asCheck(name, result) {
  return {
    name,
    ok: result.ok,
    command: result.command,
    invocation: result.invocation,
    detail: result.version || result.error || result.command,
  };
}

function writableCheck(name, path) {
  try {
    if (existsSync(path)) accessSync(path, constants.W_OK);
    return { name, ok: true, detail: path };
  } catch (error) {
    return { name, ok: false, detail: `${path}: ${error.message}` };
  }
}

export function formatDoctor(result) {
  const lines = [
    `agent-manager doctor v${result.version || "unknown"}: ${result.ok ? "ready" : "action required"}`,
    `runtime: ${formatRuntime(result.runtime)}`,
  ];
  for (const check of result.checks) {
    const label = check.ok ? "PASS" : check.optional ? "WARN" : "FAIL";
    const via = check.invocation?.[0] && check.invocation[0] !== check.command
      ? ` (via ${check.invocation.join(" ")})`
      : "";
    lines.push(`${label}  ${check.name}: ${check.detail}${via}`);
    if (check.recommendation) lines.push(`      fix: ${check.recommendation}`);
  }
  return lines.join("\n");
}
