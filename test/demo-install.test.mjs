import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  createDemo,
  isDemoRun,
  listDemoRuns,
  listRunIds,
  markDemoRun,
  adoptDemoRun,
  TERMINAL_RUN_STATES,
} from "../src/demo.mjs";
import { hostNames, hostSkillsRoot, installCursor, installHost, INSTALLED_SKILLS } from "../src/install.mjs";
import { fakeHarnessAllowed } from "../src/constants.mjs";
import { loadWorkflow } from "../src/workflow.mjs";
import { assertPlanningReady } from "../src/planning.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ------------------------------------------------------------------- the demo

test("the demo scaffold is a real repository whose planning block is current", (t) => {
  const dir = join(scratch("am-demo-"), "repo");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scaffold = createDemo({ dir });

  assert.equal(scaffold.repo, resolve(dir));
  assert.ok(existsSync(scaffold.workflowPath));
  const head = execFileSync("git", ["-C", scaffold.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(scaffold.baseSha, head, "the recorded base must be the commit that exists");

  const doc = YAML.parse(readFileSync(scaffold.workflowPath, "utf8"));
  assert.equal(doc.planning.reviewed_base_sha, head);
  assert.equal(doc.harness_default, "fake");
  // The scratch path is absolute, so the demo never consults AGENT_MANAGER_DEV_ROOT.
  assert.ok(doc.repo.startsWith("/") || /^[A-Za-z]:/.test(doc.repo));
  for (const value of Object.values(doc.planning.attestations)) assert.equal(value, true);
});

test("the scaffolded workflow passes the real planning gate, unexempted", (t) => {
  const dir = join(scratch("am-demo-gate-"), "repo");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scaffold = createDemo({ dir });
  const workflow = loadWorkflow(scaffold.workflowPath);
  // This is the check that rejected the shipped fixture. It must pass here on
  // the merits, not because the demo skipped it.
  assert.doesNotThrow(() => assertPlanningReady(workflow));
});

test("a second demo rebuilds the repository and moves the base commit", (t) => {
  const dir = join(scratch("am-demo-twice-"), "repo");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  createDemo({ dir });
  writeFileSync(join(dir, "leftover.txt"), "from the previous demo\n");
  const second = createDemo({ dir });
  assert.ok(!existsSync(join(dir, "leftover.txt")), "the scratch repo is rebuilt, not reused");
  // Rebuilt repositories may reproduce a SHA byte-for-byte (same tree, author,
  // and second), which is harmless. What must hold is that the recorded base is
  // the commit this repository actually has right now.
  const head = execFileSync("git", ["-C", second.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(second.baseSha, head);
  assert.equal(execFileSync("git", ["-C", second.repo, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(), "1");
});

test("the demo commits without a global Git identity", (t) => {
  const dir = join(scratch("am-demo-identity-"), "repo");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scaffold = createDemo({ dir });
  const author = execFileSync("git", ["-C", scaffold.repo, "log", "-1", "--format=%an <%ae>"], { encoding: "utf8" }).trim();
  assert.equal(author, "agent-manager demo <demo@agent-manager.invalid>");
});

// ------------------------------------------------------- the fake-harness gate

test("the demo opt-in permits the fake harness without the test sandbox", () => {
  assert.equal(fakeHarnessAllowed({}), false);
  assert.equal(fakeHarnessAllowed({ AGENT_MANAGER_TEST_MODE: "1" }), true);
  assert.equal(fakeHarnessAllowed({ AGENT_MANAGER_DEMO: "1" }), true);
  // Anything else stays closed.
  assert.equal(fakeHarnessAllowed({ AGENT_MANAGER_DEMO: "yes" }), false);
});

test("a run records its demo opt-in so a later reply can resume it", (t) => {
  const runs = scratch("am-demo-runs-");
  t.after(() => rmSync(runs, { recursive: true, force: true }));
  const dir = join(runs, "run-1");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(runs, "run-2"), { recursive: true });
  assert.equal(isDemoRun(dir), false);
  markDemoRun(dir);
  assert.equal(isDemoRun(dir), true);
  assert.deepEqual(listDemoRuns(runs), ["run-1"]);
  assert.deepEqual(listRunIds(runs), ["run-2", "run-1"]);

  const previous = process.env.AGENT_MANAGER_DEMO;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_MANAGER_DEMO;
    else process.env.AGENT_MANAGER_DEMO = previous;
  });
  delete process.env.AGENT_MANAGER_DEMO;
  assert.equal(adoptDemoRun(join(runs, "run-2")), false);
  assert.equal(process.env.AGENT_MANAGER_DEMO, undefined);
  assert.equal(adoptDemoRun(dir), true);
  assert.equal(process.env.AGENT_MANAGER_DEMO, "1");
});

test("listing runs tolerates a runs root that does not exist yet", () => {
  assert.deepEqual(listRunIds(join(tmpdir(), "am-nope-" + process.pid)), []);
  assert.ok(TERMINAL_RUN_STATES.includes("cancelled"));
});

// ----------------------------------------------------------------- installing

test("install writes both skills for every supported host", (t) => {
  const home = scratch("am-install-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const host of hostNames()) {
    const result = installHost(host, { home });
    assert.equal(result.host, host);
    assert.equal(result.installed.length, INSTALLED_SKILLS.length);
    for (const skill of INSTALLED_SKILLS) {
      assert.ok(existsSync(join(hostSkillsRoot(host, { home }), skill, "SKILL.md")), `${host}/${skill}`);
    }
  }
  // Claude Code was the gap this closes.
  assert.ok(existsSync(join(home, ".claude", "skills", "agent-manager", "SKILL.md")));
});

test("install refuses to clobber an existing skill unless forced", (t) => {
  const home = scratch("am-install-force-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  installHost("claude", { home });
  assert.throws(() => installHost("claude", { home }), /already exists/);
  assert.doesNotThrow(() => installHost("claude", { home, force: true }));
});

test("an unknown host names the ones that exist", () => {
  assert.throws(() => installHost("emacs"), /unknown host: emacs; supported: claude, codex, cursor/);
  assert.throws(() => hostSkillsRoot("emacs"), /unknown host/);
});

test("installCursor still works and still carries the project rule", (t) => {
  const home = scratch("am-install-cursor-");
  const project = scratch("am-install-project-");
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
  assert.equal(installCursor({ home }).host, "cursor");
  const scoped = installHost("cursor", { home, project });
  assert.ok(scoped.installed.some((p) => p.endsWith(join("rules", "agent-manager.mdc"))));
  // Only Cursor has a rule; Claude must not invent one.
  const claude = installHost("claude", { home, project });
  assert.ok(!claude.installed.some((p) => p.includes(join("rules", ""))));
});

test("the packaged skills the installer copies actually exist", () => {
  for (const skill of INSTALLED_SKILLS) {
    assert.ok(existsSync(join(ROOT, "skills", skill, "SKILL.md")), skill);
  }
});
