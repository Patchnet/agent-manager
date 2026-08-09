// Test isolation for Agent Manager roots.
//
// Importing this module guarantees the current process — and every child it
// spawns — resolves its runs, claims, and brain roots inside a disposable temp
// sandbox, no matter what `AGENT_MANAGER_*` variables the operator has exported.
// The enforcement itself lives in `src/config.mjs`, which every root passes
// through; this module is the test-side handle on it.
//
// Usable three ways:
//   1. implicitly — `node --test` sets `NODE_TEST_CONTEXT`, which config.mjs
//      already treats as a sandbox trigger;
//   2. as an import in a test file, for `sandboxRoot()` / `isolatedRoot()`;
//   3. as a preload — `node --import ./test-support/isolated-roots.mjs …` —
//      for runners that do not set `NODE_TEST_CONTEXT`.

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { TEST_SANDBOX_ENV, isIsolatedPath, testSandboxRoot } from "../src/config.mjs";

// Side effect on import: claim the sandbox now, so a preload run is isolated
// before any Agent Manager module resolves a root.
const SANDBOX = testSandboxRoot();

/** Absolute path of this test session's sandbox. Shared with child processes. */
export function sandboxRoot() {
  return SANDBOX;
}

/** Creates a fresh disposable directory inside the sandbox. */
export function isolatedRoot(prefix = "case-") {
  return mkdtempSync(join(SANDBOX, prefix));
}

/**
 * Child-process environment that stays inside the sandbox. Ambient roots are
 * dropped rather than inherited, so a spawned CLI cannot reach a real registry
 * even if it never consults `src/config.mjs`.
 */
export function isolatedEnv(overrides = {}) {
  const root = isolatedRoot("env-");
  const env = { ...process.env };
  delete env.AGENT_MANAGER_CONFIG;
  return {
    ...env,
    [TEST_SANDBOX_ENV]: SANDBOX,
    AGENT_MANAGER_DEV_ROOT: join(root, "dev"),
    AGENT_MANAGER_RUNS_ROOT: join(root, "runs"),
    AGENT_MANAGER_CLAIMS_ROOT: join(root, "claims"),
    AGENT_MANAGER_BRAIN_ROOT: join(root, "brain"),
    ...overrides,
  };
}

/**
 * Points this process's Agent Manager roots at `root` before any src module is
 * imported. Call at the top of a test file, above its dynamic imports.
 */
export function useIsolatedRoots(root = isolatedRoot("roots-")) {
  const roots = {
    AGENT_MANAGER_DEV_ROOT: root,
    AGENT_MANAGER_RUNS_ROOT: join(root, "runs"),
    AGENT_MANAGER_CLAIMS_ROOT: join(root, "claims"),
    AGENT_MANAGER_BRAIN_ROOT: join(root, "brain"),
  };
  delete process.env.AGENT_MANAGER_CONFIG;
  delete process.env.AGENT_MANAGER_CLAIM_BIN;
  Object.assign(process.env, roots, { [TEST_SANDBOX_ENV]: SANDBOX });
  return { root, ...roots };
}

/** Throws unless the roots this process actually resolved are disposable. */
export async function assertResolvedRootsIsolated() {
  const paths = await import("../src/paths.mjs");
  return assertIsolated({
    runs: paths.RUNS_ROOT,
    claims: paths.CLAIMS_ROOT,
    brain: paths.BRAIN_ROOT,
  }, "resolved root");
}

/** Throws unless every supplied path is disposable. */
export function assertIsolated(paths, label = "path") {
  for (const [name, value] of Object.entries(paths)) {
    if (!isIsolatedPath(value)) {
      throw new Error(`${label} ${name} escaped test isolation: ${value}`);
    }
  }
  return true;
}

export { TEST_SANDBOX_ENV, isIsolatedPath };
