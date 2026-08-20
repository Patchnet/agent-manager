export const MAX_LANES = 5;
export const DEFAULT_MAX_CONCURRENCY = 3;

/**
 * The fake harness is available only to tests or to the explicit local demo.
 * Test mode redirects state into a disposable sandbox; demo mode grants only
 * fake-harness access so its telemetry remains available after launch.
 */
export function fakeHarnessAllowed(env = process.env) {
  return env.AGENT_MANAGER_TEST_MODE === "1" || env.AGENT_MANAGER_DEMO === "1";
}
