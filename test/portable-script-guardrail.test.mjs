import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { currentHead, validateLaneGuardrails } from "../src/guardrails.mjs";

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "agent-manager-portable-script-"));
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", [
    "-C", repo,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid",
    "commit", "-m", "base",
  ], { stdio: "ignore" });
  return { repo, baseCommit: currentHead(repo) };
}

function inspect(files) {
  const { repo, baseCommit } = fixture();
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(repo, name), contents);
    }
    return validateLaneGuardrails({
      worktree: repo,
      scope: Object.keys(files),
      baseCommit,
      policy: { allow_commit: false },
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test("extensionless shebang and shell-extension CRLF files fail", () => {
  const result = inspect({
    launch: "#!/bin/sh\r\necho launch\r\n",
    "tools.sh": "echo tools\r\n",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.portableScriptViolations, ["launch", "tools.sh"]);
  assert.match(result.policyViolations.join("; "), /launch/);
  assert.match(result.policyViolations.join("; "), /tools\.sh/);
});

test("LF portable scripts and ordinary CRLF text pass", () => {
  const result = inspect({
    launch: "#!/bin/sh\necho launch\n",
    "tools.sh": "echo tools\n",
    "notes.txt": "ordinary\r\ntext\r\n",
    "notes.md": "# Notes\r\n\r\nOrdinary Markdown.\r\n",
    "tools.ps1": "Write-Output 'PowerShell'\r\n",
    "tools.bat": "@echo batch\r\n",
    "tools.cmd": "@echo command\r\n",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.portableScriptViolations, []);
});
