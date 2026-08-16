export const MAX_LANES = 5;
export const DEFAULT_MAX_CONCURRENCY = 3;

/**
 * Who may launch the fake harness. Two separate opt-ins, deliberately:
 * `AGENT_MANAGER_TEST_MODE` also redirects every root into a temporary sandbox
 * that is removed when the process exits, which is right for a test and wrong
 * for `agent-manager demo` — a demo whose telemetry deletes itself cannot show
 * the operator fleet, status, or Delivery Review. `AGENT_MANAGER_DEMO` permits
 * the fake harness and nothing else, so a demo run lands in the real runs root
 * and behaves like any other run.
 */
export function fakeHarnessAllowed(env = process.env) {
  return env.AGENT_MANAGER_TEST_MODE === "1" || env.AGENT_MANAGER_DEMO === "1";
}
