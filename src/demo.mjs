// A local walkthrough that exercises the real planning and run pipeline while
// using only the built-in fake harness.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import YAML from "yaml";

export const DEFAULT_DEMO_DIR = join(tmpdir(), "agent-manager-demo");

const SCRATCH_MARKER = ".agent-manager-demo.json";
const RUN_MARKER = "demo.json";
const SCRATCH_SCHEMA = "agent-manager.demo-scratch.v1";

const SEED_README = `# Agent Manager demo

This disposable repository was created by \`agent-manager demo\`.
`;

const SEED_AGENTS = `# Demo repository instructions

Each lane writes only its declared output file. Do not commit or ship changes.
`;

const CONTEXT = `A local walkthrough with two independent fake-harness lanes.
One lane writes a file and finishes. One lane asks the operator a question and
resumes after the answer. No model CLI or remote service is used.`;

/** Build a marker-owned scratch repository and a current workflow for it. */
export function createDemo({ dir = DEFAULT_DEMO_DIR, now = new Date() } = {}) {
  const repo = resolve(dir);
  prepareScratchDirectory(repo);

  writeFileSync(
    join(repo, SCRATCH_MARKER),
    JSON.stringify({ schema: SCRATCH_SCHEMA }, null, 2) + "\n",
  );
  writeFileSync(join(repo, "README.md"), SEED_README);
  writeFileSync(join(repo, "AGENTS.md"), SEED_AGENTS);

  const git = (...argv) => execFileSync("git", ["-C", repo, ...argv], {
    encoding: "utf8",
    stdio: "pipe",
  });
  git("init", "--quiet");
  // Repository-local identity keeps the demo independent of the operator's
  // global Git configuration and signing settings.
  git("config", "user.name", "agent-manager demo");
  git("config", "user.email", "agent-manager-demo.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "--quiet", "-m", "demo: seed scratch repository");
  const baseSha = git("rev-parse", "HEAD").trim();

  const workflow = {
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
      reviewed_base_sha: baseSha,
      verified_by: "agent-manager-demo",
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
        expected_outputs: ["demo-output.txt"],
        prompt: "Create the demo output.",
        fake: { write: { path: "demo-output.txt", content: "demo complete" } },
      },
      {
        id: "demo-question",
        scope: "demo-answer.txt",
        expected_outputs: ["demo-answer.txt"],
        prompt: "Ask for a value, then resume.",
        fake: {
          needs_input: "Which value should the demo use?",
          resume: {
            write: { path: "demo-answer.txt", content: "operator answered" },
          },
        },
      },
    ],
  };

  const workflowPath = join(repo, "agent-manager.yaml");
  writeFileSync(workflowPath, YAML.stringify(workflow));
  return { schema: "agent-manager.demo.v1", repo, workflowPath, baseSha };
}

/** True only for a directory created by this demo implementation. */
export function isDemoScratch(dir) {
  try {
    const marker = JSON.parse(readFileSync(join(resolve(dir), SCRATCH_MARKER), "utf8"));
    return marker?.schema === SCRATCH_SCHEMA;
  } catch {
    return false;
  }
}

/** Record that one run explicitly opted into the fake-harness demo. */
export function markDemoRun(dir) {
  writeFileSync(
    join(dir, RUN_MARKER),
    JSON.stringify({ schema: "agent-manager.demo-run.v1" }) + "\n",
  );
}

export function isDemoRun(dir) {
  try {
    const marker = JSON.parse(readFileSync(join(dir, RUN_MARKER), "utf8"));
    return marker?.schema === "agent-manager.demo-run.v1";
  } catch {
    return false;
  }
}

export function listDemoRuns(runsRoot) {
  return listRunIds(runsRoot).filter((runId) => isDemoRun(join(runsRoot, runId)));
}

export function listRunIds(runsRoot) {
  try {
    return readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/** Re-enable only the fake-harness permission for a recorded demo resume. */
export function adoptDemoRun(dir) {
  if (!isDemoRun(dir)) return false;
  process.env.AGENT_MANAGER_DEMO = "1";
  return true;
}

export function formatDemo(scaffold, { launched = null, retired = [] } = {}) {
  const lines = [
    `demo repository: ${scaffold.repo}`,
    `demo workflow:   ${scaffold.workflowPath}`,
    `base commit:     ${scaffold.baseSha}`,
  ];
  if (retired.length) lines.push(`retired runs:      ${retired.join(", ")}`);
  if (launched) {
    lines.push(
      "",
      `launched ${launched} with the fake harness; no model CLI was started.`,
      "",
      `  agent-manager status ${launched}`,
      `  agent-manager reply ${launched} demo-question --message "Use blue"`,
      `  agent-manager review ${launched}`,
    );
  } else {
    lines.push(
      "",
      "scaffolded only; the fake harness was not launched.",
      `Run \`agent-manager demo --dir "${scaffold.repo}"\` to rebuild and launch it.`,
    );
  }
  return lines.join("\n");
}

function prepareScratchDirectory(repo) {
  const root = parse(repo).root;
  if (repo === root || repo === resolve(tmpdir())) {
    throw new Error(`refusing to use a filesystem or temporary root as the demo directory: ${repo}`);
  }
  if (existsSync(repo)) {
    const entries = readdirSync(repo);
    if (entries.length && !isDemoScratch(repo)) {
      throw new Error(
        `refusing to replace an existing non-demo directory: ${repo}; ` +
        "choose a new --dir or remove its contents yourself",
      );
    }
    if (isDemoScratch(repo)) rmSync(repo, { recursive: true, force: true });
  }
  mkdirSync(repo, { recursive: true, mode: 0o700 });
}
