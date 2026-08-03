import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-core-"));
process.env.AGENT_MANAGER_DEV_ROOT = root;
const repo = join(root, "fixture-repo");
mkdirSync(repo, { recursive: true });

const { loadWorkflow } = await import("../src/workflow.mjs?core-test");
const { FeedPublisher } = await import("../src/feed.mjs?core-test");
const {
  currentHead,
  inspectInitialRepo,
  matchesScope,
  validateLaneGuardrails,
} = await import("../src/guardrails.mjs?core-test");

test.after(() => rmSync(root, { recursive: true, force: true }));

test("workflow parses feed configuration and defaults to fail-soft disabled", () => {
  const configuredPath = join(root, "configured.json");
  writeFileSync(configuredPath, JSON.stringify({
    repo: "fixture-repo",
    feed: { enabled: true, baseUrl: "http://localhost:9000/", topic: "runs/test" },
    lanes: [{ id: "one", scope: "src/**", prompt: "work" }],
  }));
  const configured = loadWorkflow(configuredPath);
  assert.deepEqual(configured.feed, {
    enabled: true,
    baseUrl: "http://localhost:9000",
    topic: "runs/test",
  });

  const defaultPath = join(root, "default.json");
  writeFileSync(defaultPath, JSON.stringify({
    repo: "fixture-repo",
    lanes: [{ id: "one", scope: "src/**", prompt: "work" }],
  }));
  const defaults = loadWorkflow(defaultPath);
  assert.equal(defaults.feed.enabled, false);
  assert.equal(defaults.feed.topic, "agent-manager/fixture-repo");
});

test("feed publisher emits the Agent Feed HTTP contract and fails soft", async () => {
  let request = null;
  const publisher = new FeedPublisher(
    { enabled: true, baseUrl: "http://feed.local", topic: "runs/test" },
    {
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, status: 200, json: async () => ({ id: "one" }) };
      },
    },
  );
  const result = await publisher.publish("run_started", { runId: "run-one" });
  assert.equal(result.ok, true);
  assert.equal(request.url, "http://feed.local/feed/publish");
  const body = JSON.parse(request.options.body);
  assert.equal(body.topic, "runs/test");
  assert.equal(JSON.parse(body.body).event, "run_started");
  assert.equal(body.meta.runId, "run-one");

  const unavailable = new FeedPublisher(
    { enabled: true, baseUrl: "http://offline", topic: "runs/test" },
    { fetchImpl: async () => { throw new Error("offline"); } },
  );
  assert.deepEqual(await unavailable.publish("run_failed", { runId: "run-two" }), {
    ok: false,
    error: "offline",
  });
});

test("codex harness is supported and parses thread_id session ids", async () => {
  const { getHarnessAdapter, listHarnessAdapters } = await import("../src/harness/index.mjs?codex-core");
  const { parseSessionId, summarizeEvent } = await import("../src/harness/codex.mjs?codex-core");
  const { createPolicyEventInspector } = await import("../src/guardrails.mjs?codex-core");

  const listed = listHarnessAdapters();
  assert.equal(listed.find((a) => a.name === "codex")?.supported, true);
  assert.equal(listed.find((a) => a.name === "cursor")?.supported, false);
  assert.equal(getHarnessAdapter("codex").name, "codex");

  const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
  assert.equal(parseSessionId({ type: "thread.started", thread_id: threadId }), threadId);
  assert.match(
    summarizeEvent({
      type: "item.started",
      item: { id: "item_1", type: "command_execution", command: "git status" },
    }) || "",
    /git status/,
  );

  const inspect = createPolicyEventInspector({ allow_commit: false, allow_pr: false });
  assert.match(
    inspect({
      type: "item.started",
      item: { type: "command_execution", command: "git commit -m 'nope'" },
    }) || "",
    /allow_commit=false/,
  );
});

test("Claude permission modes translate manager policy to native CLI values", async () => {
  const { permissionModeForClaude } = await import("../src/harness/claude.mjs?permission-core");

  assert.equal(permissionModeForClaude("readOnly"), "plan");
  assert.equal(permissionModeForClaude("read-only"), "plan");
  assert.equal(permissionModeForClaude("read_only"), "plan");
  assert.equal(permissionModeForClaude("workspace-write"), "acceptEdits");
  assert.equal(permissionModeForClaude("acceptEdits"), "acceptEdits");
});

test("runtime profiles and command adapters distinguish Windows, macOS, and Linux", async () => {
  const { detectRuntimeProfile, runtimePrompt } = await import("../src/runtime.mjs?runtime-core");
  const { resolveSpawnCommand } = await import("../src/command.mjs?runtime-core");
  const windows = detectRuntimeProfile({
    platform: "win32",
    arch: "x64",
    release: "10.0.0",
    env: {},
  });
  const linux = detectRuntimeProfile({
    platform: "linux",
    arch: "arm64",
    release: "6.1.0",
    env: { SHELL: "/bin/bash" },
  });
  const macos = detectRuntimeProfile({
    platform: "darwin",
    arch: "arm64",
    release: "24.5.0",
    env: { SHELL: "/bin/zsh" },
  });

  assert.deepEqual(windows, {
    hostPlatform: "win32",
    os: "windows",
    arch: "x64",
    release: "10.0.0",
    shell: "powershell",
    commandMode: "spawn-no-shell",
    pathStyle: "windows",
  });
  assert.equal(linux.os, "linux");
  assert.equal(linux.shell, "bash");
  assert.equal(linux.pathStyle, "posix");
  assert.deepEqual(macos, {
    hostPlatform: "darwin",
    os: "macos",
    arch: "arm64",
    release: "24.5.0",
    shell: "zsh",
    commandMode: "spawn-no-shell",
    pathStyle: "posix",
  });
  assert.match(runtimePrompt(windows), /Do not assume Bash on Windows/);
  assert.equal(
    resolveSpawnCommand("npm", ["--version"], {
      platform: "win32",
      env: { ComSpec: "cmd.exe" },
    }).command,
    "cmd.exe",
  );
  assert.deepEqual(
    resolveSpawnCommand("npm", ["--version"], { platform: "linux" }),
    { command: "npm", args: ["--version"] },
  );
  assert.deepEqual(
    resolveSpawnCommand("npm", ["--version"], { platform: "darwin" }),
    { command: "npm", args: ["--version"] },
  );
  const { formatDoctor } = await import("../src/doctor.mjs?runtime-core");
  assert.match(
    formatDoctor({
      ok: true,
      runtime: windows,
      checks: [{
        name: "npm (version checks)",
        ok: true,
        command: "npm",
        invocation: ["cmd.exe", "/d", "/s", "/c", "npm", "--version"],
        detail: "11.0.0",
      }],
    }),
    /via cmd\.exe \/d \/s \/c npm --version/,
  );
});

test("Master return authentication stays out of worker harness environments", async () => {
  const { buildHarnessEnv, buildMasterReturnEnv } = await import("../src/environment.mjs?master-return-env");
  const source = {
    PATH: "fixture-path",
    CURSOR_API_KEY: "cursor-secret",
    CLAUDE_CODE_SESSION_ID: "private-session",
  };
  const worker = buildHarnessEnv([], source);
  const master = buildMasterReturnEnv([], source);
  assert.equal(worker.CURSOR_API_KEY, undefined);
  assert.equal(worker.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(master.CURSOR_API_KEY, "cursor-secret");
  assert.equal(master.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(master.AGENT_MANAGER_MASTER_RETURN, "1");
});

test("allow_commit=false blocks mutators but allows read-only git tag/show/log", async () => {
  const { createPolicyEventInspector, isForbiddenGitMutation } = await import(
    "../src/guardrails.mjs?git-ro"
  );
  const inspect = createPolicyEventInspector({ allow_commit: false });

  const allowed = [
    "git status",
    "git log -5 --oneline",
    "git show HEAD:README.md",
    "git branch --show-current",
    "git tag --contains HEAD",
    "git tag --list",
    "git tag -l 'v*'",
    "git tag",
    "git merge-base main HEAD",
    "git -C C:/tmp/wt tag --contains abc123",
    "git show HEAD && git tag --contains HEAD",
  ];
  for (const command of allowed) {
    assert.equal(isForbiddenGitMutation(command), false, "should allow: " + command);
    assert.equal(
      inspect({ type: "item.started", item: { type: "command_execution", command } }),
      null,
      "inspector should allow: " + command,
    );
  }

  const blocked = [
    "git commit -m 'nope'",
    "git push origin main",
    "git merge feature",
    "git tag -a v1.2.3 -m 'release'",
    "git tag -d v1.2.3",
    "git tag v1.2.3",
    "git rebase main",
    "git cherry-pick abc",
    "git log -1 && git tag -a v9 -m x",
  ];
  for (const command of blocked) {
    assert.equal(isForbiddenGitMutation(command), true, "should block: " + command);
    assert.match(
      inspect({ type: "item.started", item: { type: "command_execution", command } }) || "",
      /allow_commit=false/,
      "inspector should block: " + command,
    );
  }
});

test("git guardrails report dirty state, scope violations, and worker commits", () => {
  execFileSync("git", ["init", repo]);
  writeFileSync(join(repo, "allowed.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "allowed.txt"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  const baseCommit = currentHead(repo);
  assert.equal(inspectInitialRepo(repo).dirty, false);

  writeFileSync(join(repo, "allowed.txt"), "changed\n");
  writeFileSync(join(repo, "outside.txt"), "outside\n");
  const check = validateLaneGuardrails({
    worktree: repo,
    scope: "allowed.txt",
    baseCommit,
    policy: { allow_commit: false },
  });
  assert.equal(check.ok, false);
  assert.deepEqual(check.scopeViolations, ["outside.txt"]);
  assert.equal(inspectInitialRepo(repo).dirty, true);
  assert.equal(matchesScope("src/a/b.mjs", "src/**"), true);

  execFileSync("git", ["-C", repo, "add", "allowed.txt"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "worker commit"]);
  const committed = validateLaneGuardrails({
    worktree: repo,
    scope: "allowed.txt,outside.txt",
    baseCommit,
    policy: { allow_commit: false },
  });
  assert.equal(committed.commitCount, 1);
  assert.match(committed.policyViolations[0], /allow_commit=false/);
});
