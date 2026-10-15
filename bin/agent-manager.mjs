#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cancelRun } from "../src/cancel.mjs";
import { cleanupRun, cleanupStaleRuns, previewStaleRuns } from "../src/cleanup.mjs";
import {
  formatAgentManagerConfig,
  formatIgnoredPathOverrides,
  initAgentManagerConfig,
  resolveAgentManagerConfig,
} from "../src/config.mjs";
import { formatDoctor, runDoctor } from "../src/doctor.mjs";
import { EVENT_KINDS, emitEvent, makeEvent, readEvents } from "../src/events.mjs";
import { ensurePrivateDir } from "../src/fs-safe.mjs";
import { listHarnessAdapters } from "../src/harness/index.mjs";
import { buildRunIdentity } from "../src/identity.mjs";
import { initWorkflow } from "../src/init.mjs";
import { integrateRun } from "../src/integrate-run.mjs";
import { IGNORED_PATH_OVERRIDES, assertSafeSlug, runDir } from "../src/paths.mjs";
import { preflightWorkflow, validateRepository } from "../src/preflight.mjs";
import { ratifyLane } from "../src/ratify.mjs";
import { prepareReply, resumeLane } from "../src/reply.mjs";
import { closeRunById, reviewRun } from "../src/review.mjs";
import { newRunId, runWorkflow } from "../src/run.mjs";
import { formatRuntime } from "../src/runtime.mjs";
import { shipRun } from "../src/ship.mjs";
import { formatStatus, latestRunId, readStatus, writeStatus } from "../src/status.mjs";
import { AGENT_MANAGER_VERSION, currentVersionInfo } from "../src/version.mjs";
import { waitForEvent } from "../src/wait.mjs";
import { assertDangerousPermissionApproval, loadWorkflow } from "../src/workflow.mjs";
import { TIERS_FILE, changedPaths, classifyPaths, loadTiers } from "../tools/ship-tier.mjs";

const selfPath = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const cmd = args[0];
const json = args.includes("--json");

const USAGE = `agent-manager v${AGENT_MANAGER_VERSION} - cross-harness lanes, claims, and tiered shipping

Run
  agent-manager run <workflow.yaml> --detach [--repo <path>] [--title <text>] [--json]
  agent-manager validate <workflow.yaml> [--repo <path>] [--json]
  agent-manager init [--repo <path>] [--request <text>] [--harnesses claude,codex]
  agent-manager status [runId] [--json]
  agent-manager wait [runId] [--timeout-sec <n>] [--kinds a,b]   (run in the background)
  agent-manager reply <runId> <laneId> --message <text> [--extend-scope <globs> --by <id>] [--force]
  agent-manager ratify <runId> <laneId> --reason <text> --by <id>
  agent-manager integrate <runId> [--force-lanes done,failed-with-snapshot]
  agent-manager cancel <runId> [--remove-worktrees]

Deliver
  agent-manager review <runId> --verdict accept|revise|reject --reviewer <id> [--notes <text>]
  agent-manager ship <runId> [--target <id>] [--message <text>] [--approved-by <id>]
  agent-manager tier [--base origin/main] [--head HEAD] [--repo <path>] [--json]
  agent-manager close <runId> [--reason <text>]

Events
  agent-manager events [runId] [--json]
  agent-manager emit <kind> --repo <name> [--run <id>] [--lane <id>] [--pr <n>] [--sha <sha>]
                     [--tier <n>] [--verdict <v>] [--text <text>] [--actor <id>]

Setup
  agent-manager doctor [--repo <path>] [--json]
  agent-manager config init|show [--dev-root <p>] [--runs-root <p>] [--claims-root <p>]
  agent-manager cleanup <runId> | --stale [--older-than-days 30] [--dry-run]
  agent-manager harnesses | version`;

function flag(name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const VALUE_FLAGS = new Set([
  "--repo", "--title", "--repo-shorthand", "--manager-harness", "--manager-model",
  "--manager-thread-title", "--run-id", "--message", "--extend-scope", "--by", "--reason",
  "--force-lanes", "--verdict", "--reviewer", "--notes", "--target", "--approved-by",
  "--remote", "--base", "--head", "--timeout-sec", "--kinds", "--run", "--lane", "--pr",
  "--sha", "--tier", "--text", "--actor", "--request", "--harnesses", "--output",
  "--older-than-days", "--dev-root", "--runs-root", "--claims-root", "--config",
]);

function positionals(from = 1) {
  const out = [];
  for (let index = from; index < args.length; index += 1) {
    if (VALUE_FLAGS.has(args[index])) index += 1;
    else if (!args[index].startsWith("--")) out.push(args[index]);
  }
  return out;
}

function print(payload, text) {
  console.log(json ? JSON.stringify(payload) : text);
}

function spawnDetached(childArgs, logPath, env = {}) {
  const fd = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [selfPath, ...childArgs], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  });
  child.unref();
  try { closeSync(fd); } catch { /* the child owns the handle */ }
  return child;
}

function identityOverrides() {
  return {
    title: flag("--title"),
    repoShorthand: flag("--repo-shorthand"),
    managerHarness: flag("--manager-harness"),
    managerModel: flag("--manager-model"),
    managerThreadTitle: flag("--manager-thread-title"),
  };
}

function detachRun(file) {
  const workflowPath = resolve(file);
  const repo = flag("--repo");
  const dangerous = args.includes("--allow-dangerous-permissions");
  const workflow = loadWorkflow(workflowPath, { repoOverride: repo });
  assertDangerousPermissionApproval(workflow, dangerous);
  preflightWorkflow(workflow);
  if (!json) for (const warning of workflow.lint_warnings) console.error(`warning: ${warning.message}`);
  const runId = assertSafeSlug(flag("--run-id") || newRunId(), "run id");
  const dir = runDir(runId);
  if (existsSync(dir)) throw new Error(`run id already exists: ${runId}`);
  ensurePrivateDir(dir);
  const overrides = identityOverrides();
  const identity = buildRunIdentity({ runId, workflow, overrides });
  const childArgs = ["run", workflowPath, "--run-id", runId];
  if (repo) childArgs.push("--repo", resolve(repo));
  if (dangerous) childArgs.push("--allow-dangerous-permissions");
  for (const [name, value] of [
    ["--title", overrides.title], ["--repo-shorthand", overrides.repoShorthand],
    ["--manager-harness", overrides.managerHarness], ["--manager-model", overrides.managerModel],
    ["--manager-thread-title", overrides.managerThreadTitle],
  ]) if (value) childArgs.push(name, value);
  const logPath = join(dir, "supervisor.log");
  const child = spawnDetached(childArgs, logPath, dangerous ? { AGENT_MANAGER_ALLOW_DANGEROUS_PERMISSIONS: "1" } : {});
  const payload = {
    runId, state: "detached", pid: child.pid, title: identity.displayTitle,
    lanes: workflow.lanes.length, telemetry: join(dir, "status.json"), supervisorLog: logPath,
    wait: `agent-manager wait ${runId}`,
  };
  print(payload, [
    `runId: ${runId}`, `title: ${identity.displayTitle}`, `lanes: ${workflow.lanes.length}`,
    `runtime: ${formatRuntime(workflow.runtime)}`, `telemetry: ${payload.telemetry}`,
    `next: run \`${payload.wait}\` in the background; it returns on the next event`,
  ].join("\n"));
}

function detachReply(runId, laneId) {
  const prepared = prepareReply(runId, laneId, flag("--message"), {
    force: args.includes("--force"),
    extendScope: flag("--extend-scope") || [],
    by: flag("--by"),
  });
  const logPath = join(runDir(runId), assertSafeSlug(laneId, "lane id"), `resume-supervisor-${prepared.lane.attempt}.log`);
  let child;
  try {
    child = spawnDetached(["_resume-lane", runId, laneId, prepared.messagePath], logPath);
  } catch (error) {
    prepared.lane.state = prepared.previousLaneState || "blocked";
    prepared.lane.needsInput = prepared.previousNeedsInput;
    prepared.status.state = prepared.previousRunState || "blocked";
    writeStatus(runId, prepared.status);
    throw error;
  }
  prepared.status.supervisor = { pid: child.pid, startedAt: new Date().toISOString(), kind: "resume" };
  writeStatus(runId, prepared.status);
  print({ runId, laneId, state: "running", attempt: prepared.lane.attempt, pid: child.pid },
    `runId: ${runId}\nlaneId: ${laneId}\nstate: running (attempt ${prepared.lane.attempt})`);
}

const commands = {
  async run() {
    if (IGNORED_PATH_OVERRIDES.length && !json) console.error(formatIgnoredPathOverrides(IGNORED_PATH_OVERRIDES));
    const [file] = positionals();
    if (!file) throw new Error("run requires <workflow.yaml>");
    if (args.includes("--detach")) return detachRun(file);
    const result = await runWorkflow(resolve(file), {
      runId: flag("--run-id") || undefined,
      repoOverride: flag("--repo"),
      allowDangerousPermissions: args.includes("--allow-dangerous-permissions"),
      identityOverrides: identityOverrides(),
    });
    if (json) console.log(JSON.stringify({ runId: result.runId, state: result.status.state }));
  },
  validate() {
    const [file] = positionals();
    if (!file) throw new Error("validate requires <workflow.yaml>");
    const workflow = loadWorkflow(resolve(file), { repoOverride: flag("--repo") });
    assertDangerousPermissionApproval(workflow, args.includes("--allow-dangerous-permissions"));
    validateRepository(workflow);
    const payload = {
      ok: true, repo: workflow.repoRoot, laneCount: workflow.lanes.length,
      effectiveParallelism: workflow.topology.effectiveParallelism,
      lanes: workflow.lanes.map(({ id, harness, scope, depends_on: dependsOn }) => ({ id, harness, scope, dependsOn })),
      delivery: workflow.delivery, warnings: workflow.lint_warnings,
    };
    print(payload, [
      `valid: ${file}`, `repo: ${payload.repo}`, `lanes: ${payload.laneCount} (parallelism ${payload.effectiveParallelism})`,
      ...payload.warnings.map((warning) => `warning: ${warning.message}`),
    ].join("\n"));
  },
  init() {
    const harnesses = flag("--harnesses")?.split(",").map((value) => value.trim()).filter(Boolean);
    const result = initWorkflow({
      repo: resolve(flag("--repo") || process.cwd()),
      output: flag("--output") || "agent-manager.yaml",
      request: flag("--request") || "Implement the requested change",
      harnesses,
    });
    print(result, `created: ${result.path}\nnext: agent-manager validate "${result.path}"`);
  },
  status() {
    const runId = positionals()[0] || latestRunId();
    const status = readStatus(runId);
    if (!status) throw new Error("no status for " + (runId || "(none)"));
    print(status, formatStatus(status));
  },
  async wait() {
    const runId = positionals()[0] || null;
    const event = await waitForEvent(runId, {
      timeoutSec: Number(flag("--timeout-sec") || 0),
      kinds: flag("--kinds")?.split(",").map((value) => value.trim()),
    });
    console.log(JSON.stringify(event));
    if (event.kind === "timeout") process.exitCode = 3;
  },
  events() {
    const runId = positionals()[0] || null;
    const events = readEvents(runId ? { runId } : {});
    console.log(json ? JSON.stringify(events) : events.map((event) => JSON.stringify(event)).join("\n"));
  },
  async emit() {
    const [kind] = positionals();
    if (!EVENT_KINDS.has(kind)) throw new Error(`emit requires a kind: ${[...EVENT_KINDS].join(", ")}`);
    const event = makeEvent(kind, {
      repo: flag("--repo"), runId: flag("--run"), lane: flag("--lane"), pr: flag("--pr"),
      sha: flag("--sha"), tier: flag("--tier"), verdict: flag("--verdict"), text: flag("--text"),
      actor: flag("--actor") || "operator",
    });
    if (event.runId) assertSafeSlug(event.runId, "run id");
    await emitEvent(event);
    console.log(JSON.stringify(event));
  },
  reply() {
    const [runId, laneId] = positionals();
    if (!runId || !laneId) throw new Error("reply requires <runId> <laneId>");
    detachReply(runId, laneId);
  },
  async "_resume-lane"() {
    await resumeLane(args[1], args[2], args[3]);
  },
  ratify() {
    const [runId, laneId] = positionals();
    if (!runId || !laneId) throw new Error("ratify requires <runId> <laneId>");
    const reason = flag("--reason");
    if (!reason) throw new Error("ratify requires --reason <text>");
    const result = ratifyLane(runId, laneId, { reason, by: flag("--by") });
    print(result, `ratified ${laneId} by ${result.by}: ${result.violations.join("; ")}\nnext: agent-manager integrate ${runId} --force-lanes done,failed-with-snapshot`);
  },
  review() {
    const runId = positionals()[0] || latestRunId();
    const status = reviewRun(runId, { verdict: flag("--verdict"), reviewer: flag("--reviewer"), notes: flag("--notes") });
    print(status, `${runId}: ${status.delivery.review.verdict} by ${status.delivery.review.reviewer} → ${status.state}${status.state === "ship_pending" ? `\nnext: agent-manager ship ${runId}` : ""}`);
  },
  ship() {
    const runId = positionals()[0] || latestRunId();
    const result = shipRun(runId, {
      targetId: flag("--target"), message: flag("--message"), approvedBy: flag("--approved-by"), remote: flag("--remote"),
    });
    print({ runId, state: result.status.state, targets: result.status.delivery.targets, notices: result.lines }, result.lines.join("\n"));
  },
  tier() {
    const repoRoot = resolve(flag("--repo") || process.cwd());
    const tiers = loadTiers(repoRoot);
    const result = classifyPaths(changedPaths(repoRoot, flag("--base") || "origin/main", flag("--head") || "HEAD"), tiers);
    print({ ...result, tiersFile: tiers.missing ? null : TIERS_FILE }, [
      `tier ${result.tier}${tiers.missing ? ` (no ${TIERS_FILE}: every path is tier 1)` : ""}`,
      ...result.files.map((file) => `  ${file.tier}  ${file.path}${file.pattern ? `  (${file.pattern})` : ""}`),
    ].join("\n"));
  },
  close() {
    const runId = positionals()[0];
    if (!runId) throw new Error("close requires <runId>");
    print(closeRunById(runId, { reason: flag("--reason") || undefined }), `${runId}: closed`);
  },
  async cancel() {
    const [runId] = positionals();
    if (!runId) throw new Error("cancel requires <runId>");
    const status = await cancelRun(runId, { removeWorktrees: args.includes("--remove-worktrees") });
    print(status, formatStatus(status));
  },
  cleanup() {
    const olderThanDays = Number(flag("--older-than-days") || 30);
    if (args.includes("--stale")) {
      if (args.includes("--dry-run")) {
        const preview = previewStaleRuns({ olderThanDays });
        print(preview, [`stale runs older than ${olderThanDays} days: ${preview.runs.length}`,
          ...preview.runs.map((run) => `${run.runId}  ${run.state}  action=${run.recommendedAction}`)].join("\n"));
        return;
      }
      const failed = [];
      const cleaned = cleanupStaleRuns({
        olderThanDays,
        keepLogs: args.includes("--keep-logs"),
        onFailure: (runId, error) => failed.push(`${runId}: ${error.message}`),
      });
      print(cleaned, [`cleaned stale runs: ${cleaned.length}`, ...cleaned,
        ...(failed.length ? [`failed: ${failed.length}`, ...failed] : [])].join("\n"));
      for (const line of failed) console.error(`cleanup failed ${line}`);
      return;
    }
    const [runId] = positionals();
    if (!runId) throw new Error("cleanup requires <runId> or --stale");
    print(cleanupRun(runId, { keepLogs: args.includes("--keep-logs") }), `cleaned ${runId}`);
  },
  async integrate() {
    const [runId] = positionals();
    if (!runId) throw new Error("integrate requires <runId>");
    const status = await integrateRun(runId, { forceLanes: flag("--force-lanes") || [] });
    print(status, formatStatus(status));
  },
  doctor() {
    const result = runDoctor({ repo: flag("--repo") || process.cwd() });
    print(result, formatDoctor(result));
    if (!result.ok) process.exitCode = 1;
  },
  config() {
    const action = args[1];
    const configPath = flag("--config") || undefined;
    if (action === "init") {
      const created = initAgentManagerConfig({
        configPath,
        devRoot: flag("--dev-root") || undefined,
        runsRoot: flag("--runs-root") || undefined,
        claimsRoot: flag("--claims-root") || undefined,
        force: args.includes("--force"),
      });
      const resolved = resolveAgentManagerConfig({ configPath: created.path });
      print(resolved, `created: ${created.path}\n${formatAgentManagerConfig(resolved)}`);
    } else if (action === "show") {
      const resolved = resolveAgentManagerConfig({ configPath });
      print(resolved, formatAgentManagerConfig(resolved));
    } else throw new Error("config requires init or show");
  },
  harnesses() {
    const adapters = listHarnessAdapters();
    print(adapters, adapters.map((adapter) => `${adapter.name}: ${adapter.supported ? "supported" : "not implemented"}`).join("\n"));
  },
  version() {
    const version = currentVersionInfo();
    print(version, `agent-manager v${version.runtimeVersion}${version.restartRequired ? ` (installed files: v${version.installedVersion}; restart required)` : ""}`);
  },
};

async function main() {
  if (cmd === "--version" || cmd === "-v") return console.log(AGENT_MANAGER_VERSION);
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(USAGE);
    if (!cmd) process.exitCode = 1;
    return;
  }
  const handler = commands[cmd];
  if (!handler) throw new Error(`unknown command: ${cmd}\n\n${USAGE}`);
  await handler();
}

main().catch((error) => {
  if (json && typeof error?.toJSON === "function") console.error(JSON.stringify(error.toJSON()));
  else console.error(process.env.AGENT_MANAGER_DEBUG ? error?.stack || error : error?.message || error);
  process.exitCode = 1;
});
