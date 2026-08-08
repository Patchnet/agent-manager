import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  initAgentManagerConfig,
  parseConfigEnv,
  resolveAgentManagerConfig,
} from "../src/config.mjs";

const root = mkdtempSync(join(tmpdir(), "agent-manager-config-"));
const home = join(root, "home");
const work = join(root, "work");
const configPath = join(home, ".agent-manager", "config.env");

test.after(() => rmSync(root, { recursive: true, force: true }));

test("config parser accepts dotenv syntax and ignores unrelated variables", () => {
  assert.deepEqual(parseConfigEnv([
    "# paths",
    "export AGENT_MANAGER_DEV_ROOT=../dev",
    'AGENT_MANAGER_RUNS_ROOT="./run data"',
    "SECRET_VALUE=do-not-load",
  ].join("\n")), {
    AGENT_MANAGER_DEV_ROOT: "../dev",
    AGENT_MANAGER_RUNS_ROOT: "./run data",
  });
});

test("config resolution uses command line, environment, user config, then defaults", () => {
  initAgentManagerConfig({
    env: {}, home, cwdValue: work, configPath,
    devRoot: join(root, "configured-dev"),
    runsRoot: "./relative-runs",
    claimsRoot: join(root, "configured-claims"),
    brainRoot: join(root, "configured-brain"),
  });
  const resolved = resolveAgentManagerConfig({
    env: { AGENT_MANAGER_RUNS_ROOT: join(root, "environment-runs") },
    home,
    cwdValue: work,
    configPath,
    overrides: { AGENT_MANAGER_DEV_ROOT: join(root, "cli-dev") },
  });
  assert.equal(resolved.values.AGENT_MANAGER_DEV_ROOT, join(root, "cli-dev"));
  assert.equal(resolved.sources.AGENT_MANAGER_DEV_ROOT, "command-line");
  assert.equal(resolved.values.AGENT_MANAGER_RUNS_ROOT, join(root, "environment-runs"));
  assert.equal(resolved.sources.AGENT_MANAGER_RUNS_ROOT, "environment");
  assert.equal(resolved.values.AGENT_MANAGER_CLAIMS_ROOT, join(root, "configured-claims"));
  assert.equal(resolved.sources.AGENT_MANAGER_CLAIMS_ROOT, "user-config");
  assert.equal(resolved.values.AGENT_MANAGER_BRAIN_ROOT, join(root, "configured-brain"));
  assert.equal(resolved.sources.AGENT_MANAGER_BRAIN_ROOT, "user-config");
  assert.equal(resolved.values.AGENT_MANAGER_CLAIM_BIN, null);
  assert.equal(resolved.sources.AGENT_MANAGER_CLAIM_BIN, "default");
});

test("config init writes portable absolute paths and protects existing config", () => {
  const secondPath = join(root, "space home", "config.env");
  const result = initAgentManagerConfig({
    env: {}, home, cwdValue: work, configPath: secondPath,
    devRoot: ".",
    runsRoot: join(root, "run data"),
    claimsRoot: "~/claims",
    brainRoot: "~/brain",
  });
  const text = readFileSync(result.path, "utf8");
  assert.match(text, /AGENT_MANAGER_DEV_ROOT=/);
  const resolved = resolveAgentManagerConfig({ env: {}, home, cwdValue: root, configPath: secondPath });
  assert.equal(resolved.values.AGENT_MANAGER_DEV_ROOT, resolve(work));
  assert.equal(resolved.values.AGENT_MANAGER_RUNS_ROOT, join(root, "run data"));
  assert.equal(resolved.values.AGENT_MANAGER_CLAIMS_ROOT, join(home, "claims"));
  assert.equal(resolved.values.AGENT_MANAGER_BRAIN_ROOT, join(home, "brain"));
  assert.throws(() => initAgentManagerConfig({ env: {}, home, cwdValue: work, configPath: secondPath }), /already exists/);
});
