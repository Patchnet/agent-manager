import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createE2eFixture } from "../test-support/e2e-fixture.mjs";

const {
  runsRoot,
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

test("integrate --force-lanes folds snapshotted failed lanes and records which", async () => {
  const runId = "run-force-integrate";
  const workflow = writeWorkflow("force-integrate", baseWorkflow([
    {
      id: "writer",
      scope: "allowed.txt",
      prompt: "write the allowed file",
      fake: { write: { path: "allowed.txt", content: "allowed\n" } },
    },
    {
      id: "breaker",
      scope: "broken.txt",
      prompt: "write then die",
      fake: { write: { path: "broken.txt", content: "half done\n" }, exit_code: 3 },
    },
    {
      id: "silent",
      scope: "never.txt",
      prompt: "die with nothing",
      fake: { exit_code: 4 },
    },
    {
      id: "stray",
      scope: "mine.txt",
      prompt: "write outside the lane scope",
      fake: { write: { path: "stray.txt", content: "out of scope\n" } },
    },
  ]));

  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const failed = await waitForStatus(runId, (status) => status.state === "failed");
  await waitForFeed("run_failed", runId);
  const laneStates = Object.fromEntries(failed.lanes.map((lane) => [lane.id, lane]));
  assert.equal(laneStates.writer.state, "done");
  assert.equal(laneStates.breaker.state, "failed");
  assert.equal(laneStates.silent.state, "failed");
  assert.equal(laneStates.stray.state, "failed");
  assert.deepEqual(laneStates.stray.scopeViolations, ["stray.txt"]);

  // Every writable lane is snapshotted at lane end, done or failed.
  assert.equal(laneStates.writer.snapshot.state, "committed");
  assert.equal(laneStates.breaker.snapshot.state, "committed");
  assert.deepEqual(laneStates.breaker.snapshot.files, ["broken.txt"]);
  assert.equal(laneStates.silent.snapshot.state, "clean");
  assert.equal(laneStates.stray.snapshot.state, "committed");

  // Default behaviour is unchanged: a mixed run does not integrate.
  assert.match(
    await cliError(["integrate", runId]),
    /all lanes must be done before integration/,
  );
  assert.match(
    await cliError(["integrate", runId, "--force-lanes", "bogus"]),
    /unknown --force-lanes selector: bogus/,
  );
  // The selector list is an exact comma-split, not a substring test: a value
  // that merely contains a known selector is a typo, not a permission.
  assert.match(
    await cliError(["integrate", runId, "--force-lanes", "done-ish,failed-with-snapshot"]),
    /unknown --force-lanes selector: done-ish \(expected done, failed-with-snapshot\)/,
  );
  assert.match(
    await cliError(["integrate", runId, "--force-lanes", "done"]),
    /--force-lanes done does not cover breaker \(failed\), silent \(failed\), stray \(failed\)/,
  );
  const afterRefusals = JSON.parse((await runCli(["status", runId, "--json"])).stdout.trim());
  assert.equal(afterRefusals.state, "failed", "refused integrations leave the run alone");
  assert.equal(afterRefusals.integrate, undefined);

  const forced = await runCli([
    "integrate", runId, "--force-lanes", " done , FAILED-WITH-SNAPSHOT , done ", "--json",
  ]);
  const status = JSON.parse(forced.stdout.trim());

  assert.equal(status.integrate.state, "ready");
  assert.deepEqual(status.integrate.forcedLanes, ["breaker"]);
  assert.deepEqual(
    status.integrate.forceLaneSelectors,
    ["done", "failed-with-snapshot"],
    "whitespace, case, and duplicates normalize into the same two selectors",
  );
  assert.deepEqual(status.integrate.ratifiedLanes, [], "nothing here was ratified");
  const excluded = Object.fromEntries(
    status.integrate.excludedLanes.map((lane) => [lane.id, lane.reason]),
  );
  assert.deepEqual(
    Object.keys(excluded).sort(),
    ["silent", "stray"],
    "nothing committed, or stopped by a guardrail: dropped, not folded",
  );
  assert.match(excluded.silent, /lane snapshot clean/);
  assert.match(excluded.stray, /guardrail violations: stray\.txt/);
  assert.deepEqual(status.integrate.merged.sort(), ["breaker", "writer"]);
  assert.equal(status.state, "delivery_review_pending");

  const integrated = join(runsRoot, runId, "integrate", "wt");
  assert.ok(existsSync(join(integrated, "allowed.txt")), "the done lane is in the fold");
  assert.ok(existsSync(join(integrated, "broken.txt")), "so is the forced lane's snapshot");
  assert.ok(!existsSync(join(integrated, "never.txt")));
  assert.ok(
    !existsSync(join(integrated, "stray.txt")),
    "a scope violation is not laundered by a snapshot",
  );

  const breaker = status.lanes.find((lane) => lane.id === "breaker");
  assert.equal(breaker.state, "failed", "forcing the fold does not relabel the lane");
  assert.deepEqual(breaker.changedFiles, ["broken.txt"]);
  const target = status.delivery.targets.find((item) => item.id === "integrate");
  assert.deepEqual(target.changedFiles.sort(), ["allowed.txt", "broken.txt"]);

  await runCli(["cancel", runId]);
});

test("a ratified guardrail violation folds; an unratified one still does not", async () => {
  const runId = "run-force-ratified";
  const workflow = writeWorkflow("force-ratified", baseWorkflow([
    {
      id: "sanctioned",
      scope: "mine.txt",
      prompt: "write the file Master later ratifies",
      fake: { write: { path: "sanctioned.txt", content: "master wanted this\n" } },
    },
    {
      id: "unsanctioned",
      scope: "yours.txt",
      prompt: "write outside the lane scope",
      fake: { write: { path: "unsanctioned.txt", content: "nobody asked for this\n" } },
    },
  ]));

  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const failed = await waitForStatus(runId, (status) => status.state === "failed");
  await waitForFeed("run_failed", runId);
  for (const lane of failed.lanes) {
    assert.equal(lane.state, "failed", lane.id);
    assert.equal(lane.snapshot.state, "committed", lane.id);
  }

  assert.match(
    await cliError(["ratify", runId, "sanctioned", "--reason", ""]),
    /ratify requires --reason <text>/,
  );
  await runCli([
    "ratify", runId, "sanctioned", "--reason", "audited 2026-08-17: this is the work Master asked for",
  ]);

  const forced = JSON.parse((await runCli([
    "integrate", runId, "--force-lanes", "done,failed-with-snapshot", "--json",
  ])).stdout.trim());
  assert.equal(forced.integrate.state, "ready");
  assert.deepEqual(forced.integrate.merged, ["sanctioned"]);
  assert.deepEqual(forced.integrate.ratifiedLanes, ["sanctioned"]);
  assert.deepEqual(
    forced.integrate.excludedLanes.map((lane) => [lane.id, lane.reason]),
    [["unsanctioned", "guardrail violations: unsanctioned.txt"]],
    "the default is untouched for a violation nobody ratified",
  );
  const ratifiedLane = forced.lanes.find((lane) => lane.id === "sanctioned");
  assert.equal(ratifiedLane.state, "failed");
  assert.deepEqual(ratifiedLane.scopeViolations, ["sanctioned.txt"]);
  assert.equal(ratifiedLane.ratification.by, "test-manager");

  await runCli(["cancel", runId]);
});

test("a ratification does not cover violations recorded after it", async () => {
  const runId = "run-force-ratified-gap";
  const workflow = writeWorkflow("force-ratified-gap", baseWorkflow([
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
  await runCli(["ratify", runId, "stray", "--reason", "audited: stray.txt is fine"]);

  // New evidence lands on the lane after the ratifier looked at it.
  const statusPath = join(runsRoot, runId, "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  status.lanes[0].scopeViolations = ["stray.txt", "later.txt"];
  writeFileSync(statusPath, JSON.stringify(status, null, 2) + "\n");

  assert.match(
    await cliError(["integrate", runId, "--force-lanes", "done,failed-with-snapshot"]),
    /no done lanes and no snapshotted failed lanes to integrate: stray \(guardrail violations recorded after ratification: later\.txt\)/,
  );
  const refused = JSON.parse(readFileSync(statusPath, "utf8"));
  assert.equal(refused.integrate, undefined, "a refused fold leaves the run alone");

  // Re-ratifying on the full evidence lets it through.
  await runCli(["ratify", runId, "stray", "--reason", "audited again: both files are fine"]);
  const forced = JSON.parse((await runCli([
    "integrate", runId, "--force-lanes", "done,failed-with-snapshot", "--json",
  ])).stdout.trim());
  assert.deepEqual(forced.integrate.merged, ["stray"]);
  assert.deepEqual(forced.integrate.ratifiedLanes, ["stray"]);

  await runCli(["cancel", runId]);
});

test("ratify refuses a lane with nothing to ratify and a lane with nothing to fold", async () => {
  const runId = "run-force-ratify-refusals";
  const workflow = writeWorkflow("force-ratify-refusals", baseWorkflow([
    {
      id: "writer",
      scope: "allowed.txt",
      prompt: "write the allowed file",
      fake: { write: { path: "allowed.txt", content: "allowed\n" } },
    },
    {
      id: "silent",
      scope: "never.txt",
      prompt: "die with nothing",
      fake: { exit_code: 4 },
    },
  ]));

  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  await waitForStatus(runId, (status) => status.state === "failed");
  await waitForFeed("run_failed", runId);

  assert.match(
    await cliError(["ratify", runId, "writer", "--reason", "it went fine"]),
    /recorded no guardrail violations; there is nothing to ratify/,
  );
  assert.match(
    await cliError(["ratify", runId, "silent", "--reason", "let it through"]),
    /recorded no guardrail violations; there is nothing to ratify/,
  );
  assert.match(
    await cliError(["ratify", runId, "ghost", "--reason", "who?"]),
    /no lane ghost in/,
  );
  // The run stays `failed`: refusing to ratify is not a state change, and a
  // terminal run has nothing left to cancel.
  assert.equal(
    JSON.parse((await runCli(["status", runId, "--json"])).stdout.trim()).state,
    "failed",
  );
});

test("a force-integrated run can be reviewed and accepted, with the fold surfaced", async () => {
  const runId = "run-force-review";
  const workflow = writeWorkflow("force-review", baseWorkflow([
    {
      id: "writer",
      scope: "allowed.txt",
      prompt: "write the allowed file",
      fake: { write: { path: "allowed.txt", content: "allowed\n" } },
    },
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
  await runCli(["integrate", runId, "--force-lanes", "done,failed-with-snapshot", "--json"]);

  const presented = JSON.parse(
    (await runCli(["review", runId, "--json"])).stdout.trim(),
  );
  assert.match(
    presented.markdown,
    /- Structural preflight: \*\*passed\*\*/,
    "a force-included lane is accounted for, not a structural error",
  );
  assert.match(
    presented.markdown,
    /\*\*Force-included in integration:\*\* lane ended `failed`/,
    "the forced lane is never silently equal to done",
  );
  assert.match(presented.markdown, /- Force-included lanes \(`--force-lanes done,failed-with-snapshot`\): breaker \(failed\)/);

  const accepted = JSON.parse(
    (await runCli([
      "review", runId, "--pass", "1", "--verdict", "accept",
      "--reviewer", "test-operator", "--json",
    ])).stdout.trim(),
  );
  assert.equal(accepted.verdict, "accept");
  assert.equal(accepted.state, "ship_gate_pending");

  const reviewed = JSON.parse((await runCli(["status", runId, "--json"])).stdout.trim());
  assert.equal(reviewed.delivery.review.state, "accepted");
  assert.equal(
    reviewed.lanes.find((lane) => lane.id === "breaker").state,
    "failed",
    "acceptance does not rewrite what happened to the lane",
  );

  await runCli(["cancel", runId]);
});

test("an unaccounted failed lane still blocks acceptance", async () => {
  const runId = "run-force-review-gap";
  const workflow = writeWorkflow("force-review-gap", baseWorkflow([
    {
      id: "writer",
      scope: "allowed.txt",
      prompt: "write the allowed file",
      fake: { write: { path: "allowed.txt", content: "allowed\n" } },
    },
    {
      id: "breaker",
      scope: "broken.txt",
      prompt: "write then die",
      fake: { write: { path: "broken.txt", content: "half done\n" }, exit_code: 3 },
    },
    {
      id: "silent",
      scope: "never.txt",
      prompt: "die with nothing",
      fake: { exit_code: 4 },
    },
  ]));

  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  await waitForStatus(runId, (status) => status.state === "failed");
  await waitForFeed("run_failed", runId);
  await runCli(["integrate", runId, "--force-lanes", "done,failed-with-snapshot", "--json"]);

  const presented = JSON.parse((await runCli(["review", runId, "--json"])).stdout.trim());
  assert.match(presented.markdown, /- Structural preflight: \*\*failed\*\*/);
  assert.match(presented.markdown, /- Structural preflight errors: lane silent is failed/);
  assert.match(presented.markdown, /- Lanes excluded from the fold: silent \(lane snapshot clean\)/);
  assert.match(
    await cliError([
      "review", runId, "--pass", "1", "--verdict", "accept", "--reviewer", "test-operator",
    ]),
    /Delivery Review cannot be accepted; structural preflight failed: lane silent is failed/,
  );

  await runCli(["cancel", runId]);
});
