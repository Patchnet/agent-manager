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
    assertMergedPullRequest(target, pr);
    const mergeSha = normalizeSha(pr.mergeSha, `pull request ${prRef} merge SHA`);
    if (target.mergeSha && target.mergeSha !== mergeSha) {
      throw new ReconciliationError(
        "merge-drift",
        `delivery target ${target.id} recorded merge ${target.mergeSha}, but provider reports ${mergeSha}`,
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
    const tag = candidate.ship?.tag || candidate.ship?.plannedTag || candidate.delivery.release?.tag;
    if (!tag) throw new ReconciliationError("tag-missing", "release reconciliation requires the recorded planned tag");
    if (candidate.ship?.version && tag !== `v${candidate.ship.version}`) {
      throw new ReconciliationError("version-drift", `recorded version ${candidate.ship.version} does not match tag ${tag}`);
    }
    const [remoteTag, release] = await Promise.all([
      provider.inspectTag(tag),
      provider.inspectRelease(tag),
    ]);
    if (!remoteTag?.sha) throw new ReconciliationError("tag-unverified", `provider cannot verify remote tag ${tag}`);
    const releaseSha = normalizeSha(remoteTag.sha, `tag ${tag} SHA`);
    if (!release?.published || release.tag !== tag) {
      throw new ReconciliationError("release-unverified", `provider cannot verify a published release for ${tag}`);
    }
    if (release.sha && normalizeSha(release.sha, `release ${tag} SHA`) !== releaseSha) {
      throw new ReconciliationError("release-tag-drift", `release ${tag} does not resolve to remote tag ${releaseSha}`);
    }
    const recordedReleaseSha = candidate.ship?.releaseSha || candidate.delivery.release?.sha || null;
    if (recordedReleaseSha && recordedReleaseSha !== releaseSha) {
      throw new ReconciliationError(
        "release-sha-drift",
        `recorded release SHA ${recordedReleaseSha} does not match remote tag ${releaseSha}`,
      );
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
      at: isoNow(now),
    });
    releaseEvidence = {
      tag,
      sha: releaseSha,
      publishedAt: release.publishedAt || null,
      url: release.url || null,
      verifiedMergeShas: merges,
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
        requiredChecksSatisfied: failedOrPendingChecks(checks).length === 0,
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

function assertMergedPullRequest(target, pr) {
  if (!pr || String(pr.state).toUpperCase() !== "MERGED") {
    throw new ReconciliationError("pr-not-merged", `delivery target ${target.id} pull request is not merged`);
  }
  if (target.branch && pr.head && target.branch !== pr.head) {
    throw new ReconciliationError("pr-head-drift", `delivery target ${target.id} expected head ${target.branch}, provider reports ${pr.head}`);
  }
  if (target.base && pr.base && target.base !== pr.base) {
    throw new ReconciliationError("pr-base-drift", `delivery target ${target.id} expected base ${target.base}, provider reports ${pr.base}`);
  }
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
