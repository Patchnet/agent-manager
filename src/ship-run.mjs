import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ensurePrivateDir, writePrivateFile } from "./fs-safe.mjs";
import { assertPathInside, assertSafeSlug, runDir } from "./paths.mjs";
import { writeReport } from "./report.mjs";
import { readStatus, writeStatus } from "./status.mjs";
import { resolveSpawnCommand, spawnCommandSync } from "./command.mjs";
import { detectRuntimeProfile } from "./runtime.mjs";
import {
  assertAcceptedReview,
  expectedMergeShas,
  recordMergedTarget,
  recordRelease,
  selectDeliveryTarget,
} from "./delivery.mjs";

export { resolveSpawnCommand } from "./command.mjs";

const APPROVALS = new Set(["all", "through-pr"]);
const CONVENTIONAL_COMMIT =
  /^(?:feat|fix|docs|refactor|chore|test|build|ci|perf|revert)(?:!)?(?:\([^)]+\))?: .+/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const FAILURE_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "startup_failure",
  "timed_out",
]);

export class ShipBlockedError extends Error {
  constructor(message, options = []) {
    super(message);
    this.name = "ShipBlockedError";
    this.options = options;
  }
}

class ShipCancelledError extends Error {
  constructor() {
    super("shipping cancelled");
    this.name = "ShipCancelledError";
  }
}

export function prepareShipHandoff(runId, options = {}) {
  const id = assertSafeSlug(runId, "run id");
  const status = readStatus(id);
  if (!status) throw new Error(`no status for ${id}`);
  if (status.state === "running" || status.state === "shipping") {
    throw new Error(`run ${id} must finish delivery before shipping`);
  }
  if (status.state === "cancelled" || status.state === "failed") {
    throw new Error(`cannot ship run ${id} in state ${status.state}`);
  }
  if (status.state === "blocked" && status.ship?.state !== "blocked") {
    throw new Error(`run ${id} has an unresolved delivery blocker`);
  }

  const approval = String(options.approve || "");
  if (!APPROVALS.has(approval)) {
    throw new Error("ship requires --approve all|through-pr from an accepted Ship Gate");
  }
  assertAcceptedReview(status);

  const flow = status.target_dev_flow || "simple";
  if (flow !== "simple" && flow !== "formal") {
    throw new Error(`unsupported target_dev_flow: ${flow}`);
  }
  if (flow === "simple" && approval === "through-pr") {
    throw new Error("through-pr applies only to Formal Flow");
  }
  if (status.delivery?.mode === "review-only") {
    throw new Error("review-only runs cannot be shipped");
  }
  const target = selectDeliveryTarget(status, options.target || null, { allowMerged: approval === "all" });
  if (target && !(target.changedFiles || []).length) {
    throw new Error(`delivery target ${target.id} has no changed files; refusing a no-code shipment`);
  }
  if (status.integrate?.state === "ready"
    && (!target || target.id === "integrate")
    && !String(status.integrate.diffStat || "").trim()) {
    throw new Error("integrate branch has no changed files; refusing a no-code shipment");
  }
  if (approval === "all" && target && (status.delivery.targets || []).some(
    (candidate) => candidate.id !== target.id && candidate.state !== "merged",
  )) {
    throw new Error("--approve all is allowed only for the final unmerged delivery target; ship earlier targets through-pr");
  }

  const remote = safeArgument(options.remote || status.integrate?.remote || "origin", "remote");
  const base = safeArgument(
    options.base || target?.base || normalizeBase(status.baseRef, remote) || "main",
    "base branch",
  );
  const branch = safeArgument(
    options.branch ||
      target?.branch ||
      (flow === "formal" ? status.integrate?.branch : base) ||
      "",
    "ship branch",
  );
  if (!branch) {
    throw new Error("ship requires --branch when no integrate branch is recorded");
  }

  const repoValue = options.repo || status.repoRoot;
  if (!repoValue) {
    throw new Error("ship requires --repo when the run did not record repoRoot");
  }
  const repoRoot = resolve(repoValue);
  if (!existsSync(repoRoot)) {
    throw new Error("ship requires an existing repository path");
  }
  const worktree = resolve(
    options.worktree ||
      target?.worktree ||
      (flow === "formal" ? status.integrate?.worktree : null) ||
      repoRoot,
  );
  if (!existsSync(worktree)) {
    throw new Error(`ship worktree does not exist: ${worktree}`);
  }

  const commitMessage = optionalSingleLine(options.commitMessage, "commit message", 200);
  if (commitMessage && !CONVENTIONAL_COMMIT.test(commitMessage)) {
    throw new Error("commit message must use a conventional commit prefix");
  }

  const version = optionalSingleLine(options.version, "version", 80);
  const summary = optionalSingleLine(options.summary, "release summary", 240);
  if (approval === "all") {
    if (!version || !SEMVER.test(version)) {
      throw new Error("--approve all requires --version <semver>");
    }
    if (!summary) {
      throw new Error("--approve all requires --summary <public release summary>");
    }
    if (flow === "simple" && !commitMessage) {
      throw new Error("Simple Flow shipping requires --commit-message");
    }
  }

  const pollSec = boundedNumber(options.pollSec ?? 10, "poll seconds", 1, 300);
  const timeoutSec = boundedNumber(options.timeoutSec ?? 1800, "timeout seconds", 1, 86400);
  const prValue = options.pr || target?.pr || target?.prUrl || (!target ? status.ship?.prUrl : null) || null;
  const pr = prValue ? safeArgument(prValue, "pull request") : null;

  return {
    schema: "agent-manager.ship-handoff.v1",
    runId: id,
    approve: approval,
    flow,
    repoRoot,
    worktree,
    branch,
    base,
    remote,
    pr,
    targetId: target?.id || null,
    commitMessage,
    version,
    summary,
    pollSec,
    timeoutSec,
    runtime: detectRuntimeProfile(),
    requestedAt: new Date().toISOString(),
  };
}

export function preflightShipHandoff(handoff, exec = execCommand) {
  preflight(handoff, exec);
  return true;
}

export function queueShip(runId, handoff) {
  const status = readStatus(runId);
  if (!status) throw new Error(`no status for ${runId}`);
  const dir = ensurePrivateDir(join(runDir(runId), "ship"));
  const handoffPath = join(dir, "handoff.json");
  writePrivateFile(handoffPath, JSON.stringify(handoff, null, 2) + "\n", "utf8");
  const attempt = Number(status.ship?.attempt || 0) + 1;
  status.runtime = handoff.runtime || status.runtime || detectRuntimeProfile();
  status.state = "shipping";
  status.endedAt = null;
  status.ship = {
    schema: "agent-manager.ship.v1",
    state: "queued",
    phase: "preflight",
    approve: handoff.approve,
    flow: handoff.flow,
    runtime: status.runtime,
    repoRoot: handoff.repoRoot,
    worktree: handoff.worktree,
    branch: handoff.branch,
    base: handoff.base,
    remote: handoff.remote,
    prUrl: handoff.pr,
    targetId: handoff.targetId || null,
    mergeSha: handoff.targetId ? null : status.ship?.mergeSha || null,
    version: handoff.version,
    plannedTag: handoff.version ? `v${handoff.version}` : null,
    tag: null,
    pid: null,
    attempt,
    startedAt: new Date().toISOString(),
    endedAt: null,
    lastActivity: "queued for detached shipping",
    needsInput: null,
    error: null,
    steps: [],
  };
  if (status.delivery) {
    status.delivery.state = "shipping";
    const target = (status.delivery.targets || []).find((candidate) => candidate.id === handoff.targetId);
    if (target) target.state = "shipping";
  }
  const saved = writeStatus(runId, status);
  writeReport(runId, saved);
  return { status: saved, handoffPath };
}

export function markShipSupervisor(runId, pid) {
  const status = readStatus(runId);
  if (!status?.ship) throw new Error(`no queued ship phase for ${runId}`);
  status.ship.pid = pid;
  status.ship.state = "running";
  status.ship.lastActivity = "detached ship supervisor started";
  return writeStatus(runId, status);
}

export function blockQueuedShip(runId, error) {
  const status = readStatus(runId);
  if (!status?.ship) return status;
  const prompt = String(error?.message || error);
  status.state = "blocked";
  status.ship.state = "blocked";
  status.ship.phase = "preflight";
  status.ship.pid = null;
  status.ship.lastActivity = prompt;
  status.ship.needsInput = { type: "blocked", prompt, options: ["Fix the launch error and rerun ship."] };
  status.ship.error = prompt;
  if (status.delivery) {
    status.delivery.state = "blocked";
    const target = (status.delivery.targets || []).find((candidate) => candidate.id === status.ship.targetId);
    if (target) target.state = "blocked";
  }
  const saved = writeStatus(runId, status);
  writeReport(runId, saved);
  return saved;
}

export async function runShip(runId, handoff, dependencies = {}) {
  const exec = dependencies.exec || execCommand;
  const sleep =
    dependencies.sleep || ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
  const now = dependencies.now || (() => Date.now());
  const id = assertSafeSlug(runId, "run id");
  const shipDir = ensurePrivateDir(join(runDir(id), "ship"));
  const lockPath = join(shipDir, "ship.lock");
  let lockFd;
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    throw new Error(`ship phase for ${id} is already active or locked: ${error.message}`);
  }

  let status = readStatus(id);
  if (!status?.ship) {
    throw new Error(`no queued ship phase for ${id}`);
  }
  status.state = "shipping";
  status.ship.state = "running";
  status.ship.pid = process.pid;
  status.ship.needsInput = null;
  status.ship.error = null;
  status.ship.lastActivity = "validating ship handoff";
  status = save(id, status);

  try {
    preflight(handoff, exec);
    assertNotCancelled(id);
    if (handoff.flow === "formal") {
      status = await runFormal(id, status, handoff, { exec, sleep, now });
    } else {
      status = await runSimple(id, status, handoff, { exec, sleep, now });
    }
    const completedAt = new Date(now()).toISOString();
    status.ship.state = "done";
    status.ship.phase = "done";
    status.ship.pid = null;
    status.ship.endedAt = completedAt;
    status.ship.lastActivity =
      handoff.approve === "through-pr"
        ? "pull request merged"
        : `release ${status.ship.tag} shipped`;
    if (handoff.targetId) {
      recordMergedTarget(status, {
        targetId: handoff.targetId,
        prUrl: status.ship.prUrl,
        mergeSha: status.ship.mergeSha || status.ship.releaseSha,
        at: completedAt,
      });
    } else if (handoff.approve === "through-pr") {
      status.delivery.state = "merged";
      status.state = "merged";
      status.endedAt = completedAt;
    }
    if (handoff.approve === "all") {
      const verifiedMergeShas = status.ship.verifiedMergeShas || expectedMergeShas(status, status.ship);
      recordRelease(status, {
        sha: status.ship.releaseSha,
        tag: status.ship.tag,
        verifiedMergeShas,
        at: completedAt,
      });
    }
    status = save(id, status);
    writeShipSummary(id, status);
    return status;
  } catch (error) {
    status = readStatus(id) || status;
    if (error instanceof ShipCancelledError || status.state === "cancelled") {
      status.state = "cancelled";
      status.endedAt ||= new Date(now()).toISOString();
      status.ship.state = "cancelled";
      status.ship.pid = null;
      status.ship.endedAt = status.endedAt;
      status.ship.lastActivity = "shipping cancelled";
    } else if (error instanceof ShipBlockedError) {
      status.state = "blocked";
      status.endedAt = null;
      status.ship.state = "blocked";
      status.ship.pid = null;
      status.ship.lastActivity = error.message;
      status.ship.needsInput = {
        type: "blocked",
        prompt: error.message,
        options: error.options,
      };
      status.ship.error = error.message;
      if (status.delivery) {
        status.delivery.state = "blocked";
        const target = (status.delivery.targets || []).find((candidate) => candidate.id === status.ship.targetId);
        if (target) target.state = "blocked";
      }
    } else {
      status.state = "failed";
      status.endedAt = new Date(now()).toISOString();
      status.ship.state = "failed";
      status.ship.pid = null;
      status.ship.endedAt = status.endedAt;
      status.ship.lastActivity = String(error?.message || error);
      status.ship.error = String(error?.message || error);
      if (status.delivery) {
        status.delivery.state = "failed";
        const target = (status.delivery.targets || []).find((candidate) => candidate.id === status.ship.targetId);
        if (target) target.state = "failed";
      }
    }
    status = save(id, status);
    writeShipSummary(id, status);
    if (!(error instanceof ShipBlockedError) && !(error instanceof ShipCancelledError)) {
      throw error;
    }
    return status;
  } finally {
    try {
      closeSync(lockFd);
    } catch {
      // Lock may not have opened.
    }
    rmSync(lockPath, { force: true });
  }
}

async function runFormal(runId, status, handoff, dependencies) {
  const { exec, sleep, now } = dependencies;
  status = phase(runId, status, "commit", "checking the approved ship branch");
  ensureCurrentBranch(exec, handoff.worktree, handoff.branch);
  const recordedPr = handoff.pr ? viewPr(exec, handoff.worktree, handoff.pr) : null;
  if (recordedPr) validatePrTarget(recordedPr, handoff);
  const dirty = must(exec, "git", ["status", "--porcelain=v1"], handoff.worktree, "inspect branch").stdout;
  if (recordedPr?.state === "MERGED" && dirty) {
    throw new ShipBlockedError("The recorded pull request is merged, but its worktree has new changes.", [
      "Review the new changes and start a new Delivery Review and Ship Gate.",
      "Discard the unapproved changes before retrying this ship phase.",
    ]);
  }
  if (dirty) {
    if (!handoff.commitMessage) {
      throw new ShipBlockedError(
        "The ship branch has uncommitted changes; rerun with the Ship Gate commit message.",
        ["Rerun ship with --commit-message <conventional message>.", "Abandon the dirty changes."],
      );
    }
    must(exec, "git", ["add", "-A"], handoff.worktree, "stage approved changes");
    must(exec, "git", ["commit", "-m", handoff.commitMessage], handoff.worktree, "commit approved changes");
  }
  status = step(runId, status, "commit", "done", dirty ? "changes committed" : "branch already clean");

  if (recordedPr?.state === "MERGED") {
    status.ship.prUrl = recordedPr.url || handoff.pr;
    status.ship.prNumber = recordedPr.number || null;
    status.ship.mergeSha = recordedPr.mergeCommit?.oid || recordedPr.mergeCommit || null;
    status = step(runId, status, "push", "skipped", "pull request already merged");
    status = step(runId, status, "pr", "done", status.ship.prUrl || `#${status.ship.prNumber}`);
    status = step(runId, status, "merge", "done", status.ship.mergeSha || "already merged");
    if (handoff.approve === "through-pr") return status;
    return await releaseFormal(runId, status, handoff, { exec, sleep, now });
  }

  assertNotCancelled(runId);
  status = phase(runId, status, "push", `pushing ${handoff.branch}`);
  must(
    exec,
    "git",
    ["push", "--set-upstream", handoff.remote, handoff.branch],
    handoff.worktree,
    "push ship branch",
  );
  status = step(runId, status, "push", "done", `${handoff.remote}/${handoff.branch}`);

  assertNotCancelled(runId);
  status = phase(runId, status, "pr", "finding or creating the pull request");
  let pr = recordedPr || viewPr(exec, handoff.worktree, handoff.branch, false);
  if (!pr) {
    const created = must(
      exec,
      "gh",
      ["pr", "create", "--head", handoff.branch, "--base", handoff.base, "--fill"],
      handoff.worktree,
      "create pull request",
    );
    const url = created.stdout.split(/\r?\n/).find((line) => /^https?:\/\//.test(line.trim()))?.trim();
    if (!url) {
      throw new ShipBlockedError("The pull request was created but its URL could not be read.", [
        "Provide the pull request URL with --pr and rerun ship.",
      ]);
    }
    pr = viewPr(exec, handoff.worktree, url);
  }
  validatePrTarget(pr, handoff);
  status.ship.prUrl = pr.url || handoff.pr;
  status.ship.prNumber = pr.number || null;
  status = step(runId, status, "pr", "done", status.ship.prUrl || `#${status.ship.prNumber}`);

  assertNotCancelled(runId);
  status = phase(runId, status, "merge", "enabling squash auto-merge");
  if (pr.state !== "MERGED") {
    must(
      exec,
      "gh",
      ["pr", "merge", status.ship.prUrl || String(status.ship.prNumber), "--auto", "--squash"],
      handoff.worktree,
      "enable pull request auto-merge",
    );
  }
  const merged = await waitForPr(runId, status, handoff, { exec, sleep, now });
  status = merged.status;
  status.ship.mergeSha = merged.pr.mergeCommit?.oid || merged.pr.mergeCommit || null;
  status.ship.prUrl = merged.pr.url || status.ship.prUrl;
  status = step(runId, status, "merge", "done", status.ship.mergeSha || "merged");

  if (handoff.approve === "through-pr") return status;

  assertNotCancelled(runId);
  return await releaseFormal(runId, status, handoff, { exec, sleep, now });
}

async function runSimple(runId, status, handoff, dependencies) {
  const { exec, sleep, now } = dependencies;
  const simpleRoot = handoff.worktree || handoff.repoRoot;
  const simpleHandoff = { ...handoff, repoRoot: simpleRoot };
  ensureCurrentBranch(exec, simpleRoot, handoff.branch);
  status = phase(runId, status, "release", `stamping ${handoff.version}`);
  const stamp = applyVersionStamp(simpleRoot, handoff.version, handoff.summary, now());
  verifyVersionStamp(simpleRoot, handoff.version, exec);
  status = step(runId, status, "release", "done", stamp.files.join(", "));

  assertNotCancelled(runId);
  status = phase(runId, status, "commit", "committing the approved release");
  must(exec, "git", ["add", "-A"], simpleRoot, "stage approved release");
  const dirty = must(exec, "git", ["status", "--porcelain=v1"], simpleRoot, "inspect release").stdout;
  if (dirty) {
    must(exec, "git", ["commit", "-m", handoff.commitMessage], simpleRoot, "commit approved release");
  }
  const sha = must(exec, "git", ["rev-parse", "HEAD"], simpleRoot, "read release commit").stdout;
  status.ship.releaseSha = sha;
  status = step(runId, status, "commit", "done", sha);

  status = phase(runId, status, "push", `pushing ${handoff.branch} to ${handoff.base}`);
  must(exec, "git", ["push", handoff.remote, `HEAD:${handoff.base}`], simpleRoot, "push release");
  status = step(runId, status, "push", "done", `${handoff.remote}/${handoff.base}`);

  status = await waitForCiIfConfigured(runId, status, simpleRoot, sha, handoff, {
    exec,
    sleep,
    now,
  });
  return tagRelease(runId, status, simpleHandoff, sha, exec);
}

async function releaseFormal(runId, status, handoff, dependencies) {
  const { exec, sleep, now } = dependencies;
  status = phase(runId, status, "release", `preparing ${handoff.version} on ${handoff.base}`);
  const dirty = must(
    exec,
    "git",
    ["status", "--porcelain=v1"],
    handoff.repoRoot,
    "inspect release checkout",
  ).stdout;
  if (dirty) {
    throw new ShipBlockedError("The base-branch checkout has local changes.", [
      "Clean or preserve the local changes, then rerun ship.",
    ]);
  }
  must(exec, "git", ["fetch", handoff.remote, handoff.base], handoff.repoRoot, "fetch base branch");
  must(exec, "git", ["switch", handoff.base], handoff.repoRoot, "switch to base branch");
  must(
    exec,
    "git",
    ["pull", "--ff-only", handoff.remote, handoff.base],
    handoff.repoRoot,
    "fast-forward base branch",
  );
  const baseSha = must(exec, "git", ["rev-parse", "HEAD"], handoff.repoRoot, "read release base").stdout;
  status = verifyDeliveryAncestry(runId, status, handoff, baseSha, exec);
  const stamp = applyVersionStamp(handoff.repoRoot, handoff.version, handoff.summary, now());
  verifyVersionStamp(handoff.repoRoot, handoff.version, exec);
  must(exec, "git", ["add", ...stamp.files], handoff.repoRoot, "stage release stamp");
  const stampDirty = must(
    exec,
    "git",
    ["status", "--porcelain=v1"],
    handoff.repoRoot,
    "inspect release stamp",
  ).stdout;
  if (stampDirty) {
    must(
      exec,
      "git",
      ["commit", "-m", `chore: release ${handoff.version}`],
      handoff.repoRoot,
      "commit release stamp",
    );
  }
  const sha = must(exec, "git", ["rev-parse", "HEAD"], handoff.repoRoot, "read release commit").stdout;
  status.ship.releaseSha = sha;
  status = step(runId, status, "release", "done", sha);

  status = phase(runId, status, "release-push", `pushing ${handoff.base}`);
  must(exec, "git", ["push", handoff.remote, handoff.base], handoff.repoRoot, "push release stamp");
  status = step(runId, status, "release-push", "done", `${handoff.remote}/${handoff.base}`);

  status = await waitForCiIfConfigured(runId, status, handoff.repoRoot, sha, handoff, {
    exec,
    sleep,
    now,
  });
  return tagRelease(runId, status, handoff, sha, exec);
}

export function verifyDeliveryAncestry(runId, status, handoff, releaseBaseSha, exec = execCommand) {
  const targets = status.delivery?.targets || [];
  if (!targets.length || handoff.flow !== "formal") return status;
  const expected = expectedMergeShas(status, status.ship);
  if (expected.length !== targets.length) {
    const missing = targets
      .filter((target) => !target.mergeSha && !(status.ship?.targetId === target.id && status.ship?.mergeSha))
      .map((target) => target.id);
    throw new ShipBlockedError(
      `release is missing merge evidence for delivery target(s): ${missing.join(", ")}`,
      ["Merge every delivery target before creating the release stamp."],
    );
  }
  for (const mergeSha of expected) {
    const result = exec("git", ["merge-base", "--is-ancestor", mergeSha, releaseBaseSha], {
      cwd: handoff.repoRoot,
    });
    if (!result.ok) {
      throw new ShipBlockedError(
        `release base ${releaseBaseSha} does not contain expected merge ${mergeSha}`,
        ["Update the release base to contain every delivery target merge, then rerun shipping."],
      );
    }
  }
  status.ship.verifiedMergeShas = expected;
  return save(runId, status);
}

async function waitForPr(runId, status, handoff, { exec, sleep, now }) {
  const deadline = now() + handoff.timeoutSec * 1000;
  let updatedBehind = false;
  while (now() <= deadline) {
    assertNotCancelled(runId);
    const pr = viewPr(exec, handoff.worktree, status.ship.prUrl || String(status.ship.prNumber));
    validatePrTarget(pr, handoff);
    status.ship.lastActivity = `PR ${pr.state || "UNKNOWN"} · ${pr.mergeStateStatus || "UNKNOWN"}`;
    status.ship.checks = summarizeChecks(pr.statusCheckRollup);
    status.ship.reviewDecision = pr.reviewDecision || null;
    status = save(runId, status);
    if (pr.state === "MERGED") return { status, pr };
    if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
      throw new ShipBlockedError("The pull request has merge conflicts.", [
        "Resolve the conflicts on the ship branch and rerun ship.",
        "Abandon the ship phase.",
      ]);
    }
    if (pr.reviewDecision === "CHANGES_REQUESTED") {
      throw new ShipBlockedError("A pull-request review requested changes.", [
        "Address the review feedback on the ship branch and rerun ship.",
        "Reject or abandon the release.",
      ]);
    }
    const failed = failedChecks(pr.statusCheckRollup);
    if (failed.length) {
      throw new ShipBlockedError(`Pull request checks failed: ${failed.join(", ")}`, [
        "Fix the failing checks on the ship branch and rerun ship.",
        "Reject or abandon the release.",
      ]);
    }
    const blockedDiag = diagnoseBlockedMerge(pr, exec, handoff.worktree);
    if (blockedDiag) throw blockedDiag;
    if (pr.mergeStateStatus === "BEHIND" && !updatedBehind) {
      must(
        exec,
        "gh",
        ["pr", "update-branch", status.ship.prUrl || String(status.ship.prNumber)],
        handoff.worktree,
        "update pull request branch",
      );
      updatedBehind = true;
      status.ship.lastActivity = "base branch update requested";
      status = save(runId, status);
    }
    await sleep(handoff.pollSec * 1000);
  }
  throw new ShipBlockedError("Timed out waiting for the pull request to merge.", [
    "Compare branch-protection required status checks to the PR check names (exact match).",
    "Inspect reviews and CI, then rerun ship.",
  ]);
}

async function waitForCiIfConfigured(
  runId,
  status,
  repoRoot,
  sha,
  handoff,
  { exec, sleep, now },
) {
  if (!hasCiWorkflows(repoRoot)) {
    status = step(runId, status, "ci", "skipped", "no GitHub Actions workflows detected");
    return status;
  }
  status = phase(runId, status, "ci", `waiting for CI on ${sha.slice(0, 12)}`);
  const deadline = now() + handoff.timeoutSec * 1000;
  while (now() <= deadline) {
    assertNotCancelled(runId);
    const result = must(
      exec,
      "gh",
      [
        "run",
        "list",
        "--commit",
        sha,
        "--limit",
        "50",
        "--json",
        "databaseId,status,conclusion,url,workflowName,event,headSha",
      ],
      repoRoot,
      "read release CI",
    );
    const runs = parseJson(result.stdout, "GitHub Actions runs");
    if (!Array.isArray(runs)) {
      throw new ShipBlockedError("GitHub returned an invalid CI response.", [
        "Inspect GitHub Actions and rerun ship.",
      ]);
    }
    const failed = runs.filter((run) => FAILURE_CONCLUSIONS.has(run.conclusion));
    if (failed.length) {
      throw new ShipBlockedError(
        `Release CI failed: ${failed.map((run) => run.workflowName || run.databaseId).join(", ")}`,
        ["Fix the failed workflow and rerun ship.", "Reject or abandon the release."],
      );
    }
    if (runs.length && runs.every((run) => run.status === "completed")) {
      status.ship.ci = {
        state: "green",
        runs: runs.map((run) => ({
          id: run.databaseId,
          workflow: run.workflowName,
          conclusion: run.conclusion,
          url: run.url,
        })),
      };
      return step(runId, status, "ci", "done", `${runs.length} workflow run(s) green`);
    }
    status.ship.lastActivity = runs.length
      ? `CI running (${runs.filter((run) => run.status !== "completed").length} pending)`
      : "waiting for GitHub to register CI";
    status = save(runId, status);
    await sleep(handoff.pollSec * 1000);
  }
  throw new ShipBlockedError("Timed out waiting for release CI.", [
    "Inspect GitHub Actions and rerun ship.",
  ]);
}

function tagRelease(runId, status, handoff, sha, exec) {
  const tag = `v${handoff.version}`;
  status = phase(runId, status, "tag", `publishing ${tag}`);
  const local = exec("git", ["rev-parse", `refs/tags/${tag}^{}`], { cwd: handoff.repoRoot });
  if (local.ok && local.stdout !== sha) {
    throw new ShipBlockedError(`${tag} already exists at a different commit.`, [
      "Choose a new version; published tags must not move.",
    ]);
  }
  const remote = must(
    exec,
    "git",
    ["ls-remote", "--tags", handoff.remote, `refs/tags/${tag}`],
    handoff.repoRoot,
    "inspect remote tag",
  );
  if (remote.stdout) {
    const remoteSha = remote.stdout.split(/\s+/)[0];
    if (remoteSha !== sha) {
      throw new ShipBlockedError(`${tag} already exists remotely at a different commit.`, [
        "Choose a new version; published tags must not move.",
      ]);
    }
  } else {
    if (!local.ok) must(exec, "git", ["tag", tag, sha], handoff.repoRoot, "create release tag");
    must(exec, "git", ["push", handoff.remote, tag], handoff.repoRoot, "push release tag");
  }
  status.ship.tag = tag;
  return step(runId, status, "tag", "done", tag);
}

export function applyVersionStamp(repoRoot, version, summary, timestamp = Date.now()) {
  if (!SEMVER.test(version)) throw new Error(`invalid release version: ${version}`);
  const versionPath = join(repoRoot, "Version.md");
  if (!existsSync(versionPath)) {
    throw new ShipBlockedError("Version.md is required for an approved release.", [
      "Add the repository version contract, then rerun ship.",
    ]);
  }
  const versionDocument = readFileSync(versionPath, "utf8");
  const currentMatch = versionDocument.match(/^current:\s*(\d+\.\d+\.\d+)\s*$/m);
  if (!currentMatch) throw new Error("Version.md does not contain a valid current version");
  if (compareSemver(version, currentMatch[1]) < 0) {
    throw new ShipBlockedError(`release version ${version} is older than ${currentMatch[1]}`, [
      "Choose a version greater than or equal to the current version.",
    ]);
  }

  const heading = new RegExp(`^## ${escapeRegex(version)}(?:\\s|$)`, "m");
  let nextVersionDocument = versionDocument;
  if (currentMatch[1] !== version) {
    if (heading.test(versionDocument)) {
      throw new ShipBlockedError(`Version.md already contains a history entry for ${version}.`, [
        "Choose a new version or reconcile Version.md manually.",
      ]);
    }
    nextVersionDocument = nextVersionDocument.replace(currentMatch[0], `current: ${version}`);
    const date = new Date(timestamp).toISOString().slice(0, 10);
    const entry = `# Version History\n\n## ${version} - ${date}\n\n${summary}`;
    if (!nextVersionDocument.includes("# Version History")) {
      throw new Error("Version.md is missing the Version History heading");
    }
    nextVersionDocument = nextVersionDocument.replace("# Version History", entry);
  } else if (!heading.test(versionDocument)) {
    throw new ShipBlockedError(`Version.md current is ${version} but its history entry is missing.`, [
      "Repair the version history, then rerun ship.",
    ]);
  }

  const writes = [{ path: versionPath, content: nextVersionDocument }];
  const files = ["Version.md"];
  for (const name of ["package.json", "package-lock.json"]) {
    const path = join(repoRoot, name);
    if (!existsSync(path)) continue;
    const document = readFileSync(path, "utf8");
    const parsed = JSON.parse(document);
    parsed.version = version;
    if (name === "package-lock.json" && parsed.packages?.[""]) {
      parsed.packages[""].version = version;
    }
    writes.push({ path, content: JSON.stringify(parsed, null, detectIndent(document)) + "\n" });
    files.push(name);
  }
  for (const write of writes) atomicWrite(write.path, write.content);
  return { version, files };
}

export function verifyVersionStamp(repoRoot, version, exec = execCommand) {
  const versionDocument = readFileSync(join(repoRoot, "Version.md"), "utf8");
  const current = versionDocument.match(/^current:\s*(\S+)\s*$/m)?.[1];
  if (current !== version) throw new Error(`Version.md is ${current || "missing"}; expected ${version}`);
  for (const name of ["package.json", "package-lock.json"]) {
    const path = join(repoRoot, name);
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed.version !== version) throw new Error(`${name} is ${parsed.version}; expected ${version}`);
    if (name === "package-lock.json" && parsed.packages?.[""]?.version !== version) {
      throw new Error(`${name} package root is ${parsed.packages?.[""]?.version}; expected ${version}`);
    }
  }
  const packagePath = join(repoRoot, "package.json");
  if (existsSync(packagePath)) {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    if (packageJson.scripts?.["check:version"]) {
      must(exec, "npm", ["run", "check:version"], repoRoot, "check version stamp");
    }
  }
  return true;
}

export function execCommand(command, args, { cwd } = {}) {
  const override = command === "gh" ? process.env.AGENT_MANAGER_GH_BIN : null;
  const { result } = spawnCommandSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    env: process.env,
    override,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.error?.message || result.stderr || "").trim(),
  };
}

function preflight(handoff, exec) {
  must(exec, "git", ["--version"], handoff.worktree, "find Git");
  must(exec, "gh", ["--version"], handoff.worktree, "find GitHub CLI");
  must(exec, "gh", ["auth", "status"], handoff.worktree, "verify GitHub authentication");
  if (handoff.approve === "all") {
    must(exec, "npm", ["--version"], handoff.worktree, "find npm for version checks");
  }
  must(
    exec,
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    handoff.repoRoot,
    "validate release repository",
  );
  must(
    exec,
    "git",
    ["check-ref-format", "--branch", handoff.branch],
    handoff.worktree,
    "validate ship branch",
  );
  must(
    exec,
    "git",
    ["check-ref-format", "--branch", handoff.base],
    handoff.worktree,
    "validate base branch",
  );
  must(
    exec,
    "git",
    ["remote", "get-url", handoff.remote],
    handoff.worktree,
    "validate ship remote",
  );
  ensureCurrentBranch(exec, handoff.worktree, handoff.branch);
  if (handoff.flow === "formal") {
    assertPathInside(runDir(handoff.runId), handoff.worktree, "ship worktree");
  }
}

function ensureCurrentBranch(exec, cwd, branch) {
  const current = must(exec, "git", ["branch", "--show-current"], cwd, "read current branch").stdout;
  if (current !== branch) {
    throw new ShipBlockedError(`Expected branch ${branch}, but ${current || "detached HEAD"} is checked out.`, [
      `Check out ${branch} in the approved worktree, then rerun ship.`,
    ]);
  }
}

function viewPr(exec, cwd, target, required = true) {
  const result = exec(
    "gh",
    [
      "pr",
      "view",
      target,
      "--json",
      "state,mergeStateStatus,mergeable,reviewDecision,statusCheckRollup,mergedAt,mergeCommit,url,number,headRefName,baseRefName",
    ],
    { cwd },
  );
  if (!result.ok) {
    if (!required) return null;
    throw new ShipBlockedError(`Unable to read pull request: ${result.stderr || result.stdout}`, [
      "Verify GitHub authentication and the pull request reference, then rerun ship.",
    ]);
  }
  return parseJson(result.stdout, "pull request");
}

function failedChecks(checks = []) {
  return checks
    .filter((check) => FAILURE_CONCLUSIONS.has(String(check.conclusion || "").toLowerCase()))
    .map((check) => check.name || check.context || "unnamed check");
}

function checkIsPending(check) {
  const status = String(check.status || "").toUpperCase();
  return status === "QUEUED" || status === "IN_PROGRESS" || status === "WAITING" || status === "PENDING";
}

function checkLooksComplete(check) {
  if (checkIsPending(check)) return false;
  const conclusion = String(check.conclusion || "").toLowerCase();
  return conclusion === "success" || conclusion === "skipped" || conclusion === "neutral" || conclusion === "";
}

function reportedCheckNames(checks = []) {
  return checks.map((check) => check.name || check.context || "unnamed check");
}

export function requiredStatusContexts(exec, cwd, baseBranch) {
  const result = exec(
    "gh",
    [
      "api",
      `repos/{owner}/{repo}/branches/${baseBranch}/protection/required_status_checks`,
      "--jq",
      ".contexts // []",
    ],
    { cwd },
  );
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(String(result.stdout || "null"));
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * When GitHub reports BLOCKED but CI conclusions look fine, detect required
 * status-check name mismatch (or leftover review requirements) instead of
 * implying a human Approve click.
 */
export function diagnoseBlockedMerge(pr, exec, cwd) {
  if (!pr || pr.state === "MERGED") return null;
  if (pr.mergeStateStatus !== "BLOCKED") return null;
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  if (failedChecks(checks).length) return null;
  if (pr.reviewDecision === "CHANGES_REQUESTED") return null;
  if (checks.some(checkIsPending)) return null;

  const reported = reportedCheckNames(checks);
  const required = requiredStatusContexts(exec, cwd, pr.baseRefName);
  if (required?.length) {
    const missingOrNotGreen = required.filter((ctx) => {
      const match = checks.find((check) => (check.name || check.context) === ctx);
      if (!match) return true;
      const conclusion = String(match.conclusion || "").toLowerCase();
      return conclusion !== "success" && conclusion !== "skipped" && conclusion !== "neutral";
    });
    if (missingOrNotGreen.length) {
      return new ShipBlockedError(
        `Branch protection requires status check(s) that are missing or not green under that exact name: ${missingOrNotGreen.join(", ")}. CI reported: ${reported.join(", ") || "(none)"}.`,
        [
          "Restore the workflow job display name to match protection (preferred), or update required status checks to the real check name.",
          "Do not treat this as a missing human PR approval unless reviewDecision is REVIEW_REQUIRED.",
          "Rerun ship after the check names match and CI is green.",
        ],
      );
    }
  }

  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    return new ShipBlockedError("Branch protection still requires a pull-request review.", [
      "Lower required approving review count or approve the PR, then rerun ship.",
    ]);
  }

  if (checks.length && checks.every(checkLooksComplete)) {
    return new ShipBlockedError(
      `Pull request is BLOCKED while reported checks look complete (${reported.join(", ") || "none"}). Often a required status-check name mismatch (protection expects a different exact name than CI reports).`,
      [
        "Compare Settings → Branches → required status checks to statusCheckRollup names.",
        "Do not assume a human Approve click is required if reviewDecision is empty and required_approving_review_count is 0.",
        "Fix the name mismatch, then rerun ship.",
      ],
    );
  }
  return null;
}

function validatePrTarget(pr, handoff) {
  if (pr.headRefName !== handoff.branch || pr.baseRefName !== handoff.base) {
    throw new ShipBlockedError(
      `Pull request target mismatch: expected ${handoff.branch} → ${handoff.base}.`,
      ["Provide the correct pull request or branch/base values and rerun ship."],
    );
  }
  if (pr.state === "CLOSED") {
    throw new ShipBlockedError("The pull request is closed without merging.", [
      "Reopen it or create a replacement pull request, then rerun ship.",
    ]);
  }
}

function summarizeChecks(checks = []) {
  return checks.map((check) => ({
    name: check.name || check.context || "unnamed check",
    status: check.status || null,
    conclusion: check.conclusion || null,
  }));
}

function hasCiWorkflows(repoRoot) {
  const dir = join(repoRoot, ".github", "workflows");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) => /\.ya?ml$/i.test(name));
}

function phase(runId, status, name, activity) {
  status.ship.phase = name;
  status.ship.state = "running";
  status.ship.lastActivity = activity;
  status.ship.needsInput = null;
  status.ship.steps = status.ship.steps || [];
  const existing = status.ship.steps.find((item) => item.name === name);
  if (existing) {
    existing.state = "running";
    existing.startedAt ||= new Date().toISOString();
    existing.endedAt = null;
    existing.detail = activity;
  } else {
    status.ship.steps.push({
      name,
      state: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      detail: activity,
    });
  }
  return save(runId, status);
}

function step(runId, status, name, state, detail) {
  status.ship.steps = status.ship.steps || [];
  const item = status.ship.steps.find((entry) => entry.name === name);
  if (item) {
    item.state = state;
    item.endedAt = new Date().toISOString();
    item.detail = detail;
  } else {
    status.ship.steps.push({
      name,
      state,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      detail,
    });
  }
  status.ship.lastActivity = `${name}: ${detail}`;
  return save(runId, status);
}

function save(runId, status) {
  const saved = writeStatus(runId, status);
  writeReport(runId, saved);
  return saved;
}

function writeShipSummary(runId, status) {
  const path = join(runDir(runId), "ship", "summary.json");
  writePrivateFile(path, JSON.stringify(status.ship, null, 2) + "\n", "utf8");
  return path;
}

function assertNotCancelled(runId) {
  if (existsSync(join(runDir(runId), "cancelled.json")) || readStatus(runId)?.state === "cancelled") {
    throw new ShipCancelledError();
  }
}

function must(exec, command, args, cwd, label) {
  const result = exec(command, args, { cwd });
  if (!result.ok) {
    throw new ShipBlockedError(`${label} failed: ${result.stderr || result.stdout || "unknown error"}`, [
      "Resolve the command failure and rerun ship.",
      "Abandon the ship phase.",
    ]);
  }
  return result;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid ${label} JSON: ${error.message}`);
  }
}

function normalizeBase(value, remote) {
  const text = String(value || "");
  return text.startsWith(`${remote}/`) ? text.slice(remote.length + 1) : text;
}

function safeArgument(value, label) {
  const text = optionalSingleLine(value, label, 240);
  if (!text || text.startsWith("-") || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${label} must be a safe non-option argument`);
  }
  return text;
}

function optionalSingleLine(value, label, maxLength) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!text || text.length > maxLength || /[\r\n]/.test(text)) {
    throw new Error(`${label} must be a single line of 1-${maxLength} characters`);
  }
  return text;
}

function boundedNumber(value, label, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return number;
}

function detectIndent(document) {
  return Math.min(8, document.match(/\n( +)"/)?.[1]?.length || 2);
}

function atomicWrite(path, content) {
  const temp = `${path}.agent-manager-${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function compareSemver(left, right) {
  const parse = (value) => value.split(/[+-]/, 1)[0].split(".").map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
