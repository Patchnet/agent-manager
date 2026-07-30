#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cancelRun } from "../src/cancel.mjs";
import { cleanupRun } from "../src/cleanup.mjs";
import { listHarnessAdapters } from "../src/harness/index.mjs";
import { integrateRun } from "../src/integrate-run.mjs";
import { runDir } from "../src/paths.mjs";
import { prepareReply, resumeLane } from "../src/reply.mjs";
import { newRunId, runWorkflow } from "../src/run.mjs";
import { runMonitor } from "../src/monitor.mjs";
import { formatStatus, latestRunId, readStatus, writeStatus } from "../src/status.mjs";
import { runWatchSignal } from "../src/watch-signal.mjs";

const selfPath = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const cmd = args[0];

function usage() {
  console.log([
    "agent-manager — Master Dev CLI supervisor",
    "",
    "Usage:",
    "  agent-manager run <workflow.yaml> [--detach] [--json] [--run-id <id>]",
    "  agent-manager status [runId] [--watch] [--json]",
    "  agent-manager monitor [runId] [--interval <sec>]",
    "  agent-manager watch-signal [runId] [--heartbeat-sec 180] [--poll-ms 2000]",
    "  agent-manager reply <runId> <laneId> --message \"...\" [--json]",
    "  agent-manager cancel <runId> [--remove-worktrees]",
    "  agent-manager cleanup <runId> [--keep-logs]",
    "  agent-manager integrate <runId> [--json]",
    "  agent-manager harnesses [--json]",
    "",
    "Runs: $AGENT_MANAGER_RUNS_ROOT/<runId>/ (default ~/.agent-manager/runs)",
    "Claims: bundled tools/claim.mjs (override AGENT_MANAGER_CLAIM_BIN)",
    "",
    "--detach         Spawn the run as a background supervisor and exit immediately.",
    "--json           Print machine-readable launch/status output.",
    "--run-id         Internal/forced run id (also used by --detach child).",
    "monitor          Live side-terminal lane board (status --watch aliases here).",
    "watch-signal     Emit AGENT_MANAGER_WAKE_* lines for Master Dev Cursor loops.",
  ].join("\n"));
}

function parseRunFlags(rest) {
  const flags = { detach: false, json: false, runId: null, file: null };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--detach") flags.detach = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--run-id") flags.runId = rest[++index] || null;
    else if (arg.startsWith("-")) throw new Error("unknown run flag: " + arg);
    else if (flags.file) throw new Error("unexpected argument: " + arg);
    else flags.file = arg;
  }
  return flags;
}

function flagValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function spawnDetached(childArgs, logPath) {
  const outFd = openSync(logPath, "a");
  const errFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [selfPath, ...childArgs], {
    detached: true,
    stdio: ["ignore", outFd, errFd],
    windowsHide: true,
    cwd: process.cwd(),
    env: process.env,
  });
  child.unref();
  for (const fd of [outFd, errFd]) {
    try {
      closeSync(fd);
    } catch {
      /* child owns the handle */
    }
  }
  return child;
}

function detachRun(workflowPath, forcedId, json) {
  const runId = forcedId || newRunId();
  const dir = runDir(runId);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "supervisor.log");
  const child = spawnDetached(["run", workflowPath, "--run-id", runId], logPath);
  const payload = {
    runId,
    state: "detached",
    pid: child.pid,
    telemetry: join(dir, "status.json"),
    supervisorLog: logPath,
    statusCommand: "node " + selfPath + " status " + runId,
  };
  if (json) console.log(JSON.stringify(payload));
  else {
    console.log("runId: " + runId);
    console.log("state: detached");
    console.log("pid: " + child.pid);
    console.log("telemetry: " + payload.telemetry);
    console.log("supervisorLog: " + logPath);
    console.log("status: " + payload.statusCommand);
    console.log("monitor: node " + selfPath + " monitor " + runId);
    console.log("watch-signal: node " + selfPath + " watch-signal " + runId);
  }
  return payload;
}

function detachReply(runId, laneId, message, json) {
  const prepared = prepareReply(runId, laneId, message);
  const laneDir = join(runDir(runId), laneId);
  const logPath = join(laneDir, "resume-supervisor-" + prepared.lane.attempt + ".log");
  let child;
  try {
    child = spawnDetached(
      ["_resume-lane", runId, laneId, prepared.messagePath],
      logPath,
    );
  } catch (error) {
    prepared.lane.state = "blocked";
    prepared.lane.needsInput = prepared.previousNeedsInput;
    prepared.lane.lastActivity = "resume supervisor failed to start";
    prepared.status.state = "blocked";
    prepared.status.endedAt = new Date().toISOString();
    writeStatus(runId, prepared.status);
    throw error;
  }
  prepared.lane.resumeSupervisorPid = child.pid;
  writeStatus(runId, prepared.status);
  const payload = {
    runId,
    laneId,
    state: "running",
    sessionId: prepared.lane.sessionId,
    attempt: prepared.lane.attempt,
    pid: child.pid,
    telemetry: join(runDir(runId), "status.json"),
    supervisorLog: logPath,
  };
  if (json) console.log(JSON.stringify(payload));
  else {
    console.log("runId: " + runId);
    console.log("laneId: " + laneId);
    console.log("state: running");
    console.log("sessionId: " + prepared.lane.sessionId);
    console.log("telemetry: " + payload.telemetry);
  }
  return payload;
}

async function main() {
  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    process.exitCode = cmd ? 0 : 1;
    return;
  }

  if (cmd === "run") {
    const flags = parseRunFlags(args.slice(1));
    if (!flags.file) throw new Error("run requires <workflow.yaml>");
    const workflowPath = resolve(flags.file);
    if (!existsSync(workflowPath)) throw new Error("workflow not found: " + workflowPath);
    if (flags.detach) {
      detachRun(workflowPath, flags.runId, flags.json);
      return;
    }
    const result = await runWorkflow(workflowPath, { runId: flags.runId || undefined });
    if (flags.json) console.log(JSON.stringify({ runId: result.runId, status: result.status }));
    return;
  }

  if (cmd === "status") {
    const watch = args.includes("--watch");
    const json = args.includes("--json");
    const runId = args.slice(1).find((arg) => !arg.startsWith("-")) || latestRunId();
    if (watch) {
      const intervalSec = Number(flagValue("--interval") || 2);
      await runMonitor(runId, { intervalMs: Math.max(0.5, intervalSec) * 1000 });
      return;
    }
    const status = readStatus(runId);
    if (!status) throw new Error("no status for " + (runId || "(none)"));
    console.log(json ? JSON.stringify(status) : formatStatus(status));
    return;
  }

  if (cmd === "monitor") {
    const runId = args.slice(1).find((arg) => !arg.startsWith("-")) || latestRunId();
    const intervalSec = Number(flagValue("--interval") || 2);
    await runMonitor(runId, { intervalMs: Math.max(0.5, intervalSec) * 1000 });
    return;
  }

  if (cmd === "watch-signal") {
    const runId = args.slice(1).find((arg) => !arg.startsWith("-")) || latestRunId();
    const heartbeatSec = Number(flagValue("--heartbeat-sec") || 180);
    const pollMs = Number(flagValue("--poll-ms") || 2000);
    await runWatchSignal(runId, {
      heartbeatSec: Math.max(5, heartbeatSec),
      pollMs: Math.max(200, pollMs),
    });
    return;
  }

  if (cmd === "reply") {
    const runId = args[1];
    const laneId = args[2];
    if (!runId || !laneId) throw new Error("reply requires <runId> <laneId>");
    detachReply(runId, laneId, flagValue("--message"), args.includes("--json"));
    return;
  }

  if (cmd === "_resume-lane") {
    await resumeLane(args[1], args[2], args[3]);
    return;
  }

  if (cmd === "cancel") {
    if (!args[1]) throw new Error("cancel requires <runId>");
    console.log(formatStatus(await cancelRun(args[1], {
      removeWorktrees: args.includes("--remove-worktrees"),
    })));
    return;
  }

  if (cmd === "cleanup") {
    if (!args[1]) throw new Error("cleanup requires <runId>");
    console.log(formatStatus(cleanupRun(args[1], { keepLogs: args.includes("--keep-logs") })));
    return;
  }

  if (cmd === "integrate") {
    if (!args[1]) throw new Error("integrate requires <runId>");
    const status = integrateRun(args[1]);
    console.log(args.includes("--json") ? JSON.stringify(status) : formatStatus(status));
    return;
  }

  if (cmd === "harnesses") {
    const adapters = listHarnessAdapters();
    if (args.includes("--json")) console.log(JSON.stringify(adapters));
    else for (const adapter of adapters) {
      console.log(adapter.name + ": " + (adapter.supported ? "supported" : "not implemented"));
    }
    return;
  }

  throw new Error("unknown command: " + cmd);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
