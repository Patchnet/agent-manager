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

export function claimLane({ repo, branch, lane, scope, agent }) {
  const scopeStr = Array.isArray(scope) ? scope.join(",") : String(scope);
  const r = runClaim([
    "claim",
    "--repo", repo,
    "--branch", branch,
    "--lane", lane,
    "--scope", scopeStr,
    "--agent", agent || `agt-agent-manager-${lane}`,
  ]);
  if (!r.ok) {
    const msg = (r.stderr || r.stdout || "claim failed").trim();
    const err = new Error(msg);
    err.code = r.status;
    throw err;
  }
  return r.stdout.trim();
}

export function releaseLane({ repo, branch }) {
  return runClaim(["release", "--repo", repo, "--branch", branch]);
}
