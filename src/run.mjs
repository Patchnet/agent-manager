import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  rmSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  assertDangerousPermissionApproval,
  lanePrompt,
  loadWorkflow,
} from "./workflow.mjs";
import {
  claimLanes,
  releaseLane,
  renewLane,
} from "./claim.mjs";
import {
  addWorktree,
  assertWorktreeIdentity,
  inheritIgnoredAgentFiles,
  removeWorktree,
  resolveGitRef,
} from "./worktree.mjs";
import { deriveRunState, readStatus, writeStatus } from "./status.mjs";
import { createDeliveryStatus, markWorkersComplete } from "./delivery.mjs";
import { getHarnessAdapter } from "./harness/index.mjs";
import { buildRunIdentity } from "./identity.mjs";
import { AGENT_MANAGER_VERSION, ENGINE_IDENTITY } from "./version.mjs";
import { writeReport } from "./report.mjs";
import { integrateLanes } from "./integrate.mjs";
import { runSetup } from "./verification.mjs";
import { mergeDependencyBranches, snapshotLaneAtEnd } from "./lane-snapshot.mjs";
import { assertSafeSlug, runDir } from "./paths.mjs";
import { ensurePrivateDir, writePrivateFile } from "./fs-safe.mjs";
import { preflightSelectedHarnesses, diagnoseHarnessFailure } from "./preflight.mjs";
import { validateLaneCompletion } from "./completion.mjs";
import { inspectSupervision } from "./supervision.mjs";
import { parseEffort } from "./harness/options.mjs";
import {
  createPolicyEventInspector,
  currentHead,
  inspectInitialRepo,
  validateLaneGuardrails,
} from "./guardrails.mjs";

const CLAIM_RENEW_INTERVAL_MS = 5 * 60 * 1000;
const EXTERNAL_STATE_POLL_MS = 250;

export function newRunId() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp =
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "-" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds());
  return "run-" + stamp + "-" + randomBytes(4).toString("hex");
}

function scopeList(scope) {
  return Array.isArray(scope)
    ? scope
    : String(scope).split(",").map((value) => value.trim()).filter(Boolean);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}


function cancellationRequested(runId) {
  if (existsSync(join(runDir(runId), "cancelled.json"))) return true;
  return readStatus(runId)?.state === "cancelled";
}

function releaseLaneClaim(status, lane) {
  if (!lane.branch) return;
  if (["released", "skipped", "advisory-failed", "release-failed"].includes(lane.claim?.state)) {
    return;
  }
  const released = releaseLane({
    repo: status.repo,
    branch: lane.branch,
    mode: status.claimMode,
  });
  lane.claim = {
    state: released.ok ? "released" : "release-failed",
    at: new Date().toISOString(),
  };
}

function applyGuardrails(lane, laneConfig, workflow) {
  const check = validateLaneGuardrails({
    worktree: lane.worktree,
    scope: lane.scope,
    scopeExtensions: lane.scopeExtensions,
    readOnlyScope: lane.readOnly,
    baseCommit: lane.baseCommit,
    policy: workflow.policy,
  });
  lane.changedFiles = check.changedFiles;
  lane.scopeViolations = check.scopeViolations;
  lane.readOnlyViolations = check.readOnlyViolations;
  lane.portableScriptViolations = check.portableScriptViolations;
  lane.policyViolations = [
    ...(lane.policyViolations || []),
    ...check.policyViolations,
  ];
  if (!check.ok) {
    lane.state = "failed";
    if (check.readOnlyViolations.length) {
      lane.lastActivity = "read-only violation: " + check.readOnlyViolations.join(", ");
    } else if (check.scopeViolations.length) {
      lane.lastActivity = "scope violation: " + check.scopeViolations.join(", ");
    } else {
      lane.lastActivity = check.policyViolations.join("; ");
    }
    return;
  }
  validateLaneCompletion(lane, laneConfig);
}

function syncExternalLaneStates(laneStates, diskStatus) {
  if (!diskStatus?.lanes) return false;
  let changed = false;
  for (const lane of laneStates) {
    const diskLane = diskStatus.lanes.find((item) => item.id === lane.id);
    if (!diskLane) continue;
    const before = JSON.stringify({
      state: lane.state,
      attempt: lane.attempt,
      exitCode: lane.exitCode,
      needsInput: lane.needsInput,
    });
    if (
      lane.state === "blocked" &&
      Number(diskLane.attempt || 1) > Number(lane.attempt || 1)
    ) {
      Object.assign(lane, diskLane);
      lane.externalSupervisor = true;
    } else if (lane.externalSupervisor) {
      Object.assign(lane, diskLane);
    }
    const after = JSON.stringify({
      state: lane.state,
      attempt: lane.attempt,
      exitCode: lane.exitCode,
      needsInput: lane.needsInput,
    });
    changed ||= before !== after;
  }
  return changed;
}

function dependencyState(lane, laneStates) {
  const dependencies = lane.dependsOn.map((id) =>
    laneStates.find((candidate) => candidate.id === id),
  );
  const failed = dependencies.filter((item) =>
    ["failed", "cancelled"].includes(item?.state),
  );
  const blocked = dependencies.filter((item) =>
    ["blocked", "dependency-waiting"].includes(item?.state),
  );
  return {
    dependencies,
    ready: dependencies.every((item) => item?.state === "done"),
    failed,
    blocked,
  };
}

async function waitForExternalProgress(runId, laneStates) {
  const signature = JSON.stringify(
    laneStates.map((lane) => [lane.id, lane.state, lane.attempt, lane.exitCode]),
  );
  while (!cancellationRequested(runId)) {
    await sleep(EXTERNAL_STATE_POLL_MS);
    const disk = readStatus(runId);
    const next = JSON.stringify(
      (disk?.lanes || []).map((lane) => [lane.id, lane.state, lane.attempt, lane.exitCode]),
    );
    if (next !== signature) {
      syncExternalLaneStates(laneStates, disk);
      return;
    }
  }
}

export async function runWorkflow(workflowPath, {
  runId: forcedId,
  repoOverride = null,
  allowDangerousPermissions = false,
  identityOverrides = {},
} = {}) {
  const workflow = loadWorkflow(workflowPath, { repoOverride });
  assertDangerousPermissionApproval(workflow, allowDangerousPermissions);
  const immutableBaseCommit = resolveGitRef(workflow.repoRoot, workflow.base_ref);
  const harnessChecks = preflightSelectedHarnesses(workflow);
  const runId = assertSafeSlug(forcedId || newRunId(), "run id");
  const identity = buildRunIdentity({ runId, workflow, overrides: identityOverrides });
  const dir = runDir(runId);
  ensurePrivateDir(dir);
  const lockPath = join(dir, "supervisor.lock");
  let lockFd;
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    throw new Error(`run ${runId} is already active or its lock exists: ${error.message}`);
  }
  copyFileSync(workflow.absPath, join(dir, "workflow.yaml"));
  chmodSync(join(dir, "workflow.yaml"), 0o600);

  const startedAt = new Date().toISOString();
  const runtime = workflow.runtime;
  const initialRepo = inspectInitialRepo(workflow.repoRoot);
  const laneStates = workflow.lanes.map((lane) => ({
    id: lane.id,
    kind: lane.kind,
    harness: lane.harness || workflow.harness_default,
    modelRequested: lane.model || workflow.model_default || null,
    modelObserved: null,
    harnessOptions: { ...lane.harness_options },
    effortObserved: null,
    permissionMode: lane.permission_mode,
    allowedTools: [...lane.allowed_tools],
    allowedToolsSource: lane.allowed_tools_source || "none",
    setup: { state: lane.setup.commands.length ? "pending" : "not-configured", commands: [] },
    repo: workflow.repo,
    branch: "am/" + runId + "/" + lane.id,
    scope: scopeList(lane.scope).join(", "),
    scopeExtensions: [],
    expectedOutputs: [...lane.expected_outputs],
    allowNoChanges: lane.allow_no_changes,
    readOnly: scopeList(lane.read_only).join(", "),
    dependsOn: [...lane.depends_on],
    dependenciesIntegrated: [],
    waitingFor: [...lane.depends_on],
    queueReason: lane.depends_on.length ? "waiting for dependencies" : "concurrency limit",
    state: "queued",
    pid: null,
    sessionId: null,
    startedAt: null,
    endedAt: null,
    elapsedSec: 0,
    lastActivity: "queued",
    exitCode: null,
    worktree: null,
    inheritedInstructionFiles: [],
    logPath: null,
    runBaseCommit: immutableBaseCommit,
    baseCommit: null,
    changedFiles: [],
    scopeViolations: [],
    readOnlyViolations: [],
    portableScriptViolations: [],
    policyViolations: [],
    ratification: null,
    needsInput: null,
    attempt: 1,
    claim: { state: "pending" },
  }));

  const status = {
    runId,
    agentManager: { ...ENGINE_IDENTITY },
    harnessChecks,
    identity,
    state: "running",
    goal: workflow.goal || null,
    repo: workflow.repo,
    repoRoot: workflow.repoRoot,
    dangerousPermissionsApproved: workflow.policy.dangerously_skip_permissions === true,
    workflow: workflow.absPath,
    target_dev_flow: workflow.target_dev_flow,
    runtime,
    startedAt,
    endedAt: null,
    initialRepo,
    policy: workflow.policy,
    claimMode: workflow.claim_mode,
    maxConcurrency: workflow.max_concurrency,
    topology: workflow.topology,
    baseRef: workflow.base_ref,
    baseCommit: immutableBaseCommit,
    scopeOverrides: workflow.scope_overrides,
    sequentialOverlaps: workflow.sequential_overlaps,
    supervisor: { pid: process.pid, startedAt, kind: "run" },
    lanes: laneStates,
    execution: { state: "running", endedAt: null },
    delivery: createDeliveryStatus(workflow, laneStates),
  };
  writeStatus(runId, status);
  const persistStatus = () => {
    syncExternalLaneStates(laneStates, readStatus(runId));
    return writeStatus(runId, status);
  };
  writePrivateFile(
    join(dir, "meta.json"),
    JSON.stringify({
      runId,
      startedAt,
      initialRepo,
      immutableBaseCommit,
      runtime,
      agentManager: { ...ENGINE_IDENTITY },
      identity,
    }, null, 2) + "\n",
  );

  const activeHandles = new Map();
  const createdWorktrees = [];
  const handleSupervisorSignal = (signal) => {
    const at = new Date().toISOString();
    writePrivateFile(
      join(dir, "cancelled.json"),
      JSON.stringify({ at, reason: "supervisor signal", signal }, null, 2) + "\n",
      "utf8",
    );
    for (const entry of activeHandles.values()) entry.adapter.cancel(entry.handle);
    for (const lane of laneStates) {
      if (["running", "queued", "dependency-waiting"].includes(lane.state)) {
        lane.state = "cancelled";
        lane.lastActivity = `supervisor received ${signal}`;
        lane.endedAt = at;
      }
    }
    status.state = "cancelled";
    status.endedAt = at;
    persistStatus();
  };
  process.once("SIGINT", handleSupervisorSignal);
  process.once("SIGTERM", handleSupervisorSignal);

  let claimRenewal = null;
  try {
    const admission = claimLanes({
      repo: workflow.repo,
      group: runId,
      mode: workflow.claim_mode,
      lanes: workflow.lanes.map((lane, index) => ({
        branch: laneStates[index].branch,
        lane: lane.id,
        scope: scopeList(lane.scope),
        agent: "agt-agent-manager-" + (lane.harness || workflow.harness_default),
      })),
    });
    for (const result of admission) {
      const laneState = laneStates.find((lane) => lane.id === result.laneId);
      laneState.claim = result.skipped
        ? { state: "skipped", at: new Date().toISOString() }
        : result.ok
          ? { state: "active", at: new Date().toISOString(), group: runId }
          : {
              state: "advisory-failed",
              at: new Date().toISOString(),
              error: result.error,
            };
    }
    persistStatus();

    claimRenewal = setInterval(() => {
      for (const lane of laneStates) {
        if (!["active", "retained"].includes(lane.claim?.state)) continue;
        const renewed = renewLane({
          repo: status.repo,
          branch: lane.branch,
          mode: status.claimMode,
        });
        lane.claim.lastRenewedAt = new Date().toISOString();
        if (!renewed.ok) {
          lane.claim.renewalError = (renewed.stderr || renewed.stdout || "claim renewal failed").trim();
        }
      }
      persistStatus();
    }, CLAIM_RENEW_INTERVAL_MS);
    claimRenewal.unref?.();

    const runLane = async (index) => {
      const lane = workflow.lanes[index];
      const laneState = laneStates[index];
      const laneDir = join(dir, lane.id);
      const worktree = join(laneDir, "wt");
      ensurePrivateDir(laneDir);
      writePrivateFile(
        join(laneDir, "README-LANE.txt"),
        "Lane " + lane.id + "\nIf blocked, write needs-input.json here:\n" +
          join(laneDir, "needs-input.json") + "\n",
      );

      try {
        addWorktree({
          repoRoot: workflow.repoRoot,
          worktreePath: worktree,
          branch: laneState.branch,
          baseBranch: immutableBaseCommit,
        });
        createdWorktrees.push(worktree);
        laneState.worktree = worktree;
        laneState.inheritedInstructionFiles = inheritIgnoredAgentFiles(
          workflow.repoRoot,
          worktree,
        );

        const dependencies = laneState.dependsOn.map((id) =>
          laneStates.find((candidate) => candidate.id === id),
        );
        if (dependencies.length) {
          const merged = mergeDependencyBranches(worktree, dependencies);
          if (!merged.ok) {
            laneState.state = "failed";
            laneState.dependencyFailure = merged;
            laneState.lastActivity = merged.error;
            laneState.endedAt = new Date().toISOString();
            releaseLaneClaim(status, laneState);
            persistStatus();
            return;
          }
          laneState.dependenciesIntegrated = merged.merged;
        }

        assertWorktreeIdentity({
          worktreePath: worktree,
          expectedBranch: laneState.branch,
          expectedHead: dependencies.length ? null : immutableBaseCommit,
        });

        laneState.baseCommit = currentHead(worktree);
        laneState.state = "running";
        laneState.waitingFor = [];
        laneState.queueReason = null;
        laneState.startedAt = new Date().toISOString();
        laneState.lastActivity = lane.setup.commands.length
          ? `setup: ${lane.setup.commands[0].command}`
          : "worktree ready";
        persistStatus();
        laneState.setup = runSetup(worktree, lane.setup, {
          envAllowlist: workflow.env_allowlist,
          setupRevision: laneState.baseCommit,
          setupCacheRoot: join(dir, "setup-cache"),
        });
        if (!laneState.setup.passed) {
          throw new Error(`lane setup failed: ${laneState.setup.error}`);
        }

        laneState.lastActivity = "worktree ready";

        const prompt = lanePrompt(lane, workflow) +
          "\n\n## Escalation path\nIf blocked, write JSON to:\n" +
          join(laneDir, "needs-input.json") + "\n";
        const harnessName = lane.harness || workflow.harness_default;
        const adapter = getHarnessAdapter(harnessName);
        const inspectPolicyEvent = createPolicyEventInspector(workflow.policy);
        let handle;
        let runtimeViolation = null;
        handle = adapter.start({
          cwd: worktree,
          prompt,
          laneDir,
          lane,
          model: lane.model || workflow.model_default || null,
          harnessOptions: lane.harness_options,
          permissionMode: lane.permission_mode,
          allowedTools: lane.allowed_tools,
          dangerouslySkipPermissions: !!workflow.policy.dangerously_skip_permissions,
          envAllowlist: workflow.env_allowlist,
          onActivity: (summary) => {
            laneState.lastActivity = summary;
          },
          onEvent: (event) => {
            laneState.modelObserved ||= adapter.parseModel?.(event) || null;
            laneState.effortObserved = parseEffort(event) || laneState.effortObserved;
            runtimeViolation ||= inspectPolicyEvent(event);
            if (runtimeViolation) handle?.kill?.();
          },
        });
        laneState.pid = handle.pid ?? null;
        laneState.sessionId = handle.getSessionId?.() || null;
        laneState.logPath = join(laneDir, "stdout.log");
        activeHandles.set(lane.id, { adapter, handle });
        persistStatus();

        const pollMs = Number(workflow.policy.poll_interval_ms || 2_000);
        const attemptStarted = Date.now();
        const tick = setInterval(() => {
          laneState.elapsedSec = Math.round((Date.now() - attemptStarted) / 1000);
          laneState.sessionId = handle.getSessionId?.() || laneState.sessionId;
          if (laneState.state === "running") {
            laneState.supervision = inspectSupervision({
              startedAt: attemptStarted, lastByteAt: handle.getLastByteAt(), policy: workflow.policy,
            });
          }
          if (cancellationRequested(runId)) {
            adapter.cancel(handle);
            laneState.state = "cancelled";
            laneState.lastActivity = "cancel requested";
          }
          const needs = adapter.parseNeedsInput(laneDir, worktree);
          if (needs && laneState.state !== "cancelled") {
            laneState.needsInput = needs;
            laneState.state = "blocked";
            laneState.lastActivity = needs.prompt || "needs-input";
            laneState.claim = { ...laneState.claim, state: "retained", reason: "needs-input" };
            adapter.cancel(handle);
          } else if (
            laneState.supervision?.action === "cancel" &&
            laneState.state === "running"
          ) {
            laneState.state = "failed";
            laneState.lastActivity = `supervision: ${laneState.supervision.reason}`;
            adapter.cancel(handle);
          }
          if (runtimeViolation && laneState.state !== "cancelled") {
            laneState.state = "failed";
            laneState.policyViolations = [
              ...new Set([...(laneState.policyViolations || []), runtimeViolation]),
            ];
            laneState.lastActivity = runtimeViolation;
            adapter.cancel(handle);
          }
          persistStatus();
        }, pollMs);

        const result = await handle.done;
        clearInterval(tick);
        activeHandles.delete(lane.id);
        laneState.elapsedSec = Math.round((Date.now() - attemptStarted) / 1000);
        laneState.exitCode = result.exitCode;
        laneState.lastActivity = result.lastActivity || laneState.lastActivity;
        laneState.failureDiagnostic = result.exitCode ? diagnoseHarnessFailure(lane.harness, laneState.lastActivity) : null;
        if (laneState.supervision?.action === "cancel") {
          laneState.lastActivity = `supervision: ${laneState.supervision.reason}`;
        }
        laneState.logPath = result.logPath || laneState.logPath;
        laneState.sessionId =
          result.sessionId || handle.getSessionId?.() || laneState.sessionId;
        laneState.pid = null;

        const needs = adapter.parseNeedsInput(laneDir, worktree) || result.needsInput || null;
        if (cancellationRequested(runId) || laneState.state === "cancelled") {
          laneState.state = "cancelled";
        } else if (runtimeViolation) {
          laneState.state = "failed";
          laneState.policyViolations = [
            ...new Set([...(laneState.policyViolations || []), runtimeViolation]),
          ];
          laneState.lastActivity = runtimeViolation;
        } else if (needs) {
          laneState.needsInput = needs;
          laneState.state = "blocked";
          laneState.claim = { ...laneState.claim, state: "retained", reason: "needs-input" };
        } else if (laneState.state !== "failed" && result.exitCode === 0) {
          laneState.state = "done";
          applyGuardrails(laneState, lane, workflow);
        } else if (laneState.state !== "failed") {
          laneState.state = "failed";
        }

        // After guardrails, so the snapshot commit is never counted as a worker commit.
        snapshotLaneAtEnd(laneState);
        laneState.endedAt = new Date().toISOString();
        if (laneState.state === "blocked") {
          laneState.claim = { ...laneState.claim, state: "retained", reason: "needs-input" };
        } else {
          releaseLaneClaim(status, laneState);
        }
        persistStatus();
      } catch (error) {
        activeHandles.delete(lane.id);
        laneState.state = "failed";
        laneState.lastActivity = String(error?.message || error);
        snapshotLaneAtEnd(laneState);
        laneState.endedAt = new Date().toISOString();
        releaseLaneClaim(status, laneState);
        persistStatus();
      }
    };

    const pending = new Set(workflow.lanes.map((_, index) => index));
    const active = new Map();

    while ((pending.size || active.size) && !cancellationRequested(runId)) {
      syncExternalLaneStates(laneStates, readStatus(runId));
      let stateChanged = false;
      let launched = false;

      for (const index of [...pending]) {
        const laneState = laneStates[index];
        const dependency = dependencyState(laneState, laneStates);
        if (dependency.failed.length) {
          pending.delete(index);
          laneState.state = "failed";
          laneState.waitingFor = dependency.failed.map((item) => item.id);
          laneState.dependencyFailure = {
            failed: laneState.waitingFor,
            error: `dependency failed: ${laneState.waitingFor.join(", ")}`,
          };
          laneState.lastActivity = laneState.dependencyFailure.error;
          laneState.endedAt = new Date().toISOString();
          releaseLaneClaim(status, laneState);
          stateChanged = true;
          continue;
        }

        if (!dependency.ready) {
          const nextState = dependency.blocked.length ? "dependency-waiting" : "queued";
          const waitingFor = dependency.dependencies
            .filter((item) => item.state !== "done")
            .map((item) => item.id);
          if (
            laneState.state !== nextState ||
            JSON.stringify(laneState.waitingFor) !== JSON.stringify(waitingFor)
          ) {
            laneState.state = nextState;
            laneState.waitingFor = waitingFor;
            laneState.queueReason =
              nextState === "dependency-waiting"
                ? "blocked dependency"
                : "waiting for dependencies";
            laneState.lastActivity = laneState.queueReason + ": " + waitingFor.join(", ");
            stateChanged = true;
          }
          continue;
        }

        const runningCount = laneStates.filter((item) => item.state === "running").length;
        if (runningCount >= workflow.max_concurrency) {
          laneState.state = "queued";
          laneState.queueReason = "concurrency limit";
          laneState.lastActivity = `queued (max_concurrency=${workflow.max_concurrency})`;
          continue;
        }

        pending.delete(index);
        const promise = runLane(index).finally(() => active.delete(index));
        active.set(index, promise);
        launched = true;
      }

      status.state = laneStates.some((lane) => lane.state === "blocked")
        ? "blocked"
        : "running";
      if (stateChanged || launched) persistStatus();

      if (active.size) {
        await Promise.race(active.values());
        continue;
      }
      if (pending.size) {
        await waitForExternalProgress(runId, laneStates);
      }
    }

    if (active.size) await Promise.allSettled(active.values());

    if (cancellationRequested(runId)) {
      const cancelled = readStatus(runId) || status;
      for (const lane of cancelled.lanes || []) releaseLaneClaim(cancelled, lane);
      const saved = {
        ...cancelled,
        state: "cancelled",
        endedAt: cancelled.endedAt || new Date().toISOString(),
      };
      writeStatus(runId, saved);
      writeReport(runId, saved);
      return { runId, status: saved, dir };
    }

    status.state = deriveRunState(status);
    if (status.state === "workers_done" && workflow.integrate) {
      status.integrate = { state: "running" };
      persistStatus();
      try {
        status.integrate = integrateLanes({ workflow, runId, laneStates });
        status.state = status.integrate.state === "ready" ? "workers_done" : "blocked";
      } catch (error) {
        status.integrate = { state: "failed", error: String(error?.message || error) };
        status.state = "failed";
        status.error = status.integrate.error;
      }
    }

    if (status.state === "workers_done") {
      markWorkersComplete(status);
    } else if (status.state !== "blocked") {
      status.execution = {
        ...(status.execution || {}),
        state: status.state,
        endedAt: new Date().toISOString(),
      };
      status.endedAt = new Date().toISOString();
    }
    // Write the report before publishing status so waiters on review_pending
    // never observe a missing report.md.
    const reportPath = writeReport(runId, status);
    persistStatus();

    console.log("run " + runId + " -> " + status.state);
    console.log("status: " + join(dir, "status.json"));
    console.log("report: " + reportPath);
    for (const lane of laneStates) {
      console.log(
        "  " + lane.id + ": " + lane.state + " branch=" + lane.branch + " exit=" + lane.exitCode,
      );
    }
    if (status.integrate) {
      console.log(
        "  integrate: " + status.integrate.state + " branch=" + (status.integrate.branch || "-"),
      );
    }
    return { runId, status, dir };
  } catch (error) {
    if (cancellationRequested(runId)) {
      const cancelled = readStatus(runId);
      return { runId, status: cancelled || status, dir };
    }
    status.state = "failed";
    status.error = String(error?.message || error);
    status.endedAt = new Date().toISOString();
    for (const lane of laneStates) {
      if (["queued", "dependency-waiting", "running"].includes(lane.state)) {
        lane.state = "failed";
        lane.lastActivity = status.error;
        lane.endedAt = status.endedAt;
      }
      releaseLaneClaim(status, lane);
    }
    persistStatus();
    writeReport(runId, status);
    for (const entry of activeHandles.values()) {
      try {
        entry.adapter.cancel(entry.handle);
      } catch {
        // Best effort.
      }
    }
    for (const worktree of createdWorktrees) {
      try {
        removeWorktree({ repoRoot: workflow.repoRoot, worktreePath: worktree });
      } catch {
        // Best effort.
      }
    }
    throw error;
  } finally {
    if (claimRenewal) clearInterval(claimRenewal);
    process.removeListener("SIGINT", handleSupervisorSignal);
    process.removeListener("SIGTERM", handleSupervisorSignal);
    try {
      closeSync(lockFd);
    } catch {
      // Lock may not have opened.
    }
    rmSync(lockPath, { force: true });
  }
}
