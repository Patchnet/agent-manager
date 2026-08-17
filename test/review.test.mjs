import test from "node:test";
import assert from "node:assert/strict";
import { createE2eFixture } from "../test-support/e2e-fixture.mjs";

const {
  writeWorkflow,
  runCli,
  waitForStatus,
  waitForFeed,
  baseWorkflow,
  close,
} = await createE2eFixture();

test.after(async () => {
  await close();
});

async function cliError(args) {
  try {
    await runCli(args);
  } catch (error) {
    return String(error.stderr || error.stdout || error.message);
  }
  throw new Error("expected the CLI to refuse: " + args.join(" "));
}

function review(runId, extra = []) {
  return runCli(["review", runId, ...extra, "--json"]).then((result) =>
    JSON.parse(result.stdout.trim()));
}

test("Delivery Review renders a ratified lane's violations, never as if it were clean", async () => {
  const runId = "run-review-ratified";
  const workflow = writeWorkflow("review-ratified", baseWorkflow([
    {
      id: "writer",
      scope: "allowed.txt",
      prompt: "write the allowed file",
      fake: { write: { path: "allowed.txt", content: "allowed\n" } },
    },
    {
      id: "stray",
      scope: "mine.txt",
      prompt: "write outside the lane scope",
      fake: { write: { path: "stray.txt", content: "out of scope\n" } },
    },
  ]));

  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  await waitForStatus(runId, (status) => status.state === "failed");
  await waitForFeed("run_failed", runId);

  const ratified = JSON.parse((await runCli([
    "ratify", runId, "stray", "--reason", "audited: the file belongs to this lane", "--json",
  ])).stdout.trim());
  assert.equal(ratified.by, "test-manager");
  assert.deepEqual(ratified.violations, ["stray.txt"]);

  const integrated = JSON.parse((await runCli([
    "integrate", runId, "--force-lanes", "done,failed-with-snapshot", "--json",
  ])).stdout.trim());
  assert.deepEqual(integrated.integrate.merged.sort(), ["stray", "writer"]);
  assert.deepEqual(integrated.integrate.ratifiedLanes, ["stray"]);
  assert.equal(
    integrated.lanes.find((lane) => lane.id === "stray").state,
    "failed",
    "ratification never relabels the lane",
  );

  const presented = await review(runId);
  assert.match(presented.markdown, /- Scope violations: stray\.txt/);
  assert.match(
    presented.markdown,
    /- \*\*Ratified violations:\*\* `stray\.txt` - audited: the file belongs to this lane \(test-manager, /,
  );
  assert.match(presented.markdown, /- Lanes folded on a recorded ratification: stray/);
  assert.match(
    presented.markdown,
    /\*\*Force-included in integration:\*\* lane ended `failed`/,
  );

  await runCli(["cancel", runId]);
});

test("Delivery Review shows the scope a lane was granted alongside the scope it declared", async () => {
  const runId = "run-review-extended";
  const workflow = writeWorkflow("review-extended", baseWorkflow([
    {
      id: "writer",
      scope: "allowed.txt",
      prompt: "write the allowed file",
      fake: { write: { path: "allowed.txt", content: "allowed\n" } },
    },
    {
      id: "asker",
      scope: "mine.txt",
      prompt: "ask before touching the shared file",
      fake: {
        write: { path: "mine.txt", content: "mine\n" },
        needs_input: "may I also write shared.txt?",
        resume: { write: { path: "shared.txt", content: "granted\n" } },
      },
    },
  ]));

  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  await waitForStatus(
    runId,
    (status) => status.state === "blocked"
      && status.lanes.find((lane) => lane.id === "asker")?.state === "blocked",
  );

  const replied = JSON.parse((await runCli([
    "reply", runId, "asker",
    "--message", "yes, shared.txt is yours for this lane",
    "--extend-scope", "shared.txt",
    "--json",
  ])).stdout.trim());
  assert.deepEqual(replied.scopeExtensions[0].patterns, ["shared.txt"]);
  assert.equal(replied.scopeExtensions[0].by, "test-manager");

  const done = await waitForStatus(
    runId,
    (status) => status.state === "delivery_review_pending",
    40_000,
  );
  const asker = done.lanes.find((lane) => lane.id === "asker");
  assert.equal(asker.state, "done", "the granted write does not fail the lane at exit");
  assert.deepEqual(asker.scopeViolations, []);
  assert.deepEqual(asker.changedFiles.sort(), ["mine.txt", "shared.txt"]);

  const presented = await review(runId);
  assert.match(presented.markdown, /- Scope: mine\.txt\n- Scope extensions: `shared\.txt` \(test-manager, /);
  assert.match(presented.markdown, /### writer \(fake\)[\s\S]*?- Scope extensions: none/);

  await runCli(["cancel", runId]);
});

test("a verdict on a run that never reached review needs --recovered and is stamped as such", async () => {
  const runId = "run-review-recovered";
  const workflow = writeWorkflow("review-recovered", baseWorkflow([
    {
      id: "breaker",
      scope: "broken.txt",
      prompt: "write then die",
      fake: { write: { path: "broken.txt", content: "half done\n" }, exit_code: 3 },
    },
  ]));

  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  await waitForStatus(runId, (status) => status.state === "failed");
  await waitForFeed("run_failed", runId);

  assert.match(
    await cliError(["review", runId]),
    /is not awaiting Delivery Review \(state failed\); rerun with --recovered/,
  );
  assert.equal(
    JSON.parse((await runCli(["status", runId, "--json"])).stdout.trim()).delivery.review.state,
    "not_started",
    "a refused review records nothing",
  );

  const presented = await review(runId, ["--recovered"]);
  assert.match(presented.markdown, /- Recovered review: \*\*recorded from `failed`\*\*/);
  assert.equal(presented.state, "failed", "presenting a verdict form does not revive the run");

  const rejected = await review(runId, [
    "--pass", "1", "--verdict", "reject", "--reviewer", "test-operator", "--recovered",
  ]);
  assert.equal(rejected.verdict, "reject");

  const status = JSON.parse((await runCli(["status", runId, "--json"])).stdout.trim());
  assert.equal(status.state, "rejected");
  assert.equal(status.delivery.review.recovered, true);
  assert.equal(status.delivery.review.recoveredFrom, "failed");
  const decision = status.delivery.review.history.find((item) => item.pass === 1);
  assert.equal(decision.recovered, true);
  assert.equal(decision.recoveredFrom, "failed");
  // `rejected` is terminal: the recovered verdict closed the run rather than
  // parking it, so there is nothing left to cancel.
  assert.equal(status.endedAt !== null, true);
});

test("--recovered does not reach states that were never recoverable, and is off by default", async () => {
  const runId = "run-review-not-recoverable";
  const workflow = writeWorkflow("review-not-recoverable", baseWorkflow([
    {
      id: "writer",
      scope: "allowed.txt",
      prompt: "write the allowed file",
      fake: { write: { path: "allowed.txt", content: "allowed\n" } },
    },
  ]));

  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  await waitForStatus(runId, (status) => status.state === "delivery_review_pending");

  // The ordinary path is untouched by the flag.
  const plain = await review(runId);
  assert.ok(!plain.markdown.includes("Recovered review"));
  await review(runId, [
    "--pass", "1", "--verdict", "accept", "--reviewer", "test-operator",
  ]);
  await runCli(["cancel", runId]);

  const cancelled = await waitForStatus(runId, (status) => status.state === "cancelled");
  assert.equal(cancelled.state, "cancelled");
  assert.match(
    await cliError(["review", runId, "--pass", "1", "--verdict", "reject", "--reviewer", "x"]),
    /is not awaiting Delivery Review \(state cancelled\); rerun with --recovered/,
  );
});

test("a recovered verdict on a cancelled run persists without reviving the run", async () => {
  const runId = "run-review-cancelled";
  const workflow = writeWorkflow("review-cancelled", baseWorkflow([
    {
      id: "writer",
      scope: "allowed.txt",
      prompt: "write the allowed file",
      fake: { write: { path: "allowed.txt", content: "allowed\n" } },
    },
  ]));

  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  await waitForStatus(runId, (status) => status.state === "delivery_review_pending");
  await runCli(["cancel", runId]);
  await waitForStatus(runId, (status) => status.state === "cancelled");

  const rejected = await review(runId, [
    "--pass", "1", "--verdict", "reject", "--reviewer", "test-operator", "--recovered",
  ]);
  assert.equal(rejected.verdict, "reject");

  // The cancel marker keeps the run cancelled; the verdict lands on the
  // delivery record rather than being dropped with the whole write.
  const status = JSON.parse((await runCli(["status", runId, "--json"])).stdout.trim());
  assert.equal(status.state, "cancelled", "a recovered verdict does not resurrect a cancelled run");
  assert.equal(status.delivery.state, "rejected");
  assert.equal(status.delivery.review.state, "rejected");
  assert.equal(status.delivery.review.recoveredFrom, "cancelled");
  const decision = status.delivery.review.history.find((item) => item.pass === 1);
  assert.equal(decision.verdict, "reject");
  assert.equal(decision.recovered, true);
});
