import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HarnessPreflightError,
  preflightSelectedHarnesses,
} from "../src/preflight.mjs";
import { harnessFailureRecommendation } from "../src/harness/setup.mjs";

const root = mkdtempSync(join(tmpdir(), "agent-manager-harness-preflight-"));
const originalClaudeBin = process.env.CLAUDE_BIN;
const originalCodexBin = process.env.CODEX_BIN;
const originalTestMode = process.env.AGENT_MANAGER_TEST_MODE;

test.after(() => {
  restore("CLAUDE_BIN", originalClaudeBin);
  restore("CODEX_BIN", originalCodexBin);
  restore("AGENT_MANAGER_TEST_MODE", originalTestMode);
  rmSync(root, { recursive: true, force: true });
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function workflow(harnesses) {
  return {
    lanes: harnesses.map((harness, index) => ({
      id: `lane-${index + 1}`,
      harness,
      permission_mode: "acceptEdits",
    })),
  };
}

test("selected working harness passes once and unselected missing harness does not block", () => {
  process.env.CLAUDE_BIN = process.execPath;
  process.env.CODEX_BIN = join(root, "missing-codex");
  const checks = preflightSelectedHarnesses(workflow(["claude", "claude"]));
  assert.equal(checks.filter((check) => check.invocation.length > 0).length, 1);
  assert.equal(checks[0].harness, "claude");
  assert.equal(checks[0].ok, true);
});

test("selected missing harness returns actionable sanitized evidence", () => {
  const missing = join(root, "missing-claude");
  process.env.CLAUDE_BIN = missing;
  assert.throws(
    () => preflightSelectedHarnesses(workflow(["claude"])),
    (error) => {
      assert.ok(error instanceof HarnessPreflightError);
      assert.equal(error.code, "selected-harness-unavailable");
      assert.equal(error.failures[0].harness, "claude");
      assert.equal(error.failures[0].command, missing);
      assert.equal(
        error.failures[0].remediation,
        harnessFailureRecommendation("claude", { platform: process.platform }),
      );
      assert.equal(error.runtime.hostPlatform, process.platform);
      assert.equal(Object.hasOwn(error.runtime, "env"), false);
      assert.match(error.message, /selected harness preflight failed.*claude/s);
      return true;
    },
  );
});

test("test-only fake harness skips executable preflight", () => {
  process.env.AGENT_MANAGER_TEST_MODE = "1";
  assert.deepEqual(preflightSelectedHarnesses(workflow(["fake"])), []);
});
