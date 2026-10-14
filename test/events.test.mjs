import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isolatedRoot, useIsolatedRoots } from "../test-support/isolated-roots.mjs";

const root = isolatedRoot("events-");
useIsolatedRoots(root);
test.after(() => rmSync(root, { recursive: true, force: true }));

const { emitEvent, makeEvent, readEvents, transitionEvents } = await import("../src/events.mjs?events");
const { writeStatus } = await import("../src/status.mjs?events");
const runsRoot = join(root, "runs");

test("events have a stable, versioned shape and reject unknown kinds", () => {
  const event = makeEvent("pr_opened", { repo: "app", runId: "run-1", pr: "12", tier: "1", text: "https://example.invalid/pr/12", ts: "2026-10-13T00:00:00.000Z" });
  assert.deepEqual(event, {
    v: 1, ts: "2026-10-13T00:00:00.000Z", kind: "pr_opened", repo: "app", runId: "run-1",
    pr: 12, tier: 1, text: "https://example.invalid/pr/12", actor: "agent-manager",
  });
  assert.throws(() => makeEvent("shipped", { repo: "app" }), /unknown event kind/);
  assert.throws(() => makeEvent("merged", {}), /repo is required/);
});

test("emit writes the global and per-run logs and feeds each sink the same line", async () => {
  const sinkOut = join(root, "sink.jsonl");
  const sink = `"${process.execPath}" -e "process.stdin.pipe(require('fs').createWriteStream(process.argv[1], {flags:'a'}))" "${sinkOut}"`;
  const failing = `"${process.execPath}" -e "process.exit(3)"`;
  const event = makeEvent("merged", { repo: "app", runId: "run-emit", sha: "abc", actor: "tester" });
  const results = await emitEvent(event, { sinks: [sink, failing] });
  assert.deepEqual(results, [true, false], "a failing sink is reported, never thrown");
  const line = JSON.stringify(event);
  assert.equal(readFileSync(join(runsRoot, "events.jsonl"), "utf8").trim().split("\n").at(-1), line);
  assert.deepEqual(readEvents({ runId: "run-emit" }), [event]);
  assert.equal(readFileSync(sinkOut, "utf8").trim(), line);
});

test("status transitions become events: lanes, questions, verdicts, PRs, merges, close", () => {
  const lane = { id: "api", harness: "claude", branch: "am/r/api", scope: "src/**", attempt: 1 };
  const base = { runId: "run-t", repo: "app", lanes: [{ ...lane, state: "queued" }], delivery: { review: {}, targets: [] } };
  const kinds = (prev, next) => transitionEvents(prev, next).map((event) => event.kind);

  const running = { ...base, state: "running", lanes: [{ ...lane, state: "running" }] };
  assert.deepEqual(kinds(base, running), ["lane_started"]);
  const blocked = { ...running, state: "blocked", lanes: [{ ...lane, state: "blocked", needsInput: { prompt: "Which table?" } }] };
  const [question] = transitionEvents(running, blocked);
  assert.equal(question.kind, "waiting_operator");
  assert.equal(question.text, "Which table?");
  assert.equal(question.lane, "api");

  const done = { ...running, state: "review_pending", lanes: [{ ...lane, state: "done", lastActivity: "ok" }] };
  assert.deepEqual(kinds(running, done), ["lane_done"]);
  const target = { id: "integrate", laneId: "integrate", tier: 1 };
  const reviewed = {
    ...done, state: "ship_pending",
    delivery: { review: { verdict: "accept", reviewer: "rev-1", decidedAt: "t1" }, targets: [target] },
  };
  const [verdict] = transitionEvents(done, reviewed);
  assert.equal(verdict.kind, "review_verdict");
  assert.equal(verdict.actor, "rev-1");
  const shipping = { ...reviewed, state: "shipping", delivery: { ...reviewed.delivery, targets: [{ ...target, pr: "7", prUrl: "u", autoMerge: true }] } };
  assert.deepEqual(kinds(reviewed, shipping), ["pr_opened", "automerge_armed"]);
  const merged = { ...shipping, state: "merged", delivery: { ...shipping.delivery, targets: [{ ...shipping.delivery.targets[0], mergeSha: "f00" }] } };
  assert.deepEqual(kinds(shipping, merged), ["merged", "run_closed"]);
  assert.deepEqual(kinds(merged, merged), [], "no change, no event");
});

test("writeStatus emits transition events without failing the write", async () => {
  const lane = { id: "docs", harness: "fake", branch: "b", scope: "docs/**", state: "running", attempt: 1 };
  writeStatus("run-write", { runId: "run-write", repo: "app", state: "running", lanes: [lane] });
  writeStatus("run-write", { runId: "run-write", repo: "app", state: "cancelled", lanes: [{ ...lane, state: "cancelled" }] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(join(runsRoot, "run-write", "events.jsonl")));
  assert.deepEqual(readEvents({ runId: "run-write" }).map((event) => event.kind),
    ["lane_started", "lane_done", "cancelled", "run_closed"]);
});
