import test from "node:test";
import assert from "node:assert/strict";
import { buildRunIdentity, shortRunId } from "../src/identity.mjs";

test("run identity creates a compact harness-neutral title and Manager metadata", () => {
  const identity = buildRunIdentity({
    runId: "run-20260805-120000-4fd91abc",
    workflow: {
      title: "Fleet telemetry",
      repo_shorthand: "agent-manager",
      repoRoot: "C:\\dev\\agent-manager",
      absPath: "C:\\dev\\agent-manager\\workflow.yaml",
      planning: { planRef: "plan-one" },
    },
    overrides: {
      managerHarness: "codex",
      managerModel: "gpt-5.6",
      managerModelSource: "cli",
    },
  });

  assert.equal(shortRunId("run-20260805-120000-4fd91abc"), "4fd91abc");
  assert.equal(identity.displayTitle, "[AM 4fd91abc] agent-manager · Fleet telemetry");
  assert.equal(identity.suggestedThreadTitle, identity.displayTitle);
  assert.deepEqual(identity.manager, {
    harness: "codex",
    model: "gpt-5.6",
    modelSource: "cli",
    threadTitle: null,
  });
});

test("run identity truncates native task titles without discarding the full subject", () => {
  const subject = "A very long subject ".repeat(8);
  const identity = buildRunIdentity({
    runId: "run-one",
    workflow: { title: subject, repo_shorthand: "repo", repoRoot: "repo", absPath: "run.yaml" },
  });
  assert.ok(identity.displayTitle.length <= 80);
  assert.equal(identity.subject, subject.trim().replace(/\s+/g, " "));
});
