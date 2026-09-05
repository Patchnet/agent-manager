import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createE2eFixture } from "../test-support/e2e-fixture.mjs";

const {
  root,
  runsRoot,
  repo,
  env,
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

test("a detached attempt deadline retains its reason and a quick resume clears it", async () => {
  const runId = "run-deadline-recovery";
  const definition = baseWorkflow([{ id: "writer", scope: "deadline.txt", prompt: "fixture",
    fake: { delay_ms: 5500, resume: { write: { path: "deadline.txt", content: "recovered\n" } } } }]);
  definition.policy.max_runtime_sec = 5;
  definition.policy.stall_grace_sec = 60;
  const workflow = writeWorkflow("deadline-recovery", definition);
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const failed = await waitForStatus(runId, (status) => status.state === "failed" && status.lanes[0].endedAt);
  assert.equal(failed.lanes[0].supervision.reason, "runtime_deadline");
  assert.equal(failed.lanes[0].lastActivity, "supervision: runtime_deadline");
  await runCli(["reply", runId, "writer", "--force", "--message", "Retry the fixture.", "--json"]);
  const resumed = await waitForStatus(runId, (status) => status.state === "delivery_review_pending");
  assert.equal(resumed.lanes[0].state, "done");
  assert.notEqual(resumed.lanes[0].supervision?.reason, "runtime_deadline");
});

test("detached run publishes feed events, resumes the exact session, and releases claims", async () => {
  const runId = "run-test-reply";
  const workflow = writeWorkflow("reply", baseWorkflow([
    {
      id: "writer",
      model: "worker-test-model",
      harness_options: { effort: "high" },
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
  assert.deepEqual(writer.harnessOptions, { effort: "high" });
  assert.equal(writer.effortObserved, null);
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

test("selected missing harness fails before run intent, claims, or worktrees", async () => {
  const runId = "run-missing-selected-harness";
  const workflow = writeWorkflow("missing-selected-harness", baseWorkflow([{
    id: "must-not-start",
    harness: "claude",
    scope: "never-created.txt",
    prompt: "must not start",
  }]));
  const previous = env.CLAUDE_BIN;
  const claimsBefore = existsSync(claimLog) ? readFileSync(claimLog, "utf8") : "";
  env.CLAUDE_BIN = join(root, "missing-claude");
  try {
    await assert.rejects(
      runCli(["run", workflow, "--run-id", runId, "--json"]),
      (error) => {
        const payload = JSON.parse(String(error.stderr || "").trim());
        assert.equal(payload.code, "selected-harness-unavailable");
        assert.equal(payload.failures[0].harness, "claude");
        assert.match(payload.failures[0].remediation, /Verify from the same environment/);
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete env.CLAUDE_BIN;
    else env.CLAUDE_BIN = previous;
  }
  assert.equal(existsSync(join(runsRoot, runId)), false);
  assert.equal(existsSync(join(runsRoot, runId, "must-not-start", "wt")), false);
  assert.equal(existsSync(claimLog) ? readFileSync(claimLog, "utf8") : "", claimsBefore);
  const intents = JSON.parse((await runCli(["brain", "status", "--repo", repo, "--json"])).stdout);
  assert.equal(intents.some((intent) => intent.runId === runId), false);
});

test("portable-script CRLF violations fail a lane and remain in review evidence", async () => {
  const runId = "run-portable-script-crlf";
  const workflow = writeWorkflow("portable-script-crlf", baseWorkflow([{
    id: "launcher",
    scope: "launch",
    prompt: "write launcher",
    fake: { write: { path: "launch", content: "#!/bin/sh\r\necho launch\r\n" } },
  }]));
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const failed = await waitForStatus(runId, (status) => status.state === "failed");
  assert.deepEqual(failed.lanes[0].portableScriptViolations, ["launch"]);
  assert.match(failed.lanes[0].policyViolations.join("; "), /launch/);

  const review = JSON.parse((await runCli([
    "review", runId, "--recovered", "--json",
  ])).stdout.trim());
  assert.match(review.markdown, /Portable-script line-ending violations: launch/);
});

test("integrated output is rechecked for portable-script CRLF before review", async () => {
  const runId = "run-integrated-script-crlf";
  const workflow = writeWorkflow("integrated-script-crlf", baseWorkflow([{
    id: "launcher",
    scope: "launch.sh",
    prompt: "write launcher",
    fake: { write: { path: "launch.sh", content: "#!/bin/sh\necho launch\n" } },
  }]));
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const workersDone = await waitForStatus(
    runId,
    (status) => status.state === "delivery_review_pending",
  );
  execFileSync("git", [
    "-C", workersDone.lanes[0].worktree, "config", "core.autocrlf", "false",
  ]);
  writeFileSync(
    join(workersDone.lanes[0].worktree, "launch.sh"),
    "#!/bin/sh\r\necho integrated\r\n",
  );

  const integrated = JSON.parse((await runCli([
    "integrate", runId, "--json",
  ])).stdout.trim());
  assert.equal(integrated.state, "blocked");
  assert.deepEqual(
    integrated.integrate.portableScriptViolations,
    ["launch.sh"],
    JSON.stringify(integrated.integrate, null, 2),
  );

  const review = JSON.parse((await runCli([
    "review", runId, "--recovered", "--json",
  ])).stdout.trim());
  assert.match(review.markdown, /Portable-script line-ending violations: `launch\.sh`/);
  assert.match(review.markdown, /structural preflight failed|Structural preflight: \*\*failed\*\*/i);
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
  const launch = JSON.parse((await runCli([
    "run", workflow, "--detach", "--json", "--run-id", runId,
  ])).stdout.trim());
  assert.equal(launch.topology.effectiveParallelism, 1);
  assert.equal(launch.topology.fullySerialized, true);
  assert.equal(
    launch.warnings.some((warning) => warning.code === "fully-serialized-multi-lane"),
    true,
  );
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

test("goal references fail closed and freeze goal-tree context into admitted runs", async () => {
  await runCli([
    "goal", "create", "--id", "goal-e2e-parent", "--title", "E2E parent",
    "--outcome", "The run carries its durable goal context.", "--json",
    "--success-criterion", "The output carries goal context",
  ]);
  await runCli([
    "goal", "create", "--id", "goal-e2e-child", "--title", "E2E child",
    "--parent", "goal-e2e-parent", "--json",
  ]);
  await runCli([
    "goal", "link", "goal-e2e-child", "--type", "plan", "--ref", "plan:e2e-public",
    "--relationship", "supports", "--state", "active", "--json",
  ]);

  const missingRunId = "run-test-missing-goal";
  const missingWorkflow = writeWorkflow("missing-goal", {
    ...baseWorkflow([{
      id: "missing-goal-writer",
      scope: "missing-goal.txt",
      prompt: "must not start",
      fake: { write: { path: "missing-goal.txt", content: "unexpected\n" } },
    }]),
    goal_refs: ["goal-not-local"],
  });
  await assert.rejects(
    runCli(["run", missingWorkflow, "--detach", "--json", "--run-id", missingRunId]),
    /local goals not found/,
  );
  assert.equal(existsSync(join(runsRoot, missingRunId)), false);

  const runId = "run-test-goal-context";
  const workflow = writeWorkflow("goal-context", {
    ...baseWorkflow([{
      id: "goal-writer",
      scope: "goal-context.txt",
      prompt: "write with goal context",
      fake: { write: { path: "goal-context.txt", content: "goal context\n" } },
    }]),
    goal_refs: ["goal-e2e-parent"],
  });
  const validation = JSON.parse((await runCli(["validate", workflow, "--json"])).stdout);
  assert.deepEqual(validation.goalRefs, ["goal-e2e-parent"]);

  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const status = await waitForStatus(runId, (item) => item.state === "delivery_review_pending");
  assert.deepEqual(status.goalRefs, ["goal-e2e-parent"]);
  assert.deepEqual(status.goals.refs, ["goal-e2e-parent"]);
  assert.deepEqual(status.goals.goals.map((goal) => goal.id), ["goal-e2e-child", "goal-e2e-parent"]);
  assert.equal(status.goals.artifactLinks[0].artifactRef, "plan:e2e-public");
  assert.match(status.goals.contextDigest, /^[0-9a-f]{64}$/);
  assert.equal(existsSync(status.goals.contextSnapshot), true);
  const prompt = readFileSync(join(runsRoot, runId, "goal-writer", "prompt.md"), "utf8");
  assert.match(prompt, /## Agent Manager goal context/);
  assert.match(prompt, /goal-e2e-child/);
  assert.match(prompt, /plan:e2e-public/);
  const report = readFileSync(join(runsRoot, runId, "report.md"), "utf8");
  assert.match(report, /## Goal context/);
  assert.match(report, /goal-e2e-parent/);
  const statusEvents = readFileSync(join(runsRoot, runId, "events.jsonl"), "utf8")
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(statusEvents.some((event) => event.goalRefs?.includes("goal-e2e-parent")));

  const intents = JSON.parse((await runCli(["brain", "status", "--repo", repo, "--json"])).stdout);
  const intent = intents.find((item) => item.runId === runId);
  assert.deepEqual(intent.goalRefs, ["goal-e2e-parent"]);
  assert.equal(intent.goalAlignmentRequired, true);
  await assert.rejects(runCli(["review", runId, "--verdict", "accept", "--reviewer", "manager", "--json"]), /goal evidence/);
  const review = JSON.parse((await runCli(["review", runId, "--json"])).stdout);
  const evidence = review.goalEvidenceTemplate;
  evidence[0].criteria[0].state = "met";
  evidence[0].criteria[0].evidence = "Verified goal-context.txt and frozen prompt in the reviewed worktree";
  const evidencePath = join(runsRoot, runId, "goal-evidence.json");
  writeFileSync(evidencePath, JSON.stringify(evidence));
  await runCli(["review", runId, "--verdict", "accept", "--reviewer", "manager", "--goal-evidence", evidencePath, "--json"]);
  const accepted = JSON.parse(readFileSync(join(runsRoot, runId, "status.json"), "utf8"));
  assert.equal(accepted.delivery.review.history[0].goalAssessment[0].outcome, "fulfilled");
});
