#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cancelRun } from "../src/cancel.mjs";
import { cleanupRun, cleanupStaleRuns } from "../src/cleanup.mjs";
import { formatDoctor, runDoctor } from "../src/doctor.mjs";
import { ensurePrivateDir } from "../src/fs-safe.mjs";
import { listHarnessAdapters } from "../src/harness/index.mjs";
import { initWorkflow } from "../src/init.mjs";
import { formatInstall, hostNames, installHost } from "../src/install.mjs";
import {
  adoptDemoRun,
  createDemo,
  DEFAULT_DEMO_DIR,
  formatDemo,
  listDemoRuns,
  listRunIds,
  markDemoRun,
} from "../src/demo.mjs";
import { integrateRun } from "../src/integrate-run.mjs";
import { assertSafeSlug, IGNORED_PATH_OVERRIDES, RUNS_ROOT, runDir } from "../src/paths.mjs";
import { preflightWorkflow, validateRepository } from "../src/preflight.mjs";
import { assertPlanningReady } from "../src/planning.mjs";
import { ratifyLane } from "../src/ratify.mjs";
import { prepareReply, resumeLane } from "../src/reply.mjs";
import { buildDeliveryReview, closeoutRun, fileRunArtifacts } from "../src/review.mjs";
import { formatReconciliation, parseReconcileArgs, reconcileRun } from "../src/reconcile.mjs";
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
import { formatStatus, isTerminalState, latestRunId, readEvents, readStatus, writeStatus } from "../src/status.mjs";
import { runWatchSignal } from "../src/watch-signal.mjs";
import { assertDangerousPermissionApproval, loadWorkflow } from "../src/workflow.mjs";
import { formatRuntime } from "../src/runtime.mjs";
import { deliveryReadiness } from "../src/delivery.mjs";
import { deriveOperatorCadence } from "../src/cadence.mjs";
import { fleetUsage, parseFleetArgs, runFleet } from "../src/fleet.mjs";
import { parseTokensArgs, runTokens, tokensUsage } from "../src/tokens.mjs";
import { parseUiArgs, runUi, uiUsage } from "../src/ui-server.mjs";
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
  formatIgnoredPathOverrides,
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
  authorizedShipOptions,
  consumeAuthorization,
  createAuthorizationGrant,
  inspectAuthorization,
  revokeAuthorization,
} from "../src/authorization.mjs";
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
    "  agent-manager init [--repo <path>] [--request <text>] [--harnesses <names>]",
    "    default: one claude implementation lane; multiple lanes require an explicit list",
    "  agent-manager demo [--dir <path>] [--no-run] [--json]",
    "  agent-manager status [runId] [--watch] [--json]",
    "  agent-manager events <runId> [--jsonl]",
    "  agent-manager monitor [runId] [--interval <sec>]",
    "  agent-manager fleet [runId] [--active] [--since 24h] [--stream|--once|--json]",
    "  agent-manager tokens [--since 7d] [--by day|model|repo|source] [--watch] [--json]",
    "  agent-manager ui [--port 4317] [--host 127.0.0.1] [--no-open] [--json]",
    "    optional read-only dashboard; localhost only, no daemon",
    "  agent-manager config init [--dev-root <path>] [--runs-root <path>] [--claims-root <path>] [--brain-root <path>]",
    "  agent-manager config show [--json]",
    "  agent-manager director validate --policy <file> [--repo <path>] [--json]",
    "  agent-manager director cycle --policy <file> --items <file> --dry-run [options] [--json]",
    "  agent-manager director go --policy <file> --items <file> --detach [options] [--json]",
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
    "  agent-manager watch-signal [runId] [--heartbeat-sec 180] [--poll-ms 2000] [--notify]",
    "    --notify: OS toast on needs-input, blocked, terminal, and ship events",
    "  agent-manager reply <runId> <laneId> --message <text> [--force] [--extend-scope <globs>] [--by <id>] [--json]",
    "    --force: answer a failed lane that kept no needs-input marker",
    "    --extend-scope: grant extra comma-separated scope globs for the resumed lane",
    "  agent-manager ratify <runId> <laneId> --reason <text> [--by <id>] [--json]",
    "    records Master acceptance of a guardrail-failed lane's violations so",
    "    `integrate --force-lanes failed-with-snapshot` may fold it",
    "  agent-manager review <runId> [--pass 1|2] [--verdict <decision> --reviewer <id> [--reviewer-role manager] [--automation-policy <file>] [--notes <text>]] [--recovered] [--json]",
    "    --recovered: record a verdict on a blocked, failed, or cancelled run",
    "  agent-manager closeout <runId> --operator <id> [--reason <text>] [--no-artifacts] [--json]",
    "    accept-without-ship terminal: files run outputs, ends the run as `filed`",
    "  agent-manager file-artifacts <runId> [--json]",
    "  agent-manager next-action <runId> [--json]",
    "  agent-manager delivery-ready <runId> [--require merged|released] [--json]",
    "  agent-manager reconcile <runId> [--provider github] [--json]",
    "    verifies provider PR/check/tag ancestry evidence before repairing a stale delivery ledger",
    "  agent-manager authorization create <runId> --level through-pr|all --operator <id> --expires-at <iso> --risk <level> --risk-ceiling <level> --provider-mode <mode> [ship inputs] [--json]",
    "  agent-manager authorization inspect <runId> [--json]",
    "  agent-manager authorization revoke <runId> --operator <id> [--reason <text>] [--json]",
    "  agent-manager ship <runId> --approve all|through-pr --detach [options] [--json]",
    "  agent-manager ship <runId> --authorized --detach [--json]",
    "    options: --commit-message <text> --version <semver> --summary <text>",
    "             --repo <path> --worktree <path> --branch <ref> --base <ref>",
    "             --remote <name> --pr <url|number> --target <delivery-target-id>",
    "             --poll-sec <n> --timeout-sec <n> --check-grace-sec <n>",
    "  agent-manager cancel <runId> [--remove-worktrees]",
    "  agent-manager cleanup <runId> [--keep-logs] | --stale [--older-than-days 30]",
    "  agent-manager integrate <runId> [--force-lanes done,failed-with-snapshot] [--json]",
    "    --force-lanes: also fold failed lanes whose end-of-lane snapshot committed",
    "                   guardrail-failed lanes need `ratify` first",
    "  agent-manager install claude|codex|cursor [--project <path>] [--force] [--json]",
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
    authorized: false,
    providerMode: null,
    risk: null,
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
    ["--provider-mode", "providerMode"],
    ["--risk", "risk"],
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--detach") flags.detach = true;
    else if (arg === "--authorized") flags.authorized = true;
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

function parseAuthorizationFlags(rest) {
  const action = rest[0];
  if (!["create", "inspect", "revoke"].includes(action)) {
    throw new Error("authorization requires create, inspect, or revoke");
  }
  const valued = new Map([
    ["--level", "level"], ["--operator", "operator"], ["--operator-source", "operatorSource"],
    ["--expires-at", "expiresAt"], ["--risk", "risk"], ["--risk-ceiling", "riskCeiling"],
    ["--provider-mode", "providerMode"], ["--target", "target"], ["--repo", "repo"],
    ["--worktree", "worktree"], ["--branch", "branch"], ["--base", "base"],
    ["--remote", "remote"], ["--pr", "pr"], ["--commit-message", "commitMessage"],
    ["--version", "version"], ["--summary", "summary"], ["--poll-sec", "pollSec"],
    ["--timeout-sec", "timeoutSec"], ["--check-grace-sec", "checkGraceSec"],
    ["--retry-attempts", "retryAttempts"], ["--retry-base-ms", "retryBaseMs"],
    ["--reason", "reason"],
  ]);
  const flags = { action, runId: null, json: false };
  for (let index = 1; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") flags.json = true;
    else if (valued.has(arg)) {
      const value = rest[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      flags[valued.get(arg)] = value;
    } else if (arg.startsWith("-")) throw new Error(`unknown authorization flag: ${arg}`);
    else if (flags.runId) throw new Error(`unexpected authorization argument: ${arg}`);
    else flags.runId = arg;
  }
  if (!flags.runId) throw new Error(`authorization ${action} requires <runId>`);
  return flags;
}

function runAuthorizationCommand(rest) {
  const flags = parseAuthorizationFlags(rest);
  let status = readStatus(flags.runId);
  if (!status) throw new Error(`no status for ${flags.runId}`);
  let result;
  if (flags.action === "create") {
    result = createAuthorizationGrant(status, flags);
    status.authorization = result.summary;
    writeStatus(flags.runId, status);
  } else if (flags.action === "revoke") {
    result = revokeAuthorization(status, flags);
    status.authorization = result.summary;
    writeStatus(flags.runId, status);
  } else {
    result = inspectAuthorization(status);
  }
  const summary = result.summary;
  const publicResult = {
    schema: "agent-manager.authorization-command.v1",
    action: flags.action,
    runId: flags.runId,
    authorization: summary,
  };
  console.log(flags.json ? JSON.stringify(publicResult) : [
    `runId: ${flags.runId}`,
    `authorization: ${summary?.state || "none"}`,
    `valid: ${summary?.valid ? "yes" : "no"}`,
    `level: ${summary?.level || "-"}`,
    `grant: ${summary?.grantDigest || "-"}`,
    `receipt: ${summary?.receiptDigest || "-"}`,
    `expires: ${summary?.expiresAt || "-"}`,
    `failure: ${summary?.failureCode || "none"}`,
    `next: ${summary?.nextAction || "none"}`,
  ].join("\n"));
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
    go: action === "go",
    detach: false,
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
    else if (arg === "--detach") flags.detach = true;
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

function launchDirectorDraft({ runId, draft, policy }) {
  const existing = readStatus(runId);
  if (existing) {
    return {
      state: "detached",
      replayed: true,
      telemetry: join(runDir(runId), "status.json"),
    };
  }
  const launched = spawnSync(process.execPath, [
    selfPath, "run", draft.path, "--detach", "--json", "--run-id", runId,
    "--manager-harness", policy.director.harness,
    "--manager-model", policy.director.model,
    "--title", `Director ${draft.draftId}`,
  ], { encoding: "utf8", windowsHide: true });
  if (launched.status !== 0) {
    throw new Error(`Director go failed to detach ${draft.draftId}: ${String(launched.stderr || launched.stdout).trim()}`);
  }
  return { ...JSON.parse(launched.stdout), replayed: false };
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

function parseNamedArgs(rest, { values = {}, booleans = {}, label = "goal" } = {}) {
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
    if (arg.startsWith("-")) throw new Error(`unknown ${label} flag: ${arg}`);
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
  const topologyWarnings = workflow.lint_warnings.filter(
    (warning) => warning.code === "fully-serialized-multi-lane",
  );
  if (!flags.quiet && !flags.json) {
    for (const warning of topologyWarnings) console.error(`warning: ${warning.message}`);
  }
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
    topology: workflow.topology,
    warnings: topologyWarnings,
    telemetry: join(dir, "status.json"), supervisorLog: logPath,
    statusCommand: `agent-manager status ${runId}`,
    masterReturn: returnWatcher,
  };
  if (!flags.quiet) {
    console.log(flags.json ? JSON.stringify(payload) : [
      `runId: ${runId}`, `title: ${runIdentity.displayTitle}`, `agent-manager: v${AGENT_MANAGER_VERSION}`, "state: detached", `pid: ${child.pid}`, `telemetry: ${payload.telemetry}`,
      `runtime: ${formatRuntime(payload.runtime)}`,
      `lanes: ${workflow.lanes.length}`,
      `configured concurrency: ${workflow.max_concurrency}`,
      `effective parallelism: ${workflow.topology.effectiveParallelism}`,
      `fully serialized: ${workflow.topology.fullySerialized ? "yes" : "no"}`,
      `supervisorLog: ${logPath}`, `status: ${payload.statusCommand}`,
      `masterReturn: ${returnWatcher ? `${returnWatcher.state} (${returnWatcher.channel.host}/${returnWatcher.channel.mode})` : "not configured"}`,
      `monitor: agent-manager monitor ${runId}`, `watch-signal: agent-manager watch-signal ${runId}`,
    ].join("\n"));
  }
  return payload;
}

function detachReply(runId, laneId, message, json, {
  force = false,
  extendScope = [],
  by = null,
} = {}) {
  const prepared = prepareReply(runId, laneId, message, { force, extendScope, by });
  const laneDir = join(runDir(runId), assertSafeSlug(laneId, "lane id"));
  const logPath = join(laneDir, `resume-supervisor-${prepared.lane.attempt}.log`);
  let child;
  try {
    child = spawnDetached(["_resume-lane", runId, laneId, prepared.messagePath], logPath);
  } catch (error) {
    prepared.lane.state = prepared.previousLaneState || "blocked";
    prepared.lane.needsInput = prepared.previousNeedsInput;
    prepared.lane.lastActivity = "resume supervisor failed to start";
    prepared.status.state = prepared.previousRunState || "blocked";
    prepared.status.endedAt = null;
    writeStatus(runId, prepared.status);
    throw error;
  }
  prepared.lane.resumeSupervisorPid = child.pid;
  prepared.status.supervisor = { pid: child.pid, startedAt: new Date().toISOString(), kind: "resume" };
  writeStatus(runId, prepared.status);
  const payload = { runId, laneId, state: "running", sessionId: prepared.lane.sessionId, attempt: prepared.lane.attempt, pid: child.pid, scopeExtensions: prepared.scopeExtensions, telemetry: join(runDir(runId), "status.json"), supervisorLog: logPath };
  console.log(json ? JSON.stringify(payload) : [`runId: ${runId}`, `laneId: ${laneId}`, "state: running", `sessionId: ${prepared.lane.sessionId}`, `telemetry: ${payload.telemetry}`].join("\n"));
}

function detachShip(flags) {
  if (!flags.detach) {
    throw new Error("ship must use --detach so the host chat does not babysit CI or merge");
  }
  if (!flags.runId) throw new Error("ship requires <runId>");
  let authorization = null;
  let authorizationStatus = null;
  let handoff;
  if (flags.authorized) {
    const overrides = Object.entries(flags).filter(([key, value]) =>
      !["runId", "detach", "json", "authorized"].includes(key) && value != null);
    if (overrides.length) {
      throw new Error(`--authorized reads the immutable grant manifest; remove overrides: ${overrides.map(([key]) => key).join(", ")}`);
    }
    const status = readStatus(flags.runId);
    if (!status) throw new Error(`no status for ${flags.runId}`);
    authorizationStatus = status;
    const options = authorizedShipOptions(status);
    handoff = prepareShipHandoff(flags.runId, options);
    handoff.providerMode = options.providerMode;
    handoff.risk = options.risk;
    handoff.permittedMutations = options.permittedMutations;
  } else {
    handoff = prepareShipHandoff(flags.runId, flags);
  }
  preflightShipHandoff(handoff);
  if (authorizationStatus) {
    authorization = consumeAuthorization(authorizationStatus, handoff);
    handoff.authorization = {
      grantDigest: authorization.receipt.grantDigest,
      receiptDigest: authorization.receipt.receiptDigest,
      executionDigest: authorization.receipt.executionDigest,
    };
  }
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
    authorization: handoff.authorization ? {
      grantDigest: handoff.authorization.grantDigest,
      receiptDigest: handoff.authorization.receiptDigest,
    } : null,
  };
  console.log(flags.json ? JSON.stringify(payload) : [
    `runId: ${flags.runId}`,
    "state: detached",
    "phase: ship",
    `approve: ${handoff.approve}`,
    ...(handoff.authorization ? [`authorization: consumed (${handoff.authorization.receiptDigest})`] : []),
    `runtime: ${formatRuntime(payload.runtime)}`,
    `pid: ${child.pid}`,
    `telemetry: ${payload.telemetry}`,
    `supervisorLog: ${logPath}`,
    `status: ${payload.statusCommand}`,
    `watch-signal: ${payload.watchCommand}`,
  ].join("\n"));
  return payload;
}

function warnIgnoredPathOverrides() {
  const message = formatIgnoredPathOverrides(IGNORED_PATH_OVERRIDES);
  if (!message) return;
  console.error(message);
}

async function main() {
  if (cmd === "--version" || cmd === "-v") { console.log(AGENT_MANAGER_VERSION); return; }
  if (!cmd || cmd === "-h" || cmd === "--help") { usage(); process.exitCode = cmd ? 0 : 1; return; }

  if (cmd === "director") {
    warnIgnoredPathOverrides();
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
        automationPolicyDigest: policy.automationPolicy?.digest || null,
      };
      console.log(flags.json ? JSON.stringify(payload) : [
        `valid: ${payload.policy}`,
        `repository: ${payload.repository}`,
        `mode: ${payload.mode}`,
        `director: ${payload.director.harness}/${payload.director.model} (${payload.director.reasoning})`,
        `policy digest: ${payload.policyDigest}`,
        `automation policy: ${payload.automationPolicyDigest || "manual Ship Gate"}`,
      ].join("\n"));
      return;
    }
    if (["cycle", "go"].includes(flags.action)) {
      if (flags.action === "go" && !flags.detach) {
        throw new Error("director go requires --detach");
      }
      const result = await runDirectorCycle({
        policyPath: flags.policy,
        itemsPath: flags.items,
        repoOverride: flags.repo,
        stateRoot: flags.stateDir || undefined,
        cycleId: flags.cycleId,
        dryRun: flags.dryRun,
        go: flags.go,
        launchDraft: flags.go ? launchDirectorDraft : null,
      });
      const draftLines = (result.drafts || []).flatMap((draft) => [
        `draft: ${draft.path}${draft.validateOk ? "" : " (invalid)"}`,
        `kickoff: ${draft.kickoff}`,
        ...(draft.automationPolicy ? [
          `automation policy: ${draft.automationPolicy.path} (${draft.automationPolicy.digest})`,
          `accepted review: ${draft.review}`,
        ] : []),
      ]);
      console.log(flags.json ? JSON.stringify(result) : [
        `cycle: ${result.cycleId}`,
        `status: ${result.status}${result.replayed ? " (replayed)" : ""}`,
        `repository: ${result.repository}`,
        `director: ${result.director.harness}/${result.director.model} (${result.director.reasoning})`,
        `selected: ${result.selected.length}`,
        `quarantined: ${result.quarantined.length}`,
        `skipped: ${result.skipped.length}`,
        `drafts: ${(result.drafts || []).length}`,
        ...draftLines,
        `state: ${result.statePath}`,
        result.go
          ? `execution: detached ${result.launches.map((launch) => launch.runId).join(", ")}; independent Delivery Review owns the policy handoff`
          : "execution: proposal/dry-run; Master kickoff via run --detach (no auto launch)",
      ].join("\n"));
      return;
    }
    throw new Error("director requires validate, cycle, or go");
  }

  if (cmd === "run") {
    warnIgnoredPathOverrides();
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
      laneCount: workflow.lanes.length,
      configuredConcurrency: workflow.max_concurrency,
      maxConcurrency: workflow.max_concurrency,
      effectiveParallelism: workflow.topology.effectiveParallelism,
      fullySerialized: workflow.topology.fullySerialized,
      topology: workflow.topology,
      lanes: workflow.lanes.map(({
        id,
        harness,
        scope,
        read_only: readOnly,
        depends_on: dependsOn,
      }) => ({ id, harness, scope, readOnly, dependsOn })),
      scopeOverrides: workflow.scope_overrides,
      warnings: workflow.lint_warnings,
      verificationCommands: workflow.verification.commands.length,
      goalRefs: workflow.goal_refs,
      planning,
      delivery: workflow.delivery,
      runtime: workflow.runtime,
    };
    console.log(args.includes("--json") ? JSON.stringify(payload) : [
      `valid: ${file}`,
      `repo: ${payload.repo}`,
      `runtime: ${formatRuntime(payload.runtime)}`,
      `lanes: ${payload.laneCount}`,
      `configured concurrency: ${payload.configuredConcurrency}`,
      `effective parallelism: ${payload.effectiveParallelism}`,
      `fully serialized: ${payload.fullySerialized ? "yes" : "no"}`,
      ...(payload.topology.recommendation
        ? [`recommendation: ${payload.topology.recommendation}`]
        : []),
      ...payload.warnings
        .filter((warning) => warning.code !== "fully-serialized-multi-lane")
        .map((warning) => `warning: ${warning.message}`),
    ].join("\n"));
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
    const harnessFlag = flagValue("--harnesses");
    const harnesses = harnessFlag
      ? harnessFlag.split(",").map((value) => value.trim()).filter(Boolean)
      : undefined;
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

  if (cmd === "ui") {
    const options = parseUiArgs(args.slice(1));
    if (options.help) {
      console.log(uiUsage());
      return;
    }
    await runUi(options);
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
  if (cmd === "watch-signal") { await runWatchSignal(firstPositional(args.slice(1), ["--heartbeat-sec", "--poll-ms"]) || latestRunId(), { heartbeatSec: Math.max(5, Number(flagValue("--heartbeat-sec") || 180)), pollMs: Math.max(200, Number(flagValue("--poll-ms") || 2000)), notify: args.includes("--notify") ? true : null }); return; }

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
    adoptDemoRun(runDir(args[1]));
    detachReply(args[1], args[2], flagValue("--message"), args.includes("--json"), {
      force: args.includes("--force"),
      extendScope: flagValue("--extend-scope") || [],
      by: flagValue("--by"),
    });
    return;
  }
  if (cmd === "_resume-lane") {
    adoptDemoRun(runDir(args[1]));
    await resumeLane(args[1], args[2], args[3]);
    return;
  }

  if (cmd === "ratify") {
    if (!args[1] || !args[2]) throw new Error("ratify requires <runId> <laneId>");
    const reason = flagValue("--reason");
    if (!reason) throw new Error("ratify requires --reason <text>");
    const result = ratifyLane(args[1], args[2], { reason, by: flagValue("--by") });
    console.log(args.includes("--json") ? JSON.stringify(result) : [
      `runId: ${result.runId}`,
      `laneId: ${result.laneId} (${result.laneState})`,
      `ratified by: ${result.by} at ${result.at}`,
      `reason: ${result.reason}`,
      `violations: ${result.violations.join("; ")}`,
      "next: agent-manager integrate " + result.runId + " --force-lanes done,failed-with-snapshot",
    ].join("\n"));
    return;
  }

  if (cmd === "review") {
    const runId = firstPositional(args.slice(1), ["--pass", "--verdict", "--reviewer", "--reviewer-role", "--automation-policy", "--notes"])
      || latestRunId();
    if (!runId) throw new Error("review requires <runId>");
    const result = buildDeliveryReview(runId, {
      pass: Number(flagValue("--pass") || 1),
      verdict: flagValue("--verdict"),
      reviewer: flagValue("--reviewer"),
      reviewerRole: flagValue("--reviewer-role"),
      automationPolicy: flagValue("--automation-policy"),
      notes: flagValue("--notes"),
      recovered: args.includes("--recovered"),
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

  if (cmd === "closeout") {
    const runId = firstPositional(args.slice(1), ["--operator", "--reason"]) || latestRunId();
    if (!runId) throw new Error("closeout requires <runId>");
    const operator = flagValue("--operator");
    if (!operator) throw new Error("closeout requires --operator <id>");
    const result = await closeoutRun(runId, {
      operator,
      reason: flagValue("--reason"),
      fileArtifacts: !args.includes("--no-artifacts"),
    });
    const filedStatus = readStatus(runId);
    await syncBrainStatus(filedStatus).catch((error) => {
      filedStatus.awareness.lastError = String(error?.message || error);
      writeStatus(runId, filedStatus);
    });
    console.log(args.includes("--json") ? JSON.stringify(result) : [
      `runId: ${result.runId}`,
      `state: ${result.state}`,
      `operator: ${result.filed?.operator || "-"}`,
      `reason: ${result.filed?.reason || "-"}`,
      `closeout: ${result.closeout?.state || "skipped"}`,
      `artifacts: ${result.closeout?.artifactCount ?? 0}`,
      `bundle: ${result.closeout?.bundleRoot || "-"}`,
      `goal links: ${result.closeout?.links?.length
        ? result.closeout.links.map((link) => `${link.goalId} -> ${link.linkId}`).join(", ")
        : "none"}`,
      `goals awaiting advancement: ${result.goalHints.length
        ? result.goalHints.map((hint) => `${hint.id} (${hint.lifecycle})`).join(", ")
        : "none"}`,
      ...(result.closeout?.errors || []).map((error) => `error: ${error.goalId ? `${error.goalId}: ` : ""}${error.message}`),
    ].join("\n"));
    if (result.closeout?.errors?.length) process.exitCode = 1;
    return;
  }

  if (cmd === "file-artifacts") {
    const runId = args[1] || latestRunId();
    if (!runId) throw new Error("file-artifacts requires <runId>");
    const result = await fileRunArtifacts(runId);
    console.log(args.includes("--json") ? JSON.stringify(result) : [
      `runId: ${result.runId}`,
      `closeout: ${result.state}`,
      `artifact reference: ${result.artifactRef}`,
      `artifacts: ${result.artifactCount}`,
      `bundle: ${result.bundleRoot}`,
      `manifest: ${result.manifest}`,
      `goal links: ${result.links.length
        ? result.links.map((link) => `${link.goalId} -> ${link.linkId} (${link.action})`).join(", ")
        : "none"}`,
      ...result.warnings.map((warning) => `warning: ${warning}`),
      ...result.errors.map((error) => `error: ${error.goalId ? `${error.goalId}: ` : ""}${error.message}`),
    ].join("\n"));
    if (result.errors.length) process.exitCode = 1;
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

  if (cmd === "reconcile") {
    const flags = parseReconcileArgs(args.slice(1));
    const result = await reconcileRun(flags.runId);
    console.log(flags.json ? JSON.stringify(result) : formatReconciliation(result));
    return;
  }

  if (cmd === "authorization") {
    runAuthorizationCommand(args.slice(1));
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
      `goals awaiting advancement: ${result.goalHints.length
        ? result.goalHints.map((hint) => `${hint.id} (${hint.lifecycle})`).join(", ")
        : "none"}`,
    ].join("\n"));
    return;
  }

  if (cmd === "ship") {
    warnIgnoredPathOverrides();
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
  if (cmd === "integrate") {
    if (!args[1]) throw new Error("integrate requires <runId>");
    const status = await integrateRun(args[1], { forceLanes: flagValue("--force-lanes") || [] });
    console.log(args.includes("--json") ? JSON.stringify(status) : formatStatus(status));
    return;
  }

  if (cmd === "install") {
    const host = args[1];
    if (!host || !hostNames().includes(host)) {
      throw new Error(`install requires one of: ${hostNames().join(", ")}`);
    }
    const installFlags = parseNamedArgs(args.slice(2), {
      values: { "--project": { key: "project" } },
      booleans: { "--force": "force", "--json": "json" },
      label: "install",
    });
    if (installFlags.positionals.length) {
      throw new Error(`unexpected install argument: ${installFlags.positionals[0]}`);
    }
    if (installFlags.project?.startsWith("-")) throw new Error("--project requires a path");
    const result = installHost(host, {
      project: installFlags.project,
      force: installFlags.force,
    });
    console.log(installFlags.json ? JSON.stringify(result) : formatInstall(result));
    return;
  }

  if (cmd === "demo") {
    const demoFlags = parseNamedArgs(args.slice(1), {
      values: { "--dir": { key: "dir" } },
      booleans: { "--no-run": "noRun", "--json": "json" },
      label: "demo",
    });
    if (demoFlags.positionals.length) {
      throw new Error(`unexpected demo argument: ${demoFlags.positionals[0]}`);
    }
    if (demoFlags.dir?.startsWith("-")) throw new Error("--dir requires a path");
    const demoRepo = resolve(demoFlags.dir || DEFAULT_DEMO_DIR);
    // Match both the durable marker and the repository path. The path fallback
    // closes the tiny launch-to-marker window if a prior CLI process exited
    // after detaching the supervisor but before recording its demo marker.
    const priorIds = new Set(listDemoRuns(RUNS_ROOT));
    for (const runId of listRunIds(RUNS_ROOT)) {
      const status = readStatus(runId);
      if (status?.repo && resolve(status.repo) === demoRepo) priorIds.add(runId);
    }
    const priorRuns = [...priorIds]
      .map((runId) => ({ runId, status: readStatus(runId) }))
      .filter(({ status }) => status?.repo && resolve(status.repo) === demoRepo);
    const retired = [];
    for (const { runId, status } of priorRuns) {
      if (isTerminalState(status.state)) continue;
      try {
        await cancelRun(runId, { removeWorktrees: true });
      } catch (cleanupError) {
        try {
          await cancelRun(runId);
        } catch (cancelError) {
          throw new Error(
            `could not retire previous demo run ${runId}: ${cancelError.message}; ` +
            `initial cleanup error: ${cleanupError.message}`,
          );
        }
      }
      retired.push(runId);
    }

    const scaffold = createDemo({ dir: demoRepo });
    if (demoFlags.noRun) {
      const result = { ...scaffold, retiredRuns: retired };
      console.log(demoFlags.json ? JSON.stringify(result) : formatDemo(scaffold, { retired }));
      return;
    }

    const previousDemoOptIn = process.env.AGENT_MANAGER_DEMO;
    let launched;
    try {
      process.env.AGENT_MANAGER_DEMO = "1";
      const runFlags = parseRunFlags([scaffold.workflowPath, "--detach"]);
      runFlags.quiet = true;
      launched = await detachRun(runFlags);
    } finally {
      if (previousDemoOptIn === undefined) delete process.env.AGENT_MANAGER_DEMO;
      else process.env.AGENT_MANAGER_DEMO = previousDemoOptIn;
    }
    markDemoRun(runDir(launched.runId));
    const result = { ...scaffold, runId: launched.runId, retiredRuns: retired };
    console.log(demoFlags.json
      ? JSON.stringify(result)
      : formatDemo(scaffold, { launched: launched.runId, retired }));
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

main().catch((error) => {
  const structured = args.includes("--json") && typeof error?.toJSON === "function";
  console.error(structured ? JSON.stringify(error.toJSON()) : error?.stack || error);
  process.exitCode = 1;
});
