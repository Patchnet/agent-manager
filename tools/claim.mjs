#!/usr/bin/env node
// Checkout claims coordinate agents across scopes.
//
//   node tools/claim.mjs claim   --repo <name> --branch <b> [--lane <l>] [--scope "a/**,b/**"] [--agent <id>] [--group <run>] [--ttl <hours>] [--force]
//   node tools/claim.mjs renew   --repo <name> --branch <b>
//   node tools/claim.mjs release --repo <name> --branch <b>
//   node tools/claim.mjs list    [--repo <name>] [--all]
//
// Registry root: AGENT_MANAGER_CLAIMS_ROOT, else ~/.agent-manager/claims
// Exit: 0 ok; 2 scope overlap; 1 usage/error

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import { CLAIMS_ROOT } from "../src/paths.mjs";

const ROOT = CLAIMS_ROOT;
const DEFAULT_TTL_HOURS = 24;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = {};
for (let i = 1; i < args.length; i += 1) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
    opt[key] = value;
  }
}

const slug = (value) => {
  const result = String(value).replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (!result || result === "." || result === "..") {
    throw new Error("claim identifier is not safe");
  }
  return result.slice(0, 160);
};
const now = () => new Date().toISOString();
const isStale = (claim) => {
  const ttl = (claim.ttl_hours ?? DEFAULT_TTL_HOURS) * 3_600_000;
  return Date.now() - Date.parse(claim.renewed_at || claim.claimed_at) > ttl;
};
const localHost = hostname();
const owningProcessIsActive = (claim) => {
  if (claim.owner_host !== localHost || !Number.isInteger(Number(claim.owner_pid)) || Number(claim.owner_pid) <= 0) {
    return null;
  }
  try {
    process.kill(Number(claim.owner_pid), 0);
    return true;
  } catch (error) {
    return error?.code === "ESRCH" ? false : true;
  }
};
const canRecover = (claim) =>
  isStale(claim) && owningProcessIsActive(claim) === false;
const prefix = (glob) =>
  String(glob).replace(/\\/g, "/").split(/[*?\[]/)[0].replace(/\/+$/, "");
const overlaps = (left, right) => {
  const a = prefix(left);
  const b = prefix(right);
  if (!a || !b) return true;
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
};

function loadClaims(repo) {
  const dir = join(ROOT, slug(repo));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      file: join(dir, file),
      ...JSON.parse(readFileSync(join(dir, file), "utf8")),
    }));
}

function withRepoLock(repo, operation) {
  const dir = join(ROOT, slug(repo));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, ".claim-lock");
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      try {
        return operation();
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      Atomics.wait(waiter, 0, 0, 25);
    }
  }
  throw new Error(`timed out acquiring claim registry lock for ${repo}`);
}

function fmt(claim) {
  const age = ((Date.now() - Date.parse(claim.renewed_at || claim.claimed_at)) / 3_600_000)
    .toFixed(1);
  const state = canRecover(claim)
    ? "RECOVERABLE"
    : isStale(claim)
      ? owningProcessIsActive(claim) === null ? "STALE-UNKNOWN" : "STALE-ACTIVE"
      : "live";
  return `  [${state}] ${claim.repo} - ${claim.branch} - lane=${claim.lane ?? "-"} - agent=${claim.agent} - ${age}h old\n         scope: ${(claim.scope ?? []).join(", ") || "(whole repo)"}`;
}

if (cmd === "check") {
  if (!opt.repo) throw new Error("check requires --repo");
  const scope = opt.scope ? String(opt.scope).split(",").map((s) => s.trim()).filter(Boolean) : [""];
  const claims = loadClaims(opt.repo).filter((claim) => claim.branch !== opt.branch && (!opt.group || claim.group !== opt.group))
    .filter((claim) => scope.some((mine) => (claim.scope?.length ? claim.scope : [""]).some((other) => overlaps(mine, other))))
    .map((claim) => ({ branch: claim.branch, lane: claim.lane, scope: claim.scope,
      stale: isStale(claim), ownerActive: owningProcessIsActive(claim), recoverable: canRecover(claim) }));
  const blocked = claims.some((claim) => !claim.recoverable);
  console.log(JSON.stringify({ schema: "agent-manager.claim-preflight.v1", blocked, claims,
    nextAction: blocked ? "Verify the owner or coordinate scope; retrying unchanged will still conflict. Unknown or live ownership is never evicted by age." : "Admission may proceed; claim acquisition rechecks under lock." }));
  process.exit(blocked ? 2 : 0);
}

if (cmd === "claim") {
  if (!opt.repo || !opt.branch) {
    console.error("claim requires --repo and --branch");
    process.exit(1);
  }
  const scope = opt.scope
    ? String(opt.scope).split(",").map((item) => item.trim()).filter(Boolean)
    : [];
  const agent =
    opt.agent || process.env.CLAIM_AGENT || `${userInfo().username}@${hostname()}`;
  const result = withRepoLock(opt.repo, () => {
    const existing = loadClaims(opt.repo);
    for (const claim of existing.filter(canRecover)) unlinkSync(claim.file);
    const live = existing.filter((claim) =>
      !canRecover(claim) &&
      claim.branch !== opt.branch &&
      (!opt.group || claim.group !== opt.group)
    );
    const clashes = live.filter((claim) => {
      const other = claim.scope?.length ? claim.scope : [""];
      const mine = scope.length ? scope : [""];
      return mine.some((left) => other.some((right) => overlaps(left, right)));
    });
    if (clashes.length && !opt.force) return { clashes };

    const claimedAt = now();
    const claim = {
      agent,
      repo: opt.repo,
      branch: opt.branch,
      lane: opt.lane ?? null,
      group: opt.group ?? null,
      scope,
      claimed_at: claimedAt,
      renewed_at: claimedAt,
      ttl_hours: Number(opt.ttl ?? DEFAULT_TTL_HOURS),
      owner_pid: Number(opt["owner-pid"] ?? process.pid),
      owner_host: localHost,
      ...(clashes.length ? { override_of: clashes.map((claim) => claim.branch) } : {}),
    };
    const file = join(ROOT, slug(opt.repo), slug(opt.branch) + ".json");
    writeFileSync(file, JSON.stringify(claim, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    return { clashes: [], file };
  });

  if (result.clashes.length) {
    console.error(
      "SCOPE OVERLAP - a live claim already covers part of this scope:\n" +
        result.clashes.map(fmt).join("\n"),
    );
    console.error("\nCoordinate with that agent or narrow --scope before retrying.");
    process.exit(2);
  }
  console.log(`claimed ${opt.repo} ${opt.branch} -> ${result.file}`);
  process.exit(0);
}

if (cmd === "renew" || cmd === "release") {
  if (!opt.repo || !opt.branch) {
    console.error(`${cmd} requires --repo and --branch`);
    process.exit(1);
  }
  const file = join(ROOT, slug(opt.repo), slug(opt.branch) + ".json");
  const result = withRepoLock(opt.repo, () => {
    if (!existsSync(file)) return { found: false };
    if (cmd === "release") {
      unlinkSync(file);
      return { found: true };
    }
    const claim = JSON.parse(readFileSync(file, "utf8"));
    claim.renewed_at = now();
    writeFileSync(file, JSON.stringify(claim, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    return { found: true };
  });
  if (result.found) {
    console.log(`${cmd === "renew" ? "renewed" : "released"} ${opt.repo} ${opt.branch}`);
  } else {
    console.log(`no claim for ${opt.repo} ${opt.branch}`);
  }
  process.exit(0);
}

if (cmd === "list") {
  const repos = opt.repo
    ? [slug(opt.repo)]
    : existsSync(ROOT)
      ? readdirSync(ROOT, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [];
  let any = false;
  for (const repo of repos) {
    const claims = loadClaims(repo).filter((claim) => opt.all || !canRecover(claim));
    if (!claims.length) continue;
    any = true;
    console.log(repo + " (" + ROOT + "/" + repo + ")");
    for (const claim of claims) console.log(fmt(claim));
  }
  if (!any) console.log("(no claims)");
  process.exit(0);
}

console.error(`Usage:
  ${basename(process.argv[1])} claim   --repo <name> --branch <b> [options]
  ${basename(process.argv[1])} renew   --repo <name> --branch <b>
  ${basename(process.argv[1])} release --repo <name> --branch <b>
  ${basename(process.argv[1])} list    [--repo <name>] [--all]`);
process.exit(1);
