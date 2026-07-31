import { getHarnessAdapter } from "./harness/index.mjs";
import { resolveClaudeBin } from "./harness/claude.mjs";
import { resolveCodexBin } from "./harness/codex.mjs";
import { assertPlanningReady } from "./planning.mjs";
import { spawnCommandSync } from "./command.mjs";

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
  for (const name of new Set(workflow.lanes.map((lane) => lane.harness))) {
    getHarnessAdapter(name);
    if (name === "fake") {
      checks.push({ ok: process.env.AGENT_MANAGER_TEST_MODE === "1", command: "fake", version: "test", error: "fake harness requires AGENT_MANAGER_TEST_MODE=1" });
    } else {
      checks.push(checkCommand(name === "claude" ? resolveClaudeBin() : resolveCodexBin()));
    }
  }
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    throw new Error("preflight failed: " + failed.map((check) => `${check.command}: ${check.error}`).join("; "));
  }
  return checks;
}
