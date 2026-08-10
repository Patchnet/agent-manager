import { spawn } from "node:child_process";
import { join } from "node:path";
import { shortRunId } from "./identity.mjs";
import { runDir } from "./paths.mjs";

// Opt-in OS notification sink for `watch-signal`. The watcher already decides
// when Master Dev should wake; this turns exactly four of those wakes into a
// desktop toast so an operator who is not staring at the terminal still learns
// that a run needs them.
//
// Ultralight by construction: no daemon, no npm dependency, no background
// service. Every platform path shells out to a notifier the OS already ships,
// values travel as environment variables (so no quoting or injection surface),
// and any failure is logged and swallowed — a missing notifier must never take
// the watcher down with it.

export const NOTIFY_ENV = "AGENT_MANAGER_NOTIFY";
export const NOTIFY_TITLE_ENV = "AGENT_MANAGER_NOTIFY_TITLE";
export const NOTIFY_BODY_ENV = "AGENT_MANAGER_NOTIFY_BODY";
export const NOTIFY_APP_ID_ENV = "AGENT_MANAGER_NOTIFY_APP_ID";

/** The only wake shapes that earn an OS toast. */
export const NOTIFY_KINDS = ["needs_input", "blocked", "terminal", "ship"];

const KIND_LABELS = {
  needs_input: "needs input",
  blocked: "blocked",
  terminal: "finished",
  ship: "ship outcome",
};

// A ship channel that reached one of these has an outcome worth surfacing;
// `running` and `blocked` are already covered by the other two kinds.
const SHIP_OUTCOME_STATES = new Set(["done", "failed", "cancelled"]);
const TRUTHY = new Set(["1", "true", "yes", "on"]);

// Control characters would garble a toast (and a terminal log line); collapse
// them to spaces before anything is rendered.
const CONTROL_CHARS = /\p{Cc}+/gu;
const MAX_TITLE = 72;
const MAX_LINE = 140;

// Windows PowerShell's own AppUserModelID — using it means the toast renders
// without registering a Start Menu shortcut for agent-manager first.
const WINDOWS_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

// Self-contained and constant: the toast text is read from the child's
// environment, never interpolated into the script.
const WINDOWS_TOAST_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]",
  "[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]",
  "$xml=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$text=$xml.GetElementsByTagName('text')",
  `$text.Item(0).AppendChild($xml.CreateTextNode($env:${NOTIFY_TITLE_ENV})) | Out-Null`,
  `$text.Item(1).AppendChild($xml.CreateTextNode($env:${NOTIFY_BODY_ENV})) | Out-Null`,
  "$toast=[Windows.UI.Notifications.ToastNotification]::new($xml)",
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:${NOTIFY_APP_ID_ENV}).Show($toast)`,
].join("; ");

// `system attribute` reads the child environment, so the AppleScript source is
// a constant here too.
const MACOS_TOAST_SCRIPT =
  `display notification (system attribute "${NOTIFY_BODY_ENV}") with title (system attribute "${NOTIFY_TITLE_ENV}")`;

/**
 * Explicit `--notify` / `notify: false` wins; otherwise fall back to the env.
 * Callers wiring a CLI flag must pass `null`/`undefined` when the flag is
 * absent — passing a bare `false` suppresses `AGENT_MANAGER_NOTIFY`.
 */
export function notifyEnabled({ notify = null } = {}, env = process.env) {
  if (notify !== null && notify !== undefined) return Boolean(notify);
  return TRUTHY.has(String(env?.[NOTIFY_ENV] ?? "").trim().toLowerCase());
}

function oneLine(value, max) {
  const text = String(value ?? "").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function runStatusPath(runId) {
  if (!runId) return null;
  try {
    return join(runDir(runId), "status.json");
  } catch {
    return null; // unusual run id: drop the link rather than throw
  }
}

/**
 * Map a wake payload onto one of the four notify kinds, or null for the wakes
 * (state_change, heartbeat) that stay terminal-only.
 */
export function classifyNotification(payload) {
  if (!payload) return null;
  const shipState = payload.ship?.state || null;
  const blockedLane = (payload.lanes || []).find((lane) => lane.state === "blocked" || lane.needsInput) || null;

  if (payload.reason === "terminal") return { kind: "terminal", laneId: null, shipState };
  if (shipState && SHIP_OUTCOME_STATES.has(shipState)) return { kind: "ship", laneId: null, shipState };
  if (payload.reason === "needs_input") {
    return { kind: "needs_input", laneId: payload.laneId || blockedLane?.id || null, shipState };
  }
  if (payload.state === "blocked" || shipState === "blocked" || blockedLane) {
    return { kind: "blocked", laneId: blockedLane?.id || null, shipState };
  }
  return null;
}

function stateLineFor(payload, { kind, laneId, shipState }) {
  const parts = [];
  if (kind === "ship") {
    parts.push(`ship ${shipState}`);
    if (payload.ship?.phase) parts.push(payload.ship.phase);
  } else {
    parts.push(payload.state || "unknown");
    if (kind === "needs_input" && payload.phase === "ship") {
      parts.push(`ship ${payload.shipPhase || payload.ship?.phase || "gate"}`);
    }
    if (laneId) parts.push(`lane ${laneId}`);
  }
  if (kind === "needs_input" && payload.cadence?.operatorInputRequired?.length) {
    parts.push(`reply: ${payload.cadence.operatorInputRequired.join(" | ")}`);
  }
  return oneLine(parts.join(" · "), MAX_LINE);
}

/**
 * Build the toast for a wake payload: short run id and kind in the title, run
 * title plus a one-line state and the thing to look at in the body.
 * Returns null when the wake does not qualify.
 */
export function buildNotification(payload, status = null) {
  const classified = classifyNotification(payload);
  if (!classified) return null;
  const { kind, laneId, shipState } = classified;
  const runId = payload.runId || status?.runId || null;
  const shortId = shortRunId(runId);
  const subject = oneLine(
    status?.identity?.subject || status?.identity?.displayTitle || payload.repo || runId || "run",
    MAX_TITLE,
  );
  const stateLine = stateLineFor(payload, classified);
  const link = payload.ship?.prUrl || runStatusPath(runId) || "";
  return {
    kind,
    // Dedupe signature. A ship outcome keys off the ship channel rather than
    // the run state, so a later run-state change cannot re-toast the same
    // merge; everything else keys off the run state, lane, and ship phase.
    key: [
      kind,
      runId,
      kind === "ship" ? shipState : payload.state || "-",
      laneId || "-",
      payload.ship?.phase || "-",
    ].join("|"),
    runId,
    shortId,
    title: oneLine(`AM ${shortId} · ${KIND_LABELS[kind]}`, MAX_TITLE),
    subject,
    stateLine,
    link,
    body: [`${subject} — ${stateLine}`, link].filter(Boolean).join("\n"),
  };
}

/**
 * Resolve the OS notifier invocation. The command carries no toast text — the
 * values ride in `env` so nothing has to be quoted or escaped.
 */
export function notifyCommand(notification, { platform = process.platform, env = process.env } = {}) {
  const childEnv = {
    ...env,
    [NOTIFY_TITLE_ENV]: notification.title,
    [NOTIFY_BODY_ENV]: notification.body,
  };
  if (platform === "win32") {
    childEnv[NOTIFY_APP_ID_ENV] = WINDOWS_APP_ID;
    return {
      command: env?.SystemRoot
        ? `${env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        : "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_TOAST_SCRIPT],
      env: childEnv,
    };
  }
  if (platform === "darwin") {
    return { command: "osascript", args: ["-e", MACOS_TOAST_SCRIPT], env: childEnv };
  }
  // Linux and everything else: notify-send when the desktop provides it.
  return {
    command: "notify-send",
    args: ["--app-name=agent-manager", notification.title, notification.body],
    env: childEnv,
  };
}

/**
 * Notification sink for the watcher. `notify()` is fire-and-forget, deduped by
 * run/state signature, and never throws.
 */
export function createNotifier({
  enabled = true,
  platform = process.platform,
  env = process.env,
  spawnImpl = spawn,
  log = () => {},
} = {}) {
  const active = Boolean(enabled);
  const sent = new Set();
  return {
    enabled: active,
    sent,
    notify(payload, status = null) {
      if (!active) return null;
      try {
        const notification = buildNotification(payload, status);
        if (!notification || sent.has(notification.key)) return null;
        // Record before spawning: a notifier that fails should stay quiet
        // rather than retry on every poll.
        sent.add(notification.key);
        const { command, args, env: childEnv } = notifyCommand(notification, { platform, env });
        const child = spawnImpl(command, args, {
          env: childEnv,
          stdio: "ignore",
          shell: false,
          windowsHide: true,
        });
        child?.on?.("error", (error) => log(`notify: ${command} unavailable (${error.message})`));
        child?.unref?.();
        return notification;
      } catch (error) {
        log(`notify: ${String(error?.message || error)}`);
        return null;
      }
    },
  };
}
