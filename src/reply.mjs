import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { claimLane, releaseLane } from "./claim.mjs";
import { resolveMasterIdentity } from "./ratify.mjs";
import { normalizeScopePath } from "./scope.mjs";
import { createFeedPublisher, publishFeedEvent } from "./feed.mjs";
import { createPolicyEventInspector, validateLaneGuardrails } from "./guardrails.mjs";
import { getHarnessAdapter } from "./harness/index.mjs";
import { integrateLanes } from "./integrate.mjs";
import { restoreLaneSnapshot, snapshotLaneAtEnd } from "./lane-snapshot.mjs";
import { assertPathInside, assertSafeSlug, runDir } from "./paths.mjs";
import { writePrivateFile } from "./fs-safe.mjs";
import { writeReport } from "./report.mjs";
import { deriveRunState, readStatus, writeStatus } from "./status.mjs";
import { loadWorkflow } from "./workflow.mjs";
import { markWorkersComplete } from "./delivery.mjs";
import { validateLaneCompletion } from "./completion.mjs";
import { inspectSupervision } from "./supervision.mjs";
import { parseEffort } from "./harness/options.mjs";

/**
 * Operator vocabulary for talking to a worker lane:
 *
 * - reply      answers a lane that already stopped and raised needs-input.
 *              `prepareReply` + `resumeLane`, unchanged.
 * - correct    sends a mid-flight correction to a lane that is still running.
 *              `prepareCorrection` pauses the lane through the supervisor's
 *              needs-input channel, then resumes the same harness session with
 *              the correction as its next turn, so lane context survives.
 *
 * A correction is deliberately not a second concurrent turn: harness print-mode
 * sessions take one turn at a time, so the only honest way to reach a running
 * lane is interrupt, then resume.
 */
export const CORRECTION_TYPE = "operator_correction";
const CORRECTION_POLL_MS = 250;
const CORRECTION_TIMEOUT_MS = 60_000;
const CORRECTION_SETTLE_MS = 15_000;
const PAUSABLE_STATES = new Set(["running", "blocked"]);
/**
 * `blocked` is the ordinary reply target. `failed` is the recovery target: a
 * lane that raised needs-input and then died — a crashed resume, a stalled
 * harness — is `failed` while still holding its escalation and its worktree.
 * That lane is answerable, so reply accepts it when the needs-input marker is
 * still on record, or when the operator forces it.
 */
const REPLYABLE_STATES = new Set(["blocked", "failed"]);

function processIsAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Pause a running lane so an operator correction can be delivered. Writes the
 * lane's needs-input marker, which the run supervisor already polls: it blocks the
 * lane, retains the claim, and stops the harness at its next poll. Fails closed
 * rather than leaving a marker nobody will read.
 */
export async function interruptLaneForCorrection(runId, laneId, message, {
  pollMs = CORRECTION_POLL_MS,
  timeoutMs = CORRECTION_TIMEOUT_MS,
  settleMs = CORRECTION_SETTLE_MS,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now = () => Date.now(),
  isSupervisorAlive = processIsAlive,
} = {}) {
  assertSafeSlug(runId, "run id");
  assertSafeSlug(laneId, "lane id");
  const text = String(message || "").trim();
  if (!text) throw new Error("correction requires a non-empty message");
  const status = readStatus(runId);
  if (!status) throw new Error("no status for " + runId);
  const lane = (status.lanes || []).find((item) => item.id === laneId);
  if (!lane) throw new Error("no lane " + laneId + " in " + runId);
  if (lane.state === "blocked") {
    return { state: "already-blocked", interrupted: false, markerPath: null, settled: true };
  }
  if (!PAUSABLE_STATES.has(lane.state)) {
    throw new Error(
      "lane " + laneId + " is " + lane.state + "; corrections apply to running or blocked lanes",
    );
  }
  if (!lane.sessionId) {
    throw new Error(
      "lane " + laneId + " has no harness session id yet; wait for the first harness event before correcting it",
    );
  }

  const root = runDir(runId);
  const laneDir = join(root, laneId);
  const safeWorktree = lane.worktree
    ? assertPathInside(root, lane.worktree, `lane ${laneId} worktree`)
    : null;
  const markerPath = join(laneDir, "needs-input.json");
  for (const path of [
    markerPath,
    safeWorktree ? join(safeWorktree, "needs-input.json") : null,
  ].filter(Boolean)) {
    if (existsSync(path)) {
      throw new Error(
        "lane " + laneId + " already raised needs-input; answer it with reply instead of a correction",
      );
    }
  }
  if (!isSupervisorAlive(status.supervisor?.pid)) {
    throw new Error(
      "no live supervisor for " + runId + "; a correction cannot reach lane " + laneId,
    );
  }

  writePrivateFile(
    markerPath,
    JSON.stringify({
      type: CORRECTION_TYPE,
      prompt: text,
      blocking: true,
      source: "operator",
      requestedAt: new Date().toISOString(),
    }, null, 2) + "\n",
    "utf8",
  );

  const deadline = now() + timeoutMs;
  let blockedAt = null;
  while (now() <= deadline) {
    const current = (readStatus(runId)?.lanes || []).find((item) => item.id === laneId);
    if (current?.state === "blocked") {
      blockedAt ??= now();
      if (current.pid == null) {
        return { state: "blocked", interrupted: true, markerPath, settled: true };
      }
      if (now() - blockedAt >= settleMs) {
        return { state: "blocked", interrupted: true, markerPath, settled: false };
      }
    } else if (current && current.state !== "running") {
      rmSync(markerPath, { force: true });
      throw new Error(
        "lane " + laneId + " reached " + current.state + " before the correction was delivered",
      );
    }
    await sleep(pollMs);
  }
  // Once the lane is paused the correction is committed; only an undelivered marker
  // is withdrawn, so a slow harness exit never strands the lane without its reason.
  if (blockedAt !== null) {
    return { state: "blocked", interrupted: true, markerPath, settled: false };
  }
  rmSync(markerPath, { force: true });
  throw new Error("timed out waiting for lane " + laneId + " to pause for an operator correction");
}

/**
 * Pause a running lane and stage the correction for harness resume. Returns the same
 * shape as `prepareReply`, so a caller detaches the resume supervisor identically.
 */
export async function prepareCorrection(runId, laneId, message, options = {}) {
  const correction = await interruptLaneForCorrection(runId, laneId, message, options);
  const prepared = prepareReply(runId, laneId, message);
  if (correction.interrupted) {
    prepared.lane.lastActivity = "operator correction queued for harness resume";
    writeStatus(runId, prepared.status);
  }
  return { ...prepared, correction, interrupted: correction.interrupted };
}

/**
 * Scope patterns an operator may hand a lane along with the answer. Same shape
 * rules as `lane.scope`: repository-relative, no traversal, no control
 * characters. Validated before anything is recorded, so a typo cannot become a
 * standing grant.
 */
export function normalizeScopeExtension(input) {
  const values = (Array.isArray(input) ? input : String(input ?? "").split(","))
    .map((value) => String(value).trim())
    .filter(Boolean);
  for (const pattern of values) {
    if (/[\0\r\n]/.test(pattern)) {
      throw new Error("--extend-scope contains invalid characters");
    }
    const normalized = normalizeScopePath(pattern);
    if (isAbsolute(pattern) || normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error("--extend-scope must stay inside the repository: " + pattern);
    }
  }
  return [...new Set(values.map((value) => normalizeScopePath(value)))];
}

export function prepareReply(runId, laneId, message, {
  force = false,
  extendScope = [],
  by = null,
} = {}) {
  assertSafeSlug(runId, "run id");
  assertSafeSlug(laneId, "lane id");
  if (!message || !String(message).trim()) throw new Error("reply requires a non-empty message");
  const extensionPatterns = normalizeScopeExtension(extendScope);
  const status = readStatus(runId);
  if (!status) throw new Error("no status for " + runId);
  const lane = (status.lanes || []).find((item) => item.id === laneId);
  if (!lane) throw new Error("no lane " + laneId + " in " + runId);
  if (!REPLYABLE_STATES.has(lane.state)) throw new Error("lane " + laneId + " is not blocked");
  const previousLaneState = lane.state;
  const previousRunState = status.state;
  const recovering = previousLaneState === "failed";
  const markerPaths = needsInputMarkerPaths(runId, lane);
  const hasNeedsInput = markerPaths.some((path) => existsSync(path)) || !!lane.needsInput;
  if (recovering) {
    if (!hasNeedsInput && !force) {
      throw new Error(
        "lane " + laneId + " failed without a needs-input marker; rerun with --force to resume it anyway",
      );
    }
    if (!lane.worktree || !existsSync(lane.worktree)) {
      throw new Error("lane " + laneId + " has no worktree left to resume");
    }
  }
  if (!lane.sessionId) throw new Error("lane " + laneId + " has no harness session id to resume");
  // Resolved before anything is mutated: an unattributable grant must not leave
  // the lane half-answered.
  const extensionGrantedBy = extensionPatterns.length
    ? resolveMasterIdentity(status, by, "a scope extension")
    : null;
  const previousNeedsInput = lane.needsInput;
  const reacquired = claimLane({
    repo: status.repo,
    branch: lane.branch,
    lane: lane.id,
    scope: lane.scope,
    agent: "agt-agent-manager-" + lane.harness,
    group: lane.claim?.group || runId,
    mode: status.claimMode,
  });

  const laneDir = join(runDir(runId), laneId);
  for (const path of markerPaths) rmSync(path, { force: true });

  lane.attempt = Number(lane.attempt || 1) + 1;
  const messagePath = join(laneDir, "reply-" + lane.attempt + ".txt");
  writePrivateFile(messagePath, String(message).trim() + "\n", "utf8");
  lane.state = "running";
  lane.needsInput = null;
  lane.endedAt = null;
  lane.replyStartedAt = new Date().toISOString();
  // Recorded before the harness resumes, so work done under the grant is inside
  // scope when guardrails run at lane exit. Grants append: an earlier extension
  // is never dropped by a later reply.
  if (extensionPatterns.length) {
    lane.scopeExtensions = [
      ...(lane.scopeExtensions || []),
      { patterns: extensionPatterns, by: extensionGrantedBy, at: lane.replyStartedAt },
    ];
  }
  if (recovering) {
    lane.exitCode = null;
    lane.recovery = {
      from: previousLaneState,
      at: lane.replyStartedAt,
      needsInputMarker: hasNeedsInput,
      forced: !hasNeedsInput,
    };
  }
  status.supervisor = { pid: null, startedAt: lane.replyStartedAt, kind: "resume" };
  lane.lastActivity = "reply queued for harness resume";
  lane.claim = reacquired.skipped
    ? { state: "skipped", resumedAt: lane.replyStartedAt }
    : reacquired.ok
      ? {
          ...lane.claim,
          state: "active",
          group: lane.claim?.group || runId,
          resumedAt: lane.replyStartedAt,
        }
      : {
          state: "advisory-failed",
          error: reacquired.error,
          resumedAt: lane.replyStartedAt,
        };
  status.state = "running";
  status.endedAt = null;
  // A recovered lane is running again, so the run is too: drop the terminal
  // execution stamp, and the run-level failure once no lane is still failed.
  if (status.execution && status.execution.state !== "running") {
    status.execution = { ...status.execution, state: "running", endedAt: null };
  }
  const otherFailedLanes = (status.lanes || []).filter(
    (item) => item.id !== laneId && item.state === "failed",
  );
  if (previousRunState === "failed" && !otherFailedLanes.length && status.error) {
    delete status.error;
  }
  writeStatus(runId, status);
  return {
    status,
    lane,
    messagePath,
    previousNeedsInput,
    previousLaneState,
    previousRunState,
    recovered: recovering,
    scopeExtensions: lane.scopeExtensions || [],
  };
}

function needsInputMarkerPaths(runId, lane) {
  const root = runDir(runId);
  const safeWorktree = lane.worktree
    ? assertPathInside(root, lane.worktree, `lane ${lane.id} worktree`)
    : null;
  return [
    join(root, lane.id, "needs-input.json"),
    safeWorktree ? join(safeWorktree, "needs-input.json") : null,
  ].filter(Boolean);
}

export async function resumeLane(runId, laneId, messagePath) {
  assertSafeSlug(runId, "run id");
  assertSafeSlug(laneId, "lane id");
  const status = readStatus(runId);
  if (!status) throw new Error("no status for " + runId);
  const lane = (status.lanes || []).find((item) => item.id === laneId);
  if (!lane) throw new Error("no lane " + laneId + " in " + runId);
  const persistReplyStatus = () => {
    const disk = readStatus(runId);
    if (disk?.lanes) {
      status.lanes = status.lanes.map((item) =>
        item.id === laneId
          ? item
          : disk.lanes.find((candidate) => candidate.id === item.id) || item,
      );
    }
    return writeStatus(runId, status);
  };
  const safeMessagePath = assertPathInside(join(runDir(runId), laneId), messagePath, "reply message");
  if (!existsSync(safeMessagePath)) throw new Error("reply message not found: " + safeMessagePath);

  const workflow = loadWorkflow(join(runDir(runId), "workflow.yaml"), {
    repoOverride: status.repoRoot || status.repo,
    planningContextOverride: existsSync(join(runDir(runId), "planning-context.md"))
      ? join(runDir(runId), "planning-context.md")
      : null,
  });
  if (
    status.planning?.contextDigest &&
    workflow.planning?.context_digest !== status.planning.contextDigest
  ) {
    throw new Error("frozen planning context digest does not match recorded run evidence");
  }
  if (workflow.policy.dangerously_skip_permissions && status.dangerousPermissionsApproved !== true) {
    throw new Error("run did not record dangerous permission approval");
  }
  const laneConfig = workflow.lanes.find((item) => item.id === laneId);
  const adapter = getHarnessAdapter(lane.harness);
  const publisher = createFeedPublisher(workflow.feed);
  const root = runDir(runId);
  const laneDir = join(root, laneId);
  lane.worktree = assertPathInside(root, lane.worktree, `lane ${laneId} worktree`);
  // Hand the worker back the working tree it left, not a tree with the
  // recovery snapshot already committed on top of it.
  const restored = restoreLaneSnapshot(lane.worktree, lane.snapshot);
  if (restored.restored) {
    lane.snapshot = { ...lane.snapshot, state: "restored", restoredAt: new Date().toISOString() };
  } else if (!restored.ok) {
    lane.snapshot = { ...lane.snapshot, restoreError: restored.error };
  }
  const prompt = readFileSync(safeMessagePath, "utf8");
  const inspectPolicyEvent = createPolicyEventInspector(workflow.policy);
  let runtimeViolation = null;
  lane.supervision = null;
  lane.harnessOptions = { ...laneConfig.harness_options };
  lane.effortObserved = null;
  let handle;
  handle = adapter.resume({
    sessionId: lane.sessionId,
    cwd: lane.worktree,
    prompt,
    laneDir,
    lane: laneConfig,
    logName: "resume-" + lane.attempt + ".log",
    model: laneConfig.model || workflow.model_default || null,
    harnessOptions: laneConfig.harness_options,
    permissionMode: laneConfig.permission_mode,
    allowedTools: laneConfig.allowed_tools,
    dangerouslySkipPermissions: !!workflow.policy.dangerously_skip_permissions,
    envAllowlist: workflow.env_allowlist,
    onActivity: (summary) => {
      lane.lastActivity = summary;
    },
    onEvent: (event) => {
      lane.modelObserved ||= adapter.parseModel?.(event) || null;
      lane.effortObserved = parseEffort(event) || lane.effortObserved;
      runtimeViolation ||= inspectPolicyEvent(event);
      if (runtimeViolation) handle?.kill?.();
    },
  });
  lane.pid = handle.pid ?? null;
  lane.logPath = join(laneDir, "resume-" + lane.attempt + ".log");
  lane.sessionId = handle.getSessionId?.() || lane.sessionId;
  persistReplyStatus();
  await publishFeedEvent(publisher, status, "lane_started", {
    laneId,
    harness: lane.harness,
    branch: lane.branch,
    resumed: true,
    attempt: lane.attempt,
  });

  const started = Date.now();
  const elapsedBeforeReply = Number(lane.elapsedSec || 0);
  const pollMs = Number(workflow.policy.poll_interval_ms || 2_000);
  const timer = setInterval(() => {
    lane.elapsedSec = elapsedBeforeReply + Math.round((Date.now() - started) / 1000);
    lane.sessionId = handle.getSessionId?.() || lane.sessionId;
    if (lane.state === "running") {
      lane.supervision = inspectSupervision({
        startedAt: started, lastByteAt: handle.getLastByteAt(), policy: workflow.policy,
      });
    }
    if (existsSync(join(runDir(runId), "cancelled.json"))) {
      lane.state = "cancelled";
      lane.lastActivity = "cancel requested";
      adapter.cancel(handle);
    }
    const needs = adapter.parseNeedsInput(laneDir, lane.worktree);
    if (needs) {
      lane.state = "blocked";
      lane.needsInput = needs;
      lane.lastActivity = needs.prompt || "needs-input";
      lane.claim = { state: "retained", reason: "needs-input" };
      adapter.cancel(handle);
    }
    if (runtimeViolation) {
      lane.state = "failed";
      lane.policyViolations = [...new Set([...(lane.policyViolations || []), runtimeViolation])];
      lane.lastActivity = runtimeViolation;
      adapter.cancel(handle);
    }
    if (
      lane.supervision?.action === "cancel" &&
      lane.state === "running"
    ) {
      lane.state = "failed";
      lane.lastActivity = `supervision: ${lane.supervision.reason}`;
      adapter.cancel(handle);
    }
    persistReplyStatus();
  }, pollMs);

  const result = await handle.done;
  clearInterval(timer);
  if (existsSync(join(runDir(runId), "cancelled.json"))) {
    return readStatus(runId);
  }
  lane.exitCode = result.exitCode;
  lane.lastActivity = result.lastActivity || lane.lastActivity;
  lane.logPath = result.logPath || lane.logPath;
  lane.sessionId = result.sessionId || handle.getSessionId?.() || lane.sessionId;
  lane.pid = null;
  const needs = adapter.parseNeedsInput(laneDir, lane.worktree) || result.needsInput || null;
  if (runtimeViolation) {
    lane.state = "failed";
    lane.policyViolations = [...new Set([...(lane.policyViolations || []), runtimeViolation])];
  } else if (needs) {
    lane.state = "blocked";
    lane.needsInput = needs;
    lane.claim = { state: "retained", reason: "needs-input" };
    await publishFeedEvent(publisher, status, "needs_input", {
      laneId,
      prompt: needs.prompt || "needs-input",
      sessionId: lane.sessionId,
      attempt: lane.attempt,
    });
  } else if (lane.supervision?.action === "cancel") {
    lane.state = "failed";
    lane.lastActivity = `supervision: ${lane.supervision.reason}`;
  } else if (result.exitCode === 0) {
    try {
      const check = validateLaneGuardrails({
        worktree: lane.worktree,
        scope: lane.scope,
        scopeExtensions: lane.scopeExtensions,
        readOnlyScope: lane.readOnly || laneConfig.read_only,
        baseCommit: lane.baseCommit,
        policy: workflow.policy,
      });
      lane.changedFiles = check.changedFiles;
      lane.scopeViolations = check.scopeViolations;
      lane.readOnlyViolations = check.readOnlyViolations;
      lane.policyViolations = [...new Set([...(lane.policyViolations || []), ...check.policyViolations])];
      lane.state = check.ok ? "done" : "failed";
      if (check.ok) validateLaneCompletion(lane, laneConfig);
      if (!check.ok) {
        lane.lastActivity = check.readOnlyViolations.length
          ? "read-only violation: " + check.readOnlyViolations.join(", ")
          : check.scopeViolations.length
            ? "scope violation: " + check.scopeViolations.join(", ")
            : check.policyViolations.join("; ");
      }
    } catch (error) {
      const violation = "guardrail inspection failed: " + String(error?.message || error);
      lane.state = "failed";
      lane.policyViolations = [...new Set([...(lane.policyViolations || []), violation])];
      lane.lastActivity = violation;
    }
  } else {
    lane.state = "failed";
  }

  // After guardrails, so the snapshot commit is never counted as a worker commit.
  snapshotLaneAtEnd(lane);
  lane.endedAt = new Date().toISOString();
  if (
    lane.state !== "blocked" &&
    lane.branch &&
    ["active", "retained"].includes(lane.claim?.state)
  ) {
    const released = releaseLane({ repo: status.repo, branch: lane.branch, mode: status.claimMode });
    lane.claim = { state: released.ok ? "released" : "release-failed", at: lane.endedAt };
    await publishFeedEvent(publisher, status, "lane_done", {
      laneId,
      laneState: lane.state,
      exitCode: lane.exitCode,
      changedFiles: lane.changedFiles,
      scopeViolations: lane.scopeViolations,
      attempt: lane.attempt,
    });
  }

  status.state = deriveRunState(status);
  if (status.state === "workers_done" && workflow.integrate) {
    status.integrate = { state: "running" };
    persistReplyStatus();
    try {
      status.integrate = integrateLanes({ workflow, runId, laneStates: status.lanes });
      status.state = status.integrate.state === "ready" ? "workers_done" : "blocked";
    } catch (error) {
      status.integrate = { state: "failed", error: String(error?.message || error) };
      status.state = "failed";
    }
  }

  if (status.state === "workers_done") {
    markWorkersComplete(status);
  } else if (status.state !== "blocked" && status.state !== "running") {
    status.execution = {
      ...(status.execution || {}),
      state: status.state,
      endedAt: new Date().toISOString(),
    };
    status.endedAt = new Date().toISOString();
  }
  persistReplyStatus();
  writeReport(runId, status);
  if (status.state === "delivery_review_pending") {
    await publishFeedEvent(publisher, status, "workers_done", {
      executionEndedAt: status.execution?.endedAt,
      attempt: lane.attempt,
    });
  } else if (status.state === "failed") {
    await publishFeedEvent(publisher, status, "run_failed", {
      endedAt: status.endedAt,
      attempt: lane.attempt,
    });
  }
  const saved = persistReplyStatus();
  writeReport(runId, saved);
  return saved;
}
