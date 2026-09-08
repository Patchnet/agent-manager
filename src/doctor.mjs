import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RUNS_ROOT } from "./paths.mjs";
import { hostNames, hostSkillsRoot, readInstallMarker, contentDigest, bundledSkillDigest, INSTALLED_SKILLS } from "./install.mjs";
import { checkCommand } from "./preflight.mjs";
import { resolveClaudeBin } from "./harness/claude.mjs";
import { inspectCodexModelsCache, resolveCodexInstallation } from "./harness/codex.mjs";
import { resolveCursorBin } from "./harness/cursor.mjs";
import { harnessFailureRecommendation, harnessSetup } from "./harness/setup.mjs";
import { detectRuntimeProfile, formatRuntime } from "./runtime.mjs";
import { AGENT_MANAGER_VERSION, ENGINE_IDENTITY, sourceIdentity } from "./version.mjs";

export function runDoctor({ repo = process.cwd(), home } = {}) {
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
    asModelsCacheCheck(inspectCodexModelsCache()),
    asHarnessCheck("cursor", checkCommand(resolveCursorBin()), runtime),
    { name: "repository", ok: existsSync(root), detail: root },
    writableCheck("runs root", RUNS_ROOT),
    hostSkillCheck({ home }),
  ];
  const coreReady = checks.filter((check) => !check.optional).every((check) => check.ok);
  const harnessReady = checks.filter((check) => check.harness).some((check) => check.ok);
  const hostSkill = checks.find((check) => check.name === "host skill");
  const sourceCheckoutVersion = sourceVersion(root);
  return {
    schema: "agent-manager.doctor.v2",
    version: AGENT_MANAGER_VERSION,
    versions: {
      sourceCheckoutVersion,
      runtimeVersion: AGENT_MANAGER_VERSION,
      runtimeIdentity: ENGINE_IDENTITY,
      sourceIdentity: sourceIdentity(root),
      installedHostSkills: hostSkill.installed,
      drift: Boolean(
        (sourceCheckoutVersion && sourceCheckoutVersion !== AGENT_MANAGER_VERSION) ||
        hostSkill.installed.some((item) => item.version !== AGENT_MANAGER_VERSION || item.modified)
      ),
    },
    activation: hostSkill.activation,
    aligned: !hostSkill.activation.required && (!sourceCheckoutVersion || sourceCheckoutVersion === AGENT_MANAGER_VERSION),
    ok: coreReady && harnessReady,
    runtime,
    checks,
  };
}

function hostSkillCheck({ home } = {}) {
  const found = hostNames().flatMap((host) => {
    const path = join(hostSkillsRoot(host, home ? { home } : {}), "agent-manager");
    if (!existsSync(path)) return [];
    const skills = INSTALLED_SKILLS.map((skill) => {
      const target = join(hostSkillsRoot(host, home ? { home } : {}), skill);
      const marker = readInstallMarker(target);
      const digest = existsSync(target) ? contentDigest(target) : null;
      return { skill, version: marker?.version || "unknown", modified: marker?.contentDigest !== digest,
        current: digest === bundledSkillDigest(skill) && marker?.version === AGENT_MANAGER_VERSION };
    });
    return [{ host, path, version: readInstallMarker(path)?.version || "unknown", modified: skills.some((s) => !s.current), skills }];
  });
  const drifted = found.filter((item) => item.version !== AGENT_MANAGER_VERSION || item.modified);
  const activationHost = drifted[0]?.host || found[0]?.host || null;
  const activationCommand = activationHost
    ? `agent-manager install ${activationHost}`
    : "agent-manager install claude (or codex or cursor)";
  return {
    name: "host skill",
    ok: found.length > 0,
    optional: true,
    detail: found.length
      ? `installed for: ${found.map((item) => `${item.host}@${item.version}`).join(", ")}`
      : "not installed for any supported host",
    installed: found,
    activation: {
      required: !found.length || drifted.length > 0,
      command: activationCommand,
      commands: drifted.map((item) => `agent-manager install ${item.host}`),
      safe: true,
      idempotent: true,
      note: "Managed files update only when their recorded digest is unchanged; operator-modified files fail closed.",
    },
    recommendation: !found.length
      ? `install one explicitly: ${activationCommand}`
      : drifted.length
        ? `activate the invoked runtime skill: ${activationCommand}`
        : null,
  };
}

function sourceVersion(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return pkg.name === "agent-manager" && typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
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

// A broken models cache degrades codex (it re-fetches every run and logs
// "failed to load models cache") without stopping it, so this warns.
function asModelsCacheCheck(inspection) {
  return {
    name: inspection.name,
    ok: inspection.ok,
    optional: true,
    detail: inspection.detail,
    state: inspection.state,
    recommendation: inspection.recommendation,
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
    `versions: source=${result.versions?.sourceCheckoutVersion || "n/a"} runtime=${result.versions?.runtimeVersion || result.version || "unknown"} host-skills=${result.versions?.installedHostSkills?.map((item) => `${item.host}@${item.version}`).join(",") || "none"}`,
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
  lines.push(`alignment: ${result.aligned ? "aligned" : "action required"} (separate from executable readiness)`);
  if (result.activation?.required) for (const command of result.activation.commands?.length ? result.activation.commands : [result.activation.command]) lines.push(`ACTIVATE  ${command}`);
  return lines.join("\n");
}
