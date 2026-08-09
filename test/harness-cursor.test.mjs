import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCursorArgs,
  cursorAdapter,
  cursorPermissionArgs,
  cursorPromptDelivery,
  parseModel,
  parseResultNeedsInput,
  parseSessionId,
  resolveCursorBin,
  spawnCursor,
  summarizeEvent,
} from "../src/harness/cursor.mjs";
import { getHarnessAdapter, listHarnessAdapters } from "../src/harness/index.mjs";

const WIN_ENV = {
  LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local",
  APPDATA: "C:\\Users\\operator\\AppData\\Roaming",
  USERPROFILE: "C:\\Users\\operator",
};

test("cursor is a supported harness adapter", () => {
  assert.equal(listHarnessAdapters().find((a) => a.name === "cursor")?.supported, true);
  const adapter = getHarnessAdapter("cursor");
  assert.equal(adapter.name, "cursor");
  assert.equal(adapter, cursorAdapter);
  assert.equal(typeof adapter.start, "function");
  assert.equal(typeof adapter.resume, "function");
  assert.equal(typeof adapter.parseNeedsInput, "function");
});

test("cursor discovery prefers the native Windows install, then falls back to PATH", () => {
  const agentCmd = "C:\\Users\\operator\\AppData\\Local\\cursor-agent\\agent.cmd";
  const legacyPs1 = "C:\\Users\\operator\\AppData\\Local\\cursor-agent\\cursor-agent.ps1";

  assert.equal(
    resolveCursorBin({ env: WIN_ENV, platform: "win32", exists: (p) => p === agentCmd }),
    agentCmd,
  );
  assert.equal(
    resolveCursorBin({ env: WIN_ENV, platform: "win32", exists: (p) => p === legacyPs1 }),
    legacyPs1,
  );
  assert.equal(
    resolveCursorBin({ env: WIN_ENV, platform: "win32", exists: () => false }),
    "cursor-agent.cmd",
  );
  assert.equal(
    resolveCursorBin({
      env: { ...WIN_ENV, CURSOR_AGENT_BIN: "D:\\tools\\agent.cmd" },
      platform: "win32",
      exists: () => false,
    }),
    "D:\\tools\\agent.cmd",
  );

  const posixBin = "/home/operator/.local/bin/cursor-agent";
  assert.equal(
    resolveCursorBin({ env: { HOME: "/home/operator" }, platform: "linux", exists: (p) => p === posixBin }),
    posixBin,
  );
  assert.equal(
    resolveCursorBin({ env: { HOME: "/home/operator" }, platform: "linux", exists: () => false }),
    "cursor-agent",
  );
});

test("cursor permission modes map manager policy onto native flags", () => {
  assert.deepEqual(cursorPermissionArgs({ permissionMode: "readonly" }), ["--mode", "plan"]);
  assert.deepEqual(cursorPermissionArgs({ permissionMode: "read-only" }), ["--mode", "plan"]);
  assert.deepEqual(cursorPermissionArgs({ permissionMode: "plan" }), ["--mode", "plan"]);
  assert.deepEqual(cursorPermissionArgs({ permissionMode: "ask" }), ["--mode", "ask"]);
  assert.deepEqual(cursorPermissionArgs({ permissionMode: "auto" }), ["--auto-review"]);
  assert.deepEqual(cursorPermissionArgs({ permissionMode: "acceptEdits" }), []);
  assert.deepEqual(cursorPermissionArgs({ permissionMode: "workspace-write" }), []);

  // --force / --yolo is reachable only through an explicit dangerous policy.
  assert.deepEqual(
    cursorPermissionArgs({ permissionMode: "acceptEdits", dangerouslySkipPermissions: true }),
    ["--force"],
  );
  assert.deepEqual(
    cursorPermissionArgs({ permissionMode: "readonly", dangerouslySkipPermissions: true }),
    ["--force"],
  );
  assert.throws(() => cursorPermissionArgs({ permissionMode: "dontAsk" }), /do not support/);
});

test("cursor spawn args carry print mode, model, lane dir, and resume id", () => {
  const base = buildCursorArgs({
    laneDir: "/runs/run-1/build",
    promptArg: "do the work",
    env: {},
  });
  assert.deepEqual(base, [
    "-p",
    "--output-format", "stream-json",
    "--trust",
    "--add-dir", "/runs/run-1/build",
    "do the work",
  ]);

  const withModel = buildCursorArgs({
    laneDir: "/runs/run-1/build",
    promptArg: "do the work",
    model: "sonnet-4-thinking",
    permissionMode: "readonly",
    env: {},
  });
  assert.deepEqual(withModel.slice(0, 7), [
    "-p",
    "--output-format", "stream-json",
    "--model", "sonnet-4-thinking",
    "--mode", "plan",
  ]);
  assert.equal(withModel.at(-1), "do the work");

  // Lane model wins over the ambient CURSOR_MODEL default.
  assert.ok(buildCursorArgs({
    laneDir: "/lane",
    promptArg: "p",
    model: "gpt-5",
    env: { CURSOR_MODEL: "sonnet-4-thinking" },
  }).includes("gpt-5"));
  assert.ok(buildCursorArgs({
    laneDir: "/lane",
    promptArg: "p",
    env: { CURSOR_MODEL: "sonnet-4-thinking" },
  }).includes("sonnet-4-thinking"));

  // `--resume [chatId]` takes an optional value, so only the `=` form binds it.
  const resumed = buildCursorArgs({
    laneDir: "/lane",
    promptArg: "keep going",
    resumeSessionId: "chat-123",
    env: {},
  });
  assert.ok(resumed.includes("--resume=chat-123"));
  assert.equal(resumed.at(-1), "keep going");
  assert.ok(!resumed.includes("--force"));
});

test("Windows prompt delivery points at the prompt file instead of a mangled argv", () => {
  const prompt = "## Lane\nline two\n\"quoted\" & piped | text";
  const promptPath = "C:\\runs\\run-1\\build\\prompt.md";

  const windows = cursorPromptDelivery({ prompt, promptPath, platform: "win32" });
  assert.equal(windows.mode, "file");
  assert.ok(windows.arg.includes(promptPath));
  assert.ok(!/[\r\n]/.test(windows.arg), "windows prompt argument must stay single-line");

  const posix = cursorPromptDelivery({ prompt, promptPath, platform: "linux" });
  assert.equal(posix.mode, "inline");
  assert.equal(posix.arg, prompt);
});

test("cursor stream-json parsing captures session, model, activity, and blocked results", () => {
  const init = {
    type: "system",
    subtype: "init",
    apiKeySource: "login",
    session_id: "chat-abc",
    model: "Claude Sonnet 4.6",
    permissionMode: "default",
  };
  assert.equal(parseSessionId(init), "chat-abc");
  assert.equal(parseModel(init), "Claude Sonnet 4.6");
  assert.match(summarizeEvent(init), /system\.init: Claude Sonnet 4\.6/);

  assert.equal(parseSessionId({ type: "result", chatId: "chat-xyz" }), "chat-xyz");
  assert.equal(parseSessionId({ type: "result" }), null);

  assert.equal(
    summarizeEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "reading files" }] },
    }),
    "reading files",
  );
  assert.equal(
    summarizeEvent({ type: "tool_call", subtype: "started", tool_call: { tool: { case: "readToolCall" } } }),
    "tool: readToolCall (started)",
  );
  assert.equal(summarizeEvent({ type: "thinking", subtype: "delta" }), "thinking.delta");
  assert.match(summarizeEvent({ type: "error", message: "rate limited" }), /^error: rate limited/);
  assert.equal(summarizeEvent({ type: "result", subtype: "success" }), "result: success");
  assert.equal(summarizeEvent(null), null);

  const blocked = parseResultNeedsInput({
    type: "result",
    subtype: "success",
    result: "BLOCKED: which name should the flag use?",
  });
  assert.equal(blocked.type, "blocked");
  assert.equal(blocked.blocking, true);
  assert.equal(parseResultNeedsInput({ type: "result", result: "all done" }), null);
});

test("workflows can declare cursor lanes with a model and a supported permission mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "am-cursor-wf-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), "fixture\n");
    writeFileSync(join(repo, "context.md"), "One frozen contract for every lane.\n");
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "add", "README.md", "context.md"]);
    execFileSync("git", [
      "-C", repo,
      "-c", "user.name=Test",
      "-c", "user.email=test@example.invalid",
      "commit", "-m", "base",
    ]);
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const { loadWorkflow } = await import("../src/workflow.mjs?cursor-harness-test");

    const load = (name, lane) => {
      const path = join(root, `${name}.json`);
      writeFileSync(path, JSON.stringify({
        repo,
        harness_default: "cursor",
        planning: {
          source_refs: ["source-one"],
          plan_ref: "plan-one",
          context_file: "context.md",
          reviewed_base_sha: base,
          verified_by: "manager-one",
          verified_at: "2026-01-01T00:00:00Z",
          reviewed_paths: ["README.md"],
          repository_instruction_refs: ["fixture instructions"],
          attestations: {
            source_reviewed: true,
            repository_instructions_reviewed: true,
            relevant_code_reviewed: true,
            scope_verified: true,
          },
        },
        lanes: [{ id: "one", scope: "README.md", prompt: "Do the lane work.", ...lane }],
      }, null, 2));
      return loadWorkflow(path);
    };

    const loaded = load("cursor-lane", { model: "sonnet-4-thinking", permission_mode: "auto" });
    assert.equal(loaded.harness_default, "cursor");
    assert.equal(loaded.lanes[0].harness, "cursor");
    assert.equal(loaded.lanes[0].model, "sonnet-4-thinking");
    assert.equal(loaded.lanes[0].permission_mode, "auto");
    assert.equal(load("cursor-review", { permission_mode: "read-only" }).lanes[0].kind, "review");

    // Cursor has no allowlist-only mode, so dontAsk is refused at load time.
    assert.throws(
      () => load("cursor-dontask", { permission_mode: "dontAsk" }),
      /permission_mode dontAsk is not supported by cursor/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cursor lanes stream a fake CLI end to end without network access", async () => {
  const root = mkdtempSync(join(tmpdir(), "am-cursor-"));
  try {
    const laneDir = join(root, "lane");
    const fakeCli = join(root, "fake-cursor.mjs");
    writeFileSync(fakeCli, [
      "const args = process.argv.slice(2);",
      "process.stdout.write(JSON.stringify({",
      "  type: 'system', subtype: 'init', session_id: 'chat-fake', model: 'fake-model', args,",
      "}) + '\\n');",
      "process.stdout.write(JSON.stringify({",
      "  type: 'result', subtype: 'success', result: 'done', session_id: 'chat-fake',",
      "}) + '\\n');",
    ].join("\n"), "utf8");

    const launcher = process.platform === "win32"
      ? join(root, "fake-cursor.cmd")
      : join(root, "fake-cursor.sh");
    if (process.platform === "win32") {
      writeFileSync(launcher, `@echo off\r\nnode "${fakeCli}" %*\r\n`, "utf8");
    } else {
      writeFileSync(launcher, `#!/bin/sh\nexec node "${fakeCli}" "$@"\n`, "utf8");
      chmodSync(launcher, 0o755);
    }

    const events = [];
    const handle = spawnCursor({
      cwd: root,
      prompt: "## Lane\nmultiline briefing\n\"quoted\"",
      laneDir,
      model: "fake-model",
      permissionMode: "acceptEdits",
      env: { ...process.env, CURSOR_AGENT_BIN: launcher },
      onEvent: (event) => events.push(event),
    });
    const result = await handle.done;

    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, "chat-fake");
    assert.equal(result.lastActivity, "result: success");
    assert.equal(cursorAdapter.parseModel(events[0]), "fake-model");

    const forwarded = events[0].args;
    assert.ok(forwarded.includes("-p"));
    assert.ok(forwarded.includes("stream-json"));
    assert.ok(forwarded.includes("--model"));
    assert.ok(forwarded.includes("fake-model"));
    assert.ok(!forwarded.includes("--force"));

    // The full briefing always lands in prompt.md, whatever argv can carry.
    const promptFile = readFileSync(join(laneDir, "prompt.md"), "utf8");
    assert.match(promptFile, /multiline briefing/);
    assert.equal(
      result.promptDelivery,
      process.platform === "win32" ? "file" : "inline",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
