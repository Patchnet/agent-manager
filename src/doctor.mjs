import { accessSync, constants, existsSync } from "node:fs";
import { resolve } from "node:path";
import { RUNS_ROOT } from "./paths.mjs";
import { checkCommand } from "./preflight.mjs";
import { resolveClaudeBin } from "./harness/claude.mjs";
import { resolveCodexBin } from "./harness/codex.mjs";

export function runDoctor({ repo = process.cwd() } = {}) {
  const root = resolve(repo);
  const checks = [
    { name: "node", ok: Number(process.versions.node.split(".")[0]) >= 24, detail: process.version },
    asCheck("git", checkCommand("git")),
    { ...asCheck("claude", checkCommand(resolveClaudeBin())), optional: true },
    { ...asCheck("codex", checkCommand(resolveCodexBin())), optional: true },
    { name: "repository", ok: existsSync(root), detail: root },
    writableCheck("runs root", RUNS_ROOT),
  ];
  const coreReady = checks.filter((check) => !check.optional).every((check) => check.ok);
  const harnessReady = checks.filter((check) => check.optional).some((check) => check.ok);
  return { schema: "agent-manager.doctor.v1", ok: coreReady && harnessReady, checks };
}

function asCheck(name, result) {
  return { name, ok: result.ok, detail: result.version || result.error || result.command };
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
  const lines = [`agent-manager doctor: ${result.ok ? "ready" : "action required"}`];
  for (const check of result.checks) {
    const label = check.ok ? "PASS" : check.optional ? "WARN" : "FAIL";
    lines.push(`${label}  ${check.name}: ${check.detail}`);
  }
  return lines.join("\n");
}
