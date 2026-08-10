import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-notify-"));
const runsRoot = join(root, ".runs");
process.env.AGENT_MANAGER_DEV_ROOT = root;
process.env.AGENT_MANAGER_RUNS_ROOT = runsRoot;
mkdirSync(runsRoot, { recursive: true });
delete process.env.AGENT_MANAGER_NOTIFY;

const {
  buildNotification,
  classifyNotification,
  createNotifier,
  notifyCommand,
  notifyEnabled,
  NOTIFY_BODY_ENV,
  NOTIFY_TITLE_ENV,
} = await import("../src/notify.mjs?notify-test");
const { runWatchSignal } = await import("../src/watch-signal.mjs?notify-test");
const { writeStatus } = await import("../src/status.mjs?notify-test");

test.after(() => rmSync(root, { recursive: true, force: true }));

const RUN_ID = "run-20260810-151139-72d0e97c";

function wake(overrides = {}) {
  return {
    reason: "state_change",
    runId: RUN_ID,
    state: "running",
    repo: "fixture-repo",
    lanes: [{ id: "core", state: "running", needsInput: false }],
    ship: null,
    delivery: null,
    ...overrides,
  };
}

// A fake child process: enough surface for the sink (on/unref) plus a hook to
// replay the spawn error a missing notifier would produce.
function fakeSpawn(calls, { fail = false } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return {
      on(event, handler) {
        if (fail && event === "error") handler(new Error("spawn ENOENT"));
        return this;
      },
      unref() {},
    };
  };
}

test("notifyEnabled prefers the explicit flag and falls back to the env", () => {
  assert.equal(notifyEnabled({}, {}), false);
  assert.equal(notifyEnabled({ notify: true }, {}), true);
  assert.equal(notifyEnabled({ notify: false }, { AGENT_MANAGER_NOTIFY: "1" }), false, "an explicit off beats the env");
  assert.equal(notifyEnabled({}, { AGENT_MANAGER_NOTIFY: "1" }), true);
  assert.equal(notifyEnabled({}, { AGENT_MANAGER_NOTIFY: " TRUE " }), true);
  assert.equal(notifyEnabled({}, { AGENT_MANAGER_NOTIFY: "0" }), false);
  assert.equal(notifyEnabled({}, { AGENT_MANAGER_NOTIFY: "maybe" }), false);
});

test("classifyNotification fires on exactly four events", () => {
  assert.equal(classifyNotification(wake()), null, "a plain state change is terminal-only signal");
  assert.equal(classifyNotification(wake({ reason: "heartbeat" })), null);
  assert.equal(classifyNotification(null), null);

  assert.equal(classifyNotification(wake({ reason: "terminal", state: "merged" })).kind, "terminal");

  const needs = classifyNotification(wake({ reason: "needs_input", laneId: "core" }));
  assert.equal(needs.kind, "needs_input");
  assert.equal(needs.laneId, "core");

  const blocked = classifyNotification(wake({
    state: "blocked",
    lanes: [{ id: "docs", state: "blocked", needsInput: true }],
  }));
  assert.equal(blocked.kind, "blocked");
  assert.equal(blocked.laneId, "docs");

  const ship = classifyNotification(wake({ state: "merged", ship: { state: "done", phase: "merge" } }));
  assert.equal(ship.kind, "ship");
  assert.equal(ship.shipState, "done");
  assert.equal(
    classifyNotification(wake({ ship: { state: "running", phase: "ci" } })),
    null,
    "a ship still in flight is not an outcome",
  );
});

test("buildNotification carries the short id, run title, state, and where to look", () => {
  const notification = buildNotification(
    wake({ reason: "needs_input", state: "blocked", laneId: "core" }),
    { runId: RUN_ID, identity: { subject: "Product UX wave" } },
  );
  assert.equal(notification.kind, "needs_input");
  assert.equal(notification.shortId, "72d0e97c");
  assert.equal(notification.title, "AM 72d0e97c · needs input");
  assert.equal(notification.subject, "Product UX wave");
  assert.equal(notification.stateLine, "blocked · lane core");
  assert.ok(notification.link.endsWith(join(RUN_ID, "status.json")), notification.link);
  assert.match(notification.body, /^Product UX wave — blocked · lane core\n/);

  const shipped = buildNotification(
    wake({ state: "merged", ship: { state: "done", phase: "merge", prUrl: "https://example.invalid/pr/7" } }),
    null,
  );
  assert.equal(shipped.kind, "ship");
  assert.equal(shipped.stateLine, "ship done · merge");
  assert.equal(shipped.link, "https://example.invalid/pr/7", "a PR beats the status path");
  assert.equal(shipped.subject, "fixture-repo", "repo stands in when the run has no identity");

  assert.equal(buildNotification(wake()), null);
});

test("buildNotification keeps a hostile run title on one line", () => {
  const notification = buildNotification(
    wake({ reason: "terminal", state: "failed" }),
    { identity: { subject: "line one\nline two\ttabbed" } },
  );
  assert.equal(notification.subject, "line one line two tabbed");
  assert.equal(notification.body.split("\n").length, 2, "subject, state, then exactly one link line");
});

test("notifyCommand builds a per-platform invocation with the text in the environment", () => {
  const notification = buildNotification(wake({ reason: "terminal", state: "merged" }));

  const windows = notifyCommand(notification, { platform: "win32", env: { SystemRoot: "C:\\Windows" } });
  assert.match(windows.command, /powershell\.exe$/);
  assert.ok(windows.args.includes("-NoProfile"));
  const script = windows.args[windows.args.length - 1];
  assert.match(script, /ToastNotificationManager/);
  assert.ok(!script.includes(notification.title), "toast text is never interpolated into the script");
  assert.equal(windows.env[NOTIFY_TITLE_ENV], notification.title);
  assert.equal(windows.env[NOTIFY_BODY_ENV], notification.body);
  assert.equal(windows.env.SystemRoot, "C:\\Windows", "the parent environment is preserved");

  const mac = notifyCommand(notification, { platform: "darwin", env: {} });
  assert.equal(mac.command, "osascript");
  assert.match(mac.args[1], /display notification \(system attribute/);
  assert.equal(mac.env[NOTIFY_BODY_ENV], notification.body);

  const linux = notifyCommand(notification, { platform: "linux", env: {} });
  assert.equal(linux.command, "notify-send");
  assert.deepEqual(linux.args, ["--app-name=agent-manager", notification.title, notification.body]);
});

test("createNotifier spawns once per distinct event and stays silent otherwise", () => {
  const calls = [];
  const notifier = createNotifier({ platform: "linux", env: {}, spawnImpl: fakeSpawn(calls) });

  assert.equal(notifier.notify(wake()), null, "state changes do not toast");
  assert.equal(calls.length, 0);

  const blocked = wake({ reason: "needs_input", state: "blocked", laneId: "core" });
  assert.ok(notifier.notify(blocked));
  assert.equal(notifier.notify(blocked), null, "the same event does not toast twice");
  assert.equal(calls.length, 1);

  assert.ok(notifier.notify(wake({ reason: "needs_input", state: "blocked", laneId: "docs" })), "a second lane is a new event");
  assert.ok(notifier.notify(wake({ reason: "terminal", state: "merged" })));
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.shell, false);
});

test("a disabled notifier never spawns", () => {
  const calls = [];
  const notifier = createNotifier({ enabled: false, platform: "linux", env: {}, spawnImpl: fakeSpawn(calls) });
  assert.equal(notifier.notify(wake({ reason: "terminal", state: "merged" })), null);
  assert.equal(calls.length, 0);
});

test("a missing or failing notifier is logged, never thrown", () => {
  const logged = [];
  const failing = createNotifier({
    platform: "linux",
    env: {},
    spawnImpl: fakeSpawn([], { fail: true }),
    log: (line) => logged.push(line),
  });
  assert.ok(failing.notify(wake({ reason: "terminal", state: "merged" })));
  assert.match(logged[0], /notify: notify-send unavailable \(spawn ENOENT\)/);

  const throwing = createNotifier({
    platform: "linux",
    env: {},
    spawnImpl: () => {
      throw new Error("no child processes");
    },
    log: (line) => logged.push(line),
  });
  assert.equal(throwing.notify(wake({ reason: "terminal", state: "failed" })), null);
  assert.match(logged[1], /notify: no child processes/);
});

test("runWatchSignal reports the sink state and hands it every wake", async () => {
  const runId = "run-notify-watch";
  mkdirSync(join(runsRoot, runId), { recursive: true });
  writeStatus(runId, {
    runId,
    state: "merged",
    repo: "fixture",
    lanes: [{ id: "core", state: "done", exitCode: 0 }],
  });

  const seen = [];
  const lines = [];
  const result = await runWatchSignal(runId, {
    pollMs: 1,
    maxTicks: 1,
    sleep: async () => {},
    write: (line) => lines.push(line),
    notifier: {
      enabled: true,
      notify: (payload, status) => {
        seen.push([payload.reason, status?.state]);
        return null;
      },
    },
  });

  assert.equal(result.reason, "terminal");
  assert.deepEqual(seen, [["terminal", "merged"]]);
  assert.match(lines[0], /notify=on/);
});

test("runWatchSignal leaves notifications off unless they are asked for", async () => {
  const runId = "run-notify-watch-off";
  mkdirSync(join(runsRoot, runId), { recursive: true });
  writeStatus(runId, { runId, state: "merged", repo: "fixture", lanes: [] });

  const lines = [];
  await runWatchSignal(runId, {
    pollMs: 1,
    maxTicks: 1,
    sleep: async () => {},
    write: (line) => lines.push(line),
    env: {},
  });
  assert.match(lines[0], /notify=off/);
});
