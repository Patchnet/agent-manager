import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedRoot, useIsolatedRoots } from "../test-support/isolated-roots.mjs";

const root = isolatedRoot("allowed-tools-");
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
useIsolatedRoots(root);

execFileSync("git", ["init", "-b", "main", repo]);
writeFileSync(join(repo, "README.md"), "base\n");
execFileSync("git", ["-C", repo, "add", "README.md"]);
execFileSync("git", [
  "-C", repo,
  "-c", "user.name=Test",
  "-c", "user.email=test@example.invalid",
  "commit", "-m", "base",
]);

test.after(() => rmSync(root, { recursive: true, force: true }));

const {
  allowedToolRulesForVerification,
  loadWorkflow,
} = await import("../src/workflow.mjs?allowed-tools");

let counter = 0;

function load(value) {
  counter += 1;
  const path = join(root, `workflow-${counter}.json`);
  writeFileSync(path, JSON.stringify(value));
  return loadWorkflow(path);
}

const VERIFICATION = {
  commands: [
    { command: "npm", args: ["test"] },
    { command: "npm", args: ["run", "hygiene"] },
  ],
};

function workflow(lanes, overrides = {}) {
  return { repo: "repo", integrate: true, verification: VERIFICATION, lanes, ...overrides };
}

test("a verification command becomes one prefix rule, not a shell grant", () => {
  assert.deepEqual(allowedToolRulesForVerification(VERIFICATION.commands), [
    "Bash(npm test*)",
    "Bash(npm run hygiene*)",
  ]);
  // Sub-command depth stops at two arguments, at the first flag, and at
  // anything that would need quoting.
  assert.deepEqual(
    allowedToolRulesForVerification([
      { command: "npm", args: ["run", "check:version", "--", "--strict"] },
      { command: "node", args: ["--test", "test/"] },
      { command: "npm", args: ["test", "--", "--reporter", "dot"] },
      { command: "pytest", args: [] },
      { command: "npm", args: ["run", "lint --fix"] },
    ]),
    [
      "Bash(npm run check:version*)",
      "Bash(node*)",
      "Bash(npm test*)",
      "Bash(pytest*)",
      "Bash(npm run*)",
    ],
  );
  assert.deepEqual(allowedToolRulesForVerification(), []);
});

test("a writable Claude lane with no allowlist inherits the workflow's verification commands", () => {
  const loaded = load(workflow([
    { id: "edits", harness: "claude", permission_mode: "acceptEdits", scope: "src/**", prompt: "work" },
    { id: "workspace", harness: "claude", permission_mode: "workspace-write", scope: "docs/**", prompt: "work" },
    { id: "automatic", harness: "claude", permission_mode: "auto", scope: "test/**", prompt: "work" },
  ]));
  for (const lane of loaded.lanes) {
    assert.deepEqual(lane.allowed_tools, ["Bash(npm test*)", "Bash(npm run hygiene*)"], lane.id);
    assert.equal(lane.allowed_tools_source, "verification", lane.id);
  }
});

test("an explicit lane allowlist is never widened by synthesis", () => {
  const loaded = load(workflow([{
    id: "narrow",
    harness: "claude",
    permission_mode: "acceptEdits",
    allowed_tools: ["Bash(npm test*)"],
    scope: "src/**",
    prompt: "work",
  }]));
  assert.deepEqual(loaded.lanes[0].allowed_tools, ["Bash(npm test*)"]);
  assert.equal(loaded.lanes[0].allowed_tools_source, "declared");
});

test("dontAsk still demands its own complete allowlist", () => {
  assert.throws(
    () => load(workflow([
      { id: "locked", harness: "claude", permission_mode: "dontAsk", scope: "src/**", prompt: "work" },
    ])),
    /allowed_tools is required for Claude dontAsk mode/,
    "a derived allowlist would silently under-grant a mode that permits nothing else",
  );
});

test("read-only Claude lanes and non-Claude lanes are left alone", () => {
  const loaded = load(workflow([
    { id: "reader", harness: "claude", permission_mode: "readOnly", scope: "src/**", prompt: "read" },
    { id: "codex", harness: "codex", permission_mode: "workspace-write", scope: "docs/**", prompt: "work" },
    { id: "cursor", harness: "cursor", permission_mode: "acceptEdits", scope: "test/**", prompt: "work" },
  ]));
  const lanes = Object.fromEntries(loaded.lanes.map((lane) => [lane.id, lane]));
  assert.deepEqual(lanes.reader.allowed_tools, []);
  assert.equal(lanes.reader.allowed_tools_source, "none");
  // Codex governs execution through its sandbox mode; it has no allowlist, and
  // declaring one is still rejected.
  assert.deepEqual(lanes.codex.allowed_tools, []);
  assert.equal(lanes.codex.allowed_tools_source, undefined);
  assert.deepEqual(lanes.cursor.allowed_tools, []);
  assert.throws(
    () => load(workflow([
      {
        id: "codex",
        harness: "codex",
        permission_mode: "workspace-write",
        allowed_tools: ["Bash(npm test*)"],
        scope: "docs/**",
        prompt: "work",
      },
    ])),
    /allowed_tools is only supported by the Claude harness/,
  );
});

test("a workflow with no verification commands grants nothing", () => {
  const loaded = load({
    repo: "repo",
    lanes: [
      { id: "edits", harness: "claude", permission_mode: "acceptEdits", scope: "src/**", prompt: "work" },
    ],
  });
  assert.deepEqual(loaded.lanes[0].allowed_tools, []);
  assert.equal(loaded.lanes[0].allowed_tools_source, "none");
});
