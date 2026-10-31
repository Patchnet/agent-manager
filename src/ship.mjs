import { spawnCommandSync } from "./command.mjs";
import { assertAccepted, settleTargets } from "./delivery.mjs";
import { writeReport } from "./report.mjs";
import { readStatus, writeStatus } from "./status.mjs";
import { TIERS_FILE, classifyPaths, requireTiers } from "../tools/ship-tier.mjs";

// One command, no background phase. A repository with the pipeline gate gets one
// commit pushed through that gate. Any other repository is classified by path and
// opened (or fast-forwarded) with auto-merge. No gate and no usable policy stops
// for the operator.

export const GATE_FILES = ["pipeline.json", "scripts/quality.mjs"];

function run(command, args, cwd, { allowFail = false } = {}) {
  // AGENT_MANAGER_GH_BIN points `gh` at a stand-in (a .mjs runs under node); tests use it.
  const override = command === "gh" ? process.env.AGENT_MANAGER_GH_BIN || null : null;
  const { result } = spawnCommandSync(command, args, { cwd, encoding: "utf8", override });
  const out = { ok: result.status === 0, stdout: (result.stdout || "").trim(), stderr: (result.stderr || result.error?.message || "").trim() };
  if (!out.ok && !allowFail) throw new Error(`${command} ${args.join(" ")} failed: ${out.stderr || out.stdout}`);
  return out;
}
const git = (cwd, args, options) => run("git", args, cwd, options);
const gh = (cwd, args, options) => run("gh", args, cwd, options);

/** The gate on the base branch counts, so a change cannot add one to skip the stop. */
export function hasGate(cwd, baseRef) {
  return GATE_FILES.every((file) => git(cwd, ["cat-file", "-e", `${baseRef}:${file}`], { allowFail: true }).ok);
}

// Runs in the worktree even when a pre-push hook would, since a clone may not have the hook.
function runGate(cwd, baseRef) {
  const gate = run(process.execPath, ["scripts/quality.mjs", "--range", `${baseRef}..HEAD`], cwd, { allowFail: true });
  if (!gate.ok) throw new Error(`gate failed in ${cwd}, nothing pushed: fix it and rerun ship
${(gate.stdout || gate.stderr).slice(-2000)}`);
}

export function tierForChange(cwd, baseRef) {
  // Policy comes from the base branch, so a change cannot lower its own tier.
  const file = git(cwd, ["show", `${baseRef}:${TIERS_FILE}`], { allowFail: true });
  const diff = git(cwd, ["diff", "--name-status", "-M", `${baseRef}...HEAD`]).stdout;
  const paths = diff.split(/\r?\n/).filter(Boolean).flatMap((line) => line.split("\t").slice(1));
  try {
    return { ...classifyPaths(paths, requireTiers(file.ok ? file.stdout : null)), tiersFile: TIERS_FILE, policyProblem: null };
  } catch (error) {
    return { tier: null, files: [], tiersFile: null, policyProblem: error.message };
  }
}

export function shipRun(runId, { targetId = null, message = null, approvedBy = null, remote = null } = {}) {
  const status = readStatus(runId);
  if (!status) throw new Error(`no status for ${runId}`);
  assertAccepted(status);
  const targets = (status.delivery?.targets || []).filter((target) =>
    target.state !== "no_changes" && !target.mergeSha && (!targetId || target.id === targetId));
  if (!targets.length) throw new Error(targetId ? `no unmerged target ${targetId}` : "nothing left to ship");
  const declaredFlow = status.target_dev_flow === "formal" ? "formal" : "simple";
  const lines = [];
  for (const target of targets) {
    const cwd = target.worktree;
    const origin = remote || status.integrate?.remote || "origin";
    git(cwd, ["fetch", origin]);
    target.base ||= defaultBranch(cwd, origin);
    const baseRef = `${origin}/${target.base}`;
    const dirty = git(cwd, ["status", "--porcelain"]).stdout;
    if (dirty) {
      git(cwd, ["add", "-A"]);
      git(cwd, ["commit", "-m", message || subject(status)]);
    }
    target.gated = hasGate(cwd, baseRef);
    const tier = target.gated ? { tier: null, policyProblem: null } : tierForChange(cwd, baseRef);
    target.tier = tier.tier;
    target.policyProblem = tier.policyProblem;
    const approved = !tier.policyProblem || Boolean(approvedBy);
    if (approvedBy && tier.policyProblem) target.approvedBy = approvedBy;
    // A gated repository pushes to its base whatever flow it declares. A PR already open stays a PR.
    const flow = target.gated && !target.pr ? "simple" : declaredFlow;
    if (flow === "simple") shipSimple({ status, target, cwd, origin, baseRef, approved, message });
    else shipFormal({ status, target, cwd, origin, approved, message });
    lines.push(notice(runId, target));
  }
  settleTargets(status);
  const saved = writeStatus(runId, status);
  writeReport(runId, saved);
  return { status: saved, lines };
}

function shipSimple({ status, target, cwd, origin, baseRef, approved, message }) {
  if (!approved) {
    target.waitingOperator = waitingText(status, target, "push to " + target.base);
    return;
  }
  if (!message) throw new Error("Simple Flow ships one commit to the base branch: pass --message \"<type>: <summary>\"");
  // One commit on top of the latest base; lane snapshot commits never reach main.
  const start = git(cwd, ["merge-base", baseRef, "HEAD"]).stdout;
  git(cwd, ["reset", "--soft", start]);
  git(cwd, ["commit", "-m", message]);
  const rebased = git(cwd, ["rebase", baseRef], { allowFail: true });
  if (!rebased.ok) {
    git(cwd, ["rebase", "--abort"], { allowFail: true });
    target.waitingOperator = null;
    throw new Error(`conflict with ${baseRef}: resolve it in ${cwd} (merge or rebase, rerun tests), then rerun ship`);
  }
  if (target.gated) runGate(cwd, baseRef);
  git(cwd, ["push", origin, `HEAD:${target.base}`]);
  target.mergeSha = git(cwd, ["rev-parse", "HEAD"]).stdout;
  target.mergedAt = new Date().toISOString();
  target.waitingOperator = null;
  target.state = "merged";
}

function shipFormal({ status, target, cwd, origin, approved, message }) {
  // Only overwrite the remote branch if it still holds what this tool pushed last.
  const lease = target.pushedSha ? [`--force-with-lease=refs/heads/${target.branch}:${target.pushedSha}`] : [];
  git(cwd, ["push", ...lease, "-u", origin, `HEAD:refs/heads/${target.branch}`]);
  target.pushedSha = git(cwd, ["rev-parse", "HEAD"]).stdout;
  let pr = findPr(cwd, target);
  if (!pr) {
    const title = message || subject(status);
    const body = [
      status.goal ? `Goal: ${status.goal}` : null,
      `Agent Manager run \`${status.runId}\` · ${route(target)} · review ${status.delivery.review.verdict} by ${status.delivery.review.reviewer}`,
      status.delivery.review.notes ? `Review notes: ${status.delivery.review.notes}` : null,
    ].filter(Boolean).join("\n\n");
    gh(cwd, ["pr", "create", "--base", target.base, "--head", target.branch, "--title", title, "--body", body]);
    pr = findPr(cwd, target);
    if (!pr) throw new Error(`pull request for ${target.branch} was created but cannot be found`);
  }
  target.pr = String(pr.number);
  target.prUrl = pr.url;
  target.state = "pr_open";
  if (target.tier !== null) {
    const label = `tier:${target.tier}`;
    gh(cwd, ["label", "create", label, "--force", "--color", ["0e8a16", "fbca04", "d93f0b"][target.tier]], { allowFail: true });
    gh(cwd, ["pr", "edit", target.pr, "--add-label", label], { allowFail: true });
  }
  if (!approved) {
    // The base can lose its policy after auto-merge was armed: disarm it.
    if (target.autoMerge) {
      gh(cwd, ["pr", "merge", target.pr, "--disable-auto"]);
      target.autoMerge = false;
    }
    target.waitingOperator = waitingText(status, target, `arm auto-merge on PR #${target.pr}`);
    return;
  }
  gh(cwd, ["pr", "merge", target.pr, "--auto", "--squash"]);
  target.autoMerge = true;
  target.waitingOperator = null;
}

/** Record merges that GitHub completed since the last look. Returns true when anything changed. */
export function refreshMerges(status) {
  let changed = false;
  for (const target of status.delivery?.targets || []) {
    if (!target.pr || target.mergeSha || !target.worktree) continue;
    const view = gh(target.worktree, ["pr", "view", target.pr, "--json", "state,mergeCommit,mergedAt"], { allowFail: true });
    if (!view.ok) continue;
    const pr = JSON.parse(view.stdout);
    if (pr.state === "MERGED" && pr.mergeCommit?.oid) {
      Object.assign(target, { mergeSha: pr.mergeCommit.oid, mergedAt: pr.mergedAt, state: "merged" });
      changed = true;
    } else if (pr.state === "CLOSED" && target.state !== "closed") {
      target.state = "closed";
      changed = true;
    }
  }
  if (changed) settleTargets(status);
  return changed;
}

function findPr(cwd, target) {
  const list = gh(cwd, ["pr", "list", "--head", target.branch, "--state", "all", "--json", "number,url,state"]).stdout;
  return JSON.parse(list || "[]").find((pr) => pr.state !== "CLOSED") || null;
}

function defaultBranch(cwd, origin) {
  const head = git(cwd, ["symbolic-ref", "--short", `refs/remotes/${origin}/HEAD`], { allowFail: true });
  return head.ok ? head.stdout.slice(origin.length + 1) : "main";
}

function subject(status) {
  return status.identity?.subject || status.goal || `agent-manager run ${status.runId}`;
}

function route(target) {
  if (target.gated) return "gate";
  return target.tier === null ? "no usable policy" : `tier ${target.tier}`;
}

function waitingText(status, target, action) {
  return `Ship policy: ${target.policyProblem}: approve with \`agent-manager ship ${status.runId} --target ${target.id} --approved-by <you>\` to ${action}`;
}

export function notice(runId, target) {
  if (target.waitingOperator) return `Ship Gate · ${runId} · ${target.id} · waiting: ${target.waitingOperator}`;
  if (target.mergeSha) return `Ship · ${runId} · ${target.id} · ${route(target)} · merged ${target.mergeSha.slice(0, 12)}`;
  return `Ship · ${runId} · ${target.id} · ${route(target)} · PR ${target.prUrl} · auto-merge armed`;
}
