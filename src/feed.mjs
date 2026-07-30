const DEFAULT_TIMEOUT_MS = 2_000;

export class FeedPublisher {
  constructor(config = {}, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.enabled = config.enabled === true;
    this.baseUrl = String(config.baseUrl || "").replace(/\/+$/, "");
    this.topic = String(config.topic || "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.sent = new Set();
  }

  async publish(event, payload = {}) {
    if (!this.enabled) return { ok: false, skipped: true };
    const laneId = payload.laneId || "run";
    const attempt = payload.attempt || 1;
    const key = [payload.runId || "unknown", event, laneId, attempt].join(":");
    if (this.sent.has(key)) return { ok: true, duplicate: true };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const message = {
        event,
        ...payload,
        at: payload.at || new Date().toISOString(),
      };
      const response = await this.fetchImpl(this.baseUrl + "/feed/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topic: this.topic,
          body: JSON.stringify(message),
          author: "agent-manager",
          idempotencyKey: key,
          meta: message,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error("Agent Feed HTTP " + response.status);
      }
      this.sent.add(key);
      return { ok: true, result: await response.json().catch(() => null) };
    } catch (error) {
      return {
        ok: false,
        error: error?.name === "AbortError"
          ? "Agent Feed publish timed out"
          : String(error?.message || error),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createFeedPublisher(config, options) {
  return new FeedPublisher(config, options);
}

export async function publishFeedEvent(publisher, status, event, payload = {}) {
  const result = await publisher.publish(event, {
    runId: status.runId,
    repo: status.repo,
    state: status.state,
    ...payload,
  });
  status.feed ||= {
    enabled: publisher.enabled,
    baseUrl: publisher.baseUrl || null,
    topic: publisher.topic || null,
    failures: 0,
  };
  if (result.ok && !result.duplicate) {
    status.feed.lastEvent = event;
    status.feed.lastPublishedAt = new Date().toISOString();
    status.feed.lastError = null;
  } else if (result.error) {
    status.feed.failures += 1;
    status.feed.lastError = result.error;
  }
  return result;
}
