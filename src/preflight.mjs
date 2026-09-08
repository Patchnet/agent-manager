import { getHarnessAdapter } from "./harness/index.mjs";
import { resolveClaudeBin } from "./harness/claude.mjs";
import { resolveCodexInstallation } from "./harness/codex.mjs";
import { resolveCursorBin } from "./harness/cursor.mjs";
import { assertPlanningReady } from "./planning.mjs";
import { spawnCommandSync } from "./command.mjs";
import { harnessFailureRecommendation } from "./harness/setup.mjs";
import { detectRuntimeProfile, formatRuntime } from "./runtime.mjs";
import { preflightClaims } from "./claim.mjs";

export class HarnessPreflightError extends Error {
  constructor(failures, runtime) {
    const details = failures.map((failure) =>
      `${failure.harness} (${failure.command}) in ${formatRuntime(runtime)}: ${failure.error}. ` +
        failure.remediation,
    );
    super(`selected harness preflight failed: ${details.join("; ")}`);
    this.name = "HarnessPreflightError";
    this.code = "selected-harness-unavailable";
    this.runtime = publicRuntime(runtime);
    this.failures = failures;
  }

  toJSON() {
    return {
      schema: "agent-manager.error.v1",
      ok: false,
      code: this.code,
      message: this.message,
      runtime: this.runtime,
      failures: this.failures,
    };
  }
}

function publicRuntime(runtime) {
  return {
    hostPlatform: runtime.hostPlatform,
    os: runtime.os,
    arch: runtime.arch,
    shell: runtime.shell,
    commandMode: runtime.commandMode,
    pathStyle: runtime.pathStyle,
  };
}

export function checkCommand(command, args = ["--version"], options = {}) {
  const { result, resolved } = spawnCommandSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    ...options,
  });
  return {
    ok: result.status === 0,
    command,
    invocation: [resolved.command, ...resolved.args],
    version: result.status === 0 ? String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] : null,
    error: result.status === 0 ? null : String(result.error?.message || result.stderr || "command unavailable").trim(),
  };
}

export function checkClaudePermissionModes(command, modes, options = {}) {
  const requested = [...new Set(modes.filter((mode) => ["auto", "dontAsk"].includes(mode)))];
  if (!requested.length) {
    return { ok: true, command, invocation: [], version: null, error: null };
  }
  const { result, resolved } = spawnCommandSync(command, ["--help"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    ...options,
  });
  const output = String(result.stdout || "") + "\n" + String(result.stderr || "");
  const missing = requested.filter((mode) => !new RegExp(`(?:\\"|\\b)${mode}(?:\\"|\\b)`).test(output));
  return {
    ok: result.status === 0 && missing.length === 0,
    command,
    invocation: [resolved.command, ...resolved.args],
    version: result.status === 0 ? `permission modes: ${requested.join(", ")}` : null,
    error: result.status !== 0
      ? String(result.error?.message || result.stderr || "Claude help unavailable").trim()
      : missing.length
        ? `installed Claude CLI does not support permission mode(s): ${missing.join(", ")}`
        : null,
  };
}

export function validateRepository(workflow) {
  const repo = checkCommand("git", ["-C", workflow.repoRoot, "rev-parse", "--is-inside-work-tree"]);
  const base = checkCommand("git", ["-C", workflow.repoRoot, "rev-parse", "--verify", workflow.base_ref + "^{commit}"]);
  const checks = [
    { ...repo, command: "git repository" },
    { ...base, command: `git base ${workflow.base_ref}` },
  ];
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    throw new Error("repository validation failed: " + failed.map((check) => `${check.command}: ${check.error}`).join("; "));
  }
  return checks;
}

export function diagnoseHarnessFailure(harness, message) {
  if (harness !== "codex" || !/failed to initialize.*app-server/i.test(message || "") || !/access is denied|permission denied|os error 5/i.test(message)) return null;
  return { code: "harness-startup-permission", retryUnchanged: false,
    nextAction: "Verify Codex startup in the same launching environment and inspect its sandbox permissions. Do not create another run until the environment changes; do not disable sandbox protections automatically." };
}

export function checkHarnessOptions(command, harness, options, spawnOptions = {}) {
  const flags = new Set(options.flatMap((option) => [
    ...(option?.effort ? [harness === "claude" ? "--effort" : "--config"] : []),
    ...(option?.profile ? ["--profile"] : []),
  ]));
  if (!flags.size) return null;
  const args = harness === "codex" ? ["exec", "--help"] : ["--help"];
  const { result, resolved } = spawnCommandSync(command, args, {
    encoding: "utf8", windowsHide: true, timeout: 10_000, ...spawnOptions,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const missing = [...flags].filter((flag) => !new RegExp(`${flag}(?:[\\s=,]|$)`).test(output));
  return {
    ok: result.status === 0 && missing.length === 0, command,
    invocation: [resolved.command, ...resolved.args],
    version: null,
    error: result.status !== 0 ? "cannot inspect installed harness options"
      : missing.length ? `installed harness does not advertise ${missing.join(", ")}` : null,
  };
}

export function preflightWorkflow(workflow) {
  assertPlanningReady(workflow);
  const claims = preflightClaims(workflow);
  if (workflow.claim_mode === "required" && claims.some((item) => item.blocked)) {
    throw new Error(`claim preflight blocked before detach: ${JSON.stringify(claims.filter((item) => item.blocked))}`);
  }
  return [
    checkCommand("git"),
    ...validateRepository(workflow),
    ...preflightSelectedHarnesses(workflow),
    ...claims.map((detail) => ({ command: `claim scope ${detail.lane}`, ok: !detail.blocked, ...detail })),
  ];
}

export function preflightSelectedHarnesses(workflow) {
  const runtime = detectRuntimeProfile();
  const checks = [];
  const harnessCommands = new Map();
  for (const name of new Set(workflow.lanes.map((lane) => lane.harness))) {
    getHarnessAdapter(name);
    if (name !== "fake") {
      const installation = name === "codex" ? resolveCodexInstallation() : null;
      const command = name === "claude"
        ? resolveClaudeBin()
        : name === "cursor"
          ? resolveCursorBin()
          : installation.command;
      harnessCommands.set(command, name);
      const versionCheck = { ...checkCommand(command), harness: name };
      checks.push(versionCheck);
      if (versionCheck.ok) {
        const optionCheck = checkHarnessOptions(command, name, workflow.lanes
          .filter((lane) => lane.harness === name).map((lane) => lane.harness_options));
        if (optionCheck) checks.push({ ...optionCheck, harness: name });
      }
      if (name === "claude" && versionCheck.ok) {
        checks.push({
          ...checkClaudePermissionModes(
            command,
            workflow.lanes
              .filter((lane) => lane.harness === "claude")
              .map((lane) => lane.permission_mode),
          ),
          harness: name,
        });
      }
      if (installation?.sandboxReady === false) {
        checks.push({
          ok: false,
          command,
          version: null,
          error:
            "Windows Codex installation is missing codex-windows-sandbox-setup.exe; " +
            "install a complete Codex package or set CODEX_BIN to an explicit supported installation",
          harness: name,
        });
      }
    }
  }
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    throw new HarnessPreflightError(failed.map((check) => {
      const harness = check.harness || harnessCommands.get(check.command);
      return {
        harness,
        command: check.command,
        invocation: check.invocation || [],
        error: check.error,
        remediation: harnessFailureRecommendation(harness, { platform: runtime.hostPlatform }),
      };
    }), runtime);
  }
  return checks;
}
