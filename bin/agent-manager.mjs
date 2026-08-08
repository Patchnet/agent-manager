#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { assertPlanningReady } from "../src/planning.mjs";
import { prepareReply, resumeLane } from "../src/reply.mjs";
import { buildDeliveryReview } from "../src/review.mjs";
import { newRunId, runWorkflow } from "../src/run.mjs";
import {
  blockQueuedShip,
  markShipSupervisor,
  preflightShipHandoff,
  prepareShipHandoff,
  queueShip,
  runShip,
} from "../src/ship-run.mjs";
import { runMonitor } from "../src/monitor.mjs";
import { formatStatus, latestRunId, readEvents, readStatus, writeStatus } from "../src/status.mjs";
import { runWatchSignal } from "../src/watch-signal.mjs";
import { assertDangerousPermissionApproval, loadWorkflow } from "../src/workflow.mjs";
import { formatRuntime } from "../src/runtime.mjs";
import { deliveryReadiness } from "../src/delivery.mjs";
import { deriveOperatorCadence } from "../src/cadence.mjs";
import { fleetUsage, parseFleetArgs, runFleet } from "../src/fleet.mjs";
import { parseTokensArgs, runTokens, tokensUsage } from "../src/tokens.mjs";
import { buildRunIdentity } from "../src/identity.mjs";
import { AGENT_MANAGER_VERSION, currentVersionInfo } from "../src/version.mjs";
import {
  ensureBrain,
  formatBrainIntents,
  listBrainIntents,
  syncBrainStatus,
} from "../src/brain.mjs";
import {
  assertGoalsExist,
  createGoal,
  getGoal,
  linkGoalArtifact,
  listGoalArtifactLinks,
  listGoals,
  updateGoal,
} from "../src/goals.mjs";
import { formatGoalProgress, getGoalProgress } from "../src/goal-progress.mjs";
import { exportGoalMap } from "../src/goal-map.mjs";
import {
  formatAgentManagerConfig,
  initAgentManagerConfig,
  resolveAgentManagerConfig,
} from "../src/config.mjs";
import {
  dispatchMasterReturn,
  masterReturnSummary,
  readMasterReturn,
  resolveMasterReturn,
  writeMasterReturn,
} from "../src/master-return.mjs";
import {
  loadDirectorPolicy,
  runDirectorCycle,
} from "../src/director/index.mjs";

const selfPath = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const cmd = args[0];

function usage() {
  console.log([
    `agent-manager v${AGENT_MANAGER_VERSION} - detached multi-harness supervisor`,
    "",
    "Usage:",
    "  agent-manager run <workflow.yaml> --detach [--repo <path>] [--json]",
    "    identity: --title <subject> --repo-shorthand <name>",
    "              --manager-harness <name> --manager-model <model>",
    "              --manager-thread-title <title>",
    "    master return: auto-detected in Codex, Claude Code, and Cursor",
    "                   override with --return-host codex|claude|cursor",
    "                   --return-session <id>; disable with --no-master-return",
    "  agent-manager validate <workflow.yaml> [--repo <path>] [--json]",
    "  agent-manager doctor [--repo <path>] [--json]",
    "  agent-manager init [--repo <path>] [--request <text>] [--harnesses claude,codex]",
    "  agent-manager status [runId] [--watch] [--json]",
    "  agent-manager events <runId> [--jsonl]",
    "  agent-manager monitor [runId] [--interval <sec>]",
    "  agent-manager fleet [runId] [--active] [--since 24h] [--stream|--once|--json]",
    "  agent-manager tokens [--since 7d] [--by day|model|repo|source] [--watch] [--json]",
    "  agent-manager config init [--dev-root <path>] [--runs-root <path>] [--claims-root <path>] [--brain-root <path>]",
    "  agent-manager config show [--json]",
    "  agent-manager director validate --policy <file> [--repo <path>] [--json]",
    "  agent-manager director cycle --policy <file> --items <file> --dry-run [options] [--json]",
    "    options: --repo <path> --state-dir <path> --cycle-id <id>",
    "  agent-manager brain init [--json]",
    "  agent-manager brain status [--repo <path>] [--json]",
    "  agent-manager goals [--parent <id>|--roots] [--json]",
    "  agent-manager goal create --title <text> [--id <id>] [options] [--json]",
    "  agent-manager goal update <id> [options] [--json]",
    "  agent-manager goal show <id> [--json]",
    "  agent-manager goal status <id> [--json]",
    "  agent-manager goal map <id> [--output <file>] [--json]",
    "  agent-manager goal link <id> --type <type> --ref <ref> [options] [--json]",
    "  agent-manager watch-signal [runId] [--heartbeat-sec 180] [--poll-ms 2000]",
    "  agent-manager reply <runId> <laneId> --message <text> [--json]",
    "  agent-manager review <runId> [--pass 1|2] [--verdict <decision> --reviewer <id> [--notes <text>]] [--json]",
    "  agent-manager next-action <runId> [--json]",
    "  agent-manager delivery-ready <runId> [--require merged|released] [--json]",
    "  agent-manager ship <runId> --approve all|through-pr --detach [options] [--json]",
    "    options: --commit-message <text> --version <semver> --summary <text>",
    "             --repo <path> --worktree <path> --branch <ref> --base <ref>",
    "             --remote <name> --pr <url|number> --target <delivery-target-id>",
    "             --poll-sec <n> --timeout-sec <n> --check-grace-sec <n>",
    "  agent-manager cancel <runId> [--remove-worktrees]",
    "  agent-manager cleanup <runId> [--keep-logs] | --stale [--older-than-days 30]",
    "  agent-manager integrate <runId> [--json]",
    "  agent-manager install cursor [--project <path>] [--force] [--json]",
    "  agent-manager harnesses [--json]",
    "  agent-manager version [--json]",
    "  agent-manager --version",
    "",
    "Dangerous permission bypass requires both workflow policy and",
    "--allow-dangerous-permissions (or AGENT_MANAGER_ALLOW_DANGEROUS_PERMISSIONS=1).",
  ].join("\n"));
}

function parseShipFlags(rest) {
  const flags = {
    runId: null,
    approve: null,
    detach: false,
    json: false,
    repo: null,
    worktree: null,
    branch: null,
    base: null,
    remote: null,
    pr: null,
    commitMessage: null,
    version: null,
    summary: null,
    pollSec: null,
    timeoutSec: null,
    checkGraceSec: null,
    target: null,
  };
  const valued = new Map([
    ["--approve", "approve"],
    ["--repo", "repo"],
    ["--worktree", "worktree"],
    ["--branch", "branch"],
    ["--base", "base"],
    ["--remote", "remote"],
    ["--pr", "pr"],
    ["--commit-message", "commitMessage"],
    ["--version", "version"],
    ["--summary", "summary"],
    ["--poll-sec", "pollSec"],
    ["--timeout-sec", "timeoutSec"],
    ["--check-grace-sec", "checkGraceSec"],
    ["--target", "target"],
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--detach") flags.detach = true;
    else if (arg === "--json") flags.json = true;
    else if (valued.has(arg)) {
      const value = rest[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      flags[valued.get(arg)] = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown ship flag: ${arg}`);
    } else if (flags.runId) {
      throw new Error(`unexpected ship argument: ${arg}`);
    } else {
      flags.runId = arg;
    }
  }
  return flags;
}

function flagValue(name, source = args) {
  const index = source.indexOf(name);
  return index >= 0 ? source[index + 1] : null;
}

function parseRunFlags(rest) {
  const flags = {
    detach: false,
    json: false,
    runId: null,
    repo: null,
    dangerous: false,
    expectedPlanningDigest: null,
    returnHost: null,
    returnSession: null,
    noMasterReturn: false,
    title: null,
    repoShorthand: null,
    managerHarness: null,
    managerModel: null,
    managerThreadTitle: null,
    file: null,
  };
  const valued = new Set([
    "--run-id",
    "--repo",
    "--expected-planning-digest",
    "--return-host",
    "--return-session",
    "--title",
    "--repo-shorthand",
    "--manager-harness",
    "--manager-model",
    "--manager-thread-title",
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--detach") flags.detach = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--allow-dangerous-permissions") flags.dangerous = true;
    else if (arg === "--no-master-return") flags.noMasterReturn = true;
    else if (valued.has(arg)) {
      const value = rest[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--run-id") flags.runId = value;
      else if (arg === "--repo") flags.repo = value;
      else if (arg === "--expected-planning-digest") flags.expectedPlanningDigest = value;
      else if (arg === "--return-host") flags.returnHost = value;
      else if (arg === "--return-session") flags.returnSession = value;
      else if (arg === "--title") flags.title = value;
      else if (arg === "--repo-shorthand") flags.repoShorthand = value;
      else if (arg === "--manager-harness") flags.managerHarness = value;
      else if (arg === "--manager-model") flags.managerModel = value;
      else flags.managerThreadTitle = value;
    } else if (arg.startsWith("-")) throw new Error("unknown run flag: " + arg);
    else if (flags.file) throw new Error("unexpected argument: " + arg);
    else flags.file = arg;
  }
  return flags;
}

function parseDirectorFlags(rest) {
  let action = rest[0] || null;
  const flags = {
    action,
    policy: null,
    items: null,
    repo: null,
    stateDir: null,
    cycleId: null,
    dryRun: false,
    json: false,
  };
  if (action === "dry-cycle") {
    action = "cycle";
    flags.action = action;
    flags.dryRun = true;
  }
  const valued = new Map([
    ["--policy", "policy"],
    ["--items", "items"],
    ["--repo", "repo"],
    ["--state-dir", "stateDir"],
    ["--cycle-id", "cycleId"],
  ]);
  for (let index = 1; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--json") flags.json = true;
    else if (valued.has(arg)) {
      const value = rest[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      flags[valued.get(arg)] = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown director flag: ${arg}`);
    } else {
      throw new Error(`unexpected director argument: ${arg}`);
    }
  }
  return flags;
}

function identityOverrides(flags, masterReturn = null) {
  const managerModel = flags.managerModel || process.env.AGENT_MANAGER_MANAGER_MODEL || null;
  return {
    title: flags.title,
    repoShorthand: flags.repoShorthand,
    managerHarness: flags.managerHarness || masterReturn?.host || process.env.AGENT_MANAGER_MANAGER_HARNESS || null,
    managerModel,
    managerModelSource: flags.managerModel
      ? "cli"
      : process.env.AGENT_MANAGER_MANAGER_MODEL ? "environment" : "unavailable",
    managerThreadTitle: flags.managerThreadTitle || process.env.AGENT_MANAGER_MANAGER_THREAD_TITLE || null,
  };
}

function firstPositional(rest, valueFlags = []) {
  const valued = new Set(valueFlags);
  for (let index = 0; index < rest.length; index += 1) {
    if (valued.has(rest[index])) { index += 1; continue; }
    if (!rest[index].startsWith("-")) return rest[index];
  }
  return null;
}

function parseNamedArgs(rest, { values = {}, booleans = {} } = {}) {
  const parsed = { positionals: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (Object.hasOwn(booleans, arg)) {
      parsed[booleans[arg]] = true;
      continue;
    }
    if (Object.hasOwn(values, arg)) {
      const spec = values[arg];
      const value = rest[++index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      const items = spec.csv
        ? value.split(",").map((item) => item.trim()).filter(Boolean)
        : [value];
      if (spec.repeat) parsed[spec.key] = [...(parsed[spec.key] || []), ...items];
      else {
        if (Object.hasOwn(parsed, spec.key)) throw new Error(`${arg} may be specified only once`);
        parsed[spec.key] = value;
      }
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown goal flag: ${arg}`);
    parsed.positionals.push(arg);
  }
  return parsed;
}

const goalCommonValues = {
  "--title": { key: "title" },
  "--lifecycle": { key: "lifecycle" },
  "--parent": { key: "parentId" },
  "--parent-id": { key: "parentId" },
  "--outcome": { key: "outcome" },
  "--dependency": { key: "dependencies", repeat: true, csv: true },
  "--depends-on": { key: "dependencies", repeat: true, csv: true },
  "--dependencies": { key: "dependencies", repeat: true, csv: true },
  "--success-criterion": { key: "successCriteria", repeat: true },
  "--success-criteria": { key: "successCriteria", repeat: true, csv: true },
  "--source-ref": { key: "externalSourceRefs", repeat: true },
  "--external-source-ref": { key: "externalSourceRefs", repeat: true },
  "--external-source-refs": { key: "externalSourceRefs", repeat: true, csv: true },
};

const goalCommonBooleans = {
  "--json": "json",
  "--clear-parent": "clearParent",
  "--clear-outcome": "clearOutcome",
  "--clear-dependencies": "clearDependencies",
  "--clear-success-criteria": "clearSuccessCriteria",
  "--clear-source-refs": "clearSourceRefs",
};

function goalFields(parsed, { create = false } = {}) {
  const conflicts = [
    ["parentId", "clearParent", "parent"],
    ["outcome", "clearOutcome", "outcome"],
    ["dependencies", "clearDependencies", "dependencies"],
    ["successCriteria", "clearSuccessCriteria", "success criteria"],
    ["externalSourceRefs", "clearSourceRefs", "source refs"],
  ];
  for (const [valueKey, clearKey, label] of conflicts) {
    if (Object.hasOwn(parsed, valueKey) && parsed[clearKey]) {
      throw new Error(`cannot set and clear ${label} in the same goal update`);
    }
  }
  const fields = {};
  for (const key of [
    "title", "lifecycle", "parentId", "dependencies", "outcome", "successCriteria",
    "externalSourceRefs",
  ]) {
    if (Object.hasOwn(parsed, key)) fields[key] = parsed[key];
  }
  if (parsed.clearParent) fields.parentId = null;
  if (parsed.clearOutcome) fields.outcome = null;
  if (parsed.clearDependencies) fields.dependencies = [];
  if (parsed.clearSuccessCriteria) fields.successCriteria = [];
  if (parsed.clearSourceRefs) fields.externalSourceRefs = [];
  if (create && parsed.id) fields.id = parsed.id;
  return fields;
}

function formatGoal(goal) {
  return [
    `${goal.id}  ${goal.lifecycle}  ${goal.title}`,
    `parent: ${goal.parentId || "-"}`,
    `dependencies: ${goal.dependencies.length ? goal.dependencies.join(", ") : "-"}`,
    `outcome: ${goal.outcome || "-"}`,
    `success criteria: ${goal.successCriteria.length ? goal.successCriteria.join(" | ") : "-"}`,
    `source refs: ${goal.externalSourceRefs.length ? goal.externalSourceRefs.join(", ") : "-"}`,
  ].join("\n");
}

async function goalDetail(goalId) {
  const [goal, children, artifactLinks] = await Promise.all([
    getGoal(goalId),
    listGoals({ parentId: goalId }),
    listGoalArtifactLinks({ goalId }),
  ]);
  return {
    schema: "agent-manager.goal-detail.v1",
    goal,
    children,
    artifactLinks,
  };
}

async function runGoalsCommand(rest) {
  const parsed = parseNamedArgs(rest, {
    values: { "--parent": { key: "parentId" } },
    booleans: { "--roots": "roots", "--json": "json" },
  });
  if (parsed.positionals.length) throw new Error(`unexpected goals argument: ${parsed.positionals[0]}`);
  if (parsed.roots && parsed.parentId) throw new Error("goals accepts either --parent or --roots, not both");
  const goals = await listGoals(parsed.roots
    ? { parentId: null }
    : parsed.parentId ? { parentId: parsed.parentId } : {});
  const payload = {
    schema: "agent-manager.goals-list.v1",
    filter: parsed.roots ? { parentId: null } : parsed.parentId ? { parentId: parsed.parentId } : null,
    goals,
  };
  console.log(parsed.json
    ? JSON.stringify(payload)
    : goals.length ? goals.map((goal) => `${goal.id}\t${goal.lifecycle}\t${goal.title}`).join("\n") : "no goals");
}

async function runGoalCommand(rest) {
  const action = rest[0];
  if (!action) throw new Error("goal requires create, update, show, inspect, status, map, or link");
  if (action === "create") {
    const parsed = parseNamedArgs(rest.slice(1), {
      values: {
        ...goalCommonValues,
        "--id": { key: "id" },
        "--goal-id": { key: "id" },
      },
      booleans: { "--json": "json" },
    });
    if (parsed.positionals.length) throw new Error(`unexpected goal create argument: ${parsed.positionals[0]}`);
    const goal = await createGoal(goalFields(parsed, { create: true }));
    const payload = { schema: "agent-manager.goal-write.v1", operation: "create", goal };
    console.log(parsed.json ? JSON.stringify(payload) : formatGoal(goal));
    return;
  }
  if (action === "update") {
    const parsed = parseNamedArgs(rest.slice(1), {
      values: goalCommonValues,
      booleans: goalCommonBooleans,
    });
    if (parsed.positionals.length !== 1) throw new Error("goal update requires exactly one <id>");
    const goal = await updateGoal(parsed.positionals[0], goalFields(parsed));
    const payload = { schema: "agent-manager.goal-write.v1", operation: "update", goal };
    console.log(parsed.json ? JSON.stringify(payload) : formatGoal(goal));
    return;
  }
  if (action === "show" || action === "inspect") {
    const parsed = parseNamedArgs(rest.slice(1), { booleans: { "--json": "json" } });
    if (parsed.positionals.length !== 1) throw new Error(`goal ${action} requires exactly one <id>`);
    const payload = await goalDetail(parsed.positionals[0]);
    console.log(parsed.json ? JSON.stringify(payload) : [
      formatGoal(payload.goal),
      `children: ${payload.children.length ? payload.children.map((goal) => goal.id).join(", ") : "-"}`,
      `artifact links: ${payload.artifactLinks.length ? payload.artifactLinks.map((link) => link.id).join(", ") : "-"}`,
    ].join("\n"));
    return;
  }
  if (action === "status") {
    const parsed = parseNamedArgs(rest.slice(1), { booleans: { "--json": "json" } });
    if (parsed.positionals.length !== 1) throw new Error("goal status requires exactly one <id>");
    const progress = await getGoalProgress(parsed.positionals[0]);
    console.log(parsed.json ? JSON.stringify(progress) : formatGoalProgress(progress));
    return;
  }
  if (action === "map") {
    const parsed = parseNamedArgs(rest.slice(1), {
      values: { "--output": { key: "outputPath" }, "--out": { key: "outputPath" } },
      booleans: { "--json": "json" },
    });
    if (parsed.positionals.length !== 1) throw new Error("goal map requires exactly one <id>");
    const result = await exportGoalMap(parsed.positionals[0], {
      outputPath: parsed.outputPath || null,
    });
    console.log(parsed.json ? JSON.stringify(result) : [
      `goal map: ${result.outputPath}`,
      `effective state: ${result.effectiveState}`,
      `${result.completedLeafRatio.label}: ${result.completedLeafRatio.numerator}/${result.completedLeafRatio.denominator}`,
    ].join("\n"));
    return;
  }
  if (action === "link") {
    const parsed = parseNamedArgs(rest.slice(1), {
      values: {
        "--id": { key: "linkId" },
        "--link-id": { key: "linkId" },
        "--type": { key: "artifactType" },
        "--artifact-type": { key: "artifactType" },
        "--ref": { key: "artifactRef" },
        "--artifact-ref": { key: "artifactRef" },
        "--relationship": { key: "relationship" },
        "--state": { key: "state" },
        "--label": { key: "label" },
      },
      booleans: { "--json": "json" },
    });
    if (parsed.positionals.length !== 1) throw new Error("goal link requires exactly one <id>");
    const link = await linkGoalArtifact({
      goalId: parsed.positionals[0],
      ...(parsed.linkId ? { id: parsed.linkId } : {}),
      artifactType: parsed.artifactType,
      artifactRef: parsed.artifactRef,
      ...(parsed.relationship ? { relationship: parsed.relationship } : {}),
      ...(parsed.state ? { state: parsed.state } : {}),
      ...(parsed.label ? { label: parsed.label } : {}),
    });
    const payload = { schema: "agent-manager.goal-link.v1", operation: "link", link };
    console.log(parsed.json ? JSON.stringify(payload) : [
      `${link.id}  ${link.goalId}`,
      `${link.relationship}: ${link.artifactType}:${link.artifactRef} [${link.state}]`,
    ].join("\n"));
    return;
  }
  throw new Error(`unknown goal action: ${action}`);
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

async function detachRun(flags) {
  const workflowPath = resolve(flags.file);
  const workflow = loadWorkflow(workflowPath, { repoOverride: flags.repo });
  assertDangerousPermissionApproval(workflow, flags.dangerous);
  preflightWorkflow(workflow);
  if (workflow.goal_refs.length) await assertGoalsExist(workflow.goal_refs);
  const runId = assertSafeSlug(flags.runId || newRunId(), "run id");
  const dir = runDir(runId);
  if (existsSync(dir)) throw new Error(`run id already exists: ${runId}`);
  ensurePrivateDir(dir);
  const masterReturn = resolveMasterReturn({
    host: flags.returnHost,
    sessionId: flags.returnSession,
    disabled: flags.noMasterReturn,
  });
  if (masterReturn) writeMasterReturn(runId, masterReturn);
  const runIdentity = buildRunIdentity({
    runId,
    workflow,
    overrides: identityOverrides(flags, masterReturn),
  });
  const logPath = join(dir, "supervisor.log");
  const childArgs = ["run", workflowPath, "--run-id", runId];
  if (flags.repo) childArgs.push("--repo", resolve(flags.repo));
  if (flags.dangerous) childArgs.push("--allow-dangerous-permissions");
  const identityFlags = [
    ["--title", flags.title],
    ["--repo-shorthand", flags.repoShorthand],
    ["--manager-harness", runIdentity.manager.harness],
    ["--manager-model", runIdentity.manager.model],
    ["--manager-thread-title", runIdentity.manager.threadTitle],
  ];
  for (const [name, value] of identityFlags) if (value) childArgs.push(name, value);
  childArgs.push("--expected-planning-digest", workflow.planning.context_digest);
  const child = spawnDetached(childArgs, logPath, flags.dangerous ? { AGENT_MANAGER_ALLOW_DANGEROUS_PERMISSIONS: "1" } : {});
  let returnWatcher = null;
  if (masterReturn) {
    const returnLog = join(dir, "master-return-supervisor.log");
    try {
      const watcher = spawnDetached(["_watch-master-return", runId], returnLog);
      const watching = {
        ...masterReturn,
        state: "watching",
        watcherPid: watcher.pid,
        watcherStartedAt: new Date().toISOString(),
      };
      writeMasterReturn(runId, watching);
      returnWatcher = {
        state: "watching",
        pid: watcher.pid,
        log: returnLog,
        channel: masterReturnSummary(watching),
      };
    } catch (error) {
      const failed = {
        ...masterReturn,
        state: "failed",
        lastError: `return watcher failed to start: ${error.message}`,
      };
      writeMasterReturn(runId, failed);
      returnWatcher = {
        state: "failed",
        pid: null,
        log: returnLog,
        channel: masterReturnSummary(failed),
      };
    }
  }
  const payload = {
    runId, state: "detached", pid: child.pid,
    agentManagerVersion: AGENT_MANAGER_VERSION,
    identity: runIdentity,
    suggestedThreadTitle: runIdentity.suggestedThreadTitle,
    runtime: workflow.runtime,
    telemetry: join(dir, "status.json"), supervisorLog: logPath,
    statusCommand: `agent-manager status ${runId}`,
    masterReturn: returnWatcher,
  };
  console.log(flags.json ? JSON.stringify(payload) : [
    `runId: ${runId}`, `title: ${runIdentity.displayTitle}`, `agent-manager: v${AGENT_MANAGER_VERSION}`, "state: detached", `pid: ${child.pid}`, `telemetry: ${payload.telemetry}`,
    `runtime: ${formatRuntime(payload.runtime)}`,
    `supervisorLog: ${logPath}`, `status: ${payload.statusCommand}`,
    `masterReturn: ${returnWatcher ? `${returnWatcher.state} (${returnWatcher.channel.host}/${returnWatcher.channel.mode})` : "not configured"}`,
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

function detachShip(flags) {
  if (!flags.detach) {
    throw new Error("ship must use --detach so the host chat does not babysit CI or merge");
  }
  if (!flags.runId) throw new Error("ship requires <runId>");
  const handoff = prepareShipHandoff(flags.runId, flags);
  preflightShipHandoff(handoff);
  const queued = queueShip(flags.runId, handoff);
  const logPath = join(runDir(flags.runId), "ship", "supervisor.log");
  let child;
  try {
    child = spawnDetached(["_ship-run", flags.runId], logPath);
    markShipSupervisor(flags.runId, child.pid);
  } catch (error) {
    blockQueuedShip(flags.runId, error);
    throw error;
  }
  const payload = {
    schema: "agent-manager.ship-launch.v1",
    runId: flags.runId,
    state: "detached",
    phase: "ship",
    approve: handoff.approve,
    runtime: handoff.runtime,
    pid: child.pid,
    telemetry: join(runDir(flags.runId), "status.json"),
    supervisorLog: logPath,
    handoff: queued.handoffPath,
    statusCommand: `agent-manager status ${flags.runId}`,
    watchCommand: `agent-manager watch-signal ${flags.runId}`,
  };
  console.log(flags.json ? JSON.stringify(payload) : [
    `runId: ${flags.runId}`,
    "state: detached",
    "phase: ship",
    `approve: ${handoff.approve}`,
    `runtime: ${formatRuntime(payload.runtime)}`,
    `pid: ${child.pid}`,
    `telemetry: ${payload.telemetry}`,
    `supervisorLog: ${logPath}`,
    `status: ${payload.statusCommand}`,
    `watch-signal: ${payload.watchCommand}`,
  ].join("\n"));
  return payload;
}

async function main() {
  if (cmd === "--version" || cmd === "-v") { console.log(AGENT_MANAGER_VERSION); return; }
  if (!cmd || cmd === "-h" || cmd === "--help") { usage(); process.exitCode = cmd ? 0 : 1; return; }

  if (cmd === "director") {
    const flags = parseDirectorFlags(args.slice(1));
    if (flags.action === "validate") {
      const policy = loadDirectorPolicy(flags.policy, { repoOverride: flags.repo });
      const payload = {
        schema: "agent-manager.director-policy-validation.v1",
        ok: true,
        policy: policy.absPath,
        policyDigest: policy.digest,
        repository: policy.repoRoot,
        mode: policy.autopilot.mode,
        director: policy.director,
      };
      console.log(flags.json ? JSON.stringify(payload) : [
        `valid: ${payload.policy}`,
        `repository: ${payload.repository}`,
        `mode: ${payload.mode}`,
        `director: ${payload.director.harness}/${payload.director.model} (${payload.director.reasoning})`,
        `policy digest: ${payload.policyDigest}`,
      ].join("\n"));
      return;
    }
    if (flags.action === "cycle") {
      const result = await runDirectorCycle({
        policyPath: flags.policy,
        itemsPath: flags.items,
        repoOverride: flags.repo,
        stateRoot: flags.stateDir || undefined,
        cycleId: flags.cycleId,
        dryRun: flags.dryRun,
      });
      console.log(flags.json ? JSON.stringify(result) : [
        `cycle: ${result.cycleId}`,
        `status: ${result.status}${result.replayed ? " (replayed)" : ""}`,
        `repository: ${result.repository}`,
        `director: ${result.director.harness}/${result.director.model} (${result.director.reasoning})`,
        `selected: ${result.selected.length}`,
        `quarantined: ${result.quarantined.length}`,
        `skipped: ${result.skipped.length}`,
        `state: ${result.statePath}`,
        "execution: dry-run only; no workers or shipping actions started",
      ].join("\n"));
      return;
    }
    throw new Error("director requires validate or cycle");
  }

  if (cmd === "run") {
    const flags = parseRunFlags(args.slice(1));
    if (!flags.file) throw new Error("run requires <workflow.yaml>");
    if (!existsSync(resolve(flags.file))) throw new Error("workflow not found: " + resolve(flags.file));
    if (flags.detach) { await detachRun(flags); return; }
    const result = await runWorkflow(resolve(flags.file), {
      runId: flags.runId || undefined,
      repoOverride: flags.repo,
      allowDangerousPermissions: flags.dangerous,
      expectedPlanningDigest: flags.expectedPlanningDigest,
      identityOverrides: identityOverrides(flags, resolveMasterReturn({
        host: flags.returnHost,
        sessionId: flags.returnSession,
        disabled: flags.noMasterReturn,
      })),
    });
    if (flags.json) console.log(JSON.stringify({ runId: result.runId, status: result.status }));
    return;
  }

  if (cmd === "validate") {
    const file = firstPositional(args.slice(1), ["--repo"]);
    if (!file) throw new Error("validate requires <workflow.yaml>");
    const workflow = loadWorkflow(resolve(file), { repoOverride: flagValue("--repo") });
    assertDangerousPermissionApproval(workflow, args.includes("--allow-dangerous-permissions"));
    validateRepository(workflow);
    const planning = assertPlanningReady(workflow);
    if (workflow.goal_refs.length) await assertGoalsExist(workflow.goal_refs);
    const payload = {
      schema: "agent-manager.validation.v1",
      ok: true,
      repo: workflow.repoRoot,
      maxConcurrency: workflow.max_concurrency,
      lanes: workflow.lanes.map(({
        id,
        harness,
        scope,
        read_only: readOnly,
        depends_on: dependsOn,
      }) => ({ id, harness, scope, readOnly, dependsOn })),
      scopeOverrides: workflow.scope_overrides,
      verificationCommands: workflow.verification.commands.length,
      goalRefs: workflow.goal_refs,
      planning,
      delivery: workflow.delivery,
      runtime: workflow.runtime,
    };
    console.log(args.includes("--json")
      ? JSON.stringify(payload)
      : `valid: ${file}\nrepo: ${payload.repo}\nruntime: ${formatRuntime(payload.runtime)}\nlanes: ${payload.lanes.length}`);
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
    console.log(args.includes("--json") ? JSON.stringify(result) : [
      `created: ${result.path}`,
      `planning context: ${result.contextPath}`,
      "next: review the repository and source, complete workflow.planning, then run:",
      `agent-manager validate "${result.path}"`,
    ].join("\n"));
    return;
  }

  if (cmd === "status") {
    const watch = args.includes("--watch");
    const runId = firstPositional(args.slice(1), ["--interval"]) || latestRunId();
    if (watch) { await runMonitor(runId, { intervalMs: Math.max(0.5, Number(flagValue("--interval") || 2)) * 1000 }); return; }
    const status = readStatus(runId);
    if (!status) throw new Error("no status for " + (runId || "(none)"));
    const presented = {
      ...status,
      masterReturn: masterReturnSummary(readMasterReturn(runId)),
    };
    console.log(args.includes("--json") ? JSON.stringify(presented) : formatStatus(presented));
    return;
  }

  if (cmd === "events") {
    const runId = args[1] || latestRunId();
    if (!runId) throw new Error("events requires <runId>");
    const events = readEvents(runId);
    console.log(args.includes("--jsonl") ? events.map((event) => JSON.stringify(event)).join("\n") : JSON.stringify(events));
    return;
  }

  if (cmd === "fleet") {
    const options = parseFleetArgs(args.slice(1));
    if (options.help) {
      console.log(fleetUsage());
      return;
    }
    await runFleet(options);
    return;
  }

  if (cmd === "tokens") {
    const options = parseTokensArgs(args.slice(1));
    if (options.help) {
      console.log(tokensUsage());
      return;
    }
    await runTokens(options);
    return;
  }

  if (cmd === "config") {
    const action = args[1];
    const configPath = flagValue("--config");
    if (action === "init") {
      const result = initAgentManagerConfig({
        configPath: configPath || undefined,
        devRoot: flagValue("--dev-root") || undefined,
        runsRoot: flagValue("--runs-root") || undefined,
        claimsRoot: flagValue("--claims-root") || undefined,
        brainRoot: flagValue("--brain-root") || undefined,
        force: args.includes("--force"),
      });
      const resolved = resolveAgentManagerConfig({ configPath: result.path });
      console.log(args.includes("--json")
        ? JSON.stringify(resolved)
        : `created: ${result.path}\n${formatAgentManagerConfig(resolved)}`);
      return;
    }
    if (action === "show") {
      const resolved = resolveAgentManagerConfig({ configPath: configPath || undefined });
      console.log(args.includes("--json") ? JSON.stringify(resolved) : formatAgentManagerConfig(resolved));
      return;
    }
    throw new Error("config requires init or show");
  }

  if (cmd === "brain") {
    const action = args[1];
    if (action === "init") {
      const result = await ensureBrain();
      console.log(args.includes("--json") ? JSON.stringify(result) : [
        `brain: ${result.root}`,
        `schema version: ${result.schemaVersion}`,
        `history mode: ${result.historyMode}`,
      ].join("\n"));
      return;
    }
    if (action === "status") {
      const repo = flagValue("--repo");
      const intents = await listBrainIntents({ repoRoot: repo ? resolve(repo) : null });
      console.log(args.includes("--json") ? JSON.stringify(intents) : formatBrainIntents(intents));
      return;
    }
    throw new Error("brain requires init or status");
  }

  if (cmd === "goals") {
    await runGoalsCommand(args.slice(1));
    return;
  }

  if (cmd === "goal") {
    await runGoalCommand(args.slice(1));
    return;
  }

  if (cmd === "monitor") { await runMonitor(firstPositional(args.slice(1), ["--interval"]) || latestRunId(), { intervalMs: Math.max(0.5, Number(flagValue("--interval") || 2)) * 1000 }); return; }
  if (cmd === "watch-signal") { await runWatchSignal(firstPositional(args.slice(1), ["--heartbeat-sec", "--poll-ms"]) || latestRunId(), { heartbeatSec: Math.max(5, Number(flagValue("--heartbeat-sec") || 180)), pollMs: Math.max(200, Number(flagValue("--poll-ms") || 2000)) }); return; }

  if (cmd === "_watch-master-return") {
    const runId = args[1];
    if (!runId || !readMasterReturn(runId)) throw new Error("master return watcher requires a configured run");
    await runWatchSignal(runId, {
      heartbeatSec: 180,
      pollMs: 2_000,
      onWake: async (payload, status) => {
        const result = await dispatchMasterReturn(runId, payload, status);
        if (!result.skipped) {
          console.log(`AGENT_MANAGER_MASTER_RETURN_${runId} ${JSON.stringify({
            delivered: result.delivered,
            signaled: result.signaled || false,
            state: result.channel?.state || null,
            attempts: result.channel?.attempts || 0,
            error: result.error || null,
          })}`);
        }
      },
    });
    return;
  }

  if (cmd === "reply") {
    if (!args[1] || !args[2]) throw new Error("reply requires <runId> <laneId>");
    detachReply(args[1], args[2], flagValue("--message"), args.includes("--json"));
    return;
  }
  if (cmd === "_resume-lane") { await resumeLane(args[1], args[2], args[3]); return; }

  if (cmd === "review") {
    const runId = args[1] || latestRunId();
    if (!runId) throw new Error("review requires <runId>");
    const result = buildDeliveryReview(runId, {
      pass: Number(flagValue("--pass") || 1),
      verdict: flagValue("--verdict"),
      reviewer: flagValue("--reviewer"),
      notes: flagValue("--notes"),
    });
    if (flagValue("--verdict")) {
      const reviewedStatus = readStatus(runId);
      await syncBrainStatus(reviewedStatus).catch((error) => {
        reviewedStatus.awareness.lastError = String(error?.message || error);
        writeStatus(runId, reviewedStatus);
      });
    }
    console.log(args.includes("--json") ? JSON.stringify(result) : result.markdown);
    return;
  }

  if (cmd === "delivery-ready") {
    const runId = args[1] || latestRunId();
    if (!runId) throw new Error("delivery-ready requires <runId>");
    const status = readStatus(runId);
    if (!status) throw new Error(`no status for ${runId}`);
    const result = deliveryReadiness(status, { require: flagValue("--require") || "released" });
    console.log(args.includes("--json") ? JSON.stringify(result) : [
      `runId: ${result.runId}`,
      `ready: ${result.ready ? "yes" : "no"}`,
      `required: ${result.requiredState}`,
      `state: ${result.state}`,
    ].join("\n"));
    if (!result.ready) process.exitCode = 2;
    return;
  }

  if (cmd === "next-action") {
    const runId = args[1] || latestRunId();
    if (!runId) throw new Error("next-action requires <runId>");
    const status = readStatus(runId);
    if (!status) throw new Error(`no status for ${runId}`);
    const result = { runId, state: status.state, ...deriveOperatorCadence(status) };
    console.log(args.includes("--json") ? JSON.stringify(result) : [
      `runId: ${runId}`,
      `state: ${status.state}`,
      `stage: ${result.stage}`,
      `transition: ${result.transition}`,
      `next: ${result.nextAction}`,
      `operator input: ${result.operatorInputRequired.length ? result.operatorInputRequired.join(" | ") : "none"}`,
      `template: ${result.template}`,
    ].join("\n"));
    return;
  }

  if (cmd === "ship") {
    detachShip(parseShipFlags(args.slice(1)));
    return;
  }
  if (cmd === "_ship-run") {
    if (!args[1]) throw new Error("_ship-run requires <runId>");
    const handoffPath = join(runDir(args[1]), "ship", "handoff.json");
    const handoff = JSON.parse(readFileSync(handoffPath, "utf8"));
    await runShip(args[1], handoff);
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
  if (cmd === "integrate") { if (!args[1]) throw new Error("integrate requires <runId>"); const status = await integrateRun(args[1]); console.log(args.includes("--json") ? JSON.stringify(status) : formatStatus(status)); return; }

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
  if (cmd === "version") {
    const version = currentVersionInfo();
    console.log(args.includes("--json") ? JSON.stringify(version) : [
      `agent-manager runtime: v${version.runtimeVersion}`,
      `installed files: v${version.installedVersion}`,
      `restart required: ${version.restartRequired ? "yes" : "no"}`,
      ...(version.notice ? [version.notice] : []),
    ].join("\n"));
    return;
  }
  throw new Error("unknown command: " + cmd);
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
