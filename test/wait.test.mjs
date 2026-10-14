import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { isolatedRoot, useIsolatedRoots } from "../test-support/isolated-roots.mjs";

const root = isolatedRoot("wait-");
useIsolatedRoots(root);
test.after(() => rmSync(root, { recursive: true, force: true }));

const { waitForEvent } = await import("../src/wait.mjs?wait");
const { emitEvent, makeEvent } = await import("../src/events.mjs?wait");
const { writeStatus } = await import("../src/status.mjs?wait");

test("wait returns the next event for the run and ignores older ones", async () => {
  writeStatus("run-w", { runId: "run-w", repo: "app", state: "running", lanes: [] });
  await emitEvent(makeEvent("blocked", { repo: "app", runId: "run-w", text: "old" }), { sinks: [] });
  const pending = waitForEvent("run-w", { pollMs: 20, timeoutSec: 5 });
  setTimeout(() => emitEvent(makeEvent("waiting_operator", { repo: "app", runId: "run-w", text: "Pick one" }), { sinks: [] }), 60);
  const event = await pending;
  assert.equal(event.kind, "waiting_operator");
  assert.equal(event.text, "Pick one");
});

test("wait with no run returns the next event from any run, filtered by kind", async () => {
  const pending = waitForEvent(null, { pollMs: 20, timeoutSec: 5, kinds: ["merged"] });
  setTimeout(async () => {
    await emitEvent(makeEvent("pr_opened", { repo: "other", pr: 3 }), { sinks: [] });
    await emitEvent(makeEvent("merged", { repo: "other", pr: 3, sha: "abc" }), { sinks: [] });
  }, 60);
  const event = await pending;
  assert.equal(event.kind, "merged");
  assert.equal(event.repo, "other");
});

test("wait returns at once for a closed run and times out otherwise", async () => {
  writeStatus("run-closed", { runId: "run-closed", repo: "app", state: "merged", lanes: [] });
  assert.equal((await waitForEvent("run-closed", { pollMs: 20 })).alreadyClosed, true);
  writeStatus("run-quiet", { runId: "run-quiet", repo: "app", state: "running", lanes: [] });
  assert.equal((await waitForEvent("run-quiet", { pollMs: 20, timeoutSec: 0.1 })).kind, "timeout");
});
