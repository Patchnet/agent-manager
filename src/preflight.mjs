import { getHarnessAdapter } from "./harness/index.mjs";
import { resolveClaudeBin } from "./harness/claude.mjs";
import { resolveCodexInstallation } from "./harness/codex.mjs";
import { resolveCursorBin } from "./harness/cursor.mjs";
import { assertPlanningReady } from "./planning.mjs";
import { spawnCommandSync } from "./command.mjs";
import { harnessFailureRecommendation } from "./harness/setup.mjs";

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

export function preflightWorkflow(workflow) {
  assertPlanningReady(workflow);
  const checks = [checkCommand("git"), ...validateRepository(workflow)];
  const harnessCommands = new Map();
  for (const name of new Set(workflow.lanes.map((lane) => lane.harness))) {
    getHarnessAdapter(name);
    if (name === "fake") {
      checks.push({ ok: process.env.AGENT_MANAGER_TEST_MODE === "1", command: "fake", version: "test", error: "fake harness requires AGENT_MANAGER_TEST_MODE=1" });
    } else {
      const installation = name === "codex" ? resolveCodexInstallation() : null;
      const command = name === "claude"
        ? resolveClaudeBin()
        : name === "cursor"
          ? resolveCursorBin()
          : installation.command;
      harnessCommands.set(command, name);
      checks.push(checkCommand(command));
      if (name === "claude") {
        checks.push(checkClaudePermissionModes(
          command,
          workflow.lanes
            .filter((lane) => lane.harness === "claude")
            .map((lane) => lane.permission_mode),
        ));
      }
      if (installation?.sandboxReady === false) {
        checks.push({
          ok: false,
          command,
          version: null,
          error:
            "Windows Codex installation is missing codex-windows-sandbox-setup.exe; " +
            "install a complete Codex package or set CODEX_BIN to an explicit supported installation",
        });
      }
    }
  }
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    throw new Error("preflight failed: " + failed.map((check) => {
      const harness = harnessCommands.get(check.command);
      const fix = harness ? ` ${harnessFailureRecommendation(harness)}` : "";
      return `${check.command}: ${check.error}.${fix}`;
    }).join("; "));
  }
  return checks;
}
