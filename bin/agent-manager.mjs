#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cancelRun } from "../src/cancel.mjs";
import { cleanupRun, cleanupStaleRuns } from "../src/cleanup.mjs";
import { formatDoctor, runDoctor } from "../src/doctor.mjs";
import { ensurePrivateDir } from "../src/fs-safe.mjs";
import { listHarnessAdapters } from "../src/harness/index.mjs";
import { initWorkflow } from "../src/init.mjs";
import { installCursor } from "../src/install.mjs";
import { integrateRun } from "../src/integrate-run.mjs";
import { assertSafeSlug, runDir } from "../src/paths.mjs";
import { preflightWorkflow, validateRepository } from "../src/preflight.mjs";
import { prepareReply, resumeLane } from "../src/reply.mjs";
import { buildDeliveryReview } from "../src/review.mjs";
import { newRunId, runWorkflow } from "../src/run.mjs";
import { runMonitor } from "../src/monitor.mjs";
import { formatStatus, latestRunId, readEvents, readStatus, writeStatus } from "../src/status.mjs";
import { runWatchSignal } from "../src/watch-signal.mjs";
import { assertDangerousPermissionApproval, loadWorkflow } from "../src/workflow.mjs";

const selfPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(selfPath), "..");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const args = process.argv.slice(2);
const cmd = args[0];

function usage() {
  console.log([
    "agent-manager - detached multi-harness supervisor",
    "",
    "Usage:",
    "  agent-manager run <workflow.yaml> --detach [--repo <path>] [--json]",
    "  agent-manager validate <workflow.yaml> [--repo <path>] [--json]",
    "  agent-manager doctor [--repo <path>] [--json]",
    "  agent-manager init [--repo <path>] [--request <text>] [--harnesses claude,codex]",
    "  agent-manager status [runId] [--watch] [--json]",
    "  agent-manager events <runId> [--jsonl]",
    "  agent-manager monitor [runId] [--interval <sec>]",
    "  agent-manager watch-signal [runId] [--heartbeat-sec 180] [--poll-ms 2000]",
    "  agent-manager reply <runId> <laneId> --message <text> [--json]",
    "  agent-manager review <runId> [--pass 1|2] [--json]",
    "  agent-manager cancel <runId> [--remove-worktrees]",
    "  agent-manager cleanup <runId> [--keep-logs] | --stale [--older-than-days 30]",
    "  agent-manager integrate <runId> [--json]",
    "  agent-manager install cursor [--project <path>] [--force] [--json]",
    "  agent-manager harnesses [--json]",
    "  agent-manager --version",
    "",
    "Dangerous permission bypass requires both workflow policy and",
    "--allow-dangerous-permissions (or AGENT_MANAGER_ALLOW_DANGEROUS_PERMISSIONS=1).",
  ].join("\n"));
}

function flagValue(name, source = args) {
  const index = source.indexOf(name);
  return index >= 0 ? source[index + 1] : null;
}

function parseRunFlags(rest) {
  const flags = { detach: false, json: false, runId: null, repo: null, dangerous: false, file: null };
  const valued = new Set(["--run-id", "--repo"]);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--detach") flags.detach = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--allow-dangerous-permissions") flags.dangerous = true;
    else if (valued.has(arg)) {
      const value = rest[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--run-id") flags.runId = value;
      else flags.repo = value;
    } else if (arg.startsWith("-")) throw new Error("unknown run flag: " + arg);
    else if (flags.file) throw new Error("unexpected argument: " + arg);
    else flags.file = arg;
  }
  return flags;
}

function firstPositional(rest, valueFlags = []) {
  const valued = new Set(valueFlags);
  for (let index = 0; index < rest.length; index += 1) {
    if (valued.has(rest[index])) { index += 1; continue; }
    if (!rest[index].startsWith("-")) return rest[index];
  }
  return null;
}

function spawnDetached(childArgs, logPath, envOverrides = {}) {
  const outFd = openSync(logPath, "a", 0o600);
  const errFd = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [selfPath, ...childArgs], {
    detached: true,
    stdio: ["ignore", outFd, errFd],
    windowsHide: true,
    cwd: process.cwd(),
    env: { ...process.env, ...envOverrides },
  });
  child.unref();
  for (const fd of [outFd, errFd]) {
    try { closeSync(fd); } catch { /* child owns the handle */ }
  }
  return child;
}

function detachRun(flags) {
  const workflowPath = resolve(flags.file);
  const workflow = loadWorkflow(workflowPath, { repoOverride: flags.repo });
  assertDangerousPermissionApproval(workflow, flags.dangerous);
  preflightWorkflow(workflow);
  const runId = assertSafeSlug(flags.runId || newRunId(), "run id");
  const dir = runDir(runId);
  if (existsSync(dir)) throw new Error(`run id already exists: ${runId}`);
  ensurePrivateDir(dir);
  const logPath = join(dir, "supervisor.log");
  const childArgs = ["run", workflowPath, "--run-id", runId];
  if (flags.repo) childArgs.push("--repo", resolve(flags.repo));
  if (flags.dangerous) childArgs.push("--allow-dangerous-permissions");
  const child = spawnDetached(childArgs, logPath, flags.dangerous ? { AGENT_MANAGER_ALLOW_DANGEROUS_PERMISSIONS: "1" } : {});
  const payload = {
    runId, state: "detached", pid: child.pid,
    telemetry: join(dir, "status.json"), supervisorLog: logPath,
    statusCommand: `agent-manager status ${runId}`,
  };
  console.log(flags.json ? JSON.stringify(payload) : [
    `runId: ${runId}`, "state: detached", `pid: ${child.pid}`, `telemetry: ${payload.telemetry}`,
    `supervisorLog: ${logPath}`, `status: ${payload.statusCommand}`,
    `monitor: agent-manager monitor ${runId}`, `watch-signal: agent-manager watch-signal ${runId}`,
  ].join("\n"));
  return payload;
}

function detachReply(runId, laneId, message, json) {
  const prepared = prepareReply(runId, laneId, message);
  const laneDir = join(runDir(runId), assertSafeSlug(laneId, "lane id"));
  const logPath = join(laneDir, `resume-supervisor-${prepared.lane.attempt}.log`);
  let child;
  try {
    child = spawnDetached(["_resume-lane", runId, laneId, prepared.messagePath], logPath);
  } catch (error) {
    prepared.lane.state = "blocked";
    prepared.lane.needsInput = prepared.previousNeedsInput;
    prepared.lane.lastActivity = "resume supervisor failed to start";
    prepared.status.state = "blocked";
    prepared.status.endedAt = null;
    writeStatus(runId, prepared.status);
    throw error;
  }
  prepared.lane.resumeSupervisorPid = child.pid;
  prepared.status.supervisor = { pid: child.pid, startedAt: new Date().toISOString(), kind: "resume" };
  writeStatus(runId, prepared.status);
  const payload = { runId, laneId, state: "running", sessionId: prepared.lane.sessionId, attempt: prepared.lane.attempt, pid: child.pid, telemetry: join(runDir(runId), "status.json"), supervisorLog: logPath };
  console.log(json ? JSON.stringify(payload) : [`runId: ${runId}`, `laneId: ${laneId}`, "state: running", `sessionId: ${prepared.lane.sessionId}`, `telemetry: ${payload.telemetry}`].join("\n"));
}

async function main() {
  if (cmd === "--version" || cmd === "-v") { console.log(packageJson.version); return; }
  if (!cmd || cmd === "-h" || cmd === "--help") { usage(); process.exitCode = cmd ? 0 : 1; return; }

  if (cmd === "run") {
    const flags = parseRunFlags(args.slice(1));
    if (!flags.file) throw new Error("run requires <workflow.yaml>");
    if (!existsSync(resolve(flags.file))) throw new Error("workflow not found: " + resolve(flags.file));
    if (flags.detach) { detachRun(flags); return; }
    const result = await runWorkflow(resolve(flags.file), { runId: flags.runId || undefined, repoOverride: flags.repo, allowDangerousPermissions: flags.dangerous });
    if (flags.json) console.log(JSON.stringify({ runId: result.runId, status: result.status }));
    return;
  }

  if (cmd === "validate") {
    const file = firstPositional(args.slice(1), ["--repo"]);
    if (!file) throw new Error("validate requires <workflow.yaml>");
    const workflow = loadWorkflow(resolve(file), { repoOverride: flagValue("--repo") });
    assertDangerousPermissionApproval(workflow, args.includes("--allow-dangerous-permissions"));
    validateRepository(workflow);
    const payload = { schema: "agent-manager.validation.v1", ok: true, repo: workflow.repoRoot, lanes: workflow.lanes.map(({ id, harness, scope }) => ({ id, harness, scope })) };
    console.log(args.includes("--json") ? JSON.stringify(payload) : `valid: ${file}\nrepo: ${payload.repo}\nlanes: ${payload.lanes.length}`);
    return;
  }

  if (cmd === "doctor") {
    const result = runDoctor({ repo: flagValue("--repo") || process.cwd() });
    console.log(args.includes("--json") ? JSON.stringify(result) : formatDoctor(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "init") {
    const repo = resolve(flagValue("--repo") || process.cwd());
    const harnesses = (flagValue("--harnesses") || "claude,codex").split(",").map((value) => value.trim()).filter(Boolean);
    const result = initWorkflow({ repo, output: flagValue("--output") || "agent-manager.yaml", request: flagValue("--request") || "Implement the requested change", harnesses });
    console.log(args.includes("--json") ? JSON.stringify(result) : `created: ${result.path}\nnext: agent-manager validate "${result.path}"`);
    return;
  }

  if (cmd === "status") {
    const watch = args.includes("--watch");
    const runId = firstPositional(args.slice(1), ["--interval"]) || latestRunId();
    if (watch) { await runMonitor(runId, { intervalMs: Math.max(0.5, Number(flagValue("--interval") || 2)) * 1000 }); return; }
    const status = readStatus(runId);
    if (!status) throw new Error("no status for " + (runId || "(none)"));
    console.log(args.includes("--json") ? JSON.stringify(status) : formatStatus(status));
    return;
  }

  if (cmd === "events") {
    const runId = args[1] || latestRunId();
    if (!runId) throw new Error("events requires <runId>");
    const events = readEvents(runId);
    console.log(args.includes("--jsonl") ? events.map((event) => JSON.stringify(event)).join("\n") : JSON.stringify(events));
    return;
  }

  if (cmd === "monitor") { await runMonitor(firstPositional(args.slice(1), ["--interval"]) || latestRunId(), { intervalMs: Math.max(0.5, Number(flagValue("--interval") || 2)) * 1000 }); return; }
  if (cmd === "watch-signal") { await runWatchSignal(firstPositional(args.slice(1), ["--heartbeat-sec", "--poll-ms"]) || latestRunId(), { heartbeatSec: Math.max(5, Number(flagValue("--heartbeat-sec") || 180)), pollMs: Math.max(200, Number(flagValue("--poll-ms") || 2000)) }); return; }

  if (cmd === "reply") {
    if (!args[1] || !args[2]) throw new Error("reply requires <runId> <laneId>");
    detachReply(args[1], args[2], flagValue("--message"), args.includes("--json"));
    return;
  }
  if (cmd === "_resume-lane") { await resumeLane(args[1], args[2], args[3]); return; }

  if (cmd === "review") {
    const runId = args[1] || latestRunId();
    if (!runId) throw new Error("review requires <runId>");
    const result = buildDeliveryReview(runId, { pass: Number(flagValue("--pass") || 1) });
    console.log(args.includes("--json") ? JSON.stringify(result) : result.markdown);
    return;
  }

  if (cmd === "cancel") { if (!args[1]) throw new Error("cancel requires <runId>"); console.log(formatStatus(await cancelRun(args[1], { removeWorktrees: args.includes("--remove-worktrees") }))); return; }
  if (cmd === "cleanup") {
    if (args.includes("--stale")) {
      const cleaned = cleanupStaleRuns({ olderThanDays: Number(flagValue("--older-than-days") || 30), keepLogs: args.includes("--keep-logs") });
      console.log(args.includes("--json") ? JSON.stringify(cleaned) : `cleaned stale runs: ${cleaned.length}${cleaned.length ? "\n" + cleaned.join("\n") : ""}`);
      return;
    }
    if (!args[1]) throw new Error("cleanup requires <runId> or --stale");
    console.log(formatStatus(cleanupRun(args[1], { keepLogs: args.includes("--keep-logs") })));
    return;
  }
  if (cmd === "integrate") { if (!args[1]) throw new Error("integrate requires <runId>"); const status = integrateRun(args[1]); console.log(args.includes("--json") ? JSON.stringify(status) : formatStatus(status)); return; }

  if (cmd === "install") {
    if (args[1] !== "cursor") throw new Error("install currently supports: cursor");
    const result = installCursor({ project: flagValue("--project"), force: args.includes("--force") });
    console.log(args.includes("--json") ? JSON.stringify(result) : `installed Cursor integration:\n${result.installed.join("\n")}`);
    return;
  }

  if (cmd === "harnesses") {
    const adapters = listHarnessAdapters();
    console.log(args.includes("--json") ? JSON.stringify(adapters) : adapters.map((adapter) => `${adapter.name}: ${adapter.supported ? "supported" : "not implemented"}`).join("\n"));
    return;
  }
  throw new Error("unknown command: " + cmd);
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
