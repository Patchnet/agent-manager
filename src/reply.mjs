import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { claimLane, releaseLane } from "./claim.mjs";
import { createFeedPublisher, publishFeedEvent } from "./feed.mjs";
import { createPolicyEventInspector, validateLaneGuardrails } from "./guardrails.mjs";
import { getHarnessAdapter } from "./harness/index.mjs";
import { integrateLanes } from "./integrate.mjs";
import { assertPathInside, assertSafeSlug, runDir } from "./paths.mjs";
import { writePrivateFile } from "./fs-safe.mjs";
import { writeReport } from "./report.mjs";
import { deriveRunState, readStatus, writeStatus } from "./status.mjs";
import { loadWorkflow } from "./workflow.mjs";

export function prepareReply(runId, laneId, message) {
  assertSafeSlug(runId, "run id");
  assertSafeSlug(laneId, "lane id");
  if (!message || !String(message).trim()) throw new Error("reply requires a non-empty message");
  const status = readStatus(runId);
  if (!status) throw new Error("no status for " + runId);
  const lane = (status.lanes || []).find((item) => item.id === laneId);
  if (!lane) throw new Error("no lane " + laneId + " in " + runId);
  if (lane.state !== "blocked") throw new Error("lane " + laneId + " is not blocked");
  if (!lane.sessionId) throw new Error("lane " + laneId + " has no harness session id to resume");
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

  const root = runDir(runId);
  const laneDir = join(root, laneId);
  const safeWorktree = lane.worktree ? assertPathInside(root, lane.worktree, `lane ${laneId} worktree`) : null;
  for (const path of [
    join(laneDir, "needs-input.json"),
    safeWorktree ? join(safeWorktree, "needs-input.json") : null,
  ].filter(Boolean)) {
    rmSync(path, { force: true });
  }

  lane.attempt = Number(lane.attempt || 1) + 1;
  const messagePath = join(laneDir, "reply-" + lane.attempt + ".txt");
  writePrivateFile(messagePath, String(message).trim() + "\n", "utf8");
  lane.state = "running";
  lane.needsInput = null;
  lane.endedAt = null;
  lane.replyStartedAt = new Date().toISOString();
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
  writeStatus(runId, status);
  return { status, lane, messagePath, previousNeedsInput };
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
  const prompt = readFileSync(safeMessagePath, "utf8");
  const inspectPolicyEvent = createPolicyEventInspector(workflow.policy);
  let runtimeViolation = null;
  let handle;
  handle = adapter.resume({
    sessionId: lane.sessionId,
    cwd: lane.worktree,
    prompt,
    laneDir,
    lane: laneConfig,
    logName: "resume-" + lane.attempt + ".log",
    model: laneConfig.model || workflow.model_default || null,
    permissionMode: workflow.policy.permission_mode,
    dangerouslySkipPermissions: !!workflow.policy.dangerously_skip_permissions,
    envAllowlist: workflow.env_allowlist,
    onActivity: (summary) => {
      lane.lastActivity = summary;
    },
    onEvent: (event) => {
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
      Date.now() - handle.getLastByteAt() > (workflow.policy.stall_timeout_sec || 600) * 1000 &&
      lane.state === "running"
    ) {
      lane.state = "failed";
      lane.lastActivity = "stalled (silence exceeded timeout)";
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
  const needs = adapter.parseNeedsInput(laneDir, lane.worktree);
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
  } else if (result.exitCode === 0) {
    try {
      const check = validateLaneGuardrails({
        worktree: lane.worktree,
        scope: lane.scope,
        readOnlyScope: lane.readOnly || laneConfig.read_only,
        baseCommit: lane.baseCommit,
        policy: workflow.policy,
      });
      lane.changedFiles = check.changedFiles;
      lane.scopeViolations = check.scopeViolations;
      lane.readOnlyViolations = check.readOnlyViolations;
      lane.policyViolations = [...new Set([...(lane.policyViolations || []), ...check.policyViolations])];
      lane.state = check.ok ? "done" : "failed";
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
  if (status.state === "done" && workflow.integrate) {
    status.integrate = { state: "running" };
    persistReplyStatus();
    try {
      status.integrate = integrateLanes({ workflow, runId, laneStates: status.lanes });
      status.state = status.integrate.state === "ready" ? "done" : "blocked";
    } catch (error) {
      status.integrate = { state: "failed", error: String(error?.message || error) };
      status.state = "failed";
    }
  }

  status.endedAt = status.state === "blocked" || status.state === "running" ? null : new Date().toISOString();
  persistReplyStatus();
  writeReport(runId, status);
  if (status.state === "done") {
    await publishFeedEvent(publisher, status, "run_done", {
      endedAt: status.endedAt,
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
