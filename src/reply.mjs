import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseLane } from "./claim.mjs";
import { createFeedPublisher, publishFeedEvent } from "./feed.mjs";
import { createPolicyEventInspector, validateLaneGuardrails } from "./guardrails.mjs";
import { getHarnessAdapter } from "./harness/index.mjs";
import { integrateLanes } from "./integrate.mjs";
import { runDir } from "./paths.mjs";
import { writeReport } from "./report.mjs";
import { deriveRunState, readStatus, writeStatus } from "./status.mjs";
import { loadWorkflow } from "./workflow.mjs";

export function prepareReply(runId, laneId, message) {
  if (!message || !String(message).trim()) throw new Error("reply requires a non-empty message");
  const status = readStatus(runId);
  if (!status) throw new Error("no status for " + runId);
  const lane = (status.lanes || []).find((item) => item.id === laneId);
  if (!lane) throw new Error("no lane " + laneId + " in " + runId);
  if (lane.state !== "blocked") throw new Error("lane " + laneId + " is not blocked");
  if (!lane.sessionId) throw new Error("lane " + laneId + " has no harness session id to resume");
  const previousNeedsInput = lane.needsInput;

  const laneDir = join(runDir(runId), laneId);
  for (const path of [
    join(laneDir, "needs-input.json"),
    lane.worktree ? join(lane.worktree, "needs-input.json") : null,
  ].filter(Boolean)) {
    rmSync(path, { force: true });
  }

  lane.attempt = Number(lane.attempt || 1) + 1;
  const messagePath = join(laneDir, "reply-" + lane.attempt + ".txt");
  writeFileSync(messagePath, String(message).trim() + "\n", "utf8");
  lane.state = "running";
  lane.needsInput = null;
  lane.endedAt = null;
  lane.replyStartedAt = new Date().toISOString();
  lane.lastActivity = "reply queued for harness resume";
  lane.claim = { state: "active", resumedAt: lane.replyStartedAt };
  status.state = "running";
  status.endedAt = null;
  writeStatus(runId, status);
  return { status, lane, messagePath, previousNeedsInput };
}

export async function resumeLane(runId, laneId, messagePath) {
  const status = readStatus(runId);
  if (!status) throw new Error("no status for " + runId);
  const lane = (status.lanes || []).find((item) => item.id === laneId);
  if (!lane) throw new Error("no lane " + laneId + " in " + runId);
  if (!existsSync(messagePath)) throw new Error("reply message not found: " + messagePath);

  const workflow = loadWorkflow(join(runDir(runId), "workflow.yaml"));
  const laneConfig = workflow.lanes.find((item) => item.id === laneId);
  const adapter = getHarnessAdapter(lane.harness, {
    allowTest: workflow.policy.allow_test_harness === true,
  });
  const publisher = createFeedPublisher(workflow.feed);
  const laneDir = join(runDir(runId), laneId);
  const prompt = readFileSync(messagePath, "utf8");
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
  writeStatus(runId, status);
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
    writeStatus(runId, status);
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
    const check = validateLaneGuardrails({
      worktree: lane.worktree,
      scope: lane.scope,
      baseCommit: lane.baseCommit,
      policy: workflow.policy,
    });
    lane.changedFiles = check.changedFiles;
    lane.scopeViolations = check.scopeViolations;
    lane.policyViolations = [...new Set([...(lane.policyViolations || []), ...check.policyViolations])];
    lane.state = check.ok ? "done" : "failed";
    if (!check.ok) {
      lane.lastActivity = check.scopeViolations.length
        ? "scope violation: " + check.scopeViolations.join(", ")
        : check.policyViolations.join("; ");
    }
  } else {
    lane.state = "failed";
  }

  lane.endedAt = new Date().toISOString();
  if (lane.state !== "blocked" && lane.branch) {
    const released = releaseLane({ repo: status.repo, branch: lane.branch });
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
    writeStatus(runId, status);
    try {
      status.integrate = integrateLanes({ workflow, runId, laneStates: status.lanes });
      status.state = status.integrate.state === "ready" ? "done" : "blocked";
    } catch (error) {
      status.integrate = { state: "failed", error: String(error?.message || error) };
      status.state = "failed";
    }
  }

  if (status.state !== "running") status.endedAt = new Date().toISOString();
  writeStatus(runId, status);
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
  const saved = writeStatus(runId, status);
  writeReport(runId, saved);
  return saved;
}
