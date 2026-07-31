import { spawnSync } from "node:child_process";
import { CLAIM_BIN } from "./paths.mjs";

function runClaim(args) {
  const r = spawnSync(process.execPath, [CLAIM_BIN, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: r.status === 0,
    status: r.status ?? 1,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

export function claimLane({
  repo,
  branch,
  lane,
  scope,
  agent,
  group = null,
  ttlHours = null,
  mode = "auto",
}) {
  if (mode === "off") return { ok: true, skipped: true };
  const scopeStr = Array.isArray(scope) ? scope.join(",") : String(scope);
  const args = [
    "claim",
    "--repo", repo,
    "--branch", branch,
    "--lane", lane,
    "--scope", scopeStr,
    "--agent", agent || `agt-agent-manager-${lane}`,
  ];
  if (group) args.push("--group", group);
  if (ttlHours) args.push("--ttl", String(ttlHours));
  args.push("--owner-pid", String(process.pid));
  const r = runClaim(args);
  if (!r.ok) {
    const msg = (r.stderr || r.stdout || "claim failed").trim();
    const err = new Error(msg);
    err.code = r.status;
    if (mode === "required") throw err;
    return { ok: false, advisory: true, error: msg };
  }
  return { ok: true, output: r.stdout.trim() };
}

export function claimLanes({ repo, group, lanes, mode = "auto" }) {
  if (mode === "off") {
    return lanes.map((lane) => ({ laneId: lane.lane, ok: true, skipped: true }));
  }
  const admitted = [];
  const results = [];
  try {
    for (const lane of lanes) {
      const result = claimLane({ repo, group, mode, ...lane });
      results.push({ laneId: lane.lane, ...result });
      if (result.ok && !result.skipped) admitted.push(lane.branch);
    }
    return results;
  } catch (error) {
    for (const branch of admitted.reverse()) {
      releaseLane({ repo, branch, mode: "auto" });
    }
    error.message = `required claim admission failed; no lane was started: ${error.message}`;
    throw error;
  }
}

export function releaseLane({ repo, branch, mode = "auto" }) {
  if (mode === "off") return { ok: true, skipped: true };
  return runClaim(["release", "--repo", repo, "--branch", branch]);
}

export function renewLane({ repo, branch, mode = "auto" }) {
  if (mode === "off") return { ok: true, skipped: true };
  return runClaim(["renew", "--repo", repo, "--branch", branch]);
}
