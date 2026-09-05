import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { ensurePrivateDir } from "./fs-safe.mjs";
import { assertSafeSlug, runDir } from "./paths.mjs";

const LEVELS = new Set(["through-pr", "all"]);
const RISKS = Object.freeze({ low: 0, moderate: 1, high: 2, critical: 3 });
const MAX_GRANT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_SCHEMA = "agent-manager.authorization-grant.v1";
const RECEIPT_SCHEMA = "agent-manager.authorization-receipt.v1";
const REVOCATION_SCHEMA = "agent-manager.authorization-revocation.v1";
const POLICY_SCHEMA = "agent-manager.automation-policy.v1";
const POLICY_KEYS = new Set([
  "schema", "enabled", "repository", "approval", "risk", "provider", "shipment", "revocation",
]);
const POLICY_REPOSITORY_KEYS = new Set(["path", "base_ref"]);
const POLICY_APPROVAL_KEYS = new Set(["level", "operator", "approved_at", "expires_at"]);
const POLICY_RISK_KEYS = new Set(["observed", "ceiling", "classes", "exceptions"]);
const POLICY_PROVIDER_KEYS = new Set(["mode"]);
const POLICY_SHIPMENT_KEYS = new Set([
  "target", "repo", "worktree", "branch", "base", "remote", "pr", "commit_message",
  "version", "summary", "poll_sec", "timeout_sec", "check_grace_sec", "retry_attempts",
  "retry_base_ms",
]);
const POLICY_REVOCATION_KEYS = new Set(["revoked_at", "revoked_by", "reason"]);
const MANUAL_RISK_CLASSES = new Set(["security", "authentication"]);

export class AuthorizationError extends Error {
  constructor(code, message, action) {
    super(`${message} Operator action: ${action}`);
    this.name = "AuthorizationError";
    this.code = code;
    this.action = action;
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestCanonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function resolveReviewerIdentity(status, role) {
  if (!role) return null;
  if (role !== "manager") {
    throw fail("reviewer-policy", "conditional authority only accepts the recorded run manager as reviewer",
      "Record the review with --reviewer-role manager or use the manual Ship Gate.");
  }
  const manager = status.identity?.manager || {};
  if (!manager.harness || (!manager.model && !manager.threadTitle)) {
    throw fail("reviewer-identity-missing", "the run has no attributable manager identity",
      "Start a new run with recorded manager harness and model metadata, then obtain a new independent review.");
  }
  const identity = {
    kind: "manager",
    source: "run-identity",
    harness: manager.harness,
    model: manager.model || null,
    threadTitle: manager.threadTitle || null,
  };
  return { ...identity, identityDigest: digestCanonical(identity) };
}

export function loadAutomationPolicy(filePath, { repoOverride = null } = {}) {
  if (!filePath) throw fail("policy-missing", "automation policy is required",
    "Use the manual Ship Gate, or pass --automation-policy <file> to the accepting review.");
  const path = resolve(filePath);
  if (!existsSync(path)) throw fail("policy-missing", `automation policy not found: ${path}`,
    "Use the manual Ship Gate, or restore the exact reviewed policy file.");
  let document;
  try {
    const raw = readFileSync(path, "utf8");
    document = extname(path).toLowerCase() === ".json" ? JSON.parse(raw) : YAML.parse(raw);
  } catch (error) {
    throw fail("policy-invalid", `automation policy parse failed: ${error.message}`,
      "Use the manual Ship Gate, or repair and independently review the policy before accepting again.");
  }
  return normalizeAutomationPolicy(document, { policyPath: path, repoOverride });
}

export function normalizeAutomationPolicy(document, { policyPath, repoOverride = null } = {}) {
  assertMapping(document, "automation policy");
  assertKnownKeys(document, POLICY_KEYS, "automation policy");
  if (document.schema !== POLICY_SCHEMA) {
    throw fail("policy-invalid", `automation policy schema must be ${POLICY_SCHEMA}`,
      "Use the manual Ship Gate, or update the policy to the supported schema.");
  }
  if (typeof document.enabled !== "boolean") {
    throw fail("policy-invalid", "automation policy.enabled must be true or false",
      "Use the manual Ship Gate, or set an explicit policy opt-in.");
  }
  const repository = assertMapping(document.repository, "automation policy.repository");
  assertKnownKeys(repository, POLICY_REPOSITORY_KEYS, "automation policy.repository");
  const repositoryPath = requiredText(repository.path, "automation policy repository path", 2_000);
  const repositoryRoot = resolve(repoOverride || (isAbsolute(repositoryPath)
    ? repositoryPath
    : resolve(dirname(policyPath), repositoryPath)));
  const baseRef = requiredText(repository.base_ref, "automation policy base ref", 240);

  const approval = assertMapping(document.approval, "automation policy.approval");
  assertKnownKeys(approval, POLICY_APPROVAL_KEYS, "automation policy.approval");
  const approvedAt = dateFrom(approval.approved_at, "automation policy.approval.approved_at").toISOString();
  const expiresAt = dateFrom(approval.expires_at, "automation policy.approval.expires_at").toISOString();

  const risk = assertMapping(document.risk, "automation policy.risk");
  assertKnownKeys(risk, POLICY_RISK_KEYS, "automation policy.risk");
  const riskClasses = stringList(risk.classes, "automation policy.risk.classes");
  const riskExceptions = stringList(risk.exceptions, "automation policy.risk.exceptions");

  const provider = assertMapping(document.provider, "automation policy.provider");
  assertKnownKeys(provider, POLICY_PROVIDER_KEYS, "automation policy.provider");
  const shipment = assertMapping(document.shipment, "automation policy.shipment");
  assertKnownKeys(shipment, POLICY_SHIPMENT_KEYS, "automation policy.shipment");

  let revocation = null;
  if (document.revocation != null) {
    revocation = assertMapping(document.revocation, "automation policy.revocation");
    assertKnownKeys(revocation, POLICY_REVOCATION_KEYS, "automation policy.revocation");
    revocation = {
      revoked_at: dateFrom(revocation.revoked_at, "automation policy.revocation.revoked_at").toISOString(),
      revoked_by: requiredText(revocation.revoked_by, "automation policy revoker", 160),
      reason: optionalText(revocation.reason, "automation policy revocation reason", 500),
    };
  }

  const normalized = {
    schema: POLICY_SCHEMA,
    enabled: document.enabled,
    repository: { path: repositoryPath, base_ref: baseRef },
    approval: {
      level: requiredEnum(approval.level, LEVELS, "automation policy approval level"),
      operator: requiredText(approval.operator, "automation policy operator", 160),
      approved_at: approvedAt,
      expires_at: expiresAt,
    },
    risk: {
      observed: requiredRisk(risk.observed, "automation policy observed risk"),
      ceiling: requiredRisk(risk.ceiling, "automation policy risk ceiling"),
      classes: riskClasses,
      exceptions: riskExceptions,
    },
    provider: { mode: requiredText(provider.mode, "automation policy provider mode", 80) },
    shipment: normalizePolicyShipment(shipment),
    revocation,
  };
  return {
    ...normalized,
    absPath: resolve(policyPath),
    repoRoot: repositoryRoot,
    digest: digestCanonical(normalized),
    document: normalized,
  };
}

export function materializeReviewAuthorization(status, { policyPath } = {}, dependencies = {}) {
  const policy = loadAutomationPolicy(policyPath);
  assertAutomationPolicyReady(status, policy, dependencies);
  return createAuthorizationGrant(status, {
    ...policyShipmentOptions(policy.shipment),
    level: policy.approval.level,
    operator: policy.approval.operator,
    operatorSource: "repo-automation-policy",
    expiresAt: policy.approval.expires_at,
    risk: policy.risk.observed,
    riskCeiling: policy.risk.ceiling,
    providerMode: policy.provider.mode,
    repo: policy.repoRoot,
    policyBinding: {
      schema: policy.schema,
      path: policy.absPath,
      digest: policy.digest,
    },
    requireAcceptedReview: true,
  }, dependencies);
}

function normalizePolicyShipment(shipment) {
  return {
    target: optionalText(shipment.target, "automation policy shipment target", 240),
    repo: optionalText(shipment.repo, "automation policy shipment repo", 2_000),
    worktree: optionalText(shipment.worktree, "automation policy shipment worktree", 2_000),
    branch: optionalText(shipment.branch, "automation policy shipment branch", 240),
    base: optionalText(shipment.base, "automation policy shipment base", 240),
    remote: optionalText(shipment.remote, "automation policy shipment remote", 120),
    pr: optionalText(shipment.pr, "automation policy shipment pull request", 240),
    commit_message: optionalText(shipment.commit_message, "automation policy commit message", 200),
    version: optionalText(shipment.version, "automation policy version", 80),
    summary: optionalText(shipment.summary, "automation policy summary", 240),
    poll_sec: boundedNumber(shipment.poll_sec ?? 10, "automation policy poll seconds", 1, 300),
    timeout_sec: boundedNumber(shipment.timeout_sec ?? 1800, "automation policy timeout seconds", 1, 86_400),
    check_grace_sec: boundedNumber(shipment.check_grace_sec ?? 90, "automation policy check grace seconds", 0, 900),
    retry_attempts: boundedNumber(shipment.retry_attempts ?? 5, "automation policy retry attempts", 1, 10),
    retry_base_ms: boundedNumber(shipment.retry_base_ms ?? 1_000, "automation policy retry base milliseconds", 100, 60_000),
  };
}

function policyShipmentOptions(shipment) {
  return {
    target: shipment.target,
    repo: shipment.repo,
    worktree: shipment.worktree,
    branch: shipment.branch,
    base: shipment.base,
    remote: shipment.remote,
    pr: shipment.pr,
    commitMessage: shipment.commit_message,
    version: shipment.version,
    summary: shipment.summary,
    pollSec: shipment.poll_sec,
    timeoutSec: shipment.timeout_sec,
    checkGraceSec: shipment.check_grace_sec,
    retryAttempts: shipment.retry_attempts,
    retryBaseMs: shipment.retry_base_ms,
  };
}

function assertAutomationPolicyReady(status, policy, dependencies = {}) {
  if (policy.enabled !== true) {
    throw fail("policy-disabled", "repo automation policy is not enabled",
      "Use the manual Ship Gate, or obtain a new explicit repo policy opt-in.");
  }
  if (policy.revocation) {
    throw fail("policy-revoked", "repo automation policy is revoked",
      "Use the manual Ship Gate; a revoked policy cannot be reused.");
  }
  const now = dateFrom(dependencies.now?.() ?? new Date(), "current time");
  const approvedAt = dateFrom(policy.approval.approved_at, "automation policy approval time");
  const expiresAt = dateFrom(policy.approval.expires_at, "automation policy expiry");
  if (approvedAt.getTime() > now.getTime() || expiresAt.getTime() <= now.getTime()) {
    throw fail("policy-expired", "repo automation policy is not within its approved time window",
      "Use the manual Ship Gate, or obtain a fresh bounded policy approval.");
  }
  if (expiresAt.getTime() - now.getTime() > MAX_GRANT_LIFETIME_MS) {
    throw fail("policy-expiry", "repo automation policy expiry is more than 7 days away",
      "Use the manual Ship Gate, or reduce the policy expiry to a bounded 7-day window.");
  }
  if (!sameResolvedPath(policy.repoRoot, status.repoRoot)) {
    throw fail("policy-repo-drift", "repo automation policy is bound to a different repository",
      "Use the manual Ship Gate, or review a policy scoped to this exact repository.");
  }
  const target = selectTarget(status, policy.shipment.target);
  const targetBase = normalizeBaseRef(target.base || status.baseRef, policy.shipment.remote || "origin");
  if (targetBase !== normalizeBaseRef(policy.repository.base_ref, policy.shipment.remote || "origin")) {
    throw fail("policy-base-drift", "repo automation policy is bound to a different base branch",
      "Use the manual Ship Gate, or review a policy for the current destination branch.");
  }
  if (RISKS[policy.risk.observed] > RISKS[policy.risk.ceiling]) {
    throw fail("risk-ceiling", `observed risk ${policy.risk.observed} exceeds ceiling ${policy.risk.ceiling}`,
      "Use the manual Ship Gate, reduce the risk, or obtain a policy with an adequate ceiling.");
  }
  const exceptions = new Set(policy.risk.exceptions);
  const uncovered = policy.risk.classes.filter((riskClass) =>
    MANUAL_RISK_CLASSES.has(riskClass) && !exceptions.has(riskClass));
  if (uncovered.length) {
    throw fail("risk-exception-missing", `manual risk class is not explicitly excepted: ${uncovered.join(", ")}`,
      "Use the manual Ship Gate, or obtain an explicit risk exception for the exact class.");
  }
}

function assertCurrentPolicyBinding(status, grant) {
  if (!grant.policyBinding) return;
  let policy;
  try {
    policy = loadAutomationPolicy(grant.policyBinding.path);
  } catch (error) {
    if (error instanceof AuthorizationError) throw error;
    throw fail("policy-unavailable", "the bound repo automation policy cannot be loaded",
      "Use the manual Ship Gate or start a new reviewed run with an available policy.");
  }
  if (policy.enabled !== true || policy.revocation) {
    throw fail("policy-revoked", "the bound repo automation policy was disabled or revoked",
      "Use the manual Ship Gate; do not reuse the revoked conditional grant.");
  }
  if (policy.digest !== grant.policyBinding.digest) {
    throw fail("policy-drift", "the bound repo automation policy changed after review",
      "Use the manual Ship Gate or start a new run with a new independent review of the changed policy.");
  }
  if (!sameResolvedPath(policy.repoRoot, status.repoRoot)) {
    throw fail("policy-repo-drift", "the bound policy repository changed after review",
      "Use the manual Ship Gate or start a new reviewed run for the current repository.");
  }
}

function assertAcceptedReviewForPolicy(status) {
  const review = status.delivery?.review;
  if (review?.state !== "accepted" || !["accept", "accept-with-notes"].includes(review.verdict)) {
    throw fail("review-inconclusive", "policy authorization can only be materialized by an accepting Delivery Review",
      "Use the manual Ship Gate, or record the independent accepting review with --automation-policy in the same operation.");
  }
}

function acceptedReviewDecisionDigest(status) {
  const review = status.delivery?.review;
  if (review?.state !== "accepted") return null;
  const decision = (review.history || []).find((item) => item.pass === review.latestPass);
  if (!decision) return null;
  return digestCanonical({
    pass: decision.pass,
    verdict: decision.verdict,
    reviewer: decision.reviewer,
    reviewerIdentity: decision.reviewerIdentity || null,
    notes: decision.notes || null,
    ...(decision.goalAssessment ? { goalAssessment: decision.goalAssessment } : {}),
    decidedAt: decision.decidedAt,
  });
}

function sameResolvedPath(left, right) {
  if (!left || !right) return false;
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function normalizeBaseRef(value, remote) {
  const text = String(value || "");
  return text.startsWith(`${remote}/`) ? text.slice(remote.length + 1) : text;
}

export function createAuthorizationGrant(status, options = {}, dependencies = {}) {
  assertGrantableStatus(status);
  const now = dateFrom(dependencies.now?.() ?? new Date(), "current time");
  const expiresAt = dateFrom(options.expiresAt, "--expires-at");
  const lifetime = expiresAt.getTime() - now.getTime();
  if (lifetime <= 0 || lifetime > MAX_GRANT_LIFETIME_MS) {
    throw fail("expiry", "authorization expiry must be in the future and no more than 7 days away",
      "Choose a bounded --expires-at value within the next 7 days.");
  }
  const level = requiredEnum(options.level, LEVELS, "authorization level");
  const risk = requiredRisk(options.risk, "observed risk");
  const riskCeiling = requiredRisk(options.riskCeiling, "risk ceiling");
  if (RISKS[risk] > RISKS[riskCeiling]) {
    throw fail("risk-ceiling", `observed risk ${risk} exceeds ceiling ${riskCeiling}`,
      "Reduce the work risk or create a separately reviewed grant with an adequate ceiling.");
  }
  const operator = requiredText(options.operator, "operator", 160);
  const providerMode = requiredText(options.providerMode, "provider mode", 80);
  const target = selectTarget(status, options.target);
  const manifest = buildExecutionManifest(status, target, {
    ...options,
    level,
    risk,
    providerMode,
  });
  const snapshot = evidenceSnapshot(status, target, dependencies);
  const expectedReviewer = resolveReviewerIdentity(status, "manager");
  if (options.requireAcceptedReview === true) assertAcceptedReviewForPolicy(status);
  const reviewDecisionDigest = acceptedReviewDecisionDigest(status);
  const reviewerPolicy = {
    type: "independent-manager",
    allowedReviewerKinds: ["manager"],
    requiredReviewerIdentityDigest: expectedReviewer.identityDigest,
    authorIdentityDigests: authorIdentities(status).map((item) => item.identityDigest).sort(),
  };
  if (options.requireAcceptedReview === true) {
    assertIndependentAcceptedReview(status, { reviewerPolicy });
  }
  const body = {
    schema: AUTH_SCHEMA,
    runId: status.runId,
    level,
    reviewedBase: snapshot.reviewedBase,
    reviewedHead: snapshot.reviewedHead,
    evidenceDigest: snapshot.evidenceDigest,
    manifestDigest: digestCanonical(manifest),
    riskCeiling,
    reviewerPolicy,
    expiresAt: expiresAt.toISOString(),
    permittedMutations: [...manifest.permittedMutations],
    providerMode,
    agentManagerVersion: status.agentManager?.version || "legacy/unrecorded",
    reviewDecisionDigest,
    policyBinding: options.policyBinding || null,
    operatorProvenance: {
      id: operator,
      source: requiredText(options.operatorSource || "cli", "operator source", 80),
      grantedAt: now.toISOString(),
    },
    manifest,
  };
  const grant = { ...body, grantDigest: digestCanonical(body) };
  withAuthorizationLock(status.runId, () => {
    const paths = authorizationPaths(status.runId);
    if (existsSync(paths.grant)) {
      throw fail("grant-exists", "an immutable authorization grant already exists for this run",
        `Inspect it with agent-manager authorization inspect ${status.runId}; revoke it before creating a replacement run grant.`);
    }
    atomicExclusiveWrite(paths.grant, grant);
  });
  return { grant, summary: summarizeAuthorization(status, { grant, now }) };
}

export function inspectAuthorization(status, dependencies = {}) {
  const now = dateFrom(dependencies.now?.() ?? new Date(), "current time");
  const grant = readGrant(status.runId);
  if (!grant) return { exists: false, state: "none", valid: false, summary: null };
  const result = evaluateAuthorization(status, { grant, now, dependencies });
  return { exists: true, ...result, summary: summarizeResult(grant, result) };
}

export function revokeAuthorization(status, options = {}, dependencies = {}) {
  const grant = requireGrant(status.runId);
  const now = dateFrom(dependencies.now?.() ?? new Date(), "current time");
  const revocationBody = {
    schema: REVOCATION_SCHEMA,
    runId: status.runId,
    grantDigest: grant.grantDigest,
    revokedAt: now.toISOString(),
    revokedBy: requiredText(options.operator, "operator", 160),
    reason: optionalText(options.reason, "reason", 500),
  };
  const revocation = { ...revocationBody, revocationDigest: digestCanonical(revocationBody) };
  withAuthorizationLock(status.runId, () => {
    const paths = authorizationPaths(status.runId);
    if (existsSync(paths.receipt)) {
      throw fail("already-consumed", "the authorization has already produced an execution receipt",
        "Inspect the receipt and current ship state; do not revoke or replay an executed grant.");
    }
    if (existsSync(paths.revocation)) {
      throw fail("already-revoked", "the authorization is already revoked",
        `Inspect it with agent-manager authorization inspect ${status.runId}.`);
    }
    atomicExclusiveWrite(paths.revocation, revocation);
  });
  return { revocation, summary: summarizeAuthorization(status, { grant, now }) };
}

export function authorizedShipOptions(status) {
  const grant = requireGrant(status.runId);
  return {
    approve: grant.level,
    ...grant.manifest,
    authorized: true,
  };
}

export function consumeAuthorization(status, handoff, dependencies = {}) {
  const now = dateFrom(dependencies.now?.() ?? new Date(), "current time");
  const grant = requireGrant(status.runId);
  const manifest = manifestFromHandoff(handoff);
  const result = evaluateAuthorization(status, { grant, now, dependencies, manifest });
  if (!result.valid) throw result.error;
  const receiptBody = {
    schema: RECEIPT_SCHEMA,
    runId: status.runId,
    grantDigest: grant.grantDigest,
    executionDigest: digestCanonical(manifest),
    approvalLevel: grant.level,
    permittedMutations: [...grant.permittedMutations],
    reviewedBase: grant.reviewedBase,
    reviewedHead: grant.reviewedHead,
    evidenceDigest: grant.evidenceDigest,
    agentManagerVersion: grant.agentManagerVersion,
    issuedAt: now.toISOString(),
  };
  const receipt = { ...receiptBody, receiptDigest: digestCanonical(receiptBody) };
  withAuthorizationLock(status.runId, () => {
    const paths = authorizationPaths(status.runId);
    if (existsSync(paths.receipt)) {
      throw fail("replay", "this authorization grant has already been consumed",
        "Inspect the existing receipt and current shipment outcome; create a new reviewed run before any new mutation.");
    }
    if (existsSync(paths.revocation)) {
      throw fail("revoked", "this authorization grant was revoked before execution",
        "Use a new explicit manual Ship Gate, or start a new reviewed run and grant.");
    }
    atomicExclusiveWrite(paths.receipt, receipt);
  });
  return { receipt, summary: summarizeAuthorization(status, { grant, now }) };
}

export function assertAuthorizationReceipt(status, handoff, dependencies = {}) {
  if (!handoff.authorization) return true;
  const grant = requireGrant(status.runId);
  const receipt = readJson(authorizationPaths(status.runId).receipt);
  if (!receipt || receipt.receiptDigest !== handoff.authorization.receiptDigest) {
    throw fail("receipt-missing", "the queued authorized shipment has no matching immutable receipt",
      "Stop the shipment and inspect the private authorization artifacts; do not retry the grant.");
  }
  assertDigest(grant, "grantDigest", "grant-integrity");
  assertDigest(receipt, "receiptDigest", "receipt-integrity");
  if (receipt.grantDigest !== grant.grantDigest || handoff.authorization.grantDigest !== grant.grantDigest) {
    throw fail("receipt-binding", "the execution receipt is not bound to this grant",
      "Stop the shipment and create a new reviewed run; do not repair or replay authority files.");
  }
  if (existsSync(authorizationPaths(status.runId).revocation)) {
    throw fail("revoked", "the authorization was revoked before provider execution",
      "Stop the shipment and create a new reviewed grant; never bypass the revocation.");
  }
  const now = dateFrom(dependencies.now?.() ?? new Date(), "current time");
  if (now.getTime() >= Date.parse(grant.expiresAt)) {
    throw fail("expired", "the authorization expired before provider execution",
      "Stop the shipment; use a new explicit manual decision or start a new reviewed run and grant.");
  }
  if ((status.agentManager?.version || "legacy/unrecorded") !== grant.agentManagerVersion) {
    throw fail("version-drift", "the Agent Manager version changed before provider execution",
      "Stop the shipment and start a new reviewed run and grant with the current runtime.");
  }
  assertIndependentAcceptedReview(status, grant);
  const manifest = manifestFromHandoff(handoff);
  if (receipt.executionDigest !== digestCanonical(manifest)) {
    throw fail("execution-drift", "the queued ship handoff differs from the receipted execution",
      "Stop the shipment and start a new reviewed run and grant for the exact inputs.");
  }
  const current = evidenceSnapshot(status, selectTarget(status, grant.manifest.target), dependencies);
  if (current.reviewedBase !== grant.reviewedBase || current.reviewedHead !== grant.reviewedHead
    || current.evidenceDigest !== grant.evidenceDigest) {
    throw fail("evidence-drift", "reviewed code or evidence changed after the execution receipt was issued",
      "Stop the shipment and start a new reviewed run and grant for the current worktree.");
  }
  return true;
}

export function summarizeAuthorization(status, { grant = readGrant(status.runId), now = new Date() } = {}) {
  if (!grant) return null;
  return summarizeResult(grant, evaluateAuthorization(status, {
    grant,
    now: dateFrom(now, "current time"),
    dependencies: {},
  }));
}

function evaluateAuthorization(status, { grant, now, dependencies = {}, manifest = null }) {
  try {
    assertDigest(grant, "grantDigest", "grant-integrity");
    if (grant.runId !== status.runId) {
      throw fail("run-drift", "the authorization grant belongs to a different run",
        "Use the manual Ship Gate or create a grant for this exact run.");
    }
    const paths = authorizationPaths(status.runId);
    if (existsSync(paths.revocation)) {
      throw fail("revoked", "the conditional authorization is revoked",
        "Use a new explicit manual Ship Gate, or start a new reviewed run and grant; revoked grants are immutable.");
    }
    if (existsSync(paths.receipt)) {
      throw fail("replay", "the conditional authorization already has an execution receipt",
        "Inspect the prior receipt and shipment outcome; never retry or reuse the consumed grant.");
    }
    if (now.getTime() >= Date.parse(grant.expiresAt)) {
      throw fail("expired", "the conditional authorization has expired",
        "Use a new explicit manual Ship Gate, or start a new reviewed run and grant with a fresh bounded expiry.");
    }
    if ((status.agentManager?.version || "legacy/unrecorded") !== grant.agentManagerVersion) {
      throw fail("version-drift", "the Agent Manager version changed after authorization",
        "Start a new reviewed run and grant with the current runtime.");
    }
    assertCurrentPolicyBinding(status, grant);
    const target = selectTarget(status, grant.manifest.target);
    const current = evidenceSnapshot(status, target, dependencies);
    if (current.reviewedBase !== grant.reviewedBase) {
      throw fail("base-drift", "the reviewed base changed after authorization",
        "Restore the reviewed inputs or start a new reviewed run and grant from the new base.");
    }
    if (current.reviewedHead !== grant.reviewedHead || current.evidenceDigest !== grant.evidenceDigest) {
      throw fail("evidence-drift", "the reviewed head, worktree, or evidence changed after authorization",
        "Revoke this grant, then use a new explicit manual Ship Gate or start a new reviewed run and grant.");
    }
    assertIndependentAcceptedReview(status, grant);
    if (grant.reviewDecisionDigest
      && acceptedReviewDecisionDigest(status) !== grant.reviewDecisionDigest) {
      throw fail("review-drift", "the accepted Delivery Review decision changed after authorization",
        "Use the manual Ship Gate or start a new run with a new independent review and policy grant.");
    }
    if (status.state !== "ship_gate_pending") {
      throw fail("state-drift", `run state ${status.state} is not eligible for conditional advance`,
        "Do not use the grant. Inspect the current delivery outcome or start a new reviewed run and grant.");
    }
    if (manifest) {
      const digest = digestCanonical(manifest);
      if (digest !== grant.manifestDigest) {
        const code = manifest.providerMode !== grant.providerMode
          ? "provider-mode-drift"
          : manifest.version !== grant.manifest.version
            ? "version-drift"
            : manifest.risk !== grant.manifest.risk
              ? "risk-drift"
              : "manifest-drift";
        throw fail(code, "the requested execution differs from the authorized manifest",
          "Use the exact grant inputs, or start a new reviewed run and grant for the changed request.");
      }
    }
    return { valid: true, state: "ready", code: null, action: null, error: null };
  } catch (error) {
    const normalized = error instanceof AuthorizationError
      ? error
      : fail("invalid", String(error?.message || error),
        "Use a new explicit manual Ship Gate, or start a new reviewed run and grant.");
    return {
      valid: false,
      state: authorizationState(normalized.code),
      code: normalized.code,
      action: normalized.action,
      error: normalized,
    };
  }
}

function assertIndependentAcceptedReview(status, grant) {
  const review = status.delivery?.review;
  if (review?.state === "rejected" || review?.verdict === "reject") {
    throw fail("review-rejected", "Delivery Review rejected this work",
      "Do not ship this run. Close it as rejected; materially revised work requires a new run and review.");
  }
  if (review?.state !== "accepted" || !["accept", "accept-with-notes"].includes(review.verdict)) {
    throw fail("review-inconclusive", "conditional authorization requires a persisted accepting Delivery Review",
      `Record an accepting review with agent-manager review ${status.runId} --verdict accept --reviewer <id> --reviewer-role manager, or use the manual path.`);
  }
  const decision = (review.history || []).find((item) => item.pass === review.latestPass);
  const identity = decision?.reviewerIdentity;
  if (!identity || identity.kind !== "manager" || identity.source !== "run-identity") {
    throw fail("reviewer-unattributed", "the accepting review has no independently attributable run-manager identity",
      "Obtain a new independent review recorded with --reviewer-role manager; a reviewer label alone is not authority.");
  }
  const currentManager = resolveReviewerIdentity(status, "manager");
  if (identity.identityDigest !== currentManager.identityDigest) {
    throw fail("reviewer-drift", "the recorded reviewer identity no longer matches the run manager identity",
      "Start a new run and obtain an independent review from its recorded manager before granting authority.");
  }
  if (identity.identityDigest !== grant.reviewerPolicy?.requiredReviewerIdentityDigest) {
    throw fail("reviewer-drift", "the accepting reviewer is not the manager identity bound by the grant",
      "Start a new run and grant that names the intended independent manager identity.");
  }
  const authorDigests = new Set(grant.reviewerPolicy?.authorIdentityDigests || []);
  if (authorDigests.has(identity.identityDigest) || reviewerCollidesWithAuthor(status, decision)) {
    throw fail("reviewer-collision", "the accepting reviewer identity collides with a worker author identity",
      "Start a new run with a different recorded manager, then obtain review and create its grant.");
  }
}

function reviewerCollidesWithAuthor(status, decision) {
  const reviewerValues = new Set([
    decision.reviewer,
    decision.reviewerIdentity?.threadTitle,
    decision.reviewerIdentity?.identityDigest,
  ].filter(Boolean));
  return authorIdentities(status).some((author) =>
    reviewerValues.has(author.laneId)
    || reviewerValues.has(author.sessionId)
    || reviewerValues.has(author.identityDigest));
}

function evidenceSnapshot(status, target, dependencies) {
  const reviewedBase = status.integrate?.baseSha
    || status.planning?.actualBaseSha
    || status.planning?.reviewedBaseSha
    || status.baseCommit
    || status.initialRepo?.head
    || null;
  if (!reviewedBase) {
    throw fail("base-missing", "the run has no immutable reviewed base",
      "Use the manual Ship Gate or start a run with verified planning/base evidence.");
  }
  const git = (dependencies.gitSnapshot || defaultGitSnapshot)(target.worktree);
  const evidence = {
    runId: status.runId,
    reviewedBase,
    reviewedHead: git.head,
    worktreeStatus: git.status,
    worktreeDigest: git.worktreeDigest || digestCanonical({ status: git.status }),
    planningContextDigest: status.planning?.contextDigest || null,
    target: {
      id: target.id,
      branch: target.branch,
      base: target.base,
      changedFiles: [...(target.changedFiles || [])].sort(),
    },
    integration: status.integrate ? {
      merged: [...(status.integrate.merged || [])].sort(),
      forcedLanes: [...(status.integrate.forcedLanes || [])].sort(),
      excludedLanes: status.integrate.excludedLanes || [],
      ratifiedLanes: [...(status.integrate.ratifiedLanes || [])].sort(),
      verification: status.integrate.verification || null,
      diffStat: status.integrate.diffStat || null,
    } : null,
    lanes: (status.lanes || []).map((lane) => ({
      id: lane.id,
      state: lane.state,
      changedFiles: [...(lane.changedFiles || [])].sort(),
      scopeViolations: [...(lane.scopeViolations || [])].sort(),
      readOnlyViolations: [...(lane.readOnlyViolations || [])].sort(),
      policyViolations: [...(lane.policyViolations || [])].sort(),
      snapshot: lane.snapshot || null,
      ratification: lane.ratification || null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    authorIdentityDigests: authorIdentities(status).map((item) => item.identityDigest).sort(),
  };
  return {
    reviewedBase,
    reviewedHead: git.head,
    evidenceDigest: digestCanonical(evidence),
  };
}

function defaultGitSnapshot(worktree) {
  if (!worktree) {
    throw fail("worktree-missing", "the delivery target has no worktree",
      "Integrate the run or select a delivery target with a retained worktree.");
  }
  const head = spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
    encoding: "utf8", windowsHide: true,
  });
  const status = spawnSync("git", ["-C", worktree, "status", "--porcelain=v1"], {
    encoding: "utf8", windowsHide: true,
  });
  const diff = spawnSync("git", ["-C", worktree, "diff", "--binary", "--no-ext-diff", "HEAD"], {
    encoding: "buffer", windowsHide: true,
  });
  const untracked = spawnSync("git", ["-C", worktree, "ls-files", "--others", "--exclude-standard", "-z"], {
    encoding: "buffer", windowsHide: true,
  });
  if (head.status !== 0 || status.status !== 0 || diff.status !== 0 || untracked.status !== 0) {
    throw fail("worktree-unreadable", "the reviewed worktree cannot be fingerprinted",
      "Restore the recorded worktree and re-run Delivery Review before creating authority.");
  }
  const untrackedFiles = String(untracked.stdout || "").split("\0").filter(Boolean).sort();
  const untrackedEvidence = untrackedFiles.map((path) => ({
    path,
    digest: hashWorktreePath(worktree, path),
  }));
  return {
    head: String(head.stdout).trim(),
    status: String(status.stdout).trim(),
    worktreeDigest: digestCanonical({
      diffSha256: createHash("sha256").update(diff.stdout || Buffer.alloc(0)).digest("hex"),
      untracked: untrackedEvidence,
    }),
  };
}

function buildExecutionManifest(status, target, options) {
  const flow = status.target_dev_flow || "simple";
  const level = options.level;
  if (flow === "simple" && level === "through-pr") {
    throw fail("level-policy", "through-pr is not valid for Simple Flow",
      "Use level all for Simple Flow, or use the manual Ship Gate.");
  }
  const remote = optionalText(options.remote, "remote", 120) || status.integrate?.remote || "origin";
  let base = optionalText(options.base, "base", 240) || target.base || status.baseRef || null;
  if (base?.startsWith(`${remote}/`)) base = base.slice(remote.length + 1);
  if (!base || base === "HEAD" || base === "@" || /^[0-9a-f]{40}$/i.test(base)) {
    throw fail("base-ambiguous", "conditional authority requires an explicit destination branch",
      "Create the grant with --base <branch>; moving or commit-only base refs are not accepted.");
  }
  const branch = optionalText(options.branch, "branch", 240) || target.branch || status.integrate?.branch || base;
  const repoValue = options.repo || status.repoRoot;
  if (!repoValue) {
    throw fail("repo-missing", "conditional authority requires the recorded repository root",
      "Create the grant with --repo <path> or use the manual Ship Gate.");
  }
  const repoRoot = resolve(repoValue);
  const worktree = resolve(options.worktree || target.worktree || status.integrate?.worktree || repoRoot);
  const version = optionalText(options.version, "version", 80);
  const summary = optionalText(options.summary, "summary", 240);
  const commitMessage = optionalText(options.commitMessage, "commit message", 200);
  if (commitMessage && !/^(?:feat|fix|docs|refactor|chore|test|build|ci|perf|revert)(?:!)?(?:\([^)]+\))?: .+/.test(commitMessage)) {
    throw fail("commit-message-invalid", "commit message must use a conventional commit prefix",
      "Choose an exact conventional commit message before creating the grant.");
  }
  if (level === "all") {
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw fail("version-missing", "level all requires an exact semantic version",
        "Create the grant with --version <semver>.");
    }
    if (!summary) {
      throw fail("summary-missing", "level all requires a public release summary",
        "Create the grant with --summary <text>.");
    }
    if (flow === "simple" && !commitMessage) {
      throw fail("commit-message-missing", "Simple Flow level all requires a commit message",
        "Create the grant with --commit-message <conventional message>.");
    }
  }
  return {
    level,
    flow,
    repo: repoRoot,
    worktree,
    branch,
    base,
    remote,
    pr: optionalText(options.pr, "pull request", 240),
    target: target.id,
    commitMessage,
    version,
    summary,
    pollSec: boundedNumber(options.pollSec ?? 10, "poll seconds", 1, 300),
    timeoutSec: boundedNumber(options.timeoutSec ?? 1800, "timeout seconds", 1, 86400),
    checkGraceSec: boundedNumber(options.checkGraceSec ?? 90, "check grace seconds", 0, 900),
    retryAttempts: boundedNumber(options.retryAttempts ?? 5, "retry attempts", 1, 10),
    retryBaseMs: boundedNumber(options.retryBaseMs ?? 1000, "retry base milliseconds", 100, 60000),
    providerMode: options.providerMode,
    risk: options.risk,
    permittedMutations: permittedMutations(level, flow),
  };
}

function manifestFromHandoff(handoff) {
  return {
    level: handoff.approve,
    flow: handoff.flow,
    repo: resolve(handoff.repoRoot),
    worktree: resolve(handoff.worktree),
    branch: handoff.branch,
    base: handoff.base,
    remote: handoff.remote,
    pr: handoff.pr || null,
    target: handoff.targetId,
    commitMessage: handoff.commitMessage || null,
    version: handoff.version || null,
    summary: handoff.summary || null,
    pollSec: handoff.pollSec,
    timeoutSec: handoff.timeoutSec,
    checkGraceSec: handoff.checkGraceSec,
    retryAttempts: handoff.retryAttempts,
    retryBaseMs: handoff.retryBaseMs,
    providerMode: handoff.providerMode,
    risk: handoff.risk,
    permittedMutations: [...(handoff.permittedMutations || [])],
  };
}

function selectTarget(status, targetId) {
  const targets = status.delivery?.targets || [];
  if (targets.length > 1 && !targetId) {
    throw fail("target-missing", "a delivery train requires one exact target",
      "Create the grant with --target <delivery-target-id>.");
  }
  let target = targetId ? targets.find((item) => item.id === targetId) : targets[0];
  if (!target && status.integrate?.worktree) {
    target = {
      id: "integrate",
      branch: status.integrate.branch,
      base: status.baseRef || status.integrate.baseSha,
      worktree: status.integrate.worktree,
      changedFiles: [...new Set((status.lanes || []).flatMap((lane) => lane.changedFiles || []))],
    };
  }
  if (!target) {
    throw fail("target-missing", "the run has no delivery target to authorize",
      "Integrate the run or use the manual review-only closeout path.");
  }
  if (targetId && target.id !== targetId) {
    throw fail("target-drift", `delivery target ${targetId} no longer exists`,
      "Re-run Delivery Review and create a grant for a current target.");
  }
  return target;
}

function authorIdentities(status) {
  return (status.lanes || []).map((lane) => {
    const body = {
      kind: "worker",
      laneId: lane.id,
      harness: lane.harness || null,
      model: lane.modelObserved || lane.modelRequested || null,
      sessionId: lane.sessionId || null,
    };
    return { ...body, identityDigest: digestCanonical(body) };
  });
}

function permittedMutations(level, flow = "formal") {
  if (flow === "simple") return ["commit", "push", "version", "tag"];
  const base = ["commit", "push", "pull-request", "merge"];
  return level === "all" ? [...base, "version", "tag"] : base;
}

function hashWorktreePath(worktree, path) {
  const root = resolve(worktree);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw fail("worktree-path", "Git reported an untracked path outside the reviewed worktree",
      "Stop and inspect the worktree before creating authority.");
  }
  const stat = lstatSync(target);
  const hash = createHash("sha256");
  if (stat.isSymbolicLink()) hash.update(`symlink:${readlinkSync(target)}`, "utf8");
  else if (stat.isFile()) hash.update(readFileSync(target));
  else hash.update(`non-file:${stat.mode}:${stat.size}`, "utf8");
  return hash.digest("hex");
}

function summarizeResult(grant, result) {
  return {
    schema: "agent-manager.authorization-summary.v1",
    state: result.state,
    valid: result.valid,
    level: grant.level,
    grantDigest: grant.grantDigest,
    evidenceDigest: grant.evidenceDigest,
    manifestDigest: grant.manifestDigest,
    policyDigest: grant.policyBinding?.digest || null,
    reviewDecisionDigest: grant.reviewDecisionDigest || null,
    riskCeiling: grant.riskCeiling,
    providerMode: grant.providerMode,
    expiresAt: grant.expiresAt,
    permittedMutations: [...grant.permittedMutations],
    failureCode: result.code || null,
    nextAction: result.action || null,
    receiptDigest: readJson(authorizationPaths(grant.runId).receipt)?.receiptDigest || null,
  };
}

function authorizationState(code) {
  if (code === "revoked") return "revoked";
  if (code === "replay") return "consumed";
  if (code === "expired") return "expired";
  return "blocked";
}

function assertGrantableStatus(status) {
  if (!status?.runId) throw new Error("authorization requires a run status");
  if (!["delivery_review_pending", "ship_gate_pending"].includes(status.state)) {
    throw fail("state", `run ${status.runId} cannot receive conditional authority in state ${status.state}`,
      "Wait for worker completion and frozen delivery evidence, or use the manual delivery path.");
  }
}

function authorizationPaths(runId, { ensure = false } = {}) {
  const id = assertSafeSlug(runId, "run id");
  const dir = join(runDir(id), "authorization");
  if (ensure) ensurePrivateDir(dir);
  return {
    dir,
    grant: join(dir, "grant.json"),
    revocation: join(dir, "revocation.json"),
    receipt: join(dir, "receipt.json"),
    lock: join(dir, ".lock"),
  };
}

function readGrant(runId) {
  return readJson(authorizationPaths(runId).grant);
}

function requireGrant(runId) {
  const grant = readGrant(runId);
  if (!grant) {
    throw fail("missing", "no conditional authorization grant exists for this run",
      `Use the manual Ship Gate or create one with agent-manager authorization create ${runId} ...`);
  }
  return grant;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertDigest(document, field, code) {
  const { [field]: recorded, ...body } = document;
  if (!recorded || recorded !== digestCanonical(body)) {
    throw fail(code, `immutable ${field} validation failed`,
      "Stop and inspect the private authorization files; never repair or execute modified authority.");
  }
}

function withAuthorizationLock(runId, callback) {
  const paths = authorizationPaths(runId, { ensure: true });
  let fd;
  try {
    fd = openSync(paths.lock, "wx", 0o600);
  } catch (error) {
    throw fail("locked", "authorization state is already being changed",
      "Wait for the current authorization operation to finish, then inspect the grant.");
  }
  try {
    return callback();
  } finally {
    closeSync(fd);
    rmSync(paths.lock, { force: true });
  }
}

function atomicExclusiveWrite(path, document) {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(document, null, 2) + "\n", {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    if (existsSync(path)) throw new Error(`immutable file already exists: ${path}`);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function fail(code, message, action) {
  return new AuthorizationError(code, message, action);
}

function dateFrom(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be an ISO-8601 timestamp`);
  return date;
}

function requiredText(value, label, maxLength) {
  const result = optionalText(value, label, maxLength);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function optionalText(value, label, maxLength) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!text || text.length > maxLength || /[\r\n\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${label} must be a single line of 1-${maxLength} characters`);
  }
  return text;
}

function requiredEnum(value, allowed, label) {
  const text = String(value || "");
  if (!allowed.has(text)) throw new Error(`${label} must be ${[...allowed].join(" or ")}`);
  return text;
}

function requiredRisk(value, label) {
  const risk = String(value || "");
  if (!(risk in RISKS)) throw new Error(`${label} must be low, moderate, high, or critical`);
  return risk;
}

function assertMapping(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("policy-invalid", `${label} must be a mapping`,
      "Use the manual Ship Gate, or repair and independently review the repo policy.");
  }
  return value;
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw fail("policy-invalid", `${label} contains unknown key: ${key}`,
        "Use the manual Ship Gate, or remove the unsupported field and independently review the policy.");
    }
  }
}

function stringList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw fail("policy-invalid", `${label} must be an array`,
      "Use the manual Ship Gate, or repair and independently review the repo policy.");
  }
  const items = value.map((item, index) => requiredText(item, `${label}[${index}]`, 120));
  if (new Set(items).size !== items.length) {
    throw fail("policy-invalid", `${label} must not contain duplicates`,
      "Use the manual Ship Gate, or repair and independently review the repo policy.");
  }
  return [...items].sort();
}

function boundedNumber(value, label, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return number;
}
