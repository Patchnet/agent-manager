import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedRoot, useIsolatedRoots } from "../test-support/isolated-roots.mjs";

const root = isolatedRoot("ship-");
useIsolatedRoots(root);
test.after(() => rmSync(root, { recursive: true, force: true }));

const { hasGate, shipRun, tierForChange } = await import("../src/ship.mjs?ship");
const { readStatus, writeStatus } = await import("../src/status.mjs?ship");
const { readEvents } = await import("../src/events.mjs?ship");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
const remote = join(root, "remote.git");
const seed = join(root, "seed");
git(root, "init", "--bare", "-b", "main", remote);
git(root, "init", "-b", "main", seed);
for (const cwd of [seed]) {
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.invalid");
}
mkdirSync(join(seed, ".github"), { recursive: true });
writeFileSync(join(seed, ".github", "ship-tiers.yml"), "default: 1\ntier2:\n  - \"secrets/**\"\ntier0:\n  - \"docs/**\"\n");
writeFileSync(join(seed, "README.md"), "base\n");
git(seed, "add", "-A");
git(seed, "commit", "-m", "base");
git(seed, "remote", "add", "origin", remote);
git(seed, "push", "origin", "main");

let counter = 0;
function seedRun(files, { flow = "simple", verdict = "accept" } = {}) {
  counter += 1;
  const runId = `run-ship-${counter}`;
  const worktree = join(root, `wt-${counter}`);
  git(root, "clone", "-q", remote, worktree);
  git(worktree, "config", "user.name", "Test");
  git(worktree, "config", "user.email", "test@example.invalid");
  git(worktree, "checkout", "-q", "-b", `am/${runId}/integrate`);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(worktree, path, ".."), { recursive: true });
    writeFileSync(join(worktree, path), body);
  }
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "wip(lane): snapshot");
  writeStatus(runId, {
    runId, repo: "app", state: "ship_pending", target_dev_flow: flow,
    identity: { subject: "Ship test" }, lanes: [],
    delivery: {
      mode: "single",
      review: { verdict, reviewer: "rev-1", notes: null, decidedAt: "t", history: [] },
      targets: [{
        id: "integrate", laneId: "integrate", branch: `am/${runId}/integrate`, base: "main",
        worktree, changedFiles: Object.keys(files), state: "changes_ready", pr: null, prUrl: null,
        tier: null, autoMerge: false, waitingOperator: null, mergeSha: null, mergedAt: null,
      }],
    },
  });
  return { runId, worktree };
}

test("tier policy is read from the base branch, not from the change", () => {
  const { worktree } = seedRun({ ".github/ship-tiers.yml": "default: 0\n", "src/a.ts": "x\n" });
  const tier = tierForChange(worktree, "origin/main");
  assert.equal(tier.tier, 2, "editing the tiers file is tier 2 under the base policy");
  assert.equal(tier.tiersFile, ".github/ship-tiers.yml");
});

test("Simple Flow ships a tier 1 change as one commit on main and closes the run", () => {
  const { runId } = seedRun({ "src/feature.ts": "export const x = 1;\n" });
  const result = shipRun(runId, { message: "feat: add feature" });
  const head = git(remote, "rev-parse", "main");
  const target = result.status.delivery.targets[0];
  assert.equal(result.status.state, "merged");
  assert.equal(target.tier, 1);
  assert.equal(target.mergeSha, head);
  assert.equal(git(remote, "log", "-1", "--format=%s", "main"), "feat: add feature", "lane snapshots are squashed");
  assert.match(result.lines[0], /tier 1 · merged/);
  assert.deepEqual(readEvents({ runId }).map((event) => event.kind), ["review_verdict", "merged", "run_closed"]);
});

test("a tier 2 path ships without an approval step and records no approver", () => {
  const { runId } = seedRun({ "secrets/key-rotation.md": "rotate\n" });
  const result = shipRun(runId, { message: "chore: rotate keys", approvedBy: "operator" });
  const target = result.status.delivery.targets[0];
  assert.equal(result.status.state, "merged");
  assert.equal(target.tier, 2);
  assert.equal(target.approvedBy, undefined);
  assert.equal(target.mergeSha, git(remote, "rev-parse", "main"));
  assert.match(result.lines[0], /tier 2 · merged/);
  assert.deepEqual(readEvents({ runId }).filter((event) => event.kind === "waiting_operator"), []);
});

test("Simple Flow rebases onto a moved main", () => {
  const { runId } = seedRun({ "docs/guide.md": "guide\n" });
  writeFileSync(join(seed, "OTHER.md"), "landed meanwhile\n");
  git(seed, "pull", "-q", "origin", "main");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "other");
  git(seed, "push", "-q", "origin", "main");
  const result = shipRun(runId, { message: "docs: guide" });
  assert.equal(result.status.delivery.targets[0].tier, 0);
  assert.equal(git(remote, "log", "-2", "--format=%s", "main"), "docs: guide\nother");
});

test("ship refuses without an accepted review or a Simple Flow message", () => {
  const unreviewed = seedRun({ "src/b.ts": "b\n" }, { verdict: null });
  assert.throws(() => shipRun(unreviewed.runId, { message: "feat: b" }), /no accepted review/);
  const { runId } = seedRun({ "src/c.ts": "c\n" });
  assert.throws(() => shipRun(runId, {}), /pass --message/);
  assert.equal(readStatus(runId).state, "ship_pending");
});

// Moves main to `files` (path to body, null removes it), runs `use`, then restores them.
function withBase(files, use) {
  const paths = Object.keys(files);
  const original = paths.map((path) => (existsSync(join(seed, path)) ? readFileSync(join(seed, path)) : null));
  const setFiles = (bodies, subject) => {
    git(seed, "pull", "-q", "--rebase", "origin", "main");
    paths.forEach((path, index) => {
      const file = join(seed, path);
      mkdirSync(join(file, ".."), { recursive: true });
      if (bodies[index] === null) rmSync(file, { force: true });
      else writeFileSync(file, bodies[index]);
    });
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", subject);
    git(seed, "push", "-q", "origin", "main");
  };
  setFiles(Object.values(files), "chore: change base");
  try {
    return use();
  } finally {
    setFiles(original, "chore: restore base");
  }
}
const withBasePolicy = (body, use) => withBase({ ".github/ship-tiers.yml": body }, use);

for (const [label, body, reason] of [
  ["missing", null, /no \.github\/ship-tiers\.yml/],
  ["empty", "# nothing yet\n", /ship-tiers\.yml is empty/],
  ["malformed", "default: 9\n", /default must be 0, 1, or 2/],
]) {
  test(`Simple Flow stops on a ${label} policy, then ships on operator approval`, () => {
    withBasePolicy(body, () => {
      const { runId } = seedRun({ [`src/${label}.ts`]: "x\n" });
      const before = git(remote, "rev-parse", "main");
      const waiting = shipRun(runId, { message: "feat: plain" });
      const target = waiting.status.delivery.targets[0];
      assert.equal(waiting.status.state, "waiting_operator");
      assert.equal(git(remote, "rev-parse", "main"), before, "nothing reaches main");
      assert.equal(target.tier, null);
      assert.match(target.policyProblem, reason);
      assert.match(waiting.lines[0], /waiting: Ship policy: /);
      assert.doesNotMatch(waiting.lines[0], /tier 1/);

      const shipped = shipRun(runId, { message: "feat: plain", approvedBy: "operator" });
      assert.equal(shipped.status.state, "merged");
      assert.equal(shipped.status.delivery.targets[0].approvedBy, "operator");
    });
  });
}

// A scripted `gh` (AGENT_MANAGER_GH_BIN) that keeps PR state in a JSON file.
const ghState = join(root, "gh-state.json");
const ghBin = join(root, "fake-gh.mjs");
writeFileSync(ghBin, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const path = process.env.FAKE_GH_STATE;
const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { prs: [], calls: [] };
const args = process.argv.slice(2);
state.calls.push(args.join(" "));
const value = (name) => args[args.indexOf(name) + 1];
const pr = (n) => state.prs.find((item) => String(item.number) === String(n));
let out = "";
if (args[0] === "pr" && args[1] === "list") out = JSON.stringify(state.prs.filter((item) => item.head === value("--head")));
if (args[0] === "pr" && args[1] === "create") {
  const number = state.prs.length + 1;
  state.prs.push({ number, url: "https://example.invalid/pull/" + number, state: "OPEN", head: value("--head"), autoMerge: false });
}
if (args[0] === "pr" && args[1] === "merge") pr(args[2]).autoMerge = args.includes("--auto");
if (args[0] === "pr" && args[1] === "view") out = JSON.stringify({ state: pr(args[2]).state, mergeCommit: pr(args[2]).mergeCommit || null, mergedAt: null });
writeFileSync(path, JSON.stringify(state));
process.stdout.write(out);
`);

test("Formal Flow arms auto-merge for tier 1 and keeps it armed when new commits reach tier 2", () => {
  process.env.AGENT_MANAGER_GH_BIN = ghBin;
  process.env.FAKE_GH_STATE = ghState;
  try {
    const { runId, worktree } = seedRun({ "src/formal.ts": "f\n" }, { flow: "formal" });
    const first = shipRun(runId, { message: "feat: formal" });
    const target = first.status.delivery.targets[0];
    assert.equal(first.status.state, "shipping");
    assert.equal(target.tier, 1);
    assert.equal(target.autoMerge, true);
    assert.equal(git(remote, "rev-parse", target.branch), target.pushedSha, "the delivery branch was pushed");
    assert.match(first.lines[0], /tier 1 · PR https:\/\/example\.invalid\/pull\/1 · auto-merge armed/);

    mkdirSync(join(worktree, "secrets"), { recursive: true });
    writeFileSync(join(worktree, "secrets", "x.md"), "tier 2 now\n");
    const second = shipRun(runId, { message: "feat: formal" });
    const raised = second.status.delivery.targets[0];
    assert.equal(raised.tier, 2);
    assert.equal(raised.autoMerge, true);
    assert.equal(second.status.state, "shipping");
    const state = JSON.parse(readFileSync(ghState, "utf8"));
    assert.ok(state.calls.includes("pr edit 1 --add-label tier:2"));
    assert.ok(!state.calls.some((call) => call.endsWith("--disable-auto")));
  } finally {
    delete process.env.AGENT_MANAGER_GH_BIN;
    delete process.env.FAKE_GH_STATE;
  }
});

test("Formal Flow disarms auto-merge when the base loses its policy", () => {
  process.env.AGENT_MANAGER_GH_BIN = ghBin;
  process.env.FAKE_GH_STATE = join(root, "gh-state-policy.json");
  try {
    const { runId } = seedRun({ "src/armed.ts": "a\n" }, { flow: "formal" });
    assert.equal(shipRun(runId, { message: "feat: armed" }).status.delivery.targets[0].autoMerge, true);
    withBasePolicy(null, () => {
      const stopped = shipRun(runId, { message: "feat: armed" });
      const target = stopped.status.delivery.targets[0];
      assert.equal(stopped.status.state, "waiting_operator");
      assert.equal(target.autoMerge, false);
      assert.match(target.waitingOperator, /Ship policy: no \.github\/ship-tiers\.yml/);
      const state = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, "utf8"));
      assert.ok(state.calls.some((call) => call.endsWith("--disable-auto")));
    });
  } finally {
    delete process.env.AGENT_MANAGER_GH_BIN;
    delete process.env.FAKE_GH_STATE;
  }
});

// A fictional gate: it logs its arguments and fails when FAKE_GATE_RED is set.
const gateFiles = {
  "pipeline.json": "{ \"gate\": [\"unit\"] }\n",
  "scripts/quality.mjs": `import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_GATE_LOG, process.argv.slice(2).join(" ") + "\\n");
if (process.env.FAKE_GATE_RED) {
  console.log("unit: 1 failed");
  process.exit(1);
}
`,
};
const gateLog = join(root, "gate.log");

function withGate(extra, use) {
  process.env.FAKE_GATE_LOG = gateLog;
  rmSync(gateLog, { force: true });
  try {
    return withBase({ ...gateFiles, ...extra }, use);
  } finally {
    delete process.env.FAKE_GATE_LOG;
  }
}

test("a gated repository with no policy ships through the gate with no approval", () => {
  withGate({ ".github/ship-tiers.yml": null }, () => {
    const { runId, worktree } = seedRun({ "src/gated.ts": "g\n" });
    assert.equal(hasGate(worktree, "origin/main"), true);
    const result = shipRun(runId, { message: "feat: gated" });
    const target = result.status.delivery.targets[0];
    assert.equal(result.status.state, "merged");
    assert.equal(target.gated, true);
    assert.equal(target.tier, null);
    assert.equal(target.policyProblem, null);
    assert.equal(target.mergeSha, git(remote, "rev-parse", "main"));
    assert.match(result.lines[0], /· gate · merged /);
    assert.equal(readFileSync(gateLog, "utf8").trim(), "--range origin/main..HEAD");
    assert.ok(!readEvents({ runId }).some((event) => "tier" in event));
  });
});

test("the gate wins over a tier policy, so a tier 2 path pushes with no approval", () => {
  withGate({}, () => {
    const { runId } = seedRun({ "secrets/gated.md": "g\n" });
    const result = shipRun(runId, { message: "chore: gated" });
    assert.equal(result.status.state, "merged");
    assert.equal(result.status.delivery.targets[0].tier, null);
  });
});

test("a failed gate pushes nothing, and ship succeeds once the gate is green", () => {
  withGate({ ".github/ship-tiers.yml": null }, () => {
    const { runId } = seedRun({ "src/red.ts": "r\n" });
    const before = git(remote, "rev-parse", "main");
    process.env.FAKE_GATE_RED = "1";
    try {
      assert.throws(() => shipRun(runId, { message: "feat: red" }), /gate failed[\s\S]*unit: 1 failed/);
    } finally {
      delete process.env.FAKE_GATE_RED;
    }
    assert.equal(git(remote, "rev-parse", "main"), before);
    assert.equal(readStatus(runId).state, "ship_pending");
    assert.equal(shipRun(runId, { message: "feat: red" }).status.state, "merged");
    assert.equal(git(remote, "log", "-1", "--format=%s", "main"), "feat: red");
  });
});

test("a gated repository pushes even when it declares Formal Flow", () => {
  process.env.AGENT_MANAGER_GH_BIN = ghBin;
  process.env.FAKE_GH_STATE = join(root, "gh-state-gated.json");
  try {
    withGate({}, () => {
      const { runId } = seedRun({ "src/formal-gated.ts": "f\n" }, { flow: "formal" });
      const result = shipRun(runId, { message: "feat: formal gated" });
      assert.equal(result.status.state, "merged");
      assert.equal(result.status.delivery.targets[0].pr, null);
      assert.equal(existsSync(process.env.FAKE_GH_STATE), false, "no PR tooling ran");
    });
  } finally {
    delete process.env.AGENT_MANAGER_GH_BIN;
    delete process.env.FAKE_GH_STATE;
  }
});

test("a PR that is already open stays a PR when its repository adopts the gate", () => {
  process.env.AGENT_MANAGER_GH_BIN = ghBin;
  process.env.FAKE_GH_STATE = join(root, "gh-state-adopted.json");
  try {
    const { runId } = seedRun({ "src/open.ts": "o\n" }, { flow: "formal" });
    assert.equal(shipRun(runId, { message: "feat: open" }).status.delivery.targets[0].autoMerge, true);
    withGate({}, () => {
      const result = shipRun(runId, { message: "feat: open" });
      const target = result.status.delivery.targets[0];
      assert.equal(result.status.state, "shipping");
      assert.equal(target.autoMerge, true);
      assert.match(result.lines[0], /· gate · PR /);
    });
  } finally {
    delete process.env.AGENT_MANAGER_GH_BIN;
    delete process.env.FAKE_GH_STATE;
  }
});

test("a change cannot add the gate to skip the stop", () => {
  withBasePolicy(null, () => {
    const { runId, worktree } = seedRun({ ...gateFiles, "src/sneak.ts": "s\n" });
    assert.equal(hasGate(worktree, "origin/main"), false);
    const before = git(remote, "rev-parse", "main");
    const stopped = shipRun(runId, { message: "feat: sneak" });
    assert.equal(stopped.status.state, "waiting_operator");
    assert.equal(git(remote, "rev-parse", "main"), before);
  });
});

test("one gate file alone is not a gate", () => {
  withBase({ "pipeline.json": gateFiles["pipeline.json"], ".github/ship-tiers.yml": null }, () => {
    const { runId } = seedRun({ "src/half.ts": "h\n" });
    assert.equal(shipRun(runId, { message: "feat: half" }).status.state, "waiting_operator");
  });
});
