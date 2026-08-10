// Presentation helpers shared by every view.
//
// These mirror the terminal boards on purpose: the same state should read the
// same way whether the operator is in `agent-manager fleet` or the dashboard.

const DAY_MS = 86_400_000;

const STATE_TONE = {
  running: "live",
  admitted: "live",
  shipping: "live",
  active: "live",
  queued: "muted",
  planned: "muted",
  "dependency-waiting": "muted",
  blocked: "attention",
  needs_input: "attention",
  pending_delivery: "attention",
  delivery_review_pending: "attention",
  correction_pending: "attention",
  ship_gate_pending: "attention",
  failed: "fail",
  rejected: "fail",
  delivered: "settled",
  merged: "settled",
  released: "settled",
  reviewed: "settled",
  filed: "settled",
  workers_done: "settled",
  cancelled: "settled",
  abandoned: "settled",
  superseded: "settled",
};

const TERMINAL_RUN_STATES = new Set([
  "cancelled",
  "abandoned",
  "failed",
  "filed",
  "merged",
  "released",
  "reviewed",
  "rejected",
]);

export function stateTone(state) {
  return STATE_TONE[String(state || "").toLowerCase()] || "muted";
}

export function isSettled(state) {
  return TERMINAL_RUN_STATES.has(String(state || "").toLowerCase());
}

export function stateLabel(state) {
  return String(state || "unknown").replace(/_/g, " ");
}

/** A run id is only useful to a reader as its unique suffix. */
export function shortRunId(value) {
  const text = String(value || "-");
  const match = /^run-\d{8}-\d{6}-(.+)$/.exec(text);
  return match ? match[1].slice(-8) : text.slice(-8);
}

/** Compact relative age: now, 45m, 3h, 6d, 5w, 8mo, 2y. */
export function humanizeAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(ms / DAY_MS);
  if (days < 14) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function since(iso, now = Date.now()) {
  const parsed = Date.parse(iso || "");
  return Number.isFinite(parsed) ? humanizeAge(now - parsed) : "-";
}

export function clockTime(iso) {
  const parsed = Date.parse(iso || "");
  if (!Number.isFinite(parsed)) return "-";
  return new Date(parsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function isoDate(iso) {
  const parsed = Date.parse(iso || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "unknown";
}

export function formatTokenCount(value) {
  const count = Number(value || 0);
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
  if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 2 : 1)}M`;
  return `${(count / 1_000_000_000).toFixed(2)}B`;
}

export function formatCost(value) {
  const cost = Number(value || 0);
  if (cost === 0) return "$0";
  if (cost < 0.01) return "<$0.01";
  if (cost < 100) return `$${cost.toFixed(2)}`;
  return `$${Math.round(cost).toLocaleString("en-US")}`;
}

export function totalTokens(row) {
  if (!row) return 0;
  return (row.input || 0) + (row.output || 0) + (row.cacheRead || 0) + (row.cacheWrite || 0);
}
