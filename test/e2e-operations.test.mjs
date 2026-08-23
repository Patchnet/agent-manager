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

test("lane setup completes before the worker starts and records evidence", async () => {
  const runId = "run-test-lane-setup";
  const workflow = writeWorkflow("lane-setup", baseWorkflow([{
    id: "setup-writer",
    scope: "setup.txt",
    prompt: "write after setup",
    setup: {
      timeout_sec: 30,
      commands: [{ command: "node", args: ["--version"] }],
    },
    fake: { write: { path: "setup.txt", content: "ready\n" } },
  }]));

  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const status = await waitForStatus(runId, (item) => item.state === "delivery_review_pending");
  assert.equal(status.lanes[0].state, "done");
  assert.equal(status.lanes[0].setup.state, "passed");
  assert.equal(status.lanes[0].setup.commands[0].exitCode, 0);
  assert.deepEqual(status.lanes[0].setup.commands[0].command, ["node", "--version"]);
  assert.equal(readFileSync(join(status.lanes[0].worktree, "setup.txt"), "utf8"), "ready\n");
});

test("equivalent lanes reuse copied setup output without sharing mutable files", async () => {
  const runId = "run-test-lane-setup-cache";
  const sharedSetup = {
    timeout_sec: 30,
    commands: [{
      command: "node",
      args: ["-e", "require('node:fs').writeFileSync('AGENTS.md','cached setup output\\n')"],
    }],
  };
  const workflow = writeWorkflow("lane-setup-cache", baseWorkflow([
    {
      id: "cache-source",
      scope: "source.txt",
      prompt: "write source fixture",
      setup: sharedSetup,
      fake: { write: { path: "source.txt", content: "source\n" } },
    },
    {
      id: "cache-consumer",
      scope: "consumer.txt",
      prompt: "write consumer fixture",
      setup: sharedSetup,
      fake: { write: { path: "consumer.txt", content: "consumer\n" } },
    },
  ]));

  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const status = await waitForStatus(runId, (item) => item.state === "delivery_review_pending");
  const miss = status.lanes.find((lane) => lane.setup.cache?.outcome === "miss");
  const hit = status.lanes.find((lane) => lane.setup.cache?.outcome === "hit");
  assert.ok(miss);
  assert.ok(hit);
  assert.equal(miss.setup.cache.stored, true);
  assert.equal(hit.setup.cache.restored, true);
  assert.equal(hit.setup.commands[0].cached, true);
  assert.equal(readFileSync(join(hit.worktree, "AGENTS.md"), "utf8"), "cached setup output\n");

  writeFileSync(join(hit.worktree, "AGENTS.md"), "consumer mutation\n");
  assert.equal(readFileSync(join(miss.worktree, "AGENTS.md"), "utf8"), "cached setup output\n");
});

test("scope violations fail the lane and publish run_failed", async () => {
  const runId = "run-test-scope";
  const workflow = writeWorkflow("scope", baseWorkflow([
    {
      id: "scoped",
      scope: "allowed-only.txt",
      prompt: "write outside scope",
      fake: { write: { path: "outside.txt", content: "violation\n" } },
    },
  ]));
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const failed = await waitForStatus(runId, (status) => status.state === "failed");
  assert.deepEqual(failed.lanes[0].scopeViolations, ["outside.txt"]);
  assert.match(failed.lanes[0].lastActivity, /scope violation/);
  assert.equal(failed.lanes[0].claim.state, "released");
  await waitForFeed("run_failed", runId);
  await runCli(["cleanup", runId]);
});

test("manual integrate folds a successful lane and releases its integration claim", async () => {
  const runId = "run-test-integrate";
  const workflow = writeWorkflow("integrate", baseWorkflow([
    {
      id: "integration",
      scope: "integrated.txt",
      prompt: "write integration file",
      fake: { write: { path: "integrated.txt", content: "integrated\n" } },
    },
  ]));
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  await waitForStatus(runId, (status) => status.state === "delivery_review_pending" && !status.integrate);
  const integratedOutput = await runCli(["integrate", runId, "--json"]);
  const integrated = JSON.parse(integratedOutput.stdout.trim());
  assert.equal(integrated.state, "delivery_review_pending");
  assert.equal(integrated.integrate.state, "ready");
  assert.equal(integrated.integrate.claim.state, "released");
  assert.ok(existsSync(join(integrated.integrate.worktree, "integrated.txt")));
  await runCli(["cancel", runId]);
  await runCli(["cleanup", runId]);
});

test("failed integrated verification blocks delivery with command evidence", async () => {
  const runId = "run-test-verification-block";
  const workflow = writeWorkflow("verification-block", {
    ...baseWorkflow([
      {
        id: "implementation",
        scope: "verified.txt",
        prompt: "write verification fixture",
        fake: { write: { path: "verified.txt", content: "verify\n" } },
      },
    ]),
    verification: {
      commands: [{ command: "node", args: ["-e", "process.exit(9)"] }],
      timeout_sec: 10,
    },
  });
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  await waitForStatus(runId, (status) => status.state === "delivery_review_pending" && !status.integrate);
  const output = await runCli(["integrate", runId, "--json"]);
  const blocked = JSON.parse(output.stdout.trim());
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.endedAt, null);
  assert.equal(blocked.integrate.verification.state, "failed");
  assert.equal(blocked.integrate.verification.commands[0].exitCode, 9);
  assert.match(blocked.integrate.needsInput.prompt, /verification failed/);
  await runCli(["cancel", runId]);
  await runCli(["cleanup", runId]);
});

test("failed integration setup persists evidence, skips tests, and retries", async () => {
  const runId = "run-test-verification-setup-retry";
  const workflow = writeWorkflow("verification-setup-retry", {
    ...baseWorkflow([{
      id: "implementation",
      scope: "setup-retry.txt",
      prompt: "write setup retry fixture",
      fake: { write: { path: "setup-retry.txt", content: "retry\n" } },
    }]),
    verification: {
      setup: {
        commands: [{
          command: "node",
          args: [
            "-e",
            "const fs=require('node:fs');if(!fs.existsSync('setup-ready.txt'))process.exit(8);fs.writeFileSync('setup-count.txt','1')",
          ],
        }],
        timeout_sec: 10,
      },
      commands: [{
        command: "node",
        args: ["-e", "require('node:fs').writeFileSync('verification-ran.txt','ran')"],
      }],
      timeout_sec: 10,
    },
  });
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  await waitForStatus(runId, (status) => status.state === "delivery_review_pending" && !status.integrate);

  const firstOutput = await runCli(["integrate", runId, "--json"]);
  const first = JSON.parse(firstOutput.stdout.trim());
  assert.equal(first.state, "blocked");
  assert.equal(first.integrate.verification.setup.state, "failed");
  assert.equal(first.integrate.verification.setup.commands[0].exitCode, 8);
  assert.match(first.integrate.verification.setup.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof first.integrate.verification.setup.elapsedMs, "number");
  assert.deepEqual(first.integrate.verification.commands, []);
  assert.match(first.integrate.needsInput.prompt, /verification setup failed/);
  assert.equal(existsSync(join(first.integrate.worktree, "verification-ran.txt")), false);
  const persisted = JSON.parse(readFileSync(
    join(runsRoot, runId, "integrate", "verification.json"),
    "utf8",
  ));
  assert.deepEqual(persisted, first.integrate.verification);

  writeFileSync(join(first.integrate.worktree, "setup-ready.txt"), "ready\n");
  const retryOutput = await runCli(["integrate", runId, "--json"]);
  const retried = JSON.parse(retryOutput.stdout.trim());
  assert.equal(retried.state, "delivery_review_pending");
  assert.equal(retried.integrate.state, "ready");
  assert.equal(retried.integrate.verification.setup.state, "passed");
  assert.equal(retried.integrate.verification.state, "passed");
  assert.equal(readFileSync(join(retried.integrate.worktree, "setup-count.txt"), "utf8"), "1");
  assert.equal(readFileSync(join(retried.integrate.worktree, "verification-ran.txt"), "utf8"), "ran");
  await runCli(["cancel", runId]);
  await runCli(["cleanup", runId]);
});

test("integration retries reuse successful setup evidence at the same revision", async () => {
  const runId = "run-test-verification-setup-reuse";
  const workflow = writeWorkflow("verification-setup-reuse", {
    ...baseWorkflow([{
      id: "implementation",
      scope: "setup-reuse.txt",
      prompt: "write setup reuse fixture",
      fake: { write: { path: "setup-reuse.txt", content: "reuse\n" } },
    }]),
    verification: {
      setup: {
        commands: [{
          command: "node",
          args: [
            "-e",
            "const fs=require('node:fs');const p='setup-count.txt';const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1))",
          ],
        }],
        timeout_sec: 10,
      },
      commands: [{
        command: "node",
        args: ["-e", "process.exit(require('node:fs').existsSync('verification-ready.txt')?0:9)"],
      }],
      timeout_sec: 10,
    },
  });
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  await waitForStatus(runId, (status) => status.state === "delivery_review_pending" && !status.integrate);

  const firstOutput = await runCli(["integrate", runId, "--json"]);
  const first = JSON.parse(firstOutput.stdout.trim());
  assert.equal(first.integrate.verification.setup.state, "passed");
  assert.equal(first.integrate.verification.state, "failed");
  const setupStartedAt = first.integrate.verification.setup.startedAt;
  writeFileSync(join(first.integrate.worktree, "verification-ready.txt"), "ready\n");

  const retryOutput = await runCli(["integrate", runId, "--json"]);
  const retried = JSON.parse(retryOutput.stdout.trim());
  assert.equal(retried.integrate.state, "ready");
  assert.equal(retried.integrate.verification.setup.startedAt, setupStartedAt);
  assert.equal(readFileSync(join(retried.integrate.worktree, "setup-count.txt"), "utf8"), "1");
  await runCli(["cancel", runId]);
  await runCli(["cleanup", runId]);
});

test("blocked prerequisites resume before dependent lanes launch", async () => {
  const runId = "run-test-dependent-resume";
  const workflow = writeWorkflow("dependent-resume", baseWorkflow([
    {
      id: "approval",
      scope: "approved.txt",
      prompt: "request approval",
      fake: {
        needs_input: "Approve the contract?",
        resume: { write: { path: "approved.txt", content: "approved\n" } },
      },
    },
    {
      id: "consumer",
      depends_on: ["approval"],
      scope: "consumer-after-approval.txt",
      prompt: "consume approval",
      fake: {
        write: { path: "consumer-after-approval.txt", content: "consumed\n" },
      },
    },
  ]));
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const blocked = await waitForStatus(runId, (status) =>
    status.state === "blocked" &&
    status.lanes.find((lane) => lane.id === "approval")?.state === "blocked"
  );
  assert.equal(
    blocked.lanes.find((lane) => lane.id === "consumer").state,
    "dependency-waiting",
  );

  await runCli([
    "reply", runId, "approval", "--message", "Approved.", "--json",
  ]);
  const done = await waitForStatus(
    runId,
    (status) => status.state === "delivery_review_pending",
    40_000,
  );
  const consumer = done.lanes.find((lane) => lane.id === "consumer");
  assert.equal(consumer.state, "done");
  assert.deepEqual(consumer.dependenciesIntegrated, ["approval"]);
  assert.ok(existsSync(join(consumer.worktree, "approved.txt")));
  await runCli(["cancel", runId]);
  await runCli(["cleanup", runId]);
});

test("cancel remains authoritative and cleanup removes abandoned worktrees and logs", async () => {
  const runId = "run-test-cancel";
  const workflow = writeWorkflow("cancel", baseWorkflow([
    {
      id: "slow",
      scope: "slow.txt",
      prompt: "wait",
      fake: { delay_ms: 250, write: { path: "slow.txt", content: "late\n" } },
    },
  ]));
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const running = await waitForStatus(runId, (status) => status.lanes?.[0]?.state === "running");
  const worktree = running.lanes[0].worktree;
  await runCli(["cancel", runId, "--remove-worktrees"]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const cancelled = JSON.parse(readFileSync(join(runsRoot, runId, "status.json"), "utf8"));
  assert.equal(cancelled.state, "cancelled");
  assert.ok(cancelled.endedAt);
  await waitForFeed("run_failed", runId);

  cancelled.repo = ".";
  writeFileSync(join(runsRoot, runId, "status.json"), JSON.stringify(cancelled, null, 2));
  await runCli(["cleanup", runId]);
  const cleaned = JSON.parse(readFileSync(join(runsRoot, runId, "status.json"), "utf8"));
  assert.ok(cleaned.cleanup.at);
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(join(runsRoot, runId, "slow")), false);
  assert.equal(existsSync(join(runsRoot, runId, "status.json")), true);
});
