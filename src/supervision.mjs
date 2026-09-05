// Bytes are evidence of a responsive transport, not proof of useful work.
// Silence first becomes visible telemetry. A grace period permits quiet model
// reasoning and tools; the attempt deadline also bounds noisy stuck processes.
export function inspectSupervision({ startedAt, lastByteAt, policy = {}, now = Date.now() }) {
  const silentMs = Math.max(0, now - lastByteAt);
  const elapsedMs = Math.max(0, now - startedAt);
  const quietMs = (policy.stall_timeout_sec ?? 600) * 1000;
  const graceMs = (policy.stall_grace_sec ?? 600) * 1000;
  const deadlineMs = (policy.max_runtime_sec ?? Infinity) * 1000;
  const reason = elapsedMs >= deadlineMs ? "runtime_deadline"
    : silentMs >= quietMs + graceMs ? "silence_timeout" : null;
  return {
    state: reason ? "expired" : silentMs >= quietMs ? "quiet" : "active",
    silentSec: Math.floor(silentMs / 1000),
    elapsedSec: Math.floor(elapsedMs / 1000),
    reason,
    action: reason ? "cancel" : "continue",
  };
}
