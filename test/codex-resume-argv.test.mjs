import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCodexArgs,
  CODEX_OPTION_CONTRACT,
  resolveCodexBin,
  resumeCodex,
  sandboxForPermissionMode,
} from "../src/harness/codex.mjs";
import { spawnCommandSync } from "../src/command.mjs";

const SESSION = "0199a213-81c0-7800-8aa1-bbab2a035a53";

// Flags only: values (`workspace-write`, paths, model names) never start with
// a dash, and the trailing bare `-` is the prompt.
function optionTokens(args) {
  return args.filter((arg) => arg.startsWith("-") && arg !== "-");
}

function splitByCommand(args) {
  const resumeAt = args.indexOf("resume");
  if (resumeAt === -1) return { exec: optionTokens(args.slice(1)), resume: [] };
  return {
    exec: optionTokens(args.slice(1, resumeAt)),
    // Skip the `resume` token and the session-id positional after it.
    resume: optionTokens(args.slice(resumeAt + 2)),
  };
}

test("every resume flag sits under a command that accepts it", () => {
  const cases = [
    { name: "posix workspace-write", platform: "linux", permissionMode: "acceptEdits" },
    { name: "posix read-only", platform: "linux", permissionMode: "readonly" },
    { name: "windows workspace-write", platform: "win32", permissionMode: "acceptEdits" },
    { name: "windows with model", platform: "win32", permissionMode: "acceptEdits", model: "gpt-5" },
    { name: "windows dangerous", platform: "win32", permissionMode: "acceptEdits", dangerouslySkipPermissions: true },
    { name: "posix dangerous", platform: "linux", permissionMode: "readonly", dangerouslySkipPermissions: true },
  ];

  for (const { name, ...options } of cases) {
    const args = buildCodexArgs({ cwd: "/repo/wt", resumeSessionId: SESSION, env: {}, ...options });
    const { exec, resume } = splitByCommand(args);

    for (const flag of exec) {
      assert.ok(CODEX_OPTION_CONTRACT.exec.has(flag), `${name}: \`${flag}\` is not accepted by \`codex exec\``);
    }
    for (const flag of resume) {
      assert.ok(
        CODEX_OPTION_CONTRACT["exec resume"].has(flag),
        `${name}: \`${flag}\` is not accepted by \`codex exec resume\``,
      );
    }
    // The exact flags that made all three production resumes exit 2.
    for (const rejected of ["-C", "--cd", "-s", "--sandbox"]) {
      assert.ok(!resume.includes(rejected), `${name}: \`${rejected}\` must never follow \`resume\``);
    }
    assert.equal(args[0], "exec", `${name}: subcommand shape`);
    assert.equal(args[args.indexOf("resume") + 1], SESSION, `${name}: session id is resume's positional`);
    assert.equal(args.at(-1), "-", `${name}: prompt still arrives on stdin`);
  }
});

test("resume argv keeps the cwd and sandbox policy of a fresh start", () => {
  assert.deepEqual(
    buildCodexArgs({ cwd: "/repo/wt", platform: "linux", resumeSessionId: SESSION, env: {} }),
    ["exec", "-C", "/repo/wt", "-s", "workspace-write", "resume", SESSION, "--json", "-"],
  );
  assert.deepEqual(
    buildCodexArgs({ cwd: "C:\\repo\\wt", platform: "win32", model: "gpt-5", resumeSessionId: SESSION, env: {} }),
    [
      "exec",
      "-c", "windows.sandbox_private_desktop=true",
      "-C", "C:\\repo\\wt",
      "-s", "workspace-write",
      "resume", SESSION,
      "--json",
      "-m", "gpt-5",
      "-",
    ],
  );
  assert.deepEqual(
    buildCodexArgs({ cwd: "/repo/wt", platform: "win32", permissionMode: "readonly", dangerouslySkipPermissions: true, resumeSessionId: SESSION, env: {} }),
    ["exec", "-C", "/repo/wt", "--dangerously-bypass-approvals-and-sandbox", "resume", SESSION, "--json", "-"],
  );
});

test("fresh-start argv is unchanged and stays inside the `exec` option set", () => {
  // Byte-identical to the pre-fix argv — the fresh-start path was never broken.
  assert.deepEqual(
    buildCodexArgs({ cwd: "/repo/wt", platform: "linux", env: {} }),
    ["exec", "--json", "-C", "/repo/wt", "-s", "workspace-write", "-"],
  );
  assert.deepEqual(
    buildCodexArgs({ cwd: "C:\\repo\\wt", platform: "win32", model: "gpt-5", env: {} }),
    [
      "exec",
      "-c", "windows.sandbox_private_desktop=true",
      "--json", "-C", "C:\\repo\\wt",
      "-m", "gpt-5",
      "-s", "workspace-write",
      "-",
    ],
  );
  assert.deepEqual(
    buildCodexArgs({ cwd: "/repo/wt", platform: "win32", permissionMode: "readonly", dangerouslySkipPermissions: true, env: {} }),
    ["exec", "--json", "-C", "/repo/wt", "--dangerously-bypass-approvals-and-sandbox", "-"],
  );

  for (const platform of ["linux", "win32"]) {
    const args = buildCodexArgs({ cwd: "/repo/wt", platform, model: "gpt-5", env: {} });
    for (const flag of optionTokens(args.slice(1))) {
      assert.ok(CODEX_OPTION_CONTRACT.exec.has(flag), `\`${flag}\` is not accepted by \`codex exec\``);
    }
  }
});

test("a resumed lane never gets a weaker sandbox than its fresh start", () => {
  for (const permissionMode of ["readonly", "read-only", "read_only", "acceptEdits", "workspace-write"]) {
    const expected = sandboxForPermissionMode(permissionMode);
    for (const platform of ["linux", "win32"]) {
      const fresh = buildCodexArgs({ cwd: "/repo/wt", platform, permissionMode, env: {} });
      const resumed = buildCodexArgs({ cwd: "/repo/wt", platform, permissionMode, resumeSessionId: SESSION, env: {} });
      assert.equal(fresh[fresh.indexOf("-s") + 1], expected, `${permissionMode}/${platform}: fresh`);
      assert.equal(resumed[resumed.indexOf("-s") + 1], expected, `${permissionMode}/${platform}: resumed`);
      // Windows private-desktop hardening applies to both paths alike.
      assert.equal(
        resumed.includes("windows.sandbox_private_desktop=true"),
        fresh.includes("windows.sandbox_private_desktop=true"),
        `${permissionMode}/${platform}: windows hardening`,
      );
    }
  }

  // A dangerous lane bypasses instead of configuring a sandbox — never both.
  const dangerous = buildCodexArgs({ cwd: "/repo/wt", platform: "linux", resumeSessionId: SESSION, dangerouslySkipPermissions: true, env: {} });
  assert.ok(dangerous.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!dangerous.includes("-s"));
});

test("lane model wins over the ambient CODEX_MODEL default on both paths", () => {
  const env = { CODEX_MODEL: "gpt-ambient" };
  assert.ok(buildCodexArgs({ cwd: "/repo/wt", platform: "linux", env }).includes("gpt-ambient"));
  assert.ok(buildCodexArgs({ cwd: "/repo/wt", platform: "linux", model: "gpt-lane", env }).includes("gpt-lane"));
  assert.ok(buildCodexArgs({ cwd: "/repo/wt", platform: "linux", resumeSessionId: SESSION, env }).includes("gpt-ambient"));
  assert.ok(buildCodexArgs({ cwd: "/repo/wt", platform: "linux", resumeSessionId: SESSION, model: "gpt-lane", env }).includes("gpt-lane"));
});

test("resume streams a fake CLI end to end with the prompt on stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "am-codex-resume-"));
  try {
    const laneDir = join(root, "lane");
    const fakeCli = join(root, "fake-codex.mjs");
    writeFileSync(fakeCli, [
      "const args = process.argv.slice(2);",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({",
      `    type: 'thread.started', thread_id: '${SESSION}', args, stdin,`,
      "  }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      "});",
    ].join("\n"), "utf8");

    const launcher = process.platform === "win32"
      ? join(root, "fake-codex.cmd")
      : join(root, "fake-codex.sh");
    if (process.platform === "win32") {
      writeFileSync(launcher, `@echo off\r\nnode "${fakeCli}" %*\r\n`, "utf8");
    } else {
      writeFileSync(launcher, `#!/bin/sh\nexec node "${fakeCli}" "$@"\n`, "utf8");
      chmodSync(launcher, 0o755);
    }

    const events = [];
    const handle = resumeCodex({
      cwd: root,
      prompt: "## Lane\nanswer to the blocking question\n\"quoted\" & piped | text",
      laneDir,
      sessionId: SESSION,
      model: "fake-model",
      permissionMode: "acceptEdits",
      logName: "resume-1.log",
      env: { ...process.env, CODEX_BIN: launcher },
      onEvent: (event) => events.push(event),
    });
    const result = await handle.done;

    assert.equal(result.exitCode, 0, "the restructured resume argv must parse");
    assert.equal(result.sessionId, SESSION);

    const forwarded = events[0].args;
    const { exec, resume } = splitByCommand(forwarded);
    assert.equal(forwarded[0], "exec");
    assert.equal(forwarded[forwarded.indexOf("resume") + 1], SESSION);
    assert.equal(forwarded.at(-1), "-");
    assert.ok(exec.includes("-C") && exec.includes("-s"), "cwd and sandbox bind to `exec`");
    assert.ok(!resume.includes("-C") && !resume.includes("-s"), "and never to `resume`");
    for (const flag of resume) {
      assert.ok(CODEX_OPTION_CONTRACT["exec resume"].has(flag), `\`${flag}\` reached the subcommand`);
    }
    assert.ok(forwarded.includes("fake-model"));

    // Prompt on stdin, and mirrored next to the resume log for the operator.
    assert.match(events[0].stdin, /answer to the blocking question/);
    assert.match(readFileSync(join(laneDir, "resume-1.prompt.md"), "utf8"), /answer to the blocking question/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Opt-in drift probe: re-verifies the recorded contract against whatever codex
// is installed. Off by default so `npm test` never depends on a local CLI.
test("recorded option contract still matches the installed codex CLI", {
  skip: process.env.AGENT_MANAGER_CODEX_LIVE_CONTRACT === "1"
    ? false
    : "set AGENT_MANAGER_CODEX_LIVE_CONTRACT=1 to probe the installed codex CLI",
}, () => {
  const help = (subcommand) => {
    const { result } = spawnCommandSync(resolveCodexBin(), [...subcommand, "--help"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    assert.equal(result.status, 0, `codex ${subcommand.join(" ")} --help failed`);
    return String(result.stdout || "") + "\n" + String(result.stderr || "");
  };

  const execHelp = help(["exec"]);
  const resumeHelp = help(["exec", "resume"]);
  const emitted = {
    exec: optionTokens(buildCodexArgs({ cwd: "/repo/wt", platform: "win32", model: "gpt-5", env: {} }).slice(1)),
    "exec resume": splitByCommand(
      buildCodexArgs({ cwd: "/repo/wt", platform: "win32", model: "gpt-5", resumeSessionId: SESSION, env: {} }),
    ).resume,
  };

  const mentions = (help_, flag) => new RegExp(`(?:^|[\\s,])${flag.replace(/-/g, "\\-")}(?:[\\s,=]|$)`, "m").test(help_);
  for (const flag of emitted.exec) {
    assert.ok(mentions(execHelp, flag), `\`codex exec\` no longer documents ${flag}`);
  }
  for (const flag of emitted["exec resume"]) {
    assert.ok(mentions(resumeHelp, flag), `\`codex exec resume\` no longer documents ${flag}`);
  }
  for (const flag of ["-C", "--cd", "-s", "--sandbox"]) {
    assert.ok(!mentions(resumeHelp, flag), `\`codex exec resume\` now accepts ${flag}; revisit the resume argv`);
  }
});
