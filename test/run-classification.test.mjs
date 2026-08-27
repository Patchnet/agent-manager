import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createE2eFixture } from "../test-support/e2e-fixture.mjs";
import { buildFleetSnapshot, formatFleetBoard } from "../src/fleet.mjs";
import { listBrainIntents, canonicalRepoIdentity } from "../src/brain.mjs";

const fixture = await createE2eFixture();
const {
  root,
  runsRoot,
  brainRoot,
  repo,
  claimLog,
  writeWorkflow,
  runCli,
  waitForStatus,
  baseWorkflow,
} = fixture;

test.after(async () => fixture.close());

function laneFor(name) {
  const path = `purpose-${name}.txt`;
  return {
    id: `purpose-${name}`,
    scope: path,
    prompt: `record ${name}`,
    fake: { write: { path, content: `${name}\n` } },
  };
}

function currentWorkflow(name, classification, parentRunId = null) {
  const currentBase = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const workflow = {
    ...baseWorkflow([laneFor(name)]),
    base_ref: currentBase,
    classification,
  };
  workflow.planning = {
    ...workflow.planning,
    reviewed_base_sha: currentBase,
  };
  if (parentRunId) workflow.parent_run_id = parentRunId;
  return writeWorkflow(`classification-${name}`, workflow);
}

test("new run classifications and lineage survive every public record", async () => {
  const runIds = {
    operational: "run-purpose-operational",
    benchmark: "run-purpose-benchmark",
    demo: "run-purpose-demo",
    retry: "run-purpose-retry",
    recovery: "run-purpose-recovery",
  };

  const ordinary = writeWorkflow("classification-default", baseWorkflow([laneFor("operational")]));
  const ordinaryLaunch = JSON.parse((await runCli([
    "run", ordinary, "--detach", "--json", "--run-id", runIds.operational,
  ])).stdout);
  assert.equal(ordinaryLaunch.classification, "operational");
  assert.equal(ordinaryLaunch.lineage, null);
  const parent = await waitForStatus(
    runIds.operational,
    (status) => status.state === "delivery_review_pending" && status.feed?.lastEvent === "workers_done",
  );
  assert.equal(parent.classification, "operational");
  const parentPath = join(runsRoot, runIds.operational, "status.json");
  const parentBeforeChildren = readFileSync(parentPath, "utf8");

  writeFileSync(join(repo, "newer-base.txt"), "recovery may use this newer base\n");
  execFileSync("git", ["-C", repo, "add", "newer-base.txt"]);
  execFileSync("git", [
    "-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "test: newer recovery base",
  ]);

  for (const classification of ["benchmark", "demo", "retry", "recovery"]) {
    const parentRunId = ["retry", "recovery"].includes(classification)
      ? runIds.operational
      : null;
    const workflow = currentWorkflow(classification, classification, parentRunId);
    const launch = JSON.parse((await runCli([
      "run", workflow, "--detach", "--json", "--run-id", runIds[classification],
    ])).stdout);
    assert.equal(launch.classification, classification);
    assert.deepEqual(launch.lineage, parentRunId ? {
      parentRunId,
      relationship: classification,
    } : null);
    await waitForStatus(runIds[classification], (status) => status.state === "delivery_review_pending");
  }

  assert.equal(
    readFileSync(parentPath, "utf8"),
    parentBeforeChildren,
    "starting retry and recovery runs must not rewrite the parent",
  );

  const intents = await listBrainIntents({ root: brainRoot });
  const recoveryStatus = JSON.parse(
    readFileSync(join(runsRoot, runIds.recovery, "status.json"), "utf8"),
  );
  assert.notEqual(
    recoveryStatus.baseCommit,
    parent.baseCommit,
    "recovery must be allowed to launch from a newer base than its parent",
  );
  for (const [classification, runId] of Object.entries(runIds)) {
    const status = JSON.parse(readFileSync(join(runsRoot, runId, "status.json"), "utf8"));
    const metadata = JSON.parse(readFileSync(join(runsRoot, runId, "meta.json"), "utf8"));
    const report = readFileSync(join(runsRoot, runId, "report.md"), "utf8");
    const fleet = buildFleetSnapshot({ runId }, { runsRoot, now: () => Date.now() });
    const intent = intents.find((candidate) => candidate.runId === runId);

    assert.equal(status.classification, classification);
    assert.equal(metadata.classification, classification);
    assert.match(report, new RegExp(`classification:\\*\\* ${classification}`));
    assert.equal(fleet.runs[0].classification, classification);
    assert.equal(intent.classification, classification);
    if (["retry", "recovery"].includes(classification)) {
      const expected = { parentRunId: runIds.operational, relationship: classification };
      assert.deepEqual(status.lineage, expected);
      assert.deepEqual(metadata.lineage, expected);
      assert.deepEqual(fleet.runs[0].lineage, expected);
      assert.deepEqual(intent.lineage, expected);
    }
  }
});

test("invalid purpose and lineage fail before run-side resources", async () => {
  const workflow = currentWorkflow("invalid", "operational");
  const claimsBefore = existsSync(claimLog) ? readFileSync(claimLog, "utf8") : "";
  const intentsBefore = await listBrainIntents({ root: brainRoot });

  await assert.rejects(
    runCli([
      "run", workflow, "--detach", "--json", "--run-id", "run-invalid-classification",
      "--classification", "production",
    ]),
    /run classification must be one of/,
  );
  assert.equal(existsSync(join(runsRoot, "run-invalid-classification")), false);

  await assert.rejects(
    runCli([
      "run", workflow, "--detach", "--json", "--run-id", "run-missing-parent",
      "--classification", "retry", "--parent-run", "run-does-not-exist",
    ]),
    /parent run not found locally/,
  );
  assert.equal(existsSync(join(runsRoot, "run-missing-parent")), false);

  const otherRepo = join(root, "other-repo");
  mkdirSync(otherRepo);
  execFileSync("git", ["init", "-b", "main", otherRepo]);
  writeFileSync(join(otherRepo, "README.md"), "other\n");
  execFileSync("git", ["-C", otherRepo, "add", "README.md"]);
  execFileSync("git", [
    "-C", otherRepo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "base",
  ]);
  execFileSync("git", ["-C", otherRepo, "remote", "add", "origin", otherRepo]);
  const crossParent = "run-cross-repo-parent";
  mkdirSync(join(runsRoot, crossParent));
  writeFileSync(join(runsRoot, crossParent, "status.json"), JSON.stringify({
    runId: crossParent,
    repoRoot: otherRepo,
    awareness: { repoKey: canonicalRepoIdentity(otherRepo).key },
  }));

  await assert.rejects(
    runCli([
      "run", workflow, "--detach", "--json", "--run-id", "run-cross-repo-child",
      "--classification", "recovery", "--parent-run", crossParent,
    ]),
    /same canonical repository/,
  );
  assert.equal(existsSync(join(runsRoot, "run-cross-repo-child")), false);
  assert.equal(existsSync(claimLog) ? readFileSync(claimLog, "utf8") : "", claimsBefore);
  assert.equal((await listBrainIntents({ root: brainRoot })).length, intentsBefore.length);
});

test("legacy records display and filter as unknown without being reclassified", () => {
  const runId = "run-legacy-purpose";
  const dir = join(runsRoot, runId);
  mkdirSync(dir);
  writeFileSync(join(dir, "status.json"), JSON.stringify({
    runId,
    state: "released",
    repo: "fixture-repo",
    startedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    endedAt: "2026-08-01T01:00:00.000Z",
    lanes: [],
  }, null, 2));
  const now = () => Date.parse("2026-08-01T02:00:00.000Z");
  const snapshot = buildFleetSnapshot({ classification: "unknown" }, { runsRoot, now });
  assert.equal(snapshot.runs.some((run) => run.runId === runId), true);
  assert.equal(snapshot.runs.find((run) => run.runId === runId).classification, "unknown");
  assert.match(formatFleetBoard(snapshot, { color: false }), /\[unknown\]/);
  const stored = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  assert.equal(Object.hasOwn(stored, "classification"), false);
});
