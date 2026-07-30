#!/usr/bin/env node
// Advisory checkout claims — coordinate agents across scopes without locks.
//
//   node tools/claim.mjs claim   --repo <name> --branch <b> [--lane <l>] [--scope "a/**,b/**"] [--agent <id>] [--ttl <hours>] [--force]
//   node tools/claim.mjs release --repo <name> --branch <b>
//   node tools/claim.mjs list    [--repo <name>] [--all]
//
// Registry root: AGENT_MANAGER_CLAIMS_ROOT, else ~/.agent-manager/claims
// Exit: 0 ok · 2 scope overlap · 1 usage/error

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, join } from "node:path";

const ROOT =
  process.env.AGENT_MANAGER_CLAIMS_ROOT ||
  join(homedir(), ".agent-manager", "claims");
const DEFAULT_TTL_HOURS = 24;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = {};
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const k = args[i].slice(2);
    const v = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
    opt[k] = v;
  }
}

const slug = (value) => {
  const result = String(value).replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (!result || result === "." || result === "..") throw new Error("claim identifier is not safe");
  return result.slice(0, 160);
};
const now = () => new Date().toISOString();
const isStale = (c) => {
  const ttl = (c.ttl_hours ?? DEFAULT_TTL_HOURS) * 3600 * 1000;
  return Date.now() - Date.parse(c.claimed_at) > ttl;
};
const prefix = (g) => String(g).replace(/\\/g, "/").split(/[*?\[]/)[0].replace(/\/+$/, "");
const overlaps = (a, b) => {
  const pa = prefix(a);
  const pb = prefix(b);
  if (!pa || !pb) return true;
  return pa === pb || pa.startsWith(pb + "/") || pb.startsWith(pa + "/");
};

function loadClaims(repo) {
  const dir = join(ROOT, slug(repo));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: join(dir, f), ...JSON.parse(readFileSync(join(dir, f), "utf8")) }));
}

function fmt(c) {
  const age = ((Date.now() - Date.parse(c.claimed_at)) / 3600000).toFixed(1);
  const state = isStale(c) ? "STALE" : "live";
  return `  [${state}] ${c.repo} · ${c.branch} · lane=${c.lane ?? "-"} · agent=${c.agent} · ${age}h old\n         scope: ${(c.scope ?? []).join(", ") || "(whole repo)"}`;
}

if (cmd === "claim") {
  if (!opt.repo || !opt.branch) {
    console.error("claim requires --repo and --branch");
    process.exit(1);
  }
  const scope = opt.scope
    ? String(opt.scope).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const agent =
    opt.agent || process.env.CLAIM_AGENT || `${userInfo().username}@${hostname()}`;
  const live = loadClaims(opt.repo).filter((c) => !isStale(c) && c.branch !== opt.branch);
  const clashes = live.filter((c) => {
    const other = c.scope?.length ? c.scope : [""];
    const mine = scope.length ? scope : [""];
    return mine.some((m) => other.some((o) => overlaps(m, o)));
  });
  if (clashes.length && !opt.force) {
    console.error(
      "SCOPE OVERLAP — a live claim already covers part of this scope:\n" +
        clashes.map(fmt).join("\n"),
    );
    console.error(
      "\nCoordinate with that agent, narrow --scope, or re-run with --force to record a deliberate override.",
    );
    process.exit(2);
  }
  const claim = {
    agent,
    repo: opt.repo,
    branch: opt.branch,
    lane: opt.lane ?? null,
    scope,
    claimed_at: now(),
    ttl_hours: Number(opt.ttl ?? DEFAULT_TTL_HOURS),
    ...(clashes.length ? { override_of: clashes.map((c) => c.branch) } : {}),
  };
  const dir = join(ROOT, slug(opt.repo));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, slug(opt.branch) + ".json");
  writeFileSync(file, JSON.stringify(claim, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  console.log(`claimed ${opt.repo} ${opt.branch} → ${file}`);
  process.exit(0);
}

if (cmd === "release") {
  if (!opt.repo || !opt.branch) {
    console.error("release requires --repo and --branch");
    process.exit(1);
  }
  const file = join(ROOT, slug(opt.repo), slug(opt.branch) + ".json");
  if (existsSync(file)) {
    unlinkSync(file);
    console.log(`released ${opt.repo} ${opt.branch}`);
  } else {
    console.log(`no claim for ${opt.repo} ${opt.branch}`);
  }
  process.exit(0);
}

if (cmd === "list") {
  const repos = opt.repo
    ? [slug(opt.repo)]
    : existsSync(ROOT)
      ? readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      : [];
  let any = false;
  for (const repo of repos) {
    const claims = loadClaims(repo).filter((c) => opt.all || !isStale(c));
    if (!claims.length) continue;
    any = true;
    console.log(repo + " (" + ROOT + "/" + repo + ")");
    for (const c of claims) console.log(fmt(c));
  }
  if (!any) console.log("(no claims)");
  process.exit(0);
}

console.error(`Usage:
  ${basename(process.argv[1])} claim   --repo <name> --branch <b> [options]
  ${basename(process.argv[1])} release --repo <name> --branch <b>
  ${basename(process.argv[1])} list    [--repo <name>] [--all]`);
process.exit(1);
