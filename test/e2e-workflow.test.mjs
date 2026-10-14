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
  writeWorkflow,
  runCli,
  waitForStatus,
  waitForEvent,
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
  const resumed = await waitForStatus(runId, (status) => status.state === "review_pending");
  assert.equal(resumed.lanes[0].state, "done");
  assert.notEqual(resumed.lanes[0].supervision?.reason, "runtime_deadline");
});

test("detached run emits transition events, resumes the exact session, and releases claims", async () => {
  const runId = "run-test-reply";
  const workflow = writeWorkflow("reply", {
    ...baseWorkflow([
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
    ]),
    goal: "Every lane must preserve the fixture contract.",
  });

  const launch = await runCli([
    "run", workflow, "--detach", "--json", "--run-id", runId,
    "--title", "Reply workflow", "--repo-shorthand", "fixture",
    "--manager-harness", "codex", "--manager-model", "manager-test-model",
  ]);
  // The "question" lane cannot finish until this test replies below, so a
  // launch that returned at all did not wait for the run.
  const launchPayload = JSON.parse(launch.stdout.trim());
  assert.equal(launchPayload.runId, runId);
  assert.equal(launchPayload.state, "detached");
  assert.equal(launchPayload.title, "[AM st-reply] fixture · Reply workflow");
  assert.equal(launchPayload.wait, "agent-manager wait " + runId);

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
  assert.equal(blocked.runtime.hostPlatform, process.platform);
  for (const laneId of ["writer", "question"]) {
    const prompt = readFileSync(join(runsRoot, runId, laneId, "prompt.md"), "utf8");
    assert.match(prompt, /## Run goal/);
    assert.match(prompt, /Every lane must preserve the fixture contract/);
  }
  const waiting = await waitForEvent("waiting_operator", runId);
  assert.equal(waiting.lane, "question");
  assert.equal(waiting.text, "Which value should I use?");

  const reply = await runCli([
    "reply", runId, "question", "--message", "Use the approved value.", "--json",
  ]);
  const replyPayload = JSON.parse(reply.stdout.trim());
  assert.equal(replyPayload.laneId, "question");
  assert.equal(replyPayload.state, "running");

  const done = await waitForStatus(runId, (status) => status.state === "review_pending");
  const resumed = done.lanes.find((lane) => lane.id === "question");
  assert.equal(resumed.sessionId, question.sessionId);
  assert.equal(resumed.state, "done");
  assert.equal(resumed.claim.state, "released");
  assert.ok(existsSync(join(resumed.worktree, "resume.txt")));
  assert.equal(done.delivery.review.verdict, null);
  assert.deepEqual(
    done.delivery.targets.map((target) => [target.id, target.state]),
    [["writer", "changes_ready"], ["question", "changes_ready"]],
  );

  await assert.rejects(
    runCli(["review", runId, "--verdict", "maybe", "--reviewer", "test-manager"]),
    /verdict must be accept, revise, or reject/,
  );
  const accepted = JSON.parse((await runCli([
    "review", runId, "--verdict", "accept",
    "--reviewer", "test-manager", "--notes", "fixture accepted", "--json",
  ])).stdout.trim());
  assert.equal(accepted.state, "ship_pending");
  assert.equal(accepted.delivery.review.verdict, "accept");
  assert.equal(accepted.delivery.review.reviewer, "test-manager");
  assert.equal(accepted.delivery.review.notes, "fixture accepted");
  assert.equal(accepted.delivery.review.history.length, 1);
  const verdict = await waitForEvent("review_verdict", runId);
  assert.equal(verdict.verdict, "accept");
  assert.equal(verdict.actor, "test-manager");

  const events = JSON.parse((await runCli(["events", runId, "--json"])).stdout.trim());
  assert.ok(events.every((event) => event.v === 1 && event.runId === runId && event.repo));
  const kinds = events.map((event) => event.kind);
  assert.ok(kinds.filter((kind) => kind === "lane_started").length >= 3, kinds.join(","));
  assert.ok(kinds.includes("lane_done"));
  assert.ok(kinds.includes("waiting_operator"));
  assert.ok(kinds.includes("review_verdict"));
  const report = readFileSync(join(runsRoot, runId, "report.md"), "utf8");
  assert.match(report, /\*\*goal:\*\* Every lane must preserve the fixture contract/);
  assert.match(report, /review: accept by test-manager/);
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
  assert.notEqual(failed.state, "review_pending");
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
        const stderr = String(error.stderr || "");
        assert.match(stderr, /selected harness preflight failed: claude/);
        assert.match(stderr, /Verify from the same environment/);
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
});

test("portable-script CRLF violations fail a lane and remain in the run report", async () => {
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

  const report = readFileSync(join(runsRoot, runId, "report.md"), "utf8");
  assert.match(report, /\*\*guardrail violations:\*\* .*launch/);
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
    (status) => status.state === "review_pending",
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

  await assert.rejects(
    runCli(["review", runId, "--verdict", "accept", "--reviewer", "test-manager"]),
    /is blocked; review applies after workers finish/,
  );
  const report = readFileSync(join(runsRoot, runId, "report.md"), "utf8");
  assert.match(report, /launch\.sh/);
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
    return status.state === "review_pending";
  });
  assert.equal(done.state, "review_pending", JSON.stringify(done, null, 2));
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
  const validated = JSON.parse((await runCli(["validate", workflow, "--json"])).stdout.trim());
  assert.equal(validated.effectiveParallelism, 1);
  assert.equal(
    validated.warnings.some((warning) => warning.code === "fully-serialized-multi-lane"),
    true,
  );
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const done = await waitForStatus(runId, (status) => status.state === "review_pending");
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
