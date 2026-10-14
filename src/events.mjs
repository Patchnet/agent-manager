import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "./fs-safe.mjs";
import { EVENT_SINKS, RUNS_ROOT, assertSafeSlug, runDir } from "./paths.mjs";

// Stable contract (docs/EVENTS.md). New optional fields are additive; renaming
// or removing a field bumps EVENT_VERSION.
export const EVENT_VERSION = 1;
export const EVENT_KINDS = new Set([
  "lane_started", "lane_done", "review_verdict", "pr_opened", "automerge_armed",
  "merged", "reverted", "waiting_operator", "operator_reply", "blocked",
  "cancelled", "run_closed",
]);
const FIELDS = ["runId", "lane", "pr", "sha", "tier", "verdict", "text"];
const SINK_TIMEOUT_MS = 5_000;
const CLOSED_STATES = new Set(["merged", "reviewed", "closed", "rejected", "failed", "cancelled"]);
const warnedSinks = new Set();

export function makeEvent(kind, fields = {}) {
  if (!EVENT_KINDS.has(kind)) throw new Error(`unknown event kind: ${kind}`);
  if (typeof fields.repo !== "string" || !fields.repo) throw new Error("event repo is required");
  const event = { v: EVENT_VERSION, ts: fields.ts || new Date().toISOString(), kind, repo: fields.repo };
  for (const key of FIELDS) {
    if (fields[key] !== undefined && fields[key] !== null && fields[key] !== "") event[key] = fields[key];
  }
  if (event.pr !== undefined) event.pr = Number(event.pr);
  if (event.tier !== undefined) event.tier = Number(event.tier);
  event.actor = fields.actor || "agent-manager";
  return event;
}

/**
 * Append the event to the global log and the run's own log, then hand the same
 * line to every sink. Resolves once each sink has exited or timed out; callers
 * that should not wait can ignore the promise. Sinks never fail the caller.
 */
export function emitEvent(event, { sinks = EVENT_SINKS, root = RUNS_ROOT } = {}) {
  const line = JSON.stringify(event) + "\n";
  ensurePrivateDir(root);
  appendFileSync(join(root, "events.jsonl"), line, { encoding: "utf8", mode: 0o600 });
  if (event.runId) {
    const dir = ensurePrivateDir(runDir(event.runId));
    appendFileSync(join(dir, "events.jsonl"), line, { encoding: "utf8", mode: 0o600 });
  }
  return Promise.all((sinks || []).map((command) => runSink(command, line)));
}

function runSink(command, line) {
  return new Promise((resolve) => {
    let child;
    const fail = (reason) => {
      if (!warnedSinks.has(command)) {
        warnedSinks.add(command);
        process.stderr.write(`agent-manager: event sink failed (${reason}): ${command}\n`);
      }
      resolve(false);
    };
    try {
      child = spawn(command, { shell: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    } catch (error) {
      fail(error.message);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      fail("timeout");
    }, SINK_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error.message);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(true);
      else fail(`exit ${code}`);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(line);
  });
}

export function readEvents({ runId = null, root = RUNS_ROOT } = {}) {
  const path = runId ? join(runDir(assertSafeSlug(runId, "run id")), "events.jsonl") : join(root, "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** Events implied by moving a run's status.json from `prev` to `next`. */
export function transitionEvents(prev, next) {
  if (!next) return [];
  const base = { repo: next.repo, runId: next.runId };
  const events = [];
  const add = (kind, fields = {}) => events.push(makeEvent(kind, { ...base, ...fields }));
  for (const lane of next.lanes || []) {
    const before = (prev?.lanes || []).find((item) => item.id === lane.id) || {};
    const attemptChanged = Number(lane.attempt || 1) !== Number(before.attempt || 1);
    if (lane.state === "running" && (before.state !== "running" || attemptChanged)) {
      add("lane_started", { lane: lane.id, text: `${lane.harness} · ${lane.branch} · scope ${lane.scope}` });
    }
    if (["done", "failed", "cancelled"].includes(lane.state) && (before.state !== lane.state || attemptChanged)) {
      add("lane_done", { lane: lane.id, text: `${lane.state}: ${lane.lastActivity || "-"}` });
    }
    const prompt = lane.state === "blocked" ? lane.needsInput?.prompt : null;
    if (prompt && (before.state !== "blocked" || before.needsInput?.prompt !== prompt || attemptChanged)) {
      add("waiting_operator", { lane: lane.id, text: prompt });
    }
  }
  const review = next.delivery?.review;
  if (review?.decidedAt && review.decidedAt !== prev?.delivery?.review?.decidedAt) {
    add("review_verdict", { verdict: review.verdict, text: review.notes, actor: review.reviewer });
  }
  for (const target of next.delivery?.targets || []) {
    const before = (prev?.delivery?.targets || []).find((item) => item.id === target.id) || {};
    const fields = { lane: target.laneId, pr: target.pr, tier: target.tier };
    if (target.prUrl && !before.prUrl) add("pr_opened", { ...fields, text: target.prUrl });
    if (target.autoMerge && !before.autoMerge) add("automerge_armed", fields);
    if (target.mergeSha && !before.mergeSha) add("merged", { ...fields, sha: target.mergeSha });
    if (target.waitingOperator && target.waitingOperator !== before.waitingOperator) {
      add("waiting_operator", { ...fields, text: target.waitingOperator });
    }
  }
  if (next.state !== prev?.state) {
    if (next.state === "blocked" && !events.some((event) => event.kind === "waiting_operator")) {
      add("blocked", { text: next.error || next.integrate?.error || "blocked" });
    }
    if (next.state === "cancelled") add("cancelled");
    if (CLOSED_STATES.has(next.state)) add("run_closed", { text: next.state });
  }
  return events;
}
