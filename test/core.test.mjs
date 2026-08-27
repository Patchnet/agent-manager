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
  assert.equal(defaults.classification, "operational");
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
  const { parseModel, parseSessionId, summarizeEvent } = await import("../src/harness/codex.mjs?codex-core");
  const { createPolicyEventInspector } = await import("../src/guardrails.mjs?codex-core");

  const listed = listHarnessAdapters();
  assert.equal(listed.find((a) => a.name === "codex")?.supported, true);
  assert.equal(listed.find((a) => a.name === "cursor")?.supported, true);
  assert.equal(getHarnessAdapter("codex").name, "codex");

  const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
  assert.equal(parseSessionId({ type: "thread.started", thread_id: threadId }), threadId);
  assert.equal(parseModel({ type: "thread.started", model: "gpt-test" }), "gpt-test");
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
  const {
    claudePermissionArgs,
    parseModel,
    parseResultNeedsInput,
    permissionModeForClaude,
  } = await import("../src/harness/claude.mjs?permission-core");

  assert.equal(permissionModeForClaude("readOnly"), "plan");
  assert.equal(permissionModeForClaude("read-only"), "plan");
  assert.equal(permissionModeForClaude("read_only"), "plan");
  assert.equal(permissionModeForClaude("workspace-write"), "acceptEdits");
  assert.equal(permissionModeForClaude("acceptEdits"), "acceptEdits");
  assert.equal(permissionModeForClaude("auto"), "auto");
  assert.equal(permissionModeForClaude("dontAsk"), "dontAsk");
  assert.deepEqual(claudePermissionArgs({
    permissionMode: "dontAsk",
    allowedTools: ["Bash(node --test *)", "PowerShell(node --test *)"],
  }), [
    "--permission-mode", "dontAsk",
    "--allowedTools", "Bash(node --test *)", "PowerShell(node --test *)",
  ]);
  assert.equal(parseModel({ type: "assistant", message: { model: "claude-test" } }), "claude-test");
  assert.deepEqual(
    parseResultNeedsInput({ type: "result", result: "**BLOCKED — dependency setup is missing" }),
    {
      type: "blocked",
      prompt: "**BLOCKED — dependency setup is missing",
      blocking: true,
      source: "harness-result",
    },
  );
  assert.equal(parseResultNeedsInput({ type: "result", result: "Completed successfully" }), null);
});

test("Claude unattended permission preflight fails when the installed CLI lacks a requested mode", async () => {
  const { checkClaudePermissionModes } = await import("../src/preflight.mjs?claude-permission-core");
  const supported = checkClaudePermissionModes("claude", ["auto", "dontAsk"], {
    platform: "linux",
    spawnImpl: () => ({
      status: 0,
      stdout: '--permission-mode <mode> (choices: "acceptEdits", "auto", "dontAsk", "plan")',
      stderr: "",
    }),
  });
  assert.equal(supported.ok, true);

  const unsupported = checkClaudePermissionModes("claude", ["auto"], {
    platform: "linux",
    spawnImpl: () => ({
      status: 0,
      stdout: '--permission-mode <mode> (choices: "acceptEdits", "plan")',
      stderr: "",
    }),
  });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /does not support permission mode.*auto/);
});

test("runtime profiles and command adapters distinguish Windows, macOS, and Linux", async () => {
  const { detectRuntimeProfile, runtimePrompt } = await import("../src/runtime.mjs?runtime-core");
  const { resolveSpawnCommand, spawnCommandSync } = await import("../src/command.mjs?runtime-core");
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
    resolveSpawnCommand("C:\\Users\\operator\\AppData\\Roaming\\npm\\claude.cmd", ["--version"], {
      platform: "win32",
      env: { ComSpec: "cmd.exe" },
    }),
    {
      command: "cmd.exe",
      args: [
        "/d", "/s", "/c",
        "C:\\Users\\operator\\AppData\\Roaming\\npm\\claude.cmd",
        "--version",
      ],
    },
  );
  assert.deepEqual(
    resolveSpawnCommand("C:\\tools\\claude.ps1", ["--version"], {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
    }),
    {
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [
        "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        "C:\\tools\\claude.ps1", "--version",
      ],
    },
  );
  assert.deepEqual(
    resolveSpawnCommand("npm", ["--version"], { platform: "linux" }),
    { command: "npm", args: ["--version"] },
  );
  assert.deepEqual(
    resolveSpawnCommand("npm", ["--version"], { platform: "darwin" }),
    { command: "npm", args: ["--version"] },
  );
  let capturedSpawn = null;
  const spawned = spawnCommandSync("C:\\tools\\worker.ps1", ["arg"], {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    shell: true,
    windowsHide: false,
    spawnImpl: (command, args, options) => {
      capturedSpawn = { command, args, options };
      return { status: 0, stdout: "ok", stderr: "" };
    },
  });
  assert.equal(spawned.result.status, 0);
  assert.equal(capturedSpawn.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(capturedSpawn.options.shell, false);
  assert.equal(capturedSpawn.options.windowsHide, true);
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
  assert.match(
    formatDoctor({
      ok: false,
      runtime: windows,
      checks: [{
        name: "claude",
        ok: false,
        detail: "not found",
        recommendation: "Install or configure Claude Code, then restart the launching harness.",
      }],
    }),
    /fix: Install or configure Claude Code/,
  );
});

test("harness discovery recognizes Windows npm shims and explicit overrides", async () => {
  const { resolveClaudeBin } = await import("../src/harness/claude.mjs?discovery-core");
  const {
    codexWindowsSandboxArgs,
    resolveCodexBin,
    resolveCodexInstallation,
  } = await import("../src/harness/codex.mjs?discovery-core");
  const claudeShim = "C:\\Users\\operator\\AppData\\Roaming\\npm\\claude.cmd";
  const codexShim = "C:\\Users\\operator\\AppData\\Roaming\\npm\\codex.cmd";
  const existing = new Set([claudeShim, codexShim]);
  const exists = (candidate) => existing.has(candidate);
  const env = {
    APPDATA: "C:\\Users\\operator\\AppData\\Roaming",
    USERPROFILE: "C:\\Users\\operator",
    LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local",
  };

  assert.equal(resolveClaudeBin({ env, platform: "win32", exists }), claudeShim);
  assert.equal(resolveCodexBin({ env, platform: "win32", exists }), codexShim);
  assert.equal(resolveClaudeBin({
    env: { ...env, CLAUDE_BIN: "D:\\tools\\claude.cmd" },
    platform: "win32",
    exists,
  }), "D:\\tools\\claude.cmd");
  assert.equal(resolveCodexBin({
    env: { ...env, CODEX_BIN: "D:\\tools\\codex.exe" },
    platform: "win32",
    exists,
  }), "D:\\tools\\codex.exe");

  const localCodex = "C:\\Users\\operator\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
  const standaloneCodex = "C:\\Users\\operator\\.codex\\packages\\standalone\\current\\bin\\codex.exe";
  const standaloneHelper = "C:\\Users\\operator\\.codex\\packages\\standalone\\current\\codex-resources\\codex-windows-sandbox-setup.exe";
  const packaged = new Set([localCodex, standaloneCodex, standaloneHelper]);
  const complete = resolveCodexInstallation({
    env,
    platform: "win32",
    exists: (candidate) => packaged.has(candidate),
  });
  assert.equal(complete.command, standaloneCodex);
  assert.equal(complete.source, "standalone");
  assert.equal(complete.sandboxHelper, standaloneHelper);
  assert.equal(complete.sandboxReady, true);

  const incomplete = resolveCodexInstallation({
    env,
    platform: "win32",
    exists: (candidate) => candidate === localCodex,
  });
  assert.equal(incomplete.command, localCodex);
  assert.equal(incomplete.sandboxReady, false);

  assert.deepEqual(codexWindowsSandboxArgs({ platform: "win32" }), [
    "-c",
    "windows.sandbox_private_desktop=true",
  ]);
  assert.deepEqual(codexWindowsSandboxArgs({
    platform: "win32",
    dangerouslySkipPermissions: true,
  }), []);
  assert.deepEqual(codexWindowsSandboxArgs({ platform: "darwin" }), []);
});

test("harness setup provides platform-specific, machine-readable remediation", async () => {
  const { harnessFailureRecommendation, harnessSetup } = await import("../src/harness/setup.mjs?setup-core");
  const claude = harnessSetup("claude", { platform: "win32" });
  const codex = harnessSetup("codex", { platform: "darwin" });
  const cursor = harnessSetup("cursor", { platform: "win32" });

  assert.equal(claude.overrideEnv, "CLAUDE_BIN");
  assert.match(claude.shimGuidance, /full \.cmd path/);
  assert.match(codex.install, /install\.sh/);
  assert.match(cursor.install, /cursor\.com\/install\?win32=true/);
  assert.match(cursor.shimGuidance, /CURSOR_AGENT_BIN/);
  assert.match(
    harnessFailureRecommendation("claude", { platform: "win32" }),
    /Verify from the same environment: claude --version/,
  );
  assert.match(
    harnessFailureRecommendation("claude", { platform: "win32" }),
    /does not prove it is uninstalled/,
  );
});

test("version metadata distinguishes running code from updated installed files", async () => {
  const { currentVersionInfo } = await import("../src/version.mjs?version-core");
  assert.deepEqual(currentVersionInfo({ runtimeVersion: "1.8.1", installedVersion: "1.8.1" }), {
    runtimeVersion: "1.8.1",
    installedVersion: "1.8.1",
    restartRequired: false,
    notice: null,
  });
  const updated = currentVersionInfo({ runtimeVersion: "1.8.1", installedVersion: "1.9.0" });
  assert.equal(updated.restartRequired, true);
  assert.match(updated.notice, /quit and restart.*runtime v1\.8\.1/);
});

test("Master return authentication stays out of worker harness environments", async () => {
  const { buildHarnessEnv, buildMasterReturnEnv } = await import("../src/environment.mjs?master-return-env");
  const source = {
    PATH: "fixture-path",
    CLAUDE_BIN: "C:\\tools\\claude.cmd",
    CODEX_BIN: "C:\\tools\\codex.cmd",
    CURSOR_API_KEY: "cursor-secret",
    CLAUDE_CODE_SESSION_ID: "private-session",
  };
  const worker = buildHarnessEnv([], source);
  const master = buildMasterReturnEnv([], source);
  // Cursor is a worker harness now, so its documented API key travels with
  // lanes exactly like ANTHROPIC_API_KEY and OPENAI_API_KEY. The Master's own
  // interactive session identity still stays out of worker environments.
  assert.equal(worker.CURSOR_API_KEY, "cursor-secret");
  assert.equal(worker.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(worker.CLAUDE_BIN, "C:\\tools\\claude.cmd");
  assert.equal(worker.CODEX_BIN, "C:\\tools\\codex.cmd");
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
    "rg -n -i \"git commit|git push\" README.md docs",
    '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'rg -n -i "every write|git.commit|git commit|git-commit|Git is" README.md docs\'',
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
    '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'git commit -m nope\'',
    "powershell.exe -Command 'rg pattern README.md; git push origin main'",
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

// Regression: run run-20260808-184504-acd233bf failed lane cursor-harness
// because the worker read src/harness/claude.mjs and the raw stdout scan matched
// the detector's own source text inside the tool_result.
test("empty-prompt detection reads structured error events, not echoed stream text", async () => {
  const { detectEmptyPromptEvent, isSuccessfulResultEvent } = await import(
    "../src/harness/claude.mjs?empty-prompt-core"
  );
  const phrase = "Your message came through empty";

  // False positives: the phrase travelling as content the worker read or wrote.
  assert.equal(detectEmptyPromptEvent({
    type: "user",
    message: { content: [{ type: "tool_result", content: `202: if (/came through empty/i.test(text))` }] },
  }), false);
  assert.equal(detectEmptyPromptEvent({
    type: "assistant",
    message: { content: [{ type: "text", text: `The detector matches "${phrase}" on raw stdout.` }] },
  }), false);
  assert.equal(detectEmptyPromptEvent({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `Fixed the "${phrase}" false positive.`,
  }), false);

  // True positives: the harness itself reporting the failure.
  assert.equal(detectEmptyPromptEvent({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: phrase,
  }), true);
  assert.equal(detectEmptyPromptEvent({ type: "error", message: phrase }), true);

  assert.equal(isSuccessfulResultEvent({ type: "result", subtype: "success", is_error: false }), true);
  assert.equal(isSuccessfulResultEvent({ type: "result", is_error: true }), false);
  assert.equal(isSuccessfulResultEvent({ type: "assistant" }), false);
});

test("a lane that reads the detector's own source is not forced to exit 2", async () => {
  const { resumeClaude } = await import("../src/harness/claude.mjs?empty-prompt-e2e");
  const laneDir = join(root, "empty-prompt-lane");
  mkdirSync(laneDir, { recursive: true });

  // Fake CLI: replays a tool_result carrying the detector's own source line,
  // then ends the session cleanly the way the failed run actually did.
  const fakeCli = join(laneDir, "fake-claude.mjs");
  writeFileSync(fakeCli, [
    'const events = [',
    '  { type: "system", subtype: "init", session_id: "sess-empty-prompt" },',
    '  { type: "user", message: { content: [{ type: "tool_result",',
    '      content: "if (/came through empty|message came through empty/i.test(text)) {" }] } },',
    '  { type: "assistant", message: { content: [{ type: "text",',
    '      text: "The string \'came through empty\' appears in claude.mjs." }] } },',
    '  { type: "result", subtype: "success", is_error: false, result: "done" },',
    '];',
    'process.stdin.resume();',
    'process.stdin.on("data", () => {});',
    'process.stdin.on("end", () => {',
    '  for (const ev of events) process.stdout.write(JSON.stringify(ev) + "\\n");',
    '  process.exit(0);',
    '});',
  ].join("\n"));

  // resolveSpawnCommand only routes .mjs through node for explicit overrides, so
  // the fake is exposed through a platform-native shim.
  const shim = process.platform === "win32"
    ? join(laneDir, "fake-claude.cmd")
    : join(laneDir, "fake-claude.sh");
  writeFileSync(
    shim,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fakeCli}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fakeCli}" "$@"\n`,
    { mode: 0o755 },
  );

  const run = resumeClaude({
    sessionId: "sess-empty-prompt",
    cwd: laneDir,
    prompt: "read src/harness/claude.mjs",
    laneDir,
    env: { ...process.env, CLAUDE_BIN: shim },
  });
  const result = await run.done;

  assert.equal(result.emptyPrompt, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "sess-empty-prompt");
  assert.doesNotMatch(String(result.lastActivity), /received empty prompt/);
});
