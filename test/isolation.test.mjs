import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  TEST_SANDBOX_ENV,
  detectTestContext,
  initAgentManagerConfig,
  isIsolatedPath,
  resolveAgentManagerConfig,
} from "../src/config.mjs";
import { assertIsolated, isolatedEnv, isolatedRoot, sandboxRoot } from "../test-support/isolated-roots.mjs";

// Paths an operator really uses on a fleet machine. Nothing a test does may
// resolve onto them, and no test may have to remember that on its own.
const HOSTILE = {
  AGENT_MANAGER_DEV_ROOT: resolve("/dev-root-that-must-not-be-used"),
  AGENT_MANAGER_RUNS_ROOT: resolve("/runs-root-that-must-not-be-used"),
  AGENT_MANAGER_CLAIMS_ROOT: resolve("/claims-root-that-must-not-be-used"),
  AGENT_MANAGER_BRAIN_ROOT: resolve("/brain-root-that-must-not-be-used"),
  AGENT_MANAGER_CLAIM_BIN: resolve("/claim-bin-that-must-not-be-used.mjs"),
};

const cli = join(process.cwd(), "bin", "agent-manager.mjs");
const claimTool = join(process.cwd(), "tools", "claim.mjs");

function resolveWith(env, extra = {}) {
  return resolveAgentManagerConfig({
    env: { ...env },
    home: resolve("/home-that-must-not-be-used"),
    cwdValue: process.cwd(),
    ...extra,
  });
}

test("a test process is detected from the runner, the sandbox, or an explicit opt-in", () => {
  assert.equal(detectTestContext({ env: {}, execArgv: [] }), false);
  assert.equal(detectTestContext({ env: { NODE_TEST_CONTEXT: "child-v8" }, execArgv: [] }), true);
  assert.equal(detectTestContext({ env: { AGENT_MANAGER_TEST_MODE: "1" }, execArgv: [] }), true);
  assert.equal(detectTestContext({ env: { [TEST_SANDBOX_ENV]: sandboxRoot() }, execArgv: [] }), true);
  assert.equal(detectTestContext({ env: {}, execArgv: ["--test"] }), true);
  assert.equal(detectTestContext({ env: {}, execArgv: ["--test-concurrency=4"] }), true);
  // This very file runs under the runner, so ambient detection must agree.
  assert.equal(detectTestContext(), true);
});

test("ambient operator roots are dropped in a test process and replaced by the sandbox", () => {
  const resolved = resolveWith({ ...HOSTILE, NODE_TEST_CONTEXT: "child-v8" });
  assertIsolated({
    runs: resolved.values.AGENT_MANAGER_RUNS_ROOT,
    claims: resolved.values.AGENT_MANAGER_CLAIMS_ROOT,
    brain: resolved.values.AGENT_MANAGER_BRAIN_ROOT,
  }, "resolved");
  assert.equal(resolved.sources.AGENT_MANAGER_RUNS_ROOT, "test-sandbox");
  assert.equal(resolved.sources.AGENT_MANAGER_CLAIMS_ROOT, "test-sandbox");
  assert.equal(resolved.sources.AGENT_MANAGER_BRAIN_ROOT, "test-sandbox");
  // The dev root is a lookup path, not a write target, so it falls back to the
  // working directory instead of a sandbox subdirectory — but never to the
  // operator's workspace.
  assert.equal(resolved.values.AGENT_MANAGER_DEV_ROOT, resolve(process.cwd()));
  assert.equal(resolved.sources.AGENT_MANAGER_DEV_ROOT, "default");
  // A foreign claim binary would write outside the sandbox, so it is dropped
  // in favour of the bundled tool.
  assert.equal(resolved.values.AGENT_MANAGER_CLAIM_BIN, null);
  assert.ok(resolved.testSandbox);
});

test("roots a test chooses itself are honoured when they are disposable", () => {
  const root = isolatedRoot("chosen-");
  const resolved = resolveWith({
    NODE_TEST_CONTEXT: "child-v8",
    AGENT_MANAGER_RUNS_ROOT: join(root, "runs"),
    AGENT_MANAGER_CLAIMS_ROOT: join(root, "claims"),
    AGENT_MANAGER_BRAIN_ROOT: join(root, "brain"),
  });
  assert.equal(resolved.values.AGENT_MANAGER_RUNS_ROOT, join(root, "runs"));
  assert.equal(resolved.sources.AGENT_MANAGER_RUNS_ROOT, "environment");
  assert.equal(resolved.values.AGENT_MANAGER_CLAIMS_ROOT, join(root, "claims"));
  assert.equal(resolved.values.AGENT_MANAGER_BRAIN_ROOT, join(root, "brain"));
});

test("outside a test process the operator's configuration is untouched", () => {
  const resolved = resolveWith({ ...HOSTILE }, { execArgv: [] });
  assert.equal(resolved.values.AGENT_MANAGER_RUNS_ROOT, HOSTILE.AGENT_MANAGER_RUNS_ROOT);
  assert.equal(resolved.sources.AGENT_MANAGER_RUNS_ROOT, "environment");
  assert.equal(resolved.values.AGENT_MANAGER_CLAIMS_ROOT, HOSTILE.AGENT_MANAGER_CLAIMS_ROOT);
  assert.equal(resolved.values.AGENT_MANAGER_BRAIN_ROOT, HOSTILE.AGENT_MANAGER_BRAIN_ROOT);
  assert.equal(resolved.values.AGENT_MANAGER_CLAIM_BIN, HOSTILE.AGENT_MANAGER_CLAIM_BIN);
  assert.equal(resolved.testSandbox, null);
});

test("a user configuration file outside the sandbox is never read by a test", () => {
  const home = isolatedRoot("config-home-");
  const configPath = join(home, "config.env");
  mkdirSync(home, { recursive: true });
  writeFileSync(configPath, [
    `AGENT_MANAGER_RUNS_ROOT=${resolve("/user-config-runs")}`,
    `AGENT_MANAGER_BRAIN_ROOT=${resolve("/user-config-brain")}`,
    "",
  ].join("\n"));
  const resolved = resolveWith({ NODE_TEST_CONTEXT: "child-v8", AGENT_MANAGER_CONFIG: configPath });
  // The file itself is disposable and therefore read, but the roots it names
  // are not, so they are still dropped.
  assert.equal(resolved.configPath, configPath);
  assertIsolated({
    runs: resolved.values.AGENT_MANAGER_RUNS_ROOT,
    brain: resolved.values.AGENT_MANAGER_BRAIN_ROOT,
  }, "user-config");
  assert.equal(resolved.sources.AGENT_MANAGER_RUNS_ROOT, "test-sandbox");

  // A config file at a real location is not even opened.
  const operatorConfig = resolveWith({
    NODE_TEST_CONTEXT: "child-v8",
    AGENT_MANAGER_CONFIG: resolve("/operator-home/.agent-manager/config.env"),
  });
  assert.ok(isIsolatedPath(operatorConfig.configPath));
  assert.notEqual(operatorConfig.configPath, resolve("/operator-home/.agent-manager/config.env"));
});

test("a test cannot overwrite the operator's configuration file", () => {
  assert.throws(
    () => initAgentManagerConfig({
      env: { NODE_TEST_CONTEXT: "child-v8" },
      home: resolve("/operator-home"),
      cwdValue: process.cwd(),
    }),
    /refusing to write agent-manager configuration outside the test sandbox/,
  );
  const written = initAgentManagerConfig({
    env: { NODE_TEST_CONTEXT: "child-v8" },
    home: isolatedRoot("init-home-"),
    cwdValue: process.cwd(),
    configPath: join(isolatedRoot("init-config-"), "config.env"),
  });
  assert.ok(existsSync(written.path));
});

test("a spawned CLI joins the same sandbox instead of the ambient roots", () => {
  const probe = [
    'const paths = await import("./src/paths.mjs");',
    "process.stdout.write(JSON.stringify({",
    "  sandbox: paths.TEST_SANDBOX_ROOT,",
    "  runs: paths.RUNS_ROOT,",
    "  claims: paths.CLAIMS_ROOT,",
    "  brain: paths.BRAIN_ROOT,",
    "  claimBin: paths.CLAIM_BIN,",
    "}));",
  ].join("\n");
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: process.cwd(),
    env: { ...process.env, ...HOSTILE, [TEST_SANDBOX_ENV]: sandboxRoot() },
    encoding: "utf8",
    windowsHide: true,
  });
  const child = JSON.parse(output);
  assert.equal(child.sandbox, sandboxRoot());
  assertIsolated({ runs: child.runs, claims: child.claims, brain: child.brain }, "child");
  assert.equal(child.claimBin, join(process.cwd(), "tools", "claim.mjs"));
});

test("the bundled claim tool cannot write into an ambient claims registry", () => {
  const hostileRoot = HOSTILE.AGENT_MANAGER_CLAIMS_ROOT;
  execFileSync(process.execPath, [
    claimTool,
    "claim",
    "--repo", "isolation-repo",
    "--branch", "isolation-branch",
    "--lane", "isolation",
    "--scope", "src/**",
    "--agent", "test-agent",
  ], {
    env: { ...process.env, AGENT_MANAGER_CLAIMS_ROOT: hostileRoot, [TEST_SANDBOX_ENV]: sandboxRoot() },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(existsSync(hostileRoot), false);
  const claimed = join(sandboxRoot(), "claims", "isolation-repo", "isolation-branch.json");
  assert.equal(existsSync(claimed), true);
  execFileSync(process.execPath, [claimTool, "release", "--repo", "isolation-repo", "--branch", "isolation-branch"], {
    env: { ...process.env, AGENT_MANAGER_CLAIMS_ROOT: hostileRoot, [TEST_SANDBOX_ENV]: sandboxRoot() },
    encoding: "utf8",
    windowsHide: true,
  });
});

test("a lane resumed without a branch cannot leak a claim outside the sandbox", async () => {
  // Regression guard for a real leak: a status document with no lane branch
  // produced `<claims root>/<repo>/undefined.json` in the operator registry.
  const env = isolatedEnv({ AGENT_MANAGER_TEST_MODE: "1" });
  const runId = "run-isolation-claim";
  const probe = [
    'const { writeStatus } = await import("./src/status.mjs");',
    'const { prepareReply } = await import("./src/reply.mjs");',
    `writeStatus(${JSON.stringify(runId)}, {`,
    `  runId: ${JSON.stringify(runId)},`,
    '  state: "blocked",',
    '  repo: "repo",',
    "  startedAt: new Date().toISOString(),",
    '  lanes: [{ id: "lane", harness: "fake", state: "blocked", sessionId: "s", needsInput: { prompt: "q" } }],',
    "});",
    `try { prepareReply(${JSON.stringify(runId)}, "lane", "answer"); } catch {}`,
    'process.stdout.write("done");',
  ].join("\n");
  execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  const claimsRoot = env.AGENT_MANAGER_CLAIMS_ROOT;
  const leaked = existsSync(claimsRoot)
    ? readdirSync(claimsRoot, { recursive: true, encoding: "utf8" }).filter((entry) => entry.includes("undefined"))
    : [];
  // Whatever the reply path does with a branchless lane, it stays disposable.
  assertIsolated({ claims: claimsRoot }, "reply");
  for (const entry of leaked) {
    assert.ok(isIsolatedPath(join(claimsRoot, entry)), `leaked claim escaped isolation: ${entry}`);
  }
});
