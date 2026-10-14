import { readEvents } from "./events.mjs";
import { refreshMerges } from "./ship.mjs";
import { isTerminalState, readStatus, writeStatus } from "./status.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Block until the next event (for one run, or any run when runId is null),
 * print it as one JSON line, and exit. Hosts run this as a background command
 * so the harness wakes the thread when it returns. While a run's PRs wait on
 * auto-merge, it also checks GitHub so the merge itself becomes an event.
 */
export async function waitForEvent(runId = null, {
  timeoutSec = 0,
  pollMs = 2_000,
  mergeCheckSec = 60,
  kinds = null,
} = {}) {
  const read = () => readEvents(runId ? { runId } : {});
  const seen = read().length;
  if (runId) {
    const status = readStatus(runId);
    if (!status) throw new Error(`no status for ${runId}`);
    if (isTerminalState(status.state)) return { kind: "run_closed", runId, text: status.state, alreadyClosed: true };
  }
  const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : Infinity;
  let nextMergeCheck = 0;
  while (Date.now() < deadline) {
    const fresh = read().slice(seen).filter((event) => !kinds || kinds.includes(event.kind));
    if (fresh.length) return fresh[0];
    if (runId && Date.now() >= nextMergeCheck) {
      nextMergeCheck = Date.now() + mergeCheckSec * 1000;
      const status = readStatus(runId);
      if (["shipping", "waiting_operator"].includes(status?.state) && refreshMerges(status)) {
        writeStatus(runId, status);
        continue;
      }
    }
    await sleep(pollMs);
  }
  return { kind: "timeout", runId };
}
