import { createHash } from "node:crypto";
import { spawnCommandSync } from "./command.mjs";
import { recordMergedTarget, recordRelease } from "./delivery.mjs";
import { readStatus, writeStatus } from "./status.mjs";

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const SUCCESS_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

export class ReconciliationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReconciliationError";
    this.code = code;
  }
}

/**
 * Verify provider evidence before converting a stale delivery ledger to a
 * terminal state. The input status is cloned so a failed check cannot partially
 * mark targets as merged.
 */
export async function reconcileExternalDelivery(status, {
  provider,
  now = () => new Date(),
} = {}) {
  if (!provider) throw new ReconciliationError("provider-required", "external delivery reconciliation requires a provider adapter");
  if (!status?.runId || !status.delivery) {
    throw new ReconciliationError("status-invalid", "external delivery reconciliation requires a recorded run delivery ledger");
  }
  if (!["blocked", "release_pending", "ship_gate_pending"].includes(status.state)) {
    throw new ReconciliationError("state-ineligible", `run ${status.runId} cannot reconcile from state ${status.state}`);
  }
  if (status.delivery.review?.state !== "accepted") {
    throw new ReconciliationError("review-missing", "external delivery reconciliation requires the persisted accepted Delivery Review");
  }
  const recordedProvider = status.ship?.provider || status.authorization?.providerMode || null;
  if (recordedProvider && provider.name && recordedProvider !== provider.name) {
    throw new ReconciliationError(
      "provider-drift",
      `recorded provider ${recordedProvider} does not match reconciliation provider ${provider.name}`,
    );
  }

  const candidate = structuredClone(status);
  const evidenceTargets = [];
  const targets = candidate.delivery.targets || [];
  for (const target of targets) {
    const shipMatches = candidate.ship?.targetId === target.id || targets.length === 1;
    const prRef = target.prUrl || target.pr || (shipMatches ? candidate.ship?.prUrl : null);
    if (!prRef) {
      throw new ReconciliationError("pr-missing", `delivery target ${target.id} has no recorded pull request`);
    }
    const pr = await provider.inspectPullRequest(prRef);
    const baseIdentity = deliveryBaseIdentity(candidate, target, shipMatches);
    assertMergedPullRequest(target, pr, baseIdentity.baseBranch);
    const mergeSha = normalizeSha(pr.mergeSha, `pull request ${prRef} merge SHA`);
    if (target.mergeSha && target.mergeSha !== mergeSha) {
      throw new ReconciliationError(
        "merge-drift",
        `delivery target ${target.id} recorded merge ${target.mergeSha}, but provider reports ${mergeSha}`,
      );
    }
    if (baseIdentity.baseCommit && await provider.isAncestor(baseIdentity.baseCommit, mergeSha) !== true) {
      throw new ReconciliationError(
        "base-ancestry-mismatch",
        `delivery target ${target.id} merge ${mergeSha} does not contain immutable base ${baseIdentity.baseCommit}`,
      );
    }
    if (!Array.isArray(pr.checks) || pr.checks.length === 0) {
      throw new ReconciliationError(
        "checks-unavailable",
        `pull request ${prRef} has no required CI check evidence; reconciliation cannot prove CI gated the merge`,
      );
    }
    if (pr.requiredChecksSatisfied !== true) {
      const detail = failedOrPendingChecks(pr.checks).join(", ") || "required-check evidence unavailable";
      throw new ReconciliationError("checks-unverified", `pull request ${prRef} checks are not verified: ${detail}`);
    }
    evidenceTargets.push({
      id: target.id,
      pr: pr.url || String(prRef),
      mergeSha,
      head: pr.head || null,
      base: pr.base || null,
      baseBranch: baseIdentity.baseBranch,
      baseCommit: baseIdentity.baseCommit,
      checks: (pr.checks || []).map(checkEvidence),
    });
  }

  for (const item of evidenceTargets) {
    const target = targets.find((entry) => entry.id === item.id);
    if (target.state !== "merged" || target.mergeSha !== item.mergeSha) {
      recordMergedTarget(candidate, {
        targetId: target.id,
        prUrl: item.pr,
        mergeSha: item.mergeSha,
        at: isoNow(now),
      });
    }
  }

  const releaseRequired = candidate.delivery.releaseRequired === true ||
    candidate.ship?.approve === "all" || Boolean(candidate.ship?.plannedTag || candidate.ship?.tag);
  let releaseEvidence = null;
  if (releaseRequired) {
    const releaseMode = normalizeReleaseMode(candidate.delivery.release?.mode);
    const tag = candidate.ship?.tag || candidate.ship?.plannedTag || candidate.delivery.release?.tag;
    if (!tag) throw new ReconciliationError("tag-missing", "release reconciliation requires the recorded planned tag");
    if (candidate.ship?.version && tag !== `v${candidate.ship.version}`) {
      throw new ReconciliationError("version-drift", `recorded version ${candidate.ship.version} does not match tag ${tag}`);
    }
    const remoteTag = await provider.inspectTag(tag);
    if (!remoteTag?.sha) throw new ReconciliationError("tag-unverified", `provider cannot verify remote tag ${tag}`);
    const releaseSha = normalizeSha(remoteTag.sha, `tag ${tag} SHA`);
    const recordedReleaseSha = candidate.ship?.releaseSha || candidate.delivery.release?.sha || null;
    if (recordedReleaseSha && recordedReleaseSha !== releaseSha) {
      throw new ReconciliationError(
        "release-sha-drift",
        `recorded release SHA ${recordedReleaseSha} does not match remote tag ${releaseSha}`,
      );
    }
    const version = candidate.ship?.version || (tag.startsWith("v") ? tag.slice(1) : null);
    if (!version) throw new ReconciliationError("version-missing", `release ${tag} has no recorded version`);
    if (typeof provider.inspectTagCi !== "function") {
      throw new ReconciliationError("tag-ci-unavailable", `provider cannot inspect tag-triggered CI for ${tag}`);
    }
    if (typeof provider.inspectVersionStamp !== "function") {
      throw new ReconciliationError("version-stamp-unavailable", `provider cannot inspect version stamps at ${releaseSha}`);
    }
    const [tagCi, versionStamp] = await Promise.all([
      provider.inspectTagCi(tag, releaseSha),
      provider.inspectVersionStamp(releaseSha, version),
    ]);
    const verifiedTagCi = verifyTagCi(tagCi, tag, releaseSha);
    const verifiedVersionStamp = verifyVersionStampEvidence(versionStamp, version, releaseSha);
    let providerRelease = null;
    if (releaseMode === "published-release") {
      if (typeof provider.inspectRelease !== "function") {
        throw new ReconciliationError("release-unverified", `provider cannot inspect a published release for ${tag}`);
      }
      const release = await provider.inspectRelease(tag);
      if (!release?.published || release.tag !== tag) {
        throw new ReconciliationError("release-unverified", `provider cannot verify a published release for ${tag}`);
      }
      if (release.sha && normalizeSha(release.sha, `release ${tag} SHA`) !== releaseSha) {
        throw new ReconciliationError("release-tag-drift", `release ${tag} does not resolve to remote tag ${releaseSha}`);
      }
      providerRelease = {
        publishedAt: release.publishedAt || null,
        url: release.url || null,
      };
    }
    const merges = evidenceTargets.map((item) => item.mergeSha);
    for (const mergeSha of merges) {
      if (await provider.isAncestor(mergeSha, releaseSha) !== true) {
        throw new ReconciliationError(
          "ancestry-mismatch",
          `release ${releaseSha} does not contain verified delivery merge ${mergeSha}`,
        );
      }
    }
    recordRelease(candidate, {
      sha: releaseSha,
      tag,
      verifiedMergeShas: merges,
      mode: releaseMode,
      tagCi: verifiedTagCi,
      providerRelease,
      at: isoNow(now),
    });
    releaseEvidence = {
      mode: releaseMode,
      tag,
      sha: releaseSha,
      verifiedMergeShas: merges,
      versionStamp: verifiedVersionStamp,
      tagCi: verifiedTagCi,
      providerRelease,
    };
  } else if (!targets.length || targets.every((target) => target.state === "merged")) {
    candidate.delivery.state = "merged";
    candidate.state = "merged";
    candidate.endedAt = isoNow(now);
  }

  const reconciledAt = isoNow(now);
  candidate.reconciliation = {
    schema: "agent-manager.external-reconciliation.v1",
    state: "verified",
    provider: provider.name || "unknown",
    reconciledAt,
    priorState: status.state,
    targets: evidenceTargets,
    release: releaseEvidence,
  };
  if (candidate.ship) {
    candidate.ship.state = "done";
    candidate.ship.phase = "done";
    candidate.ship.pid = null;
    candidate.ship.needsInput = null;
    candidate.ship.error = null;
    candidate.ship.endedAt = reconciledAt;
    candidate.ship.lastActivity = `external delivery verified by ${provider.name || "provider"}`;
    if (releaseEvidence) {
      candidate.ship.releaseSha = releaseEvidence.sha;
      candidate.ship.tag = releaseEvidence.tag;
      candidate.ship.verifiedMergeShas = [...releaseEvidence.verifiedMergeShas];
      candidate.ship.releaseCi = structuredClone(releaseEvidence.tagCi);
    }
  }
  return candidate;
}

export async function reconcileRun(runId, options = {}) {
  const status = readStatus(runId);
  if (!status) throw new ReconciliationError("run-missing", `no status for ${runId}`);
  const provider = options.provider || createGitHubProvider({
    cwd: status.repoRoot,
    remote: status.ship?.remote || "origin",
    exec: options.exec,
  });
  const reconciled = await reconcileExternalDelivery(status, { ...options, provider });
  return writeStatus(runId, reconciled);
}

export function createGitHubProvider({ cwd, remote = "origin", exec = execute } = {}) {
  let repository = null;
  const command = (name, args, label) => {
    const result = exec(name, args, { cwd });
    if (!result.ok) {
      throw new ReconciliationError("provider-read-failed", `${label}: ${result.stderr || result.stdout || "command failed"}`);
    }
    return result.stdout;
  };
  const repositoryName = () => {
    if (!repository) {
      repository = parseJson(
        command("gh", ["repo", "view", "--json", "nameWithOwner"], "read GitHub repository"),
        "GitHub repository",
      ).nameWithOwner;
    }
    return repository;
  };
  return {
    name: "github",
    async inspectPullRequest(ref) {
      const pr = parseJson(command("gh", [
        "pr", "view", String(ref), "--json",
        "state,statusCheckRollup,mergedAt,mergeCommit,url,headRefName,baseRefName",
      ], `read pull request ${ref}`), `pull request ${ref}`);
      const checks = pr.statusCheckRollup || [];
      return {
        state: pr.state,
        url: pr.url,
        mergeSha: pr.mergeCommit?.oid || pr.mergeCommit || null,
        mergedAt: pr.mergedAt || null,
        head: pr.headRefName || null,
        base: pr.baseRefName || null,
        checks,
        requiredChecksSatisfied: checks.length > 0 && failedOrPendingChecks(checks).length === 0,
      };
    },
    async inspectTag(tag) {
      const output = command(
        "git",
        ["ls-remote", "--tags", remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
        `read remote tag ${tag}`,
      );
      const rows = output.split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/));
      const peeled = rows.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
      const direct = rows.find(([, ref]) => ref === `refs/tags/${tag}`);
      return { tag, sha: peeled?.[0] || direct?.[0] || null };
    },
    async inspectRelease(tag) {
      const release = parseJson(command("gh", [
        "release", "view", tag, "--json",
        "tagName,isDraft,publishedAt,url",
      ], `read release ${tag}`), `release ${tag}`);
      return {
        tag: release.tagName,
        published: release.isDraft === false && Boolean(release.publishedAt),
        publishedAt: release.publishedAt || null,
        url: release.url || null,
      };
    },
    async inspectTagCi(tag, sha) {
      const runs = parseJson(command("gh", [
        "run", "list", "--branch", tag, "--commit", sha, "--event", "push", "--limit", "100", "--json",
        "databaseId,status,conclusion,url,workflowName,event,headSha",
      ], `read tag-triggered CI for ${tag}`), `tag-triggered CI for ${tag}`);
      if (!Array.isArray(runs)) {
        throw new ReconciliationError("tag-ci-invalid", `GitHub returned malformed tag-triggered CI for ${tag}`);
      }
      return {
        tag,
        sha,
        checks: runs.map((run) => ({
          id: run.databaseId == null ? null : String(run.databaseId),
          name: run.workflowName || null,
          status: run.status || null,
          conclusion: run.conclusion || null,
          url: run.url || null,
          event: run.event || null,
          headSha: run.headSha || null,
        })),
      };
    },
    async inspectVersionStamp(sha, version) {
      const repositoryPath = repositoryName();
      const tree = parseJson(command(
        "gh",
        ["api", `repos/${repositoryPath}/git/trees/${sha}?recursive=1`],
        `read release tree ${sha}`,
      ), `release tree ${sha}`);
      if (tree.truncated === true || !Array.isArray(tree.tree)) {
        throw new ReconciliationError("version-stamp-unavailable", `provider cannot read the complete release tree at ${sha}`);
      }
      const expectedPaths = ["Version.md", "package.json", "package-lock.json"];
      const entries = expectedPaths
        .map((path) => tree.tree.find((entry) => entry.path === path && entry.type === "blob") || null)
        .filter(Boolean);
      if (!entries.some((entry) => entry.path === "Version.md")) {
        throw new ReconciliationError("version-stamp-incomplete", `Version.md is missing at release ${sha}`);
      }
      const documents = new Map();
      for (const entry of entries) {
        const blob = parseJson(command(
          "gh",
          ["api", `repos/${repositoryPath}/git/blobs/${entry.sha}`],
          `read ${entry.path} at release ${sha}`,
        ), `${entry.path} at release ${sha}`);
        if (blob.encoding !== "base64" || typeof blob.content !== "string") {
          throw new ReconciliationError("version-stamp-unavailable", `provider returned unreadable ${entry.path} at ${sha}`);
        }
        documents.set(entry.path, Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8"));
      }
      assertVersionDocuments(documents, version, sha);
      const files = entries.map((entry) => ({ path: entry.path, blob: entry.sha })).sort((a, b) => a.path.localeCompare(b.path));
      return {
        sha,
        version,
        files,
        digest: createHash("sha256").update(JSON.stringify({ version, files })).digest("hex"),
        verified: true,
      };
    },
    async isAncestor(ancestor, descendant) {
      const compare = parseJson(command(
        "gh",
        ["api", `repos/${repositoryName()}/compare/${ancestor}...${descendant}`],
        `verify ancestry ${ancestor}..${descendant}`,
      ), "GitHub comparison");
      return ["ahead", "identical"].includes(String(compare.status).toLowerCase());
    },
  };
}

export function parseReconcileArgs(args = []) {
  const flags = { runId: null, provider: "github", json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") flags.json = true;
    else if (arg === "--provider") {
      const value = args[++index];
      if (!value) throw new Error("--provider requires a value");
      flags.provider = value;
    } else if (arg.startsWith("-")) throw new Error(`unknown reconcile flag: ${arg}`);
    else if (flags.runId) throw new Error(`unexpected reconcile argument: ${arg}`);
    else flags.runId = arg;
  }
  if (!flags.runId) throw new Error("reconcile requires <runId>");
  if (flags.provider !== "github") {
    throw new Error(`unsupported reconcile provider: ${flags.provider}; current adapter: github`);
  }
  return flags;
}

export function formatReconciliation(status) {
  const targets = status.reconciliation?.targets || [];
  return [
    `reconciled: ${status.runId}`,
    `state: ${status.state}`,
    `provider: ${status.reconciliation?.provider || "unknown"}`,
    `targets: ${targets.length}`,
    ...targets.map((target) => `target ${target.id}: ${target.pr} @ ${target.mergeSha}`),
    ...(status.reconciliation?.release
      ? [`release: ${status.reconciliation.release.tag} @ ${status.reconciliation.release.sha}`]
      : []),
  ].join("\n");
}

function assertMergedPullRequest(target, pr, baseBranch) {
  if (!pr || String(pr.state).toUpperCase() !== "MERGED") {
    throw new ReconciliationError("pr-not-merged", `delivery target ${target.id} pull request is not merged`);
  }
  if (target.branch && target.branch !== pr.head) {
    throw new ReconciliationError("pr-head-drift", `delivery target ${target.id} expected head ${target.branch}, provider reports ${pr.head}`);
  }
  if (baseBranch !== pr.base) {
    throw new ReconciliationError("pr-base-drift", `delivery target ${target.id} expected base ${baseBranch}, provider reports ${pr.base}`);
  }
}

function deliveryBaseIdentity(status, target, shipMatches) {
  const legacyBase = String(target.base || "").trim();
  const baseCommit = target.baseCommit || (SHA.test(legacyBase) ? normalizeSha(legacyBase, `delivery target ${target.id} base commit`) : null)
    || status.baseCommit || null;
  const branchCandidate = target.baseBranch
    || (!SHA.test(legacyBase) ? legacyBase : null)
    || (shipMatches ? status.ship?.base : null)
    || (!SHA.test(String(status.baseRef || "")) ? status.baseRef : null);
  const baseBranch = normalizeBranch(branchCandidate, status.ship?.remote || "origin");
  if (!baseBranch) {
    throw new ReconciliationError("pr-base-unrecorded", `delivery target ${target.id} has no recorded base branch identity`);
  }
  return {
    baseBranch,
    baseCommit: baseCommit ? normalizeSha(baseCommit, `delivery target ${target.id} base commit`) : null,
  };
}

function normalizeBranch(value, remote) {
  let branch = String(value || "").trim();
  if (!branch || SHA.test(branch) || branch === "HEAD" || branch === "@") return null;
  if (branch.startsWith("refs/heads/")) branch = branch.slice("refs/heads/".length);
  if (branch.startsWith(`${remote}/`)) branch = branch.slice(remote.length + 1);
  return branch || null;
}

function normalizeReleaseMode(value) {
  const mode = value || "tag-only";
  if (!["tag-only", "published-release"].includes(mode)) {
    throw new ReconciliationError("release-mode-invalid", `unsupported release completion mode: ${mode}`);
  }
  return mode;
}

function verifyTagCi(evidence, tag, sha) {
  if (!evidence || evidence.tag !== tag || normalizeSha(evidence.sha, `tag CI ${tag} SHA`) !== sha) {
    throw new ReconciliationError("tag-ci-drift", `tag-triggered CI evidence does not match ${tag} at ${sha}`);
  }
  if (!Array.isArray(evidence.checks) || evidence.checks.length === 0) {
    throw new ReconciliationError("tag-ci-missing", `tag ${tag} has no tag-triggered CI evidence`);
  }
  const checks = evidence.checks.map((check) => ({
    id: check.id == null ? null : String(check.id),
    name: check.name || "unnamed check",
    status: check.status || null,
    conclusion: check.conclusion || null,
    url: check.url || null,
    event: check.event || null,
    headSha: normalizeSha(check.headSha, `tag CI ${check.name || "check"} SHA`),
  }));
  if (checks.some((check) => check.headSha !== sha || String(check.event || "").toLowerCase() !== "push")) {
    throw new ReconciliationError("tag-ci-drift", `tag-triggered CI evidence does not belong to ${tag} at ${sha}`);
  }
  const incomplete = checks.filter((check) => String(check.status || "").toLowerCase() !== "completed"
    || !SUCCESS_CONCLUSIONS.has(String(check.conclusion || "").toLowerCase()));
  if (incomplete.length) {
    throw new ReconciliationError(
      "tag-ci-unverified",
      `tag ${tag} CI is not successful: ${incomplete.map((check) => check.name).join(", ")}`,
    );
  }
  return { tag, sha, state: "green", checks };
}

function verifyVersionStampEvidence(evidence, version, sha) {
  if (!evidence || evidence.verified !== true || normalizeSha(evidence.sha, "version stamp SHA") !== sha) {
    throw new ReconciliationError("version-stamp-unverified", `provider did not verify the complete version stamp at ${sha}`);
  }
  if (evidence.version !== version || !Array.isArray(evidence.files) || !evidence.files.length || !evidence.digest) {
    throw new ReconciliationError("version-stamp-incomplete", `version stamp evidence at ${sha} is incomplete or mismatched`);
  }
  if (!evidence.files.some((entry) => entry.path === "Version.md" && entry.blob)) {
    throw new ReconciliationError("version-stamp-incomplete", `Version.md evidence is missing at ${sha}`);
  }
  return structuredClone(evidence);
}

function assertVersionDocuments(documents, version, sha) {
  const versionDocument = documents.get("Version.md") || "";
  const current = versionDocument.match(/^current:\s*(\S+)\s*$/m)?.[1];
  if (current !== version || !new RegExp(`^## ${escapeRegex(version)}(?:\\s|$)`, "m").test(versionDocument)) {
    throw new ReconciliationError("version-stamp-incomplete", `Version.md at ${sha} does not contain the complete ${version} stamp`);
  }
  for (const name of ["package.json", "package-lock.json"]) {
    if (!documents.has(name)) continue;
    let parsed;
    try {
      parsed = JSON.parse(documents.get(name));
    } catch (error) {
      throw new ReconciliationError("version-stamp-incomplete", `${name} at ${sha} is invalid JSON: ${error.message}`);
    }
    if (parsed.version !== version || (name === "package-lock.json" && parsed.packages?.[""]?.version !== version)) {
      throw new ReconciliationError("version-stamp-incomplete", `${name} at ${sha} does not contain version ${version}`);
    }
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function failedOrPendingChecks(checks = []) {
  return checks.filter((check) => {
    const status = String(check.status || "").toLowerCase();
    const conclusion = String(check.conclusion || "").toLowerCase();
    if (["queued", "in_progress", "waiting", "pending", "requested"].includes(status)) return true;
    return conclusion && !SUCCESS_CONCLUSIONS.has(conclusion);
  }).map((check) => check.name || check.context || "unnamed check");
}

function checkEvidence(check) {
  return {
    name: check.name || check.context || "unnamed check",
    status: check.status || null,
    conclusion: check.conclusion || null,
  };
}

function normalizeSha(value, label) {
  const sha = String(value || "").trim();
  if (!SHA.test(sha)) throw new ReconciliationError("sha-invalid", `${label} is missing or invalid`);
  return sha.toLowerCase();
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ReconciliationError("provider-json-invalid", `${label} returned invalid JSON: ${error.message}`);
  }
}

function execute(command, args, { cwd } = {}) {
  const override = command === "gh" ? process.env.AGENT_MANAGER_GH_BIN : null;
  const { result } = spawnCommandSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: process.env,
    override,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.error?.message || result.stderr || "").trim(),
  };
}

function isoNow(now) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
