import { createHash, randomBytes } from "node:crypto";
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
import { syncBrainStatus } from "./brain.mjs";
import {
  assertAcceptedReview,
  expectedMergeShas,
  recordMergedTarget,
  recordRelease,
  selectDeliveryTarget,
} from "./delivery.mjs";
import {
  assertAuthorizationReceipt,
  AuthorizationError,
  inspectAuthorization,
} from "./authorization.mjs";

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

const REMOTE_RETRY_ATTEMPTS = 5;
const REMOTE_RETRY_BASE_MS = 1_000;
const REMOTE_RETRY_MAX_MS = 30_000;
const BLOCK_CONFIRM_MAX_MS = 15_000;
const TAG_RUN_REGISTRATION_GRACE_MS = 30_000;

/**
 * Failures that mean "GitHub did not answer", not "GitHub answered no". A ship that
 * reads these as a verdict parks an approved release in needs-input until an operator
 * looks: one TLS handshake timeout held an already-merged pull request there for 23h.
 */
const TRANSIENT_REMOTE_PATTERNS = [
  /\bE(?:CONNRESET|CONNABORTED|CONNREFUSED|PIPE|TIMEDOUT|AI_AGAIN|NOTFOUND|NETUNREACH|NETRESET|HOSTUNREACH)\b/i,
  /connection (?:reset|refused|closed|timed out)/i,
  /connection was (?:reset|aborted)/i,
  /socket hang ?up/i,
  /tls handshake timeout/i,
  /handshake fail/i,
  /unexpected eof/i,
  /\btimed out\b/i,
  /\btimeouts?\b/i,
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /network is unreachable/i,
  /remote end hung up/i,
  /\brpc failed\b/i,
  /early eof/i,
  /\bhttp 5\d{2}\b/i,
  /returned error: 5\d{2}\b/i,
  /\b(?:bad gateway|service unavailable|gateway time-?out|internal server error)\b/i,
  /\bserver error\b/i,
];

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

  const resolvedBase = resolveShipBase({
    explicit: options.base || null,
    recorded: target?.base || status.baseRef || null,
    remote,
    cwd: worktree,
    exec: options.exec || execCommand,
  });
  const base = safeArgument(resolvedBase.base, "base branch");
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
  const checkGraceSec = boundedNumber(
    options.checkGraceSec ?? 90,
    "check registration grace seconds",
    0,
    900,
  );
  const retryAttempts = boundedNumber(
    options.retryAttempts ?? REMOTE_RETRY_ATTEMPTS,
    "remote retry attempts",
    1,
    10,
  );
  const retryBaseMs = boundedNumber(
    options.retryBaseMs ?? REMOTE_RETRY_BASE_MS,
    "remote retry base milliseconds",
    100,
    60_000,
  );
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
    baseSource: resolvedBase.source,
    baseResolvedFrom: resolvedBase.resolvedFrom,
    remote,
    pr,
    targetId: target?.id || null,
    commitMessage,
    version,
    summary,
    pollSec,
    timeoutSec,
    checkGraceSec,
    retryAttempts,
    retryBaseMs,
    runtime: detectRuntimeProfile(),
    requestedAt: new Date().toISOString(),
  };
}

/**
 * True when a recorded base ref names a moving pointer or a bare commit rather than a
 * branch. `base_ref` defaults to HEAD so lane worktrees fork from the current commit;
 * shipping to a literal `HEAD` (or a raw SHA) would push to the wrong ref.
 */
export function isSymbolicBaseRef(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  return text === "HEAD" || text === "@" || /^[0-9a-f]{40}$/i.test(text);
}

/**
 * Read the remote's default branch: the local remote-HEAD pointer first, then GitHub.
 * Returns null when neither answers so the caller can fall back explicitly.
 */
export function resolveDefaultBaseBranch(exec, cwd, remote) {
  const symbolic = exec("git", ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], { cwd });
  if (symbolic.ok && symbolic.stdout) {
    const value = symbolic.stdout.split(/\r?\n/)[0].trim();
    const branch = value.startsWith(`${remote}/`) ? value.slice(remote.length + 1) : value;
    if (branch) return branch;
  }
  const viewed = exec(
    "gh",
    ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
    { cwd },
  );
  if (viewed.ok && viewed.stdout.trim()) return viewed.stdout.split(/\r?\n/)[0].trim();
  return null;
}

/**
 * Pick the branch an approved shipment pushes into. An explicit --base always wins; a
 * recorded branch name is kept; a symbolic default resolves to the remote's default
 * branch, and only then falls back to main.
 */
export function resolveShipBase({ explicit, recorded, remote, cwd, exec = execCommand }) {
  if (explicit) return { base: explicit, source: "override", resolvedFrom: null };
  const candidate = recorded ? normalizeBase(recorded, remote) : "";
  if (candidate && !isSymbolicBaseRef(candidate)) {
    return { base: candidate, source: "recorded", resolvedFrom: null };
  }
  const resolved = resolveDefaultBaseBranch(exec, cwd, remote);
  return {
    base: resolved || "main",
    source: resolved ? "remote-default" : "fallback",
    resolvedFrom: candidate || null,
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
    baseSource: handoff.baseSource || null,
    baseResolvedFrom: handoff.baseResolvedFrom || null,
    remote: handoff.remote,
    prUrl: handoff.pr,
    targetId: handoff.targetId || null,
    mergeSha: handoff.targetId ? null : status.ship?.mergeSha || null,
    releaseSha: status.ship?.releaseSha || null,
    releasePrUrl: status.ship?.releasePrUrl || null,
    releasePrNumber: status.ship?.releasePrNumber || null,
    releaseBranch: status.ship?.releaseBranch || null,
    releaseTransaction: status.ship?.releaseTransaction || null,
    releaseCi: status.ship?.releaseCi || null,
    providerCapabilities: handoff.providerCapabilities || status.ship?.providerCapabilities || null,
    version: handoff.version,
    // Carried across attempts on purpose: a version plan stamped on an earlier attempt
    // is what a resumed ship has to re-validate against the target repo's base branch.
    versionPlan: status.ship?.versionPlan || null,
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
    authorization: handoff.authorization ? {
      grantDigest: handoff.authorization.grantDigest,
      receiptDigest: handoff.authorization.receiptDigest,
    } : null,
  };
  if (handoff.authorization) status.authorization = inspectAuthorization(status).summary;
  if (status.delivery) {
    status.delivery.state = "shipping";
    const target = (status.delivery.targets || []).find((candidate) => candidate.id === handoff.targetId);
    if (target) {
      target.state = "shipping";
      target.baseBranch = handoff.base;
      target.baseCommit ||= /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(String(target.base || ""))
        ? target.base
        : status.baseCommit || null;
    }
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
  const tagRegistrationGraceMs =
    dependencies.tagRegistrationGraceMs ?? TAG_RUN_REGISTRATION_GRACE_MS;
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

  try {
    assertAuthorizationReceipt(status, handoff, { exec });
    await syncBrainStatus(status);
    status = save(id, status);
    preflight(handoff, exec);
    assertNotCancelled(id);
    if (handoff.flow === "formal") {
      status = await runFormal(id, status, handoff, {
        exec,
        sleep,
        now,
        tagRegistrationGraceMs,
      });
    } else {
      status = await runSimple(id, status, handoff, {
        exec,
        sleep,
        now,
        tagRegistrationGraceMs,
      });
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
        mode: status.delivery?.release?.mode || "tag-only",
        tagCi: releaseCiEvidence(status.ship.releaseCi, status.ship.tag),
        at: completedAt,
      });
    }
    status = save(id, status);
    await syncBrainStatus(status).catch((error) => {
      status.awareness.lastError = String(error?.message || error);
      status = save(id, status);
    });
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
    } else if (error instanceof ShipBlockedError || error instanceof AuthorizationError) {
      status.state = "blocked";
      status.endedAt = null;
      status.ship.state = "blocked";
      status.ship.pid = null;
      status.ship.lastActivity = error.message;
      status.ship.needsInput = {
        type: "blocked",
        prompt: error.message,
        options: error.options || [error.action],
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
    await syncBrainStatus(status).catch((brainError) => {
      status.awareness.lastError = String(brainError?.message || brainError);
      status = save(id, status);
    });
    writeShipSummary(id, status);
    if (!(error instanceof ShipBlockedError)
      && !(error instanceof AuthorizationError)
      && !(error instanceof ShipCancelledError)) {
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
  const prContext = remoteOptions(runId, handoff, sleep, "pull request state");
  let recordedPr = null;
  if (handoff.pr) {
    const recorded = await readPr(exec, handoff.worktree, handoff.pr, prContext);
    recordedPr = recorded.pr;
    status.ship.remoteRetries = addRetries(status, recorded.retries);
    validatePrTarget(recordedPr, handoff);
  }
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
    if (!status.ship.releaseTransaction) {
      const preStamped = await bindPreStampedDeliveryMerge(runId, status, handoff, recordedPr, {
        exec,
        sleep,
      });
      if (preStamped) {
        return await finalizeFormalReleaseFromMergedPr(runId, preStamped, handoff, recordedPr, {
          exec,
          sleep,
          now,
        });
      }
    }
    if (status.ship.releaseTransaction?.mode === "delivery-pr") {
      return await finalizeFormalReleaseFromMergedPr(runId, status, handoff, recordedPr, {
        exec,
        sleep,
        now,
      });
    }
    return await releaseFormal(runId, status, handoff, { exec, sleep, now });
  }

  if (handoff.approve === "all") {
    status = await prepareFormalStamp(runId, status, handoff, handoff.worktree, "delivery-pr", {
      exec,
      sleep,
      now,
    });
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

  const merged = await completeFormalPullRequest(runId, status, handoff, {
    exec,
    sleep,
    now,
    pr: recordedPr,
    context: prContext,
    urlField: "prUrl",
    numberField: "prNumber",
    prStep: "pr",
    mergeStep: "merge",
    prActivity: "finding or creating the pull request",
    mergeActivity: "enabling squash auto-merge",
    label: "pull request",
    expectedHeadSha: status.ship.releaseTransaction?.mode === "delivery-pr"
      ? status.ship.releaseTransaction.headSha || status.ship.releaseTransaction.stampCommitSha
      : null,
  });
  status = merged.status;
  status.ship.mergeSha = merged.pr.mergeCommit?.oid || merged.pr.mergeCommit || null;
  status = step(runId, status, "merge", "done", status.ship.mergeSha || "merged");

  if (handoff.approve === "through-pr") return status;

  assertNotCancelled(runId);
  return await finalizeFormalReleaseFromMergedPr(runId, status, handoff, merged.pr, {
    exec,
    sleep,
    now,
  });
}

async function bindPreStampedDeliveryMerge(runId, status, handoff, pr, { exec, sleep }) {
  const mergeSha = pr.mergeCommit?.oid || pr.mergeCommit || status.ship.mergeSha || null;
  if (!mergeSha) return null;
  const target = (status.delivery?.targets || []).find((candidate) => candidate.id === handoff.targetId);
  if (!target || status.delivery?.review?.state !== "accepted") {
    throw new ShipBlockedError("The merged pull request is not bound to the accepted delivery review.", [
      "Restore the reviewed delivery target before attempting the release.",
    ]);
  }
  if (target.mergeSha && target.mergeSha !== mergeSha) {
    throw new ShipBlockedError("The merged pull request commit differs from the recorded delivery merge.", [
      "Review the unexpected merge SHA and start a new Delivery Review before releasing it.",
    ]);
  }
  status = await ensureVersionPlan(runId, status, handoff, handoff.worktree, { exec, sleep });
  must(exec, "git", ["fetch", handoff.remote, handoff.base], handoff.worktree, "fetch merged delivery release");
  if (!exec("git", ["merge-base", "--is-ancestor", mergeSha, `${handoff.remote}/${handoff.base}`], {
    cwd: handoff.worktree,
  }).ok) {
    throw new ShipBlockedError("The reviewed pull request merge is not contained in the recorded base branch.", [
      "Do not release the unrelated SHA; verify the provider merge and base branch.",
    ]);
  }
  const versionDocument = readFileAtRef(exec, handoff.worktree, mergeSha, "Version.md", {
    required: true,
    label: "inspect merged delivery version",
  });
  const observedVersion = versionDocument.match(/^current:\s*(\S+)\s*$/m)?.[1] || null;
  if (observedVersion !== handoff.version) return null;

  const files = verifyVersionStampAtRef(exec, handoff.worktree, mergeSha, handoff.version);
  const manifest = buildStampManifestAtRef(exec, handoff.worktree, mergeSha, handoff.version, files);
  status.ship.releaseTransaction = {
    schema: "agent-manager.release-transaction.v1",
    mode: "delivery-pr",
    version: handoff.version,
    approvedHeadSha: mergeSha,
    stampCommitSha: null,
    headSha: mergeSha,
    manifest,
    prUrl: pr.url || handoff.pr || target.prUrl || target.pr || null,
    prNumber: pr.number || null,
    mergeSha,
    stampState: "already-satisfied",
  };
  status.ship.releaseSha = mergeSha;
  status.ship.versionPlan.releaseSha = mergeSha;
  status = save(runId, status);
  return step(runId, status, "release", "done", `approved delivery merge ${mergeSha} already contains ${handoff.version}`);
}

async function completeFormalPullRequest(runId, status, handoff, options) {
  const {
    exec,
    sleep,
    now,
    context,
    urlField,
    numberField,
    prStep,
    mergeStep,
    prActivity,
    mergeActivity,
    label,
    expectedHeadSha = null,
  } = options;
  assertNotCancelled(runId);
  status = phase(runId, status, prStep, prActivity);
  let pr = options.pr || null;
  if (!pr && status.ship[urlField]) {
    const recorded = await readPr(exec, handoff.worktree, status.ship[urlField], context);
    pr = recorded.pr;
    status.ship.remoteRetries = addRetries(status, recorded.retries);
  }
  if (!pr) {
    // Discovery is retried before creation so a transient read cannot duplicate a PR.
    const discovered = await readPr(exec, handoff.worktree, handoff.branch, context, false);
    pr = discovered.pr;
    status.ship.remoteRetries = addRetries(status, discovered.retries);
  }
  if (!pr) {
    const created = must(
      exec,
      "gh",
      ["pr", "create", "--head", handoff.branch, "--base", handoff.base, "--fill"],
      handoff.worktree,
      `create ${label}`,
    );
    const url = created.stdout.split(/\r?\n/).find((line) => /^https?:\/\//.test(line.trim()))?.trim();
    if (!url) {
      throw new ShipBlockedError(`The ${label} was created but its URL could not be read.`, [
        `Provide the ${label} URL and rerun shipping.`,
      ]);
    }
    const opened = await readPr(exec, handoff.worktree, url, context);
    pr = opened.pr;
    status.ship.remoteRetries = addRetries(status, opened.retries);
  }
  validatePrTarget(pr, handoff);
  status.ship[urlField] = pr.url || status.ship[urlField];
  status.ship[numberField] = pr.number || null;
  if (expectedHeadSha) {
    status.ship.releaseTransaction.prUrl = status.ship[urlField];
    status.ship.releaseTransaction.prNumber = status.ship[numberField];
    status = save(runId, status);
    verifyRemoteBranchHead(exec, handoff.worktree, handoff.remote, handoff.branch, expectedHeadSha);
  }
  const prTarget = status.ship[urlField] || String(status.ship[numberField]);
  status = step(runId, status, prStep, "done", prTarget);

  assertNotCancelled(runId);
  status = phase(runId, status, mergeStep, mergeActivity);
  if (pr.state !== "MERGED") {
    must(
      exec,
      "gh",
      ["pr", "merge", prTarget, "--auto", "--squash"],
      handoff.worktree,
      `enable ${label} auto-merge`,
    );
  }
  const merged = await waitForPr(runId, status, handoff, { exec, sleep, now, prTarget });
  status = merged.status;
  status.ship[urlField] = merged.pr.url || status.ship[urlField];
  return { status, pr: merged.pr };
}

async function prepareFormalStamp(runId, status, handoff, cwd, mode, { exec, sleep, now }) {
  status = phase(runId, status, "release", `binding ${handoff.version} to the approved ${mode}`);
  status = await ensureVersionPlan(runId, status, handoff, cwd, { exec, sleep });
  if (mode === "delivery-pr") {
    status = verifyPriorDeliveryAncestry(runId, status, handoff, cwd, exec);
  }
  const currentHead = must(exec, "git", ["rev-parse", "HEAD"], cwd, "read approved ship head").stdout;
  const existing = status.ship.releaseTransaction || null;
  if (existing && (existing.mode !== mode || existing.version !== handoff.version)) {
    throw new ShipBlockedError("The recorded release transaction does not match this approved shipment.", [
      "Start a new Delivery Review and Ship Gate for the changed release transaction.",
    ]);
  }
  if (existing?.stampCommitSha) {
    const syncedHead = syncFormalTransactionHead(exec, cwd, handoff, existing, currentHead);
    verifyVersionStamp(cwd, handoff.version, exec);
    verifyStampManifestAtRef(exec, cwd, "HEAD", existing.manifest);
    existing.headSha = syncedHead;
    status = save(runId, status);
    return step(runId, status, "release", "done", syncedHead);
  }

  const transaction = existing || {
    schema: "agent-manager.release-transaction.v1",
    mode,
    version: handoff.version,
    approvedHeadSha: currentHead,
    stampCommitSha: null,
    headSha: null,
    manifest: null,
    prUrl: null,
    prNumber: null,
    mergeSha: null,
  };
  if (transaction.approvedHeadSha !== currentHead) {
    throw new ShipBlockedError("The approved branch changed before the release stamp could be applied.", [
      "Review the new head and start a new Delivery Review and Ship Gate.",
    ]);
  }
  status.ship.releaseTransaction = transaction;
  status = save(runId, status);

  const stamp = applyVersionStamp(cwd, handoff.version, handoff.summary, now());
  verifyVersionStamp(cwd, handoff.version, exec);
  must(exec, "git", ["add", ...stamp.files], cwd, "stage release stamp");
  const staged = splitPaths(
    must(exec, "git", ["diff", "--cached", "--name-only"], cwd, "inspect staged release stamp").stdout,
  );
  assertExactStampFiles(staged, stamp.files);
  if (!staged.length) {
    throw new ShipBlockedError("The approved release stamp produced no isolated commit.", [
      "Verify the approved version and manifest, then start a new Ship Gate if they changed.",
    ]);
  }
  const manifest = buildStampManifest(exec, cwd, handoff.version, stamp.files);
  must(exec, "git", ["commit", "-m", `chore: release ${handoff.version}`], cwd, "commit release stamp");
  const stampCommitSha = must(exec, "git", ["rev-parse", "HEAD"], cwd, "read release stamp commit").stdout;
  const parentSha = must(exec, "git", ["rev-parse", "HEAD^"], cwd, "read release stamp parent").stdout;
  if (parentSha !== transaction.approvedHeadSha) {
    throw new ShipBlockedError("The release stamp is not a direct child of the approved branch head.", [
      "Do not ship the drifted branch; start a new Delivery Review and Ship Gate.",
    ]);
  }
  const committed = splitPaths(
    must(
      exec,
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
      cwd,
      "inspect release stamp commit",
    ).stdout,
  );
  assertExactStampFiles(committed, stamp.files);
  transaction.stampCommitSha = stampCommitSha;
  transaction.headSha = stampCommitSha;
  transaction.manifest = manifest;
  status.ship.releaseSha = stampCommitSha;
  status.ship.versionPlan.releaseSha = stampCommitSha;
  status = save(runId, status);
  return step(runId, status, "release", "done", stampCommitSha);
}

function syncFormalTransactionHead(exec, cwd, handoff, transaction, currentHead) {
  const stampSha = transaction.stampCommitSha;
  const containsStamp = (candidate) => exec(
    "git",
    ["merge-base", "--is-ancestor", stampSha, candidate],
    { cwd },
  ).ok;
  if (!containsStamp(currentHead)) {
    throw new ShipBlockedError("The approved release branch no longer contains its bound stamp commit.", [
      "Restore the recorded branch or start a new Delivery Review and Ship Gate.",
    ]);
  }
  const fetched = exec("git", ["fetch", handoff.remote, handoff.branch], { cwd });
  if (!fetched.ok) return currentHead;
  const remoteHeadResult = exec("git", ["rev-parse", `${handoff.remote}/${handoff.branch}`], { cwd });
  if (!remoteHeadResult.ok || !remoteHeadResult.stdout) return currentHead;
  const remoteHead = remoteHeadResult.stdout;
  if (remoteHead === currentHead) return currentHead;
  const canFastForward = exec("git", ["merge-base", "--is-ancestor", currentHead, remoteHead], { cwd }).ok;
  if (canFastForward && containsStamp(remoteHead)) {
    must(exec, "git", ["merge", "--ff-only", `${handoff.remote}/${handoff.branch}`], cwd, "update approved PR branch");
    return remoteHead;
  }
  const localAhead = exec("git", ["merge-base", "--is-ancestor", remoteHead, currentHead], { cwd }).ok;
  if (localAhead) return currentHead;
  throw new ShipBlockedError("The remote release branch diverged from its immutable transaction.", [
    "Do not force-push; review the branch drift and start a new Delivery Review if needed.",
  ]);
}

function verifyPriorDeliveryAncestry(runId, status, handoff, cwd, exec) {
  const prior = (status.delivery?.targets || []).filter((target) => target.id !== handoff.targetId);
  if (!prior.length) return status;
  const missing = prior.filter((target) => !target.mergeSha).map((target) => target.id);
  if (missing.length) {
    throw new ShipBlockedError(
      `release is missing merge evidence for prior delivery target(s): ${missing.join(", ")}`,
      ["Merge and verify every prior delivery target before stamping the final delivery PR."],
    );
  }
  const baseSha = must(
    exec,
    "git",
    ["rev-parse", `${handoff.remote}/${handoff.base}`],
    cwd,
    "read final delivery PR base",
  ).stdout;
  for (const target of prior) {
    const result = exec("git", ["merge-base", "--is-ancestor", target.mergeSha, baseSha], { cwd });
    if (!result.ok) {
      throw new ShipBlockedError(
        `final delivery PR base ${baseSha} does not contain prior merge ${target.mergeSha}`,
        ["Update the base to contain every prior target merge, then rerun shipping."],
      );
    }
  }
  status.ship.verifiedMergeShas = prior.map((target) => target.mergeSha);
  return save(runId, status);
}

async function finalizeFormalReleaseFromMergedPr(runId, status, handoff, pr, dependencies) {
  const { exec } = dependencies;
  const transaction = status.ship.releaseTransaction;
  const mergeSha = pr.mergeCommit?.oid || pr.mergeCommit || status.ship.mergeSha || null;
  if (!transaction?.manifest || !mergeSha) {
    throw new ShipBlockedError("The merged release pull request is missing immutable stamp evidence.", [
      "Verify the merged PR and rerun shipping; do not publish a tag without the bound manifest.",
    ]);
  }
  must(exec, "git", ["fetch", handoff.remote, handoff.base], handoff.worktree, "fetch merged release");
  verifyStampManifestAtRef(exec, handoff.worktree, mergeSha, transaction.manifest);
  transaction.mergeSha = mergeSha;
  status.ship.releaseSha = mergeSha;
  status.ship.versionPlan.releaseSha = mergeSha;
  status = step(runId, status, "release-push", "skipped", "release stamp merged through the protected pull request");
  status = step(runId, status, "ci", "done", "required pull-request checks completed before merge");
  return await tagRelease(runId, status, handoff, mergeSha, dependencies);
}

async function runSimple(runId, status, handoff, dependencies) {
  const { exec, sleep, now } = dependencies;
  const simpleRoot = handoff.worktree || handoff.repoRoot;
  const simpleHandoff = { ...handoff, repoRoot: simpleRoot };
  ensureCurrentBranch(exec, simpleRoot, handoff.branch);
  status = phase(runId, status, "release", `stamping ${handoff.version}`);
  status = await ensureVersionPlan(runId, status, handoff, simpleRoot, { exec, sleep });
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
  return await tagRelease(runId, status, simpleHandoff, sha, dependencies);
}

async function releaseFormal(runId, status, handoff, dependencies) {
  const { exec, sleep, now } = dependencies;
  status = phase(runId, status, "release", `preparing ${handoff.version} on ${handoff.base}`);
  const releaseRoot = prepareReleaseWorkspace(runId, handoff, exec);
  const releaseBranch = `am/${runId}/release-${handoff.version}`;
  const releaseHandoff = {
    ...handoff,
    repoRoot: releaseRoot,
    worktree: releaseRoot,
    branch: releaseBranch,
    pr: status.ship.releasePrUrl || null,
    releaseWorktree: releaseRoot,
  };
  status.ship.releaseWorktree = releaseRoot;
  status.ship.releaseBranch = releaseBranch;
  status = save(runId, status);
  const baseSha = must(exec, "git", ["rev-parse", "HEAD"], releaseRoot, "read release base").stdout;
  status = verifyDeliveryAncestry(runId, status, releaseHandoff, baseSha, exec);
  status = await prepareFormalStamp(runId, status, releaseHandoff, releaseRoot, "release-pr", {
    exec,
    sleep,
    now,
  });
  const releaseHeadSha = status.ship.releaseTransaction.headSha
    || status.ship.releaseTransaction.stampCommitSha;

  assertNotCancelled(runId);
  status = phase(runId, status, "release-push", `pushing protected release branch ${releaseBranch}`);
  must(
    exec,
    "git",
    ["push", "--set-upstream", handoff.remote, releaseBranch],
    releaseRoot,
    "push release branch",
  );
  const prContext = remoteOptions(runId, handoff, sleep, "release pull request state");
  const merged = await completeFormalPullRequest(runId, status, releaseHandoff, {
    exec,
    sleep,
    now,
    context: prContext,
    urlField: "releasePrUrl",
    numberField: "releasePrNumber",
    prStep: "release-push",
    mergeStep: "ci",
    prActivity: "finding or creating the protected release pull request",
    mergeActivity: "waiting for required release pull-request checks and merge",
    label: "protected release pull request",
    expectedHeadSha: releaseHeadSha,
  });
  status = merged.status;
  const releaseSha = merged.pr.mergeCommit?.oid || merged.pr.mergeCommit || null;
  if (!releaseSha) {
    throw new ShipBlockedError("The release pull request merged without a readable merge commit.", [
      "Verify the merged release PR, then rerun shipping.",
    ]);
  }
  must(exec, "git", ["fetch", handoff.remote, handoff.base], releaseRoot, "fetch merged release");
  verifyStampManifestAtRef(exec, releaseRoot, releaseSha, status.ship.releaseTransaction.manifest);
  status.ship.releaseTransaction.mergeSha = releaseSha;
  status.ship.releaseSha = releaseSha;
  status.ship.versionPlan.releaseSha = releaseSha;
  status = step(runId, status, "ci", "done", "release PR checks completed before merge");
  return await tagRelease(runId, status, releaseHandoff, releaseSha, dependencies);
}

function splitPaths(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((path) => path.trim().replace(/\\/g, "/"))
    .filter(Boolean)
    .sort();
}

function assertExactStampFiles(observed, expected) {
  const actual = [...observed].sort();
  const approved = [...expected].map((path) => path.replace(/\\/g, "/")).sort();
  if (JSON.stringify(actual) !== JSON.stringify(approved)) {
    throw new ShipBlockedError(
      `Release stamp mutation drifted from its approved manifest: expected ${approved.join(", ")}; observed ${actual.join(", ") || "none"}.`,
      ["Do not ship the drifted commit; review the changed manifest and rerun Ship Gate."],
    );
  }
}

function buildStampManifest(exec, cwd, version, files) {
  const entries = [...files].sort().map((path) => ({
    path: path.replace(/\\/g, "/"),
    blob: must(exec, "git", ["hash-object", path], cwd, `hash ${path} release stamp`).stdout,
  }));
  return {
    version,
    files: entries,
    digest: createHash("sha256").update(JSON.stringify({ version, files: entries })).digest("hex"),
  };
}

function buildStampManifestAtRef(exec, cwd, ref, version, files) {
  const entries = [...files].sort().map((path) => ({
    path: path.replace(/\\/g, "/"),
    blob: must(exec, "git", ["rev-parse", `${ref}:${path}`], cwd, `hash ${path} at approved release`).stdout,
  }));
  return {
    version,
    files: entries,
    digest: createHash("sha256").update(JSON.stringify({ version, files: entries })).digest("hex"),
  };
}

function verifyVersionStampAtRef(exec, cwd, ref, version) {
  const versionDocument = readFileAtRef(exec, cwd, ref, "Version.md", {
    required: true,
    label: "verify Version.md in approved release",
  });
  const current = versionDocument.match(/^current:\s*(\S+)\s*$/m)?.[1];
  if (current !== version) {
    throw new ShipBlockedError(`Version.md at the approved merge is ${current || "missing"}; expected ${version}.`, [
      "Do not release the mismatched merge; review the complete version stamp.",
    ]);
  }
  if (!new RegExp(`^## ${escapeRegex(version)}(?:\\s|$)`, "m").test(versionDocument)) {
    throw new ShipBlockedError(`Version.md at the approved merge is missing the ${version} history entry.`, [
      "Do not release the partial stamp; repair it through a reviewed pull request.",
    ]);
  }

  const files = ["Version.md"];
  for (const name of ["package.json", "package-lock.json"]) {
    const document = readFileAtRef(exec, cwd, ref, name, { required: false, label: `inspect ${name} in approved release` });
    if (document == null) continue;
    files.push(name);
    let parsed;
    try {
      parsed = JSON.parse(document);
    } catch (error) {
      throw new ShipBlockedError(`${name} at the approved merge is invalid JSON: ${error.message}`, [
        "Do not release the partial stamp; repair it through a reviewed pull request.",
      ]);
    }
    if (parsed.version !== version) {
      throw new ShipBlockedError(`${name} at the approved merge is ${parsed.version || "missing"}; expected ${version}.`, [
        "Do not release the partial stamp; repair it through a reviewed pull request.",
      ]);
    }
    if (name === "package-lock.json" && parsed.packages?.[""]?.version !== version) {
      throw new ShipBlockedError(
        `${name} package root at the approved merge is ${parsed.packages?.[""]?.version || "missing"}; expected ${version}.`,
        ["Do not release the partial stamp; repair it through a reviewed pull request."],
      );
    }
  }
  return files;
}

function readFileAtRef(exec, cwd, ref, path, { required, label }) {
  const result = exec("git", ["show", `${ref}:${path}`], { cwd });
  if (result.ok) return result.stdout;
  if (!required) return null;
  throw new ShipBlockedError(`${path} is missing from the approved release merge.`, [
    `${label}; do not release an incomplete stamp.`,
  ]);
}

function verifyStampManifestAtRef(exec, cwd, ref, manifest) {
  if (!manifest?.version || !manifest?.files?.length || !manifest.digest) {
    throw new ShipBlockedError("The release stamp manifest is missing or incomplete.", [
      "Rerun the approved release transaction before publishing its tag.",
    ]);
  }
  const entries = manifest.files.map((entry) => {
    const blob = must(
      exec,
      "git",
      ["rev-parse", `${ref}:${entry.path}`],
      cwd,
      `verify ${entry.path} in merged release`,
    ).stdout;
    return {
      path: entry.path,
      blob,
    };
  });
  const digest = createHash("sha256")
    .update(JSON.stringify({ version: manifest.version, files: entries }))
    .digest("hex");
  if (digest !== manifest.digest) {
    throw new ShipBlockedError("The merged release content does not match the immutable stamp manifest.", [
      "Do not publish the tag; inspect the merged PR and start a new Delivery Review if content changed.",
    ]);
  }
}

function verifyRemoteBranchHead(exec, cwd, remote, branch, expectedSha) {
  const result = must(
    exec,
    "git",
    ["ls-remote", "--heads", remote, `refs/heads/${branch}`],
    cwd,
    "re-check pushed release head",
  );
  const observed = result.stdout.split(/\s+/)[0] || null;
  if (!expectedSha || observed !== expectedSha) {
    throw new ShipBlockedError(
      `Remote release head drifted before merge: expected ${expectedSha || "missing"}; observed ${observed || "missing"}.`,
      ["Do not merge the drifted pull request; review its head and rerun Ship Gate."],
    );
  }
}

export function prepareReleaseWorkspace(runId, handoff, exec = execCommand) {
  const releaseParent = ensurePrivateDir(join(runDir(runId), "ship", "release"));
  const releaseRoot = join(releaseParent, "wt");
  const releaseBranch = `am/${runId}/release-${handoff.version}`;
  must(exec, "git", ["fetch", handoff.remote, handoff.base], handoff.worktree, "fetch release base");
  if (!existsSync(releaseRoot)) {
    const branchExists = exec("git", ["show-ref", "--verify", `refs/heads/${releaseBranch}`], {
      cwd: handoff.worktree,
    });
    const args = branchExists.ok
      ? ["worktree", "add", releaseRoot, releaseBranch]
      : ["worktree", "add", "-b", releaseBranch, releaseRoot, `${handoff.remote}/${handoff.base}`];
    must(exec, "git", args, handoff.worktree, "create private release worktree");
  }
  assertPathInside(runDir(runId), releaseRoot, "release worktree");
  ensureCurrentBranch(exec, releaseRoot, releaseBranch);
  const dirty = must(exec, "git", ["status", "--porcelain=v1"], releaseRoot, "inspect private release worktree").stdout;
  if (dirty) {
    const allowed = new Set(["Version.md", "package.json", "package-lock.json"]);
    const unexpected = dirty.split(/\r?\n/)
      .map((line) => line.slice(3).replace(/^"|"$/g, ""))
      .filter((path) => path && !allowed.has(path.replace(/\\/g, "/")));
    if (unexpected.length) {
      throw new ShipBlockedError("The private release worktree contains unexpected local changes.", [
        `Inspect the run-owned release workspace: ${unexpected.join(", ")}`,
      ]);
    }
  }
  return releaseRoot;
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

/**
 * Judge an approved version plan against what the target repo's base branch carries now.
 * A plan stamped on an earlier attempt is only good while the base still points at the
 * commit it was computed on; when someone else releases in between, re-applying the
 * approved number renumbers a release backwards or collides with a published tag.
 *
 * States: `unverified` (base unreadable — fail soft), `current` (base unmoved or no
 * recorded plan), `applied` (the base moved because this ship already pushed its own
 * stamp), `rebased` (base moved but the plan is still ahead), `stale` (base moved past
 * the plan — the plan must be recomputed, never applied).
 */
export function evaluateVersionPlan(plan, observed) {
  const version = String(plan?.version || "");
  if (!observed?.available || !observed.baseSha) {
    return { state: "unverified", version, recommended: null, bump: null };
  }
  if (!plan?.baseSha || plan.baseSha === observed.baseSha) {
    return { state: "current", version, recommended: null, bump: null };
  }
  if (plan.releaseSha && plan.releaseSha === observed.baseSha) {
    return { state: "applied", version, recommended: null, bump: null };
  }
  const current = observed.current;
  if (current && SEMVER.test(current) && SEMVER.test(version) && compareSemver(version, current) <= 0) {
    const bump = plan.baseVersion && SEMVER.test(plan.baseVersion)
      ? semverBumpLevel(plan.baseVersion, version)
      : null;
    return {
      state: "stale",
      version,
      bump,
      recommended: bump ? nextVersion(current, bump) : null,
    };
  }
  return { state: "rebased", version, recommended: null, bump: null };
}

/** Re-read the target repo's base branch: its head commit and the version it carries. */
async function observeShipBase(handoff, cwd, { exec, sleep, runId }) {
  const unavailable = { available: false, baseSha: null, current: null };
  const fetched = await execRemote(
    exec,
    "git",
    ["fetch", handoff.remote, handoff.base],
    cwd,
    remoteOptions(runId, handoff, sleep, `${handoff.remote}/${handoff.base}`),
  );
  if (!fetched.result.ok) return unavailable;
  const head = exec("git", ["rev-parse", `${handoff.remote}/${handoff.base}`], { cwd });
  if (!head.ok) return unavailable;
  const shown = exec("git", ["show", `${handoff.remote}/${handoff.base}:Version.md`], { cwd });
  return {
    available: true,
    baseSha: firstLine(head.stdout),
    current: shown.ok ? shown.stdout.match(/^current:\s*(\d+\.\d+\.\d+)\s*$/m)?.[1] || null : null,
  };
}

async function ensureVersionPlan(runId, status, handoff, cwd, { exec, sleep }) {
  if (!handoff.version) return status;
  const plan = status.ship.versionPlan || null;
  const observed = await observeShipBase(handoff, cwd, { exec, sleep, runId });
  const evaluation = evaluateVersionPlan(
    {
      version: handoff.version,
      baseSha: plan?.baseSha || null,
      baseVersion: plan?.baseVersion || null,
      releaseSha: plan?.releaseSha || status.ship.releaseSha || null,
    },
    observed,
  );
  if (evaluation.state === "stale") {
    throw new ShipBlockedError(
      `The approved version plan ${handoff.version} is stale: ${handoff.remote}/${handoff.base} now carries ${observed.current}.`,
      [
        evaluation.recommended
          ? `Rerun Delivery Review and Ship Gate, then ship with --version ${evaluation.recommended} (the ${evaluation.bump} bump you approved, applied to ${observed.current}).`
          : `Recompute the release version against ${observed.current}, then rerun Ship Gate.`,
        "Or confirm the release already shipped and cancel this ship phase.",
      ],
    );
  }
  status.ship.versionPlan = {
    version: handoff.version,
    baseVersion: plan?.baseVersion || observed.current || null,
    baseSha: plan?.baseSha || observed.baseSha || null,
    releaseSha: plan?.releaseSha || status.ship.releaseSha || null,
    observedBaseSha: observed.baseSha,
    observedVersion: observed.current,
    state: evaluation.state,
    plannedAt: plan?.plannedAt || new Date().toISOString(),
  };
  if (evaluation.state === "rebased") {
    status.ship.lastActivity =
      `${handoff.remote}/${handoff.base} advanced since the plan was stamped; ${handoff.version} is still ahead of ${observed.current || "its history"}`;
  }
  return save(runId, status);
}

/**
 * Classify a single pull-request read into a blocker, or null to keep waiting. Split out
 * of the poll loop so the same verdict can be recomputed against a second, fresher read
 * before an approved ship is parked in needs-input.
 */
export function classifyPrBlock(pr, { exec, cwd, insideCheckGrace = false } = {}) {
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    return new ShipBlockedError("The pull request has merge conflicts.", [
      "Resolve the conflicts on the ship branch and rerun ship.",
      "Abandon the ship phase.",
    ]);
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return new ShipBlockedError("A pull-request review requested changes.", [
      "Address the review feedback on the ship branch and rerun ship.",
      "Reject or abandon the release.",
    ]);
  }
  const failed = failedChecks(pr.statusCheckRollup);
  if (failed.length) {
    return new ShipBlockedError(`Pull request checks failed: ${failed.join(", ")}`, [
      "Fix the failing checks on the ship branch and rerun ship.",
      "Reject or abandon the release.",
    ]);
  }
  if (insideCheckGrace) return null;
  return diagnoseBlockedMerge(pr, exec, cwd);
}

async function waitForPr(runId, status, handoff, { exec, sleep, now, prTarget = null }) {
  const deadline = now() + handoff.timeoutSec * 1000;
  const checkRegistrationStartedAt = now();
  const prContext = remoteOptions(runId, handoff, sleep, "pull request state");
  const target = () => prTarget || status.ship.prUrl || String(status.ship.prNumber);
  const grace = (candidate) =>
    isWithinCheckRegistrationGrace(
      candidate,
      now() - checkRegistrationStartedAt,
      handoff.checkGraceSec ?? 90,
    );
  let updatedBehind = false;
  while (now() <= deadline) {
    assertNotCancelled(runId);
    const poll = await readPr(exec, handoff.worktree, target(), prContext);
    const pr = poll.pr;
    validatePrTarget(pr, handoff);
    status.ship.lastActivity = `PR ${pr.state || "UNKNOWN"} · ${pr.mergeStateStatus || "UNKNOWN"}`;
    status.ship.checks = summarizeChecks(pr.statusCheckRollup);
    status.ship.reviewDecision = pr.reviewDecision || null;
    status.ship.remoteRetries = addRetries(status, poll.retries);
    status = save(runId, status);
    if (pr.state === "MERGED") return { status, pr };

    const insideCheckGrace = grace(pr);
    const suspected = classifyPrBlock(pr, { exec, cwd: handoff.worktree, insideCheckGrace });
    if (suspected) {
      // GitHub serves a stale mergeStateStatus for a few seconds after a push — BLOCKED
      // before the required checks register. Confirm every state-derived blocker against
      // a second read so a pre-CI stale answer cannot end an approved ship.
      status.ship.lastActivity = `confirming a blocked pull request state: ${suspected.message}`;
      status = save(runId, status);
      await sleep(confirmDelayMs(handoff));
      assertNotCancelled(runId);
      const recheck = await readPr(exec, handoff.worktree, target(), prContext);
      const confirmedPr = recheck.pr;
      validatePrTarget(confirmedPr, handoff);
      status.ship.checks = summarizeChecks(confirmedPr.statusCheckRollup);
      status.ship.reviewDecision = confirmedPr.reviewDecision || null;
      status.ship.remoteRetries = addRetries(status, recheck.retries);
      if (confirmedPr.state === "MERGED") {
        status.ship.lastActivity = `PR ${confirmedPr.state} · ${confirmedPr.mergeStateStatus || "UNKNOWN"}`;
        status = save(runId, status);
        return { status, pr: confirmedPr };
      }
      const confirmed = classifyPrBlock(confirmedPr, {
        exec,
        cwd: handoff.worktree,
        insideCheckGrace: grace(confirmedPr),
      });
      if (confirmed) throw confirmed;
      status.ship.staleBlockedReads = Number(status.ship.staleBlockedReads || 0) + 1;
      status.ship.lastActivity =
        `re-poll cleared a stale blocked read (PR ${confirmedPr.state || "UNKNOWN"} · ${confirmedPr.mergeStateStatus || "UNKNOWN"})`;
      status = save(runId, status);
      await sleep(handoff.pollSec * 1000);
      continue;
    }

    if (insideCheckGrace && pr.mergeStateStatus === "BLOCKED") {
      status.ship.lastActivity = "waiting for GitHub to register required checks";
      status = save(runId, status);
    }
    if (pr.mergeStateStatus === "BEHIND" && !updatedBehind) {
      must(
        exec,
        "gh",
        ["pr", "update-branch", target()],
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

export function isWithinCheckRegistrationGrace(pr, elapsedMs, graceSec = 90) {
  const checks = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [];
  return pr?.mergeStateStatus === "BLOCKED"
    && checks.length === 0
    && elapsedMs < graceSec * 1000;
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
  const ciContext = remoteOptions(runId, handoff, sleep, "release CI");
  while (now() <= deadline) {
    assertNotCancelled(runId);
    const poll = await execRemote(
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
      ciContext,
    );
    const result = poll.result;
    if (!result.ok) {
      throw new ShipBlockedError(
        `read release CI failed${poll.transient ? ` after ${poll.attempts} attempts` : ""}: ${result.stderr || result.stdout || "unknown error"}`,
        ["Resolve the command failure and rerun ship.", "Abandon the ship phase."],
      );
    }
    status.ship.remoteRetries = addRetries(status, poll.retries);
    const runs = parseJson(result.stdout, "GitHub Actions runs");
    if (!Array.isArray(runs)) {
      throw new ShipBlockedError("GitHub returned an invalid CI response.", [
        "Inspect GitHub Actions and rerun ship.",
      ]);
    }
    const failed = runs.filter((run) => FAILURE_CONCLUSIONS.has(run.conclusion));
    const pending = runs.filter((run) => run.status !== "completed");
    status.ship.ci = {
      state: failed.length ? "failed" : runs.length && !pending.length ? "green" : "running",
      runs: runs.map((run) => ({
        id: run.databaseId,
        workflow: run.workflowName,
        status: run.status || null,
        conclusion: run.conclusion || null,
        url: run.url || null,
      })),
    };
    status.ship.lastActivity = runs.length
      ? `CI running (${pending.length} pending)`
      : "waiting for GitHub to register CI";
    status = save(runId, status);
    if (failed.length) {
      throw new ShipBlockedError(
        `Release CI failed: ${failed.map((run) => run.workflowName || run.databaseId).join(", ")}`,
        ["Fix the failed workflow and rerun ship.", "Reject or abandon the release."],
      );
    }
    if (runs.length && runs.every((run) => run.status === "completed")) {
      return step(runId, status, "ci", "done", `${runs.length} workflow run(s) green`);
    }
    await sleep(handoff.pollSec * 1000);
  }
  throw new ShipBlockedError("Timed out waiting for release CI.", [
    "Inspect GitHub Actions and rerun ship.",
  ]);
}

async function readActionsRuns(runId, status, handoff, sha, dependencies, label) {
  const { exec, sleep } = dependencies;
  const poll = await execRemote(
    exec,
    "gh",
    [
      "run",
      "list",
      "--commit",
      sha,
      "--limit",
      "1000",
      "--json",
      "databaseId,status,conclusion,url,workflowName,event,headSha",
    ],
    handoff.repoRoot,
    remoteOptions(runId, handoff, sleep, label),
  );
  if (!poll.result.ok) {
    throw new ShipBlockedError(
      `${label} failed${poll.transient ? ` after ${poll.attempts} attempts` : ""}: ${poll.result.stderr || poll.result.stdout || "unknown error"}`,
      ["Resolve the GitHub Actions query failure and rerun ship.", "Abandon the ship phase."],
    );
  }
  status.ship.remoteRetries = addRetries(status, poll.retries);
  let parsed;
  try {
    parsed = JSON.parse(String(poll.result.stdout || "null"));
  } catch (error) {
    throw new ShipBlockedError(`GitHub returned invalid ${label} JSON: ${error.message}`, [
      "Inspect GitHub Actions and rerun ship.",
    ]);
  }
  if (!Array.isArray(parsed)) {
    throw new ShipBlockedError(`GitHub returned malformed ${label} evidence.`, [
      "Inspect GitHub Actions and rerun ship.",
    ]);
  }
  const runs = parsed.map((run) => ({
    id: run?.databaseId == null ? "" : String(run.databaseId),
    workflow: run?.workflowName || null,
    status: run?.status || null,
    conclusion: run?.conclusion || null,
    url: run?.url || null,
    event: run?.event || null,
    headSha: run?.headSha || null,
  }));
  if (runs.some((run) => !run.id || run.headSha !== sha)) {
    throw new ShipBlockedError(`GitHub returned incomplete ${label} evidence for ${sha}.`, [
      "Inspect GitHub Actions and rerun ship.",
    ]);
  }
  return runs;
}

export async function observeTagTriggeredRuns(runId, status, handoff, sha, dependencies) {
  const { sleep, now } = dependencies;
  const baseline = status.ship.releaseCi;
  if (baseline?.sha !== sha || !Array.isArray(baseline.beforeRunIds)) {
    throw new ShipBlockedError("The release tag has no valid pre-push GitHub Actions snapshot.", [
      "Do not move the tag; restore the recorded ship evidence or review the release manually.",
    ]);
  }
  const before = new Set(baseline.beforeRunIds.map(String));
  const discovered = new Map(
    (Array.isArray(baseline.runs) ? baseline.runs : []).map((run) => [String(run.id), run]),
  );
  const started = now();
  const deadline = started + handoff.timeoutSec * 1000;
  const registrationGraceMs =
    dependencies.tagRegistrationGraceMs ?? TAG_RUN_REGISTRATION_GRACE_MS;
  const registrationDeadline = Math.min(deadline, started + registrationGraceMs);
  status = phase(runId, status, "ci", `discovering tag-triggered workflows for ${sha.slice(0, 12)}`);
  while (now() <= deadline) {
    assertNotCancelled(runId);
    const observed = await readActionsRuns(
      runId,
      status,
      handoff,
      sha,
      dependencies,
      "tag-triggered release CI",
    );
    for (const run of observed) {
      if (!before.has(run.id)) discovered.set(run.id, run);
    }
    const runs = [...discovered.values()];
    const pending = runs.filter((run) => run.status !== "completed");
    const unsuccessful = runs.filter(
      (run) => run.status === "completed" && String(run.conclusion || "").toLowerCase() !== "success",
    );
    const observedAt = now();
    status.ship.releaseCi = {
      ...baseline,
      state: unsuccessful.length
        ? "failed"
        : runs.length && !pending.length && observedAt >= registrationDeadline
          ? "green"
          : runs.length
            ? "running"
            : "registering",
      runs,
      observedAt: new Date(observedAt).toISOString(),
    };
    status.ship.ci = {
      state: status.ship.releaseCi.state,
      runs,
    };
    status.ship.lastActivity = runs.length
      ? `tag-triggered release CI (${pending.length} pending)`
      : "waiting for GitHub to register tag-triggered release CI";
    status = save(runId, status);
    if (unsuccessful.length) {
      const evidence = unsuccessful.map(
        (run) => `${run.workflow || run.id}${run.url ? ` (${run.url})` : ""}`,
      );
      throw new ShipBlockedError(`Tag-triggered release CI failed: ${evidence.join(", ")}`, [
        "Fix the failed workflow and rerun ship without moving the published tag.",
        "Reject or abandon the release.",
      ]);
    }
    if (runs.length && !pending.length && observedAt >= registrationDeadline) {
      return step(
        runId,
        status,
        "ci",
        "done",
        `${runs.length} tag-triggered workflow run(s) green`,
      );
    }
    if (!runs.length && observedAt >= registrationDeadline) {
      status.ship.releaseCi = {
        ...status.ship.releaseCi,
        state: "not_configured",
      };
      status.ship.ci = { state: "not_configured", runs: [] };
      status = save(runId, status);
      return step(
        runId,
        status,
        "ci",
        "skipped",
        "downstream release CI is not configured",
      );
    }
    await sleep(handoff.pollSec * 1000);
  }
  if (!discovered.size) {
    status.ship.releaseCi = {
      ...status.ship.releaseCi,
      state: "not_configured",
    };
    status.ship.ci = { state: "not_configured", runs: [] };
    status = save(runId, status);
    return step(
      runId,
      status,
      "ci",
      "skipped",
      "downstream release CI is not configured",
    );
  }
  const finalRuns = [...discovered.values()];
  if (finalRuns.every(
    (run) => run.status === "completed"
      && String(run.conclusion || "").toLowerCase() === "success",
  )) {
    return step(
      runId,
      status,
      "ci",
      "done",
      `${finalRuns.length} tag-triggered workflow run(s) green`,
    );
  }
  throw new ShipBlockedError("Timed out waiting for tag-triggered release CI.", [
    "Inspect GitHub Actions and rerun ship without moving the published tag.",
  ]);
}

async function tagRelease(runId, status, handoff, sha, dependencies) {
  const { exec, now } = dependencies;
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
    if (status.ship.releaseCi?.sha !== sha || !Array.isArray(status.ship.releaseCi.beforeRunIds)) {
      throw new ShipBlockedError(
        `${tag} already exists remotely, but its pre-push GitHub Actions snapshot is unavailable.`,
        ["Do not move the tag; review the release workflow evidence manually."],
      );
    }
  } else {
    const beforeRuns = await readActionsRuns(
      runId,
      status,
      handoff,
      sha,
      dependencies,
      "pre-tag GitHub Actions snapshot",
    );
    status.ship.releaseCi = {
      sha,
      state: "snapshotted",
      beforeRunIds: beforeRuns.map((run) => run.id),
      snapshotAt: new Date(now()).toISOString(),
      observedAt: null,
      runs: [],
    };
    status = save(runId, status);
    if (!local.ok) must(exec, "git", ["tag", tag, sha], handoff.repoRoot, "create release tag");
    must(exec, "git", ["push", handoff.remote, tag], handoff.repoRoot, "push release tag");
  }
  status.ship.tag = tag;
  status = step(runId, status, "tag", "done", tag);
  return await observeTagTriggeredRuns(runId, status, handoff, sha, dependencies);
}

function releaseCiEvidence(releaseCi, tag) {
  if (!releaseCi) return null;
  return {
    tag: tag || null,
    sha: releaseCi.sha || null,
    state: releaseCi.state || null,
    checks: (releaseCi.runs || []).map((run) => ({
      id: run.id || null,
      name: run.workflow || null,
      status: run.status || null,
      conclusion: run.conclusion || null,
      url: run.url || null,
      event: run.event || null,
      headSha: run.headSha || releaseCi.sha || null,
    })),
  };
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
  must(exec, "git", ["rev-parse", "--is-inside-work-tree"], handoff.worktree, "validate ship worktree");
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
    const capabilities = inspectFormalProviderCapabilities(handoff, exec);
    assertFormalProviderCapabilities(capabilities, handoff);
    if (handoff.providerCapabilities) {
      const expected = providerCapabilityFingerprint(handoff.providerCapabilities);
      const observed = providerCapabilityFingerprint(capabilities);
      if (expected !== observed) {
        throw new ShipBlockedError("GitHub shipping capabilities changed after preflight.", [
          "Review the repository policy or identity drift, then rerun Ship Gate.",
        ]);
      }
    } else {
      handoff.providerCapabilities = capabilities;
    }
  }
}

/**
 * Capture the provider facts that determine whether the selected Formal Flow can finish.
 * The shape is intentionally provider-neutral even though GitHub is the current adapter.
 */
export function inspectFormalProviderCapabilities(handoff, exec = execCommand) {
  const repository = must(
    exec,
    "gh",
    ["repo", "view", "--json", "nameWithOwner,viewerPermission"],
    handoff.worktree,
    "inspect repository shipping capabilities",
  );
  const repo = parseProviderEvidence(
    repository.stdout,
    "repository identity and permission",
  );
  const settings = parseProviderEvidence(
    must(
      exec,
      "gh",
      ["api", "repos/{owner}/{repo}"],
      handoff.worktree,
      "inspect repository merge settings",
    ).stdout,
    "repository merge settings",
  );
  const identity = must(
    exec,
    "gh",
    ["api", "user", "--jq", ".login"],
    handoff.worktree,
    "inspect GitHub identity",
  ).stdout;
  const protectionResult = exec(
    "gh",
    ["api", `repos/{owner}/{repo}/branches/${encodeURIComponent(handoff.base)}/protection`],
    { cwd: handoff.worktree },
  );
  let protection = null;
  if (protectionResult.ok) {
    protection = parseProviderEvidence(protectionResult.stdout, "base branch protection");
  } else if (!isUnprotectedBranchResponse(protectionResult)) {
    throw new ShipBlockedError(
      `Unable to inspect protection for ${handoff.base}: ${protectionResult.stderr || protectionResult.stdout || "unknown error"}`,
      ["Grant read access to repository branch protection, then rerun Ship Gate."],
    );
  }
  const contexts = protection?.required_status_checks?.contexts;
  const checks = protection?.required_status_checks?.checks;
  const reviews = protection?.required_pull_request_reviews;
  let requiredApprovals = null;
  if (reviews === null) {
    requiredApprovals = 0;
  } else if (
    Number.isInteger(reviews?.required_approving_review_count)
    && reviews.required_approving_review_count >= 0
  ) {
    requiredApprovals = reviews.required_approving_review_count;
  }
  const requiredChecks = [
    ...(Array.isArray(contexts) ? contexts : []),
    ...(Array.isArray(checks) ? checks.map((check) => check?.context) : []),
  ].filter((context) => typeof context === "string" && context);
  const permission = String(repo.viewerPermission || "").toUpperCase();
  const canWrite = ["WRITE", "MAINTAIN", "ADMIN"].includes(permission);
  return {
    schema: "agent-manager.provider-capabilities.v1",
    provider: "github",
    repository: repo.nameWithOwner || null,
    identity: String(identity || "").trim() || null,
    permission,
    base: {
      name: handoff.base,
      protected: Boolean(protection),
      requiredChecks: [...new Set(requiredChecks)].sort(),
      requiredApprovals,
    },
    autoMerge: settings.allow_auto_merge === true,
    mergeMethod: settings.allow_squash_merge === true ? "squash" : null,
    releaseAllowed: canWrite,
  };
}

function parseProviderEvidence(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || "null"));
  } catch (error) {
    throw new ShipBlockedError(`GitHub returned invalid ${label} JSON: ${error.message}`, [
      "Resolve the GitHub capability query and rerun Ship Gate.",
    ]);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ShipBlockedError(`GitHub returned malformed ${label} evidence.`, [
      "Resolve the GitHub capability query and rerun Ship Gate.",
    ]);
  }
  return parsed;
}

function isUnprotectedBranchResponse(result) {
  if (Number(result?.status) === 404) return true;
  return /(?:404|branch not protected|protection is not enabled)/i.test(
    `${result?.stderr || ""}\n${result?.stdout || ""}`,
  );
}

function assertFormalProviderCapabilities(capabilities, handoff) {
  if (!capabilities.repository || !capabilities.identity) {
    throw new ShipBlockedError("GitHub repository or shipping identity could not be resolved.", [
      "Authenticate gh for the target repository, then rerun Ship Gate.",
    ]);
  }
  if (!capabilities.releaseAllowed) {
    throw new ShipBlockedError(
      `GitHub identity ${capabilities.identity} has ${capabilities.permission || "unknown"} permission; Formal Flow requires write permission.`,
      ["Grant write permission to the shipping identity, then rerun Ship Gate."],
    );
  }
  if (!capabilities.autoMerge) {
    throw new ShipBlockedError("GitHub auto-merge is disabled for this repository.", [
      "Enable repository auto-merge before approving Formal Flow shipping.",
    ]);
  }
  if (capabilities.mergeMethod !== "squash") {
    throw new ShipBlockedError("GitHub squash merge is disabled for this repository.", [
      "Enable squash merge before approving Formal Flow shipping.",
    ]);
  }
  if (!capabilities.base.protected || capabilities.base.requiredChecks.length === 0) {
    throw new ShipBlockedError(
      `${handoff.base} has no inspectable required CI checks; Formal Flow cannot prove CI will gate auto-merge.`,
      [
        `Protect ${handoff.base} and configure at least one required status check before approving Formal Flow shipping.`,
        "Keep the repository policy and ship outside automated Formal Flow.",
      ],
    );
  }
  if (!Number.isInteger(capabilities.base.requiredApprovals)) {
    throw new ShipBlockedError(
      `${handoff.base} has no inspectable required-review evidence; Formal Flow cannot prove the approval policy.`,
      [
        `Grant access to inspect ${handoff.base} branch protection, then rerun Ship Gate.`,
        "Keep the repository policy and ship outside automated Formal Flow.",
      ],
    );
  }
  if (capabilities.base.requiredApprovals > 0) {
    throw new ShipBlockedError(
      `${handoff.base} requires ${capabilities.base.requiredApprovals} GitHub approving review(s); the approved transaction cannot complete without another human approval.`,
      [
        "Set required approving reviews to 0 for the independently reviewed shipping path.",
        "Keep the repository policy and ship outside automated Formal Flow.",
      ],
    );
  }
}

function providerCapabilityFingerprint(capabilities) {
  return JSON.stringify({
    provider: capabilities?.provider || null,
    repository: capabilities?.repository || null,
    identity: capabilities?.identity || null,
    permission: capabilities?.permission || null,
    base: capabilities?.base || null,
    autoMerge: Boolean(capabilities?.autoMerge),
    mergeMethod: capabilities?.mergeMethod || null,
    releaseAllowed: Boolean(capabilities?.releaseAllowed),
  });
}

function ensureCurrentBranch(exec, cwd, branch) {
  const current = must(exec, "git", ["branch", "--show-current"], cwd, "read current branch").stdout;
  if (current !== branch) {
    throw new ShipBlockedError(`Expected branch ${branch}, but ${current || "detached HEAD"} is checked out.`, [
      `Check out ${branch} in the approved worktree, then rerun ship.`,
    ]);
  }
}

/**
 * True when a failed remote command carries a network-shaped error rather than an
 * answer from GitHub. Only failed results qualify; a successful call is never transient.
 */
export function isTransientRemoteFailure(result) {
  if (!result || result.ok) return false;
  const text = `${result.stderr || ""}\n${result.stdout || ""}`;
  return TRANSIENT_REMOTE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Exponential backoff, capped, deterministic — attempt 1 waits the base delay. */
export function remoteBackoffMs(
  attempt,
  baseMs = REMOTE_RETRY_BASE_MS,
  maxMs = REMOTE_RETRY_MAX_MS,
) {
  const step = Math.max(1, Number(attempt) || 1);
  const base = Number(baseMs) || REMOTE_RETRY_BASE_MS;
  return Math.min(maxMs, base * 2 ** (step - 1));
}

function remoteOptions(runId, handoff, sleep, label) {
  return {
    runId,
    sleep,
    label,
    attempts: handoff.retryAttempts,
    baseMs: handoff.retryBaseMs,
  };
}

/**
 * Run a network-facing command with bounded exponential backoff. Transient failures are
 * retried in place so they never reach the caller as a verdict; a non-transient failure
 * returns on the first attempt so the fail-closed handling above it is unchanged.
 */
async function execRemote(exec, command, args, cwd, context) {
  const attempts = Math.max(1, Number(context.attempts) || REMOTE_RETRY_ATTEMPTS);
  let attempt = 1;
  let retries = 0;
  let result = exec(command, args, { cwd });
  while (!result.ok && isTransientRemoteFailure(result) && attempt < attempts) {
    const delay = remoteBackoffMs(attempt, context.baseMs);
    noteTransientRetry(context.runId, context.label, attempt, attempts, delay, result);
    await context.sleep(delay);
    attempt += 1;
    retries += 1;
    result = exec(command, args, { cwd });
  }
  return { result, retries, attempts: attempt, transient: isTransientRemoteFailure(result) };
}

function noteTransientRetry(runId, label, attempt, attempts, delay, result) {
  if (!runId) return;
  const current = readStatus(runId);
  if (!current?.ship) return;
  current.ship.remoteRetries = Number(current.ship.remoteRetries || 0) + 1;
  current.ship.lastActivity =
    `transient GitHub error reading ${label} (attempt ${attempt}/${attempts}, retrying in ${Math.round(delay / 1000)}s): ${firstLine(result.stderr || result.stdout)}`;
  save(runId, current);
}

function addRetries(status, retries) {
  return Number(status.ship.remoteRetries || 0) + Number(retries || 0);
}

async function readPr(exec, cwd, target, context, required = true) {
  const { result, retries, transient, attempts } = await execRemote(
    exec,
    "gh",
    [
      "pr",
      "view",
      target,
      "--json",
      "state,mergeStateStatus,mergeable,reviewDecision,statusCheckRollup,mergedAt,mergeCommit,url,number,headRefName,baseRefName",
    ],
    cwd,
    context,
  );
  if (!result.ok) {
    if (!required) return { pr: null, retries };
    const detail = result.stderr || result.stdout || "unknown error";
    throw new ShipBlockedError(
      `Unable to read pull request${transient ? ` after ${attempts} attempts` : ""}: ${detail}`,
      ["Verify GitHub authentication and the pull request reference, then rerun ship."],
    );
  }
  return { pr: parseJson(result.stdout, "pull request"), retries };
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
      `repos/{owner}/{repo}/branches/${encodeURIComponent(baseBranch)}/protection/required_status_checks`,
    ],
    { cwd },
  );
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(String(result.stdout || "null"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const contexts = Array.isArray(parsed.contexts) ? parsed.contexts : [];
    const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
    return [...new Set([
      ...contexts,
      ...checks.map((check) => check?.context),
    ].filter((context) => typeof context === "string" && context))].sort();
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
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function parseSemver(value) {
  return String(value).split(/[+-]/, 1)[0].split(".").map(Number);
}

/** The bump the operator approved, read back off the plan they approved it on. */
function semverBumpLevel(from, to) {
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (b[0] > a[0]) return "major";
  if (b[1] > a[1]) return "minor";
  return "patch";
}

function nextVersion(current, bump) {
  const [major, minor, patch] = parseSemver(current);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function confirmDelayMs(handoff) {
  return Math.min(BLOCK_CONFIRM_MAX_MS, Math.max(0, Number(handoff.pollSec) || 0) * 1000);
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/)[0].trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
