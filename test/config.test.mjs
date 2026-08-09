import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PATH_OVERRIDE_ENV,
  formatAgentManagerConfig,
  formatIgnoredPathOverrides,
  initAgentManagerConfig,
  parseConfigEnv,
  pathOverridesAllowed,
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

test("pathOverridesAllowed accepts 1 and true only", () => {
  assert.equal(pathOverridesAllowed({}), false);
  assert.equal(pathOverridesAllowed({ [PATH_OVERRIDE_ENV]: "0" }), false);
  assert.equal(pathOverridesAllowed({ [PATH_OVERRIDE_ENV]: "1" }), true);
  assert.equal(pathOverridesAllowed({ [PATH_OVERRIDE_ENV]: "true" }), true);
});

test("user-config beats ambient environment and CLI unless path overrides are unlocked", () => {
  initAgentManagerConfig({
    env: {}, home, cwdValue: work, configPath,
    devRoot: join(root, "configured-dev"),
    runsRoot: "./relative-runs",
    claimsRoot: join(root, "configured-claims"),
    brainRoot: join(root, "configured-brain"),
  });
  const locked = resolveAgentManagerConfig({
    env: { AGENT_MANAGER_RUNS_ROOT: join(root, "environment-runs") },
    home,
    cwdValue: work,
    configPath,
    overrides: { AGENT_MANAGER_DEV_ROOT: join(root, "cli-dev") },
    execArgv: [],
  });
  assert.equal(locked.values.AGENT_MANAGER_DEV_ROOT, join(root, "configured-dev"));
  assert.equal(locked.sources.AGENT_MANAGER_DEV_ROOT, "user-config");
  assert.equal(locked.values.AGENT_MANAGER_RUNS_ROOT, resolve(work, "relative-runs"));
  assert.equal(locked.sources.AGENT_MANAGER_RUNS_ROOT, "user-config");
  assert.equal(locked.values.AGENT_MANAGER_CLAIMS_ROOT, join(root, "configured-claims"));
  assert.equal(locked.sources.AGENT_MANAGER_CLAIMS_ROOT, "user-config");
  assert.equal(locked.values.AGENT_MANAGER_BRAIN_ROOT, join(root, "configured-brain"));
  assert.equal(locked.pathLock.active, true);
  assert.equal(locked.pathLock.unlocked, false);
  assert.equal(locked.ignoredOverrides.length, 2);
  assert.ok(locked.ignoredOverrides.some((entry) => entry.key === "AGENT_MANAGER_RUNS_ROOT" && entry.source === "environment"));
  assert.ok(locked.ignoredOverrides.some((entry) => entry.key === "AGENT_MANAGER_DEV_ROOT" && entry.source === "command-line"));
  assert.match(formatIgnoredPathOverrides(locked.ignoredOverrides), /ignored path overrides/);
  assert.match(formatAgentManagerConfig(locked), /path lock: active/);

  const unlocked = resolveAgentManagerConfig({
    env: {
      AGENT_MANAGER_RUNS_ROOT: join(root, "environment-runs"),
      [PATH_OVERRIDE_ENV]: "1",
    },
    home,
    cwdValue: work,
    configPath,
    overrides: { AGENT_MANAGER_DEV_ROOT: join(root, "cli-dev") },
    execArgv: [],
  });
  assert.equal(unlocked.values.AGENT_MANAGER_DEV_ROOT, join(root, "cli-dev"));
  assert.equal(unlocked.sources.AGENT_MANAGER_DEV_ROOT, "command-line");
  assert.equal(unlocked.values.AGENT_MANAGER_RUNS_ROOT, join(root, "environment-runs"));
  assert.equal(unlocked.sources.AGENT_MANAGER_RUNS_ROOT, "environment");
  assert.equal(unlocked.pathLock.unlocked, true);
  assert.equal(unlocked.ignoredOverrides.length, 0);
});

test("matching environment values are not reported as ignored overrides", () => {
  const runs = join(root, "same-runs");
  const localConfig = join(root, "agree-config.env");
  initAgentManagerConfig({
    env: {}, home, cwdValue: work, configPath: localConfig,
    devRoot: join(root, "agree-dev"),
    runsRoot: runs,
    claimsRoot: join(root, "agree-claims"),
    brainRoot: join(root, "agree-brain"),
  });
  const resolved = resolveAgentManagerConfig({
    env: { AGENT_MANAGER_RUNS_ROOT: runs },
    home,
    cwdValue: work,
    configPath: localConfig,
    execArgv: [],
  });
  assert.equal(resolved.sources.AGENT_MANAGER_RUNS_ROOT, "user-config");
  assert.equal(resolved.ignoredOverrides.length, 0);
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
  assert.match(text, new RegExp(PATH_OVERRIDE_ENV));
  const resolved = resolveAgentManagerConfig({
    env: {}, home, cwdValue: root, configPath: secondPath, execArgv: [],
  });
  assert.equal(resolved.values.AGENT_MANAGER_DEV_ROOT, resolve(work));
  assert.equal(resolved.values.AGENT_MANAGER_RUNS_ROOT, join(root, "run data"));
  assert.equal(resolved.values.AGENT_MANAGER_CLAIMS_ROOT, join(home, "claims"));
  assert.equal(resolved.values.AGENT_MANAGER_BRAIN_ROOT, join(home, "brain"));
  assert.throws(() => initAgentManagerConfig({ env: {}, home, cwdValue: work, configPath: secondPath, execArgv: [] }), /already exists/);
  assert.throws(
    () => initAgentManagerConfig({
      env: {}, home, cwdValue: work, configPath: secondPath, force: true, execArgv: [],
    }),
    /refusing config init --force while path lock is active/,
  );
  const replaced = initAgentManagerConfig({
    env: { [PATH_OVERRIDE_ENV]: "1" },
    home,
    cwdValue: work,
    configPath: secondPath,
    force: true,
    execArgv: [],
    runsRoot: join(root, "replaced-runs"),
  });
  assert.equal(replaced.values.AGENT_MANAGER_RUNS_ROOT, join(root, "replaced-runs"));
});
