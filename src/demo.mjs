// The local walkthrough. Scaffolds a throwaway Git repository, writes a
// workflow whose planning block is genuinely current for it, and hands the
// path back so `run --detach` can launch it.
//
// The fixture under examples/ is a reference template: it cannot be launched
// as-is because a workflow needs a real repository and a base SHA that matches
// that repository right now. Rather than exempt the demo from the planning
// gate, this builds a repository the gate is satisfied by. The first command a
// new operator runs should prove the real pipeline, not a relaxed one.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

export const DEFAULT_DEMO_DIR = join(tmpdir(), "agent-manager-demo");

const SEED_README = `# agent-manager demo

A scratch repository created by \`agent-manager demo\`. Nothing here is
precious: the command deletes and rebuilds this directory every time.
`;

const SEED_AGENTS = `# Repository instructions (demo)

Lanes in this demo write one file each and nothing else.
`;

const CONTEXT = `Demo wave. Two independent lanes exercise the full pipeline
against a scratch repository: one writes a file and finishes, one asks the
operator a question and resumes from the answer. No model CLI is launched —
both lanes run on the built-in fake harness.
`;

/**
 * Build the scratch repository and its workflow.
 * Returns the paths a caller needs to launch it.
 */
export function createDemo({ dir = DEFAULT_DEMO_DIR, now = new Date() } = {}) {
  const repo = resolve(dir);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });

  const git = (...argv) =>
    execFileSync("git", ["-C", repo, ...argv], { encoding: "utf8", stdio: "pipe" });

  git("init", "--quiet");
  // A scratch repository must not depend on the operator's global Git identity,
  // or on their signing configuration, to produce its one commit.
  git("config", "user.name", "agent-manager demo");
  git("config", "user.email", "demo@agent-manager.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), SEED_README);
  writeFileSync(join(repo, "AGENTS.md"), SEED_AGENTS);
  git("add", "-A");
  git("commit", "--quiet", "-m", "demo: seed the scratch repository");
  const baseSha = git("rev-parse", "HEAD").trim();

  const workflow = {
    // Absolute, so the demo never depends on where AGENT_MANAGER_DEV_ROOT points.
    repo,
    title: "Agent Manager demo",
    repo_shorthand: "demo",
    harness_default: "fake",
    claim_mode: "off",
    integrate: true,
    policy: {
      allow_commit: false,
      allow_pr: false,
      poll_interval_ms: 100,
      stall_timeout_sec: 30,
    },
    planning: {
      source_refs: ["demo:local-walkthrough"],
      plan_ref: "demo:local-walkthrough",
      context: CONTEXT,
      // Current by construction: this is the commit just written above.
      reviewed_base_sha: baseSha,
      verified_by: "agent-manager demo",
      verified_at: now.toISOString(),
      reviewed_paths: ["**"],
      repository_instruction_refs: ["AGENTS.md"],
      attestations: {
        source_reviewed: true,
        repository_instructions_reviewed: true,
        relevant_code_reviewed: true,
        scope_verified: true,
      },
    },
    lanes: [
      {
        id: "demo-write",
        scope: "demo-output.txt",
        prompt: "Create the demo output.",
        fake: { write: { path: "demo-output.txt", content: "demo complete" } },
      },
      {
        id: "demo-question",
        scope: "demo-answer.txt",
        prompt: "Ask for a value, then resume.",
        fake: {
          needs_input: "Which value should the demo use?",
          resume: { write: { path: "demo-answer.txt", content: "operator answered" } },
        },
      },
    ],
  };

  const workflowPath = join(repo, "agent-manager.yaml");
  writeFileSync(workflowPath, YAML.stringify(workflow));
  return { schema: "agent-manager.demo.v1", repo, workflowPath, baseSha };
}

const MARKER = "demo.json";

/**
 * Record the fake-harness opt-in alongside the run that used it. Resuming a
 * demo lane is not a second decision, so a later `reply` re-enables the fake
 * harness for that run only, rather than making the operator re-declare it.
 */
export function markDemoRun(dir) {
  writeFileSync(join(dir, MARKER), JSON.stringify({ schema: "agent-manager.demo-run.v1" }) + "\n");
}

export function isDemoRun(dir) {
  return existsSync(join(dir, MARKER));
}

/**
 * Every previous demo run, newest first. The scratch repository is rebuilt on
 * each `demo`, so an earlier demo run is stale by construction — and left
 * active it would hold the edit scopes the new one needs, blocking admission.
 */
export function listDemoRuns(runsRoot) {
  return listRunIds(runsRoot).filter((runId) => isDemoRun(join(runsRoot, runId)));
}

/** Every run directory, newest first. */
export function listRunIds(runsRoot) {
  let entries = [];
  try {
    entries = readdirSync(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

/** States after which a run holds nothing and needs no retiring. */
export const TERMINAL_RUN_STATES = [
  "merged", "released", "filed", "reviewed", "cancelled", "rejected", "failed",
];

/** Apply a recorded demo opt-in to this process, if the run carries one. */
export function adoptDemoRun(dir) {
  if (!isDemoRun(dir)) return false;
  process.env.AGENT_MANAGER_DEMO = "1";
  return true;
}

export function formatDemo(scaffold, { launched = null } = {}) {
  const lines = [
    `demo repository: ${scaffold.repo}`,
    `demo workflow:   ${scaffold.workflowPath}`,
    `base commit:     ${scaffold.baseSha}`,
  ];
  if (launched) {
    lines.push(
      "",
      `launched ${launched} on the fake harness — no model CLI was started.`,
      "",
      "  agent-manager-fleet",
      `  agent-manager status ${launched}`,
      `  agent-manager reply ${launched} demo-question --message "Use blue"`,
      `  agent-manager review ${launched}`,
    );
  } else {
    lines.push(
      "",
      "not launched. Run it with:",
      "",
      `  AGENT_MANAGER_TEST_MODE=1 agent-manager run ${scaffold.workflowPath} --detach`,
    );
  }
  return lines.join("\n");
}
