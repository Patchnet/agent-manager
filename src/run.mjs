import { chmodSync, closeSync, copyFileSync, existsSync, openSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { assertDangerousPermissionApproval, loadWorkflow, lanePrompt } from "./workflow.mjs";
import { claimLane, releaseLane } from "./claim.mjs";
import { addWorktree, removeWorktree } from "./worktree.mjs";
import { deriveRunState, readStatus, writeStatus } from "./status.mjs";
import { getHarnessAdapter } from "./harness/index.mjs";
import { writeReport } from "./report.mjs";
import { integrateLanes } from "./integrate.mjs";
import { assertSafeSlug, runDir } from "./paths.mjs";
import { ensurePrivateDir, writePrivateFile } from "./fs-safe.mjs";
import { createFeedPublisher, publishFeedEvent } from "./feed.mjs";
import {
  createPolicyEventInspector,
  currentHead,
  inspectInitialRepo,
  validateLaneGuardrails,
} from "./guardrails.mjs";

export function newRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds());
  return "run-" + stamp + "-" + randomBytes(4).toString("hex");
}

function scopeList(scope) {
  return Array.isArray(scope)
    ? scope
    : String(scope).split(",").map((value) => value.trim()).filter(Boolean);
}

function cancellationRequested(runId) {
  if (existsSync(join(runDir(runId), "cancelled.json"))) return true;
  return readStatus(runId)?.state === "cancelled";
}

function releaseLaneClaim(status, lane) {
  if (!lane.branch || lane.claim?.state === "released") return;
  const released = releaseLane({ repo: status.repo, branch: lane.branch, mode: status.claimMode });
  lane.claim = {
    state: released.ok ? "released" : "release-failed",
    at: new Date().toISOString(),
  };
}

function applyGuardrails(lane, workflow) {
  const check = validateLaneGuardrails({
    worktree: lane.worktree,
    scope: lane.scope,
    baseCommit: lane.baseCommit,
    policy: workflow.policy,
  });
  lane.changedFiles = check.changedFiles;
  lane.scopeViolations = check.scopeViolations;
  lane.policyViolations = [
    ...(lane.policyViolations || []),
    ...check.policyViolations,
  ];
  if (!check.ok) {
    lane.state = "failed";
    if (check.scopeViolations.length) {
      lane.lastActivity = "scope violation: " + check.scopeViolations.join(", ");
    } else {
      lane.lastActivity = check.policyViolations.join("; ");
    }
  }
}

export async function runWorkflow(workflowPath, {
  runId: forcedId,
  repoOverride = null,
  allowDangerousPermissions = false,
} = {}) {
  const workflow = loadWorkflow(workflowPath, { repoOverride });
  assertDangerousPermissionApproval(workflow, allowDangerousPermissions);
  const runId = assertSafeSlug(forcedId || newRunId(), "run id");
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
  const initialRepo = inspectInitialRepo(workflow.repoRoot);
  const laneStates = workflow.lanes.map((lane) => ({
    id: lane.id,
    harness: lane.harness || workflow.harness_default,
    repo: workflow.repo,
    branch: null,
    scope: scopeList(lane.scope).join(", "),
    state: "queued",
    pid: null,
    sessionId: null,
    startedAt: null,
    endedAt: null,
    elapsedSec: 0,
    lastActivity: "queued",
    exitCode: null,
    worktree: null,
    logPath: null,
    baseCommit: null,
    changedFiles: [],
    scopeViolations: [],
    policyViolations: [],
    needsInput: null,
    attempt: 1,
    claim: { state: "pending" },
  }));

  const status = {
    runId,
    state: "running",
    repo: workflow.repo,
    repoRoot: workflow.repoRoot,
    dangerousPermissionsApproved: workflow.policy.dangerously_skip_permissions === true,
    workflow: workflow.absPath,
    target_dev_flow: workflow.target_dev_flow,
    startedAt,
    endedAt: null,
    initialRepo,
    policy: workflow.policy,
    claimMode: workflow.claim_mode,
    baseRef: workflow.base_ref,
    supervisor: { pid: process.pid, startedAt, kind: "run" },
    feed: {
      enabled: workflow.feed.enabled,
      baseUrl: workflow.feed.baseUrl,
      topic: workflow.feed.topic,
      failures: 0,
    },
    lanes: laneStates,
  };
  writeStatus(runId, status);
  writePrivateFile(
    join(dir, "meta.json"),
    JSON.stringify({ runId, startedAt, initialRepo }, null, 2) + "\n",
  );

  const publisher = createFeedPublisher(workflow.feed);
  const pendingFeed = [];
  const emit = (event, payload) => {
    const task = publishFeedEvent(publisher, status, event, payload)
      .then(() => writeStatus(runId, status))
      .catch(() => null);
    pendingFeed.push(task);
    return task;
  };
  await emit("run_started", { workflow: workflow.absPath, laneCount: laneStates.length });

  const handles = [];
  const createdWorktrees = [];
  const handleSupervisorSignal = (signal) => {
    const at = new Date().toISOString();
    writePrivateFile(
      join(dir, "cancelled.json"),
      JSON.stringify({ at, reason: "supervisor signal", signal }, null, 2) + "\n",
      "utf8",
    );
    for (const entry of handles) entry.adapter.cancel(entry.handle);
    for (const lane of laneStates) {
      if (lane.state === "running" || lane.state === "queued") {
        lane.state = "cancelled";
        lane.lastActivity = `supervisor received ${signal}`;
        lane.endedAt = at;
      }
    }
    status.state = "cancelled";
    status.endedAt = at;
    writeStatus(runId, status);
  };
  process.once("SIGINT", handleSupervisorSignal);
  process.once("SIGTERM", handleSupervisorSignal);

  try {
    for (let index = 0; index < workflow.lanes.length; index++) {
      if (cancellationRequested(runId)) break;
      const lane = workflow.lanes[index];
      const laneState = laneStates[index];
      const branch = "am/" + runId + "/" + lane.id;
      const laneDir = join(dir, lane.id);
      const worktree = join(laneDir, "wt");
      ensurePrivateDir(laneDir);
      writePrivateFile(
        join(laneDir, "README-LANE.txt"),
        "Lane " + lane.id + "\nIf blocked, write needs-input.json here:\n" +
          join(laneDir, "needs-input.json") + "\n",
      );

      laneState.branch = branch;
      const claim = claimLane({
        repo: workflow.repo,
        branch,
        lane: lane.id,
        scope: scopeList(lane.scope),
        agent: "agt-agent-manager-" + (lane.harness || workflow.harness_default),
        mode: workflow.claim_mode,
      });
      laneState.claim = claim.skipped
        ? { state: "skipped", at: new Date().toISOString() }
        : claim.ok
          ? { state: "active", at: new Date().toISOString() }
          : { state: "advisory-failed", at: new Date().toISOString(), error: claim.error };

      addWorktree({ repoRoot: workflow.repoRoot, worktreePath: worktree, branch, baseBranch: workflow.base_ref });
      createdWorktrees.push(worktree);
      laneState.worktree = worktree;
      laneState.baseCommit = currentHead(worktree);
      laneState.state = "running";
      laneState.startedAt = new Date().toISOString();
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
        permissionMode: workflow.policy.permission_mode,
        dangerouslySkipPermissions: !!workflow.policy.dangerously_skip_permissions,
        envAllowlist: workflow.env_allowlist,
        onActivity: (summary) => {
          laneState.lastActivity = summary;
        },
        onEvent: (event) => {
          runtimeViolation ||= inspectPolicyEvent(event);
          if (runtimeViolation) handle?.kill?.();
        },
      });
      laneState.pid = handle.pid ?? null;
      laneState.sessionId = handle.getSessionId?.() || null;
      laneState.logPath = join(laneDir, "stdout.log");
      handles.push({ adapter, handle, laneState, laneDir, worktree, runtimeViolation: () => runtimeViolation });
      writeStatus(runId, status);
      await emit("lane_started", {
        laneId: lane.id,
        harness: harnessName,
        branch,
        scope: laneState.scope,
      });
    }

    if (cancellationRequested(runId)) {
      for (const entry of handles) entry.adapter.cancel(entry.handle);
    }

    const stallMs = (workflow.policy.stall_timeout_sec || 600) * 1000;
    const pollMs = Number(workflow.policy.poll_interval_ms || 2_000);

    await Promise.all(handles.map(async (entry) => {
      const { adapter, handle, laneState, laneDir, worktree } = entry;
      const attemptStarted = Date.now();
      let needsPublished = false;
      const tick = setInterval(() => {
        laneState.elapsedSec = Math.round((Date.now() - attemptStarted) / 1000);
        laneState.sessionId = handle.getSessionId?.() || laneState.sessionId;
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
          laneState.claim = { state: "retained", reason: "needs-input" };
          adapter.cancel(handle);
          if (!needsPublished) {
            needsPublished = true;
            void emit("needs_input", {
              laneId: laneState.id,
              prompt: needs.prompt || "needs-input",
              sessionId: laneState.sessionId,
            });
          }
        } else if (
          Date.now() - handle.getLastByteAt() > stallMs &&
          laneState.state === "running"
        ) {
          laneState.state = "failed";
          laneState.lastActivity = "stalled (silence exceeded timeout)";
          adapter.cancel(handle);
        }
        const violation = entry.runtimeViolation();
        if (violation && laneState.state !== "cancelled") {
          laneState.state = "failed";
          laneState.policyViolations = [...new Set([...(laneState.policyViolations || []), violation])];
          laneState.lastActivity = violation;
          adapter.cancel(handle);
        }
        writeStatus(runId, status);
      }, pollMs);

      const result = await handle.done;
      clearInterval(tick);
      laneState.elapsedSec = Math.round((Date.now() - attemptStarted) / 1000);
      laneState.exitCode = result.exitCode;
      laneState.lastActivity = result.lastActivity || laneState.lastActivity;
      laneState.logPath = result.logPath || laneState.logPath;
      laneState.sessionId = result.sessionId || handle.getSessionId?.() || laneState.sessionId;
      laneState.pid = null;

      const needs = adapter.parseNeedsInput(laneDir, worktree);
      const violation = entry.runtimeViolation();
      if (cancellationRequested(runId) || laneState.state === "cancelled") {
        laneState.state = "cancelled";
      } else if (violation) {
        laneState.state = "failed";
        laneState.policyViolations = [...new Set([...(laneState.policyViolations || []), violation])];
        laneState.lastActivity = violation;
      } else if (needs) {
        laneState.needsInput = needs;
        laneState.state = "blocked";
        laneState.claim = { state: "retained", reason: "needs-input" };
        if (!needsPublished) {
          needsPublished = true;
          await emit("needs_input", {
            laneId: laneState.id,
            prompt: needs.prompt || "needs-input",
            sessionId: laneState.sessionId,
          });
        }
      } else if (laneState.state !== "failed" && result.exitCode === 0) {
        laneState.state = "done";
        applyGuardrails(laneState, workflow);
      } else if (laneState.state !== "failed") {
        laneState.state = "failed";
      }

      laneState.endedAt = new Date().toISOString();
      if (laneState.state === "blocked") {
        laneState.claim = { state: "retained", reason: "needs-input" };
      } else {
        releaseLaneClaim(status, laneState);
      }
      writeStatus(runId, status);
      if (laneState.state !== "blocked") {
        await emit("lane_done", {
          laneId: laneState.id,
          laneState: laneState.state,
          exitCode: laneState.exitCode,
          changedFiles: laneState.changedFiles,
          scopeViolations: laneState.scopeViolations,
        });
      }
    }));

    if (cancellationRequested(runId)) {
      const cancelled = readStatus(runId) || status;
      for (const lane of cancelled.lanes || []) releaseLaneClaim(cancelled, lane);
      const saved = writeStatus(runId, { ...cancelled, state: "cancelled", endedAt: cancelled.endedAt || new Date().toISOString() });
      writeReport(runId, saved);
      return { runId, status: saved, dir };
    }

    status.state = deriveRunState(status);
    if (status.state === "done" && workflow.integrate) {
      status.integrate = { state: "running" };
      writeStatus(runId, status);
      try {
        status.integrate = integrateLanes({ workflow, runId, laneStates });
        status.state = status.integrate.state === "ready" ? "done" : "blocked";
      } catch (error) {
        status.integrate = { state: "failed", error: String(error?.message || error) };
        status.state = "failed";
        status.error = status.integrate.error;
      }
    }

    status.endedAt = status.state === "blocked" ? null : new Date().toISOString();
    writeStatus(runId, status);
    const reportPath = writeReport(runId, status);
    if (status.state === "done") {
      await emit("run_done", { endedAt: status.endedAt });
    } else if (status.state === "failed" || status.state === "cancelled") {
      await emit("run_failed", { endedAt: status.endedAt, error: status.error || null });
    }
    await Promise.allSettled(pendingFeed);
    writeStatus(runId, status);
    writeReport(runId, status);

    console.log("run " + runId + " -> " + status.state);
    console.log("status: " + join(dir, "status.json"));
    console.log("report: " + reportPath);
    for (const lane of laneStates) {
      console.log("  " + lane.id + ": " + lane.state + " branch=" + lane.branch + " exit=" + lane.exitCode);
    }
    if (status.integrate) {
      console.log("  integrate: " + status.integrate.state + " branch=" + (status.integrate.branch || "-"));
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
      if (lane.state === "queued" || lane.state === "running") {
        lane.state = "failed";
        lane.lastActivity = status.error;
        lane.endedAt = status.endedAt;
      }
      releaseLaneClaim(status, lane);
    }
    writeStatus(runId, status);
    writeReport(runId, status);
    await emit("run_failed", { endedAt: status.endedAt, error: status.error });
    await Promise.allSettled(pendingFeed);
    writeStatus(runId, status);
    writeReport(runId, status);
    for (const entry of handles) {
      try {
        entry.adapter.cancel(entry.handle);
      } catch {
        /* best effort */
      }
    }
    for (const worktree of createdWorktrees) {
      try {
        removeWorktree({ repoRoot: workflow.repoRoot, worktreePath: worktree });
      } catch {
        /* best effort */
      }
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", handleSupervisorSignal);
    process.removeListener("SIGTERM", handleSupervisorSignal);
    try {
      closeSync(lockFd);
    } catch {
      /* lock may not have opened */
    }
    rmSync(lockPath, { force: true });
  }
}