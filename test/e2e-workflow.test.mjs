import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createE2eFixture } from "../test-support/e2e-fixture.mjs";

const {
  runsRoot,
  repo,
  claimLog,
  fixtureBase,
  feedEvents,
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

test("detached run publishes feed events, resumes the exact session, and releases claims", async () => {
  const runId = "run-test-reply";
  const workflow = writeWorkflow("reply", baseWorkflow([
    {
      id: "writer",
      model: "worker-test-model",
      scope: "allowed.txt",
      prompt: "write allowed file",
      fake: { write: { path: "allowed.txt", content: "allowed\n" } },
    },
    {
      id: "question",
      scope: "resume.txt",
      prompt: "ask then resume",
      fake: {
        needs_input: "Which value should I use?",
        resume: { write: { path: "resume.txt", content: "answered\n" } },
      },
    },
  ]));

  const launchStarted = Date.now();
  const launch = await runCli([
    "run", workflow, "--detach", "--json", "--run-id", runId,
    "--title", "Reply workflow", "--repo-shorthand", "fixture",
    "--manager-harness", "codex", "--manager-model", "manager-test-model",
  ]);
  assert.ok(Date.now() - launchStarted < 1_000, "detached launch should return immediately");
  const launchPayload = JSON.parse(launch.stdout.trim());
  assert.equal(launchPayload.runId, runId);
  assert.equal(launchPayload.state, "detached");
  assert.match(launchPayload.agentManagerVersion, /^\d+\.\d+\.\d+/);
  assert.equal(launchPayload.runtime.hostPlatform, process.platform);
  assert.equal(launchPayload.masterReturn, null);
  assert.equal(launchPayload.suggestedThreadTitle, "[AM st-reply] fixture · Reply workflow");
  assert.equal(launchPayload.identity.manager.model, "manager-test-model");

  const blocked = await waitForStatus(runId, (status) => status.state === "blocked");
  const writer = blocked.lanes.find((lane) => lane.id === "writer");
  const question = blocked.lanes.find((lane) => lane.id === "question");
  assert.equal(writer.state, "done");
  assert.equal(writer.modelRequested, "worker-test-model");
  assert.equal(writer.modelObserved, null);
  assert.equal(blocked.identity.manager.harness, "codex");
  assert.equal(blocked.identity.manager.model, "manager-test-model");
  assert.equal(question.state, "blocked");
  assert.match(question.sessionId, /^fake-/);
  assert.equal(question.claim.state, "retained");
  for (const lane of [writer, question]) {
    assert.deepEqual(lane.inheritedInstructionFiles, ["AGENTS.md"]);
    assert.equal(
      readFileSync(join(lane.worktree, "AGENTS.md"), "utf8"),
      "# Local fixture instructions\n",
    );
  }
  assert.equal(blocked.planning.state, "verified");
  assert.equal(blocked.runtime.hostPlatform, process.platform);
  assert.equal(blocked.planning.reviewedBaseSha, fixtureBase);
  assert.match(blocked.planning.contextDigest, /^[0-9a-f]{64}$/);
  const frozenContext = readFileSync(join(runsRoot, runId, "planning-context.md"), "utf8");
  assert.match(frozenContext, /Every lane must preserve the fixture contract/);
  const writerPrompt = readFileSync(join(runsRoot, runId, "writer", "prompt.md"), "utf8");
  const questionPrompt = readFileSync(join(runsRoot, runId, "question", "prompt.md"), "utf8");
  for (const prompt of [writerPrompt, questionPrompt]) {
    assert.match(prompt, /## Verified shared planning context/);
    assert.match(prompt, /Every lane must preserve the fixture contract/);
    assert.match(prompt, new RegExp(blocked.planning.contextDigest));
  }
  writeFileSync(
    join(repo, "agent-manager.context.md"),
    "This later edit must not change the active run.\n",
  );
  await waitForFeed("needs_input", runId);

  const reply = await runCli([
    "reply", runId, "question", "--message", "Use the approved value.", "--json",
  ]);
  const replyPayload = JSON.parse(reply.stdout.trim());
  assert.equal(replyPayload.sessionId, question.sessionId);
  assert.equal(replyPayload.state, "running");

  const done = await waitForStatus(runId, (status) => status.state === "delivery_review_pending");
  const resumed = done.lanes.find((lane) => lane.id === "question");
  assert.equal(resumed.sessionId, question.sessionId);
  assert.equal(resumed.state, "done");
  assert.equal(resumed.claim.state, "released");
  assert.ok(existsSync(join(resumed.worktree, "resume.txt")));
  assert.equal(
    readFileSync(join(runsRoot, runId, "planning-context.md"), "utf8"),
    frozenContext,
  );
  await waitForFeed("workers_done", runId);

  const reviewOutput = await runCli(["review", runId, "--json"]);
  const review = JSON.parse(reviewOutput.stdout.trim());
  assert.equal(review.schema, "agent-manager.review.v1");
  assert.ok(existsSync(review.path));
  assert.match(review.markdown, /Planning preflight: \*\*verified\*\*/);
  assert.match(review.markdown, new RegExp(done.planning.contextDigest));
  assert.match(review.markdown, /WAIT_OPERATOR/);
  assert.equal(JSON.parse(readFileSync(join(runsRoot, runId, "status.json"), "utf8")).delivery.review.state, "awaiting_operator");
  const waitingCadence = JSON.parse((await runCli(["next-action", runId, "--json"])).stdout.trim());
  assert.equal(waitingCadence.transition, "WAIT_OPERATOR");
  assert.deepEqual(waitingCadence.operatorInputRequired, [
    "accept", "accept-with-notes", "revise", "relaunch", "reject",
  ]);

  const acceptedOutput = await runCli([
    "review", runId, "--pass", "1", "--verdict", "accept-with-notes",
    "--reviewer", "test-manager", "--notes", "fixture accepted", "--json",
  ]);
  const accepted = JSON.parse(acceptedOutput.stdout.trim());
  assert.equal(accepted.verdict, "accept-with-notes");
  assert.equal(accepted.state, "ship_gate_pending");
  assert.ok(existsSync(accepted.decisionPath));
  assert.match(accepted.markdown, /AUTO_CONTINUE/);
  const acceptedCadence = JSON.parse((await runCli(["next-action", runId, "--json"])).stdout.trim());
  assert.equal(acceptedCadence.transition, "AUTO_CONTINUE");
  assert.equal(acceptedCadence.stage, "ship_gate_ready");

  const eventNames = feedEvents.filter((item) => item.runId === runId).map((item) => item.event);
  assert.ok(eventNames.includes("run_started"));
  assert.ok(eventNames.filter((name) => name === "lane_started").length >= 3);
  assert.ok(eventNames.includes("lane_done"));
  assert.ok(eventNames.includes("needs_input"));
  assert.ok(eventNames.includes("workers_done"));
  const report = readFileSync(join(runsRoot, runId, "report.md"), "utf8");
  assert.match(report, /\*\*ended:\*\* -/);
  assert.match(report, /## Planning preflight/);
  assert.match(report, new RegExp(done.planning.contextDigest));
  const claims = readFileSync(claimLog, "utf8");
  assert.match(claims, /release --repo fixture-repo --branch am\/run-test-reply\/writer/);
  assert.match(claims, /release --repo fixture-repo --branch am\/run-test-reply\/question/);
  await runCli(["cancel", runId]);
  await runCli(["cleanup", runId]);
});

test("a zero-change implementation lane fails before delivery review", async () => {
  const runId = "run-zero-change";
  const workflow = writeWorkflow("zero-change", baseWorkflow([{
    id: "empty",
    kind: "implementation",
    scope: "zero-change.txt",
    prompt: "Exit successfully without writing code.",
    fake: { delay_ms: 10, exit_code: 0 },
  }]));
  await runCli(["run", workflow, "--detach", "--run-id", runId, "--json"]);
  const failed = await waitForStatus(runId, (status) => status.state === "failed");
  assert.equal(failed.lanes[0].completion.state, "failed");
  assert.match(failed.lanes[0].completion.reason, /zero changed files/);
  assert.notEqual(failed.state, "delivery_review_pending");
});

test("five lanes honor bounded concurrency and complete from one immutable base", async () => {
  const runId = "run-test-five-lanes";
  const workflow = writeWorkflow("five-lanes", {
    ...baseWorkflow([1, 2, 3, 4, 5].map((index) => ({
      id: `lane-${index}`,
      scope: `lane-${index}.txt`,
      prompt: `write lane ${index}`,
      fake: {
        delay_ms: 180,
        write: { path: `lane-${index}.txt`, content: `${index}\n` },
      },
    }))),
    max_concurrency: 2,
  });
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);

  let maxRunning = 0;
  const done = await waitForStatus(runId, (status) => {
    maxRunning = Math.max(
      maxRunning,
      status.lanes.filter((lane) => lane.state === "running").length,
    );
    return status.state === "delivery_review_pending";
  });
  assert.equal(done.state, "delivery_review_pending", JSON.stringify(done, null, 2));
  assert.ok(done.execution.endedAt);
  assert.equal(done.lanes.length, 5);
  assert.ok(done.lanes.every((lane) => lane.state === "done"));
  assert.ok(maxRunning <= 2, `observed ${maxRunning} concurrent lanes`);
  assert.equal(new Set(done.lanes.map((lane) => lane.runBaseCommit)).size, 1);
  await runCli(["cancel", runId]);
  await runCli(["cleanup", runId]);
});

test("dependent lanes can sequentially update prerequisite-owned files", async () => {
  const runId = "run-test-dependencies";
  const workflow = writeWorkflow("dependencies", baseWorkflow([
    {
      id: "contracts",
      scope: "contract.txt",
      prompt: "write contract",
      fake: { write: { path: "contract.txt", content: "contract\n" } },
    },
    {
      id: "consumer",
      depends_on: ["contracts"],
      scope: "contract.txt",
      prompt: "extend contract",
      fake: { write: { path: "contract.txt", content: "contract\nconsumer\n" } },
    },
  ]));
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const done = await waitForStatus(runId, (status) => status.state === "delivery_review_pending");
  const consumer = done.lanes.find((lane) => lane.id === "consumer");
  assert.deepEqual(consumer.dependenciesIntegrated, ["contracts"]);
  assert.ok(existsSync(join(consumer.worktree, "contract.txt")));
  assert.equal(
    readFileSync(join(consumer.worktree, "contract.txt"), "utf8").replace(/\r\n/g, "\n"),
    "contract\nconsumer\n",
  );
  assert.deepEqual(consumer.changedFiles, ["contract.txt"]);

  const integratedOutput = await runCli(["integrate", runId, "--json"]);
  const integrated = JSON.parse(integratedOutput.stdout.trim());
  assert.equal(integrated.integrate.state, "ready");
  assert.ok(existsSync(join(integrated.integrate.worktree, "contract.txt")));
  assert.equal(
    readFileSync(join(integrated.integrate.worktree, "contract.txt"), "utf8")
      .replace(/\r\n/g, "\n"),
    "contract\nconsumer\n",
  );
  assert.deepEqual(integrated.integrate.approvedChangedFileOverlaps, [
    { file: "contract.txt", lanes: ["contracts", "consumer"] },
  ]);
  await runCli(["cancel", runId]);
  await runCli(["cleanup", runId]);
});
