import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  adoptDemoRun,
  createDemo,
  isDemoRun,
  isDemoScratch,
  listDemoRuns,
  listRunIds,
  markDemoRun,
} from "../src/demo.mjs";
import { fakeHarnessAllowed } from "../src/constants.mjs";
import { formatDoctor, runDoctor } from "../src/doctor.mjs";
import {
  hostNames,
  hostSkillsRoot,
  installCursor,
  installHost,
  INSTALLED_SKILLS,
} from "../src/install.mjs";
import { assertPlanningReady } from "../src/planning.mjs";
import { loadWorkflow } from "../src/workflow.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "agent-manager.mjs");

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("demo creates a real repository with current planning", (t) => {
  const parent = scratch("am-demo-");
  const dir = join(parent, "repo");
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const scaffold = createDemo({ dir });
  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const workflow = loadWorkflow(scaffold.workflowPath);

  assert.equal(scaffold.repo, resolve(dir));
  assert.equal(scaffold.baseSha, head);
  assert.equal(workflow.planning.reviewed_base_sha, head);
  assert.equal(workflow.harness_default, "fake");
  assert.equal(workflow.lanes.every((lane) => lane.expected_outputs.length === 1), true);
  assert.doesNotThrow(() => assertPlanningReady(workflow));
  assert.equal(isDemoScratch(dir), true);
});

test("demo is repeatable only for its own marker-owned directory", (t) => {
  const parent = scratch("am-demo-repeat-");
  const dir = join(parent, "repo");
  const unrelated = join(parent, "unrelated");
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  createDemo({ dir });
  writeFileSync(join(dir, "leftover.txt"), "old demo data\n");
  const second = createDemo({ dir });
  assert.equal(existsSync(join(dir, "leftover.txt")), false);
  assert.equal(second.baseSha, execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim());

  mkdirSync(unrelated);
  writeFileSync(join(unrelated, "keep.txt"), "keep\n");
  assert.throws(() => createDemo({ dir: unrelated }), /refusing to replace an existing non-demo directory/);
  assert.equal(readFileSync(join(unrelated, "keep.txt"), "utf8"), "keep\n");
  assert.throws(() => createDemo({ dir: tmpdir() }), /refusing to use a filesystem or temporary root/);
});

test("demo uses repository-local identity instead of global Git settings", (t) => {
  const parent = scratch("am-demo-identity-");
  const dir = join(parent, "repo");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  createDemo({ dir });
  const author = execFileSync("git", ["-C", dir, "log", "-1", "--format=%an|%ae"], {
    encoding: "utf8",
  }).trim();
  assert.equal(author, "agent-manager demo|agent-manager-demo.invalid");
});

test("fake harness requires the test or explicit demo opt-in", () => {
  assert.equal(fakeHarnessAllowed({}), false);
  assert.equal(fakeHarnessAllowed({ AGENT_MANAGER_TEST_MODE: "1" }), true);
  assert.equal(fakeHarnessAllowed({ AGENT_MANAGER_DEMO: "1" }), true);
  assert.equal(fakeHarnessAllowed({ AGENT_MANAGER_DEMO: "yes" }), false);
});

test("recorded demo runs restore fake-harness permission for resume", (t) => {
  const runs = scratch("am-demo-runs-");
  t.after(() => rmSync(runs, { recursive: true, force: true }));
  const dir = join(runs, "run-1");
  mkdirSync(dir);
  mkdirSync(join(runs, "run-2"));
  markDemoRun(dir);

  assert.equal(isDemoRun(dir), true);
  assert.deepEqual(listDemoRuns(runs), ["run-1"]);
  assert.deepEqual(listRunIds(runs), ["run-2", "run-1"]);
  assert.deepEqual(listRunIds(join(runs, "missing")), []);

  const previous = process.env.AGENT_MANAGER_DEMO;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_MANAGER_DEMO;
    else process.env.AGENT_MANAGER_DEMO = previous;
  });
  delete process.env.AGENT_MANAGER_DEMO;
  assert.equal(adoptDemoRun(join(runs, "run-2")), false);
  assert.equal(adoptDemoRun(dir), true);
  assert.equal(process.env.AGENT_MANAGER_DEMO, "1");
});

test("demo --no-run stays in a caller-selected scratch directory", (t) => {
  const parent = scratch("am-demo-cli-");
  const dir = join(parent, "repo");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const output = execFileSync(process.execPath, [CLI, "demo", "--dir", dir, "--no-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, AGENT_MANAGER_TEST_MODE: "1" },
  });
  const result = JSON.parse(output);
  assert.equal(result.repo, resolve(dir));
  assert.equal(result.runId, undefined);
  assert.equal(isDemoScratch(dir), true);
});

test("install is idempotent for Claude, Codex, and Cursor", (t) => {
  const home = scratch("am-install-");
  t.after(() => rmSync(home, { recursive: true, force: true }));

  assert.deepEqual(hostNames(), ["claude", "codex", "cursor"]);
  for (const host of hostNames()) {
    const first = installHost(host, { home });
    const second = installHost(host, { home });
    assert.equal(first.results.every((item) => item.action === "installed"), true);
    assert.equal(second.results.every((item) => item.action === "unchanged"), true);
    for (const skill of INSTALLED_SKILLS) {
      assert.equal(existsSync(join(hostSkillsRoot(host, { home }), skill, "SKILL.md")), true);
    }
  }
});

test("install protects local changes and replaces them only with --force", (t) => {
  const home = scratch("am-install-force-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  installHost("claude", { home });
  const changed = join(hostSkillsRoot("claude", { home }), "agent-manager", "SKILL.md");
  writeFileSync(changed, "local change\n");

  assert.throws(
    () => installHost("claude", { home }),
    /differs from the bundled version.*--force to replace/s,
  );
  const forced = installHost("claude", { home, force: true });
  assert.equal(forced.results.some((item) => item.action === "replaced"), true);
  assert.notEqual(readFileSync(changed, "utf8"), "local change\n");
});

test("install validates every target before making changes", (t) => {
  const home = scratch("am-install-atomic-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const skills = hostSkillsRoot("claude", { home });
  const modified = join(skills, "pr-manager");
  mkdirSync(modified, { recursive: true });
  writeFileSync(join(modified, "SKILL.md"), "local skill\n");

  assert.throws(() => installHost("claude", { home }), /differs from the bundled version/);
  assert.equal(existsSync(join(skills, "agent-manager")), false);
});

test("Claude and Codex CLI installers copy bundled files without network access", (t) => {
  const parent = scratch("am-install-cli-");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  for (const host of ["claude", "codex"]) {
    const project = join(parent, host);
    mkdirSync(project);
    const output = execFileSync(process.execPath, [
      CLI, "install", host, "--project", project, "--json",
    ], { cwd: ROOT, encoding: "utf8" });
    const result = JSON.parse(output);
    assert.equal(result.host, host);
    assert.equal(result.scope, "project");
    assert.equal(result.results.length, INSTALLED_SKILLS.length);
    assert.equal(result.results.every((item) => item.path.startsWith(project)), true);
  }
});

test("unsupported installer output is actionable", () => {
  assert.throws(() => installHost("emacs"), /supported: claude, codex, cursor/);
  const result = spawnSync(process.execPath, [CLI, "install", "emacs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /install requires one of: claude, codex, cursor/);
});

test("first-run commands reject incomplete and unknown flags", () => {
  const install = spawnSync(process.execPath, [CLI, "install", "claude", "--project", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.notEqual(install.status, 0);
  assert.match(install.stderr, /--project requires a path/);

  const demo = spawnSync(process.execPath, [CLI, "demo", "--dir", "--no-run"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.notEqual(demo.status, 0);
  assert.match(demo.stderr, /--dir requires a path/);
});

test("legacy Cursor helper still installs its project rule", (t) => {
  const home = scratch("am-install-cursor-");
  const project = scratch("am-install-project-");
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
  assert.equal(installCursor({ home }).host, "cursor");
  const scoped = installHost("cursor", { home, project });
  assert.equal(scoped.results.some((item) => item.kind === "rule"), true);
});

test("Doctor gives the exact host-skill install action", (t) => {
  const home = scratch("am-doctor-host-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const before = runDoctor({ repo: ROOT, home });
  const missing = before.checks.find((check) => check.name === "host skill");
  assert.equal(missing.ok, false);
  assert.match(missing.recommendation, /agent-manager install claude \(or codex or cursor\)/);
  assert.match(
    formatDoctor(before),
    /fix: install one explicitly: agent-manager install claude \(or codex or cursor\)/,
  );

  installHost("codex", { home });
  const after = runDoctor({ repo: ROOT, home });
  assert.equal(after.checks.find((check) => check.name === "host skill").detail, "installed for: codex");
});

test("the reference fake workflow remains a documented placeholder", () => {
  const text = readFileSync(join(ROOT, "examples", "fake-demo.yaml"), "utf8");
  const doc = YAML.parse(text);
  assert.equal(doc.repo, "replace-with-absolute-repository-path");
  assert.equal(doc.harness_default, "fake");
  assert.match(text, /agent-manager demo/);
});
