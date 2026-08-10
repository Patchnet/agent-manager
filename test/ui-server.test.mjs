import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnv } from "../test-support/isolated-roots.mjs";

const root = mkdtempSync(join(tmpdir(), "agent-manager-ui-"));
const runsRoot = join(root, "runs");
const brainRoot = join(root, "brain");
const distRoot = join(root, "dist");
const emptyRoot = join(root, "empty-provider-root");
mkdirSync(runsRoot, { recursive: true });
mkdirSync(brainRoot, { recursive: true });

// Pin every provider that reads process.env at import time to an empty fixture
// path so the suite never reads the developer's real harness logs.
process.env.AGENT_MANAGER_CLAUDE_LOGS_ROOT = emptyRoot;
process.env.AGENT_MANAGER_CODEX_LOGS_ROOT = emptyRoot;
process.env.AGENT_MANAGER_TOKEN_LOGS_ROOT = emptyRoot;
delete process.env.AGENT_MANAGER_TOKEN_PROVIDERS;
delete process.env.AGENT_MANAGER_TOKEN_PRICING;

const {
  assertLoopbackHost,
  buildInstructionsPage,
  buildRunDetail,
  isLoopbackHost,
  parseUiArgs,
  runsFingerprint,
  startUiServer,
  uiUsage,
} = await import("../src/ui-server.mjs?ui-server-test");

function writeRun(runId, status, { events = [] } = {}) {
  const dir = join(runsRoot, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "status.json"),
    JSON.stringify({ runId, updatedAt: "2026-08-10T12:00:00.000Z", ...status }, null, 2),
  );
  if (events.length) {
    writeFileSync(
      join(dir, "events.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
  }
}

writeRun("run-20260810-120000-aaaaaaaa", {
  repo: "example-repo",
  state: "running",
  startedAt: "2026-08-10T12:00:00.000Z",
  identity: { repoShorthand: "example-repo", subject: "add the widget" },
  lanes: [
    { id: "lane-one", state: "running", harness: "claude", scope: "src/**" },
    { id: "lane-two", state: "queued", harness: "claude", scope: "docs/**" },
  ],
}, {
  events: [
    { schema: "agent-manager.event.v1", type: "status", at: "2026-08-10T12:00:00.000Z", state: "running", lanes: [] },
  ],
});

writeRun("run-20260810-130000-bbbbbbbb", {
  repo: "other-repo",
  state: "blocked",
  identity: { repoShorthand: "other-repo", subject: "needs a decision" },
  lanes: [
    {
      id: "lane-one",
      state: "blocked",
      harness: "claude",
      scope: "src/**",
      needsInput: { type: "question", prompt: "Which database?", blocking: true },
    },
  ],
});

let instance;

before(async () => {
  instance = await startUiServer({
    port: 0,
    host: "127.0.0.1",
    runsRoot,
    brainRoot,
    distDir: join(distRoot, "does-not-exist"),
    pollMs: 250,
  });
});

after(async () => {
  await instance?.close();
  rmSync(root, { recursive: true, force: true });
});

const api = (path) => fetch(new URL(path, instance.url));

test("loopback detection accepts only loopback addresses", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.9.9.9"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);

  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("192.168.1.10"), false);
  assert.equal(isLoopbackHost("10.0.0.1"), false);
  assert.equal(isLoopbackHost("example.com"), false);
  assert.equal(isLoopbackHost(""), false);
  assert.equal(isLoopbackHost(undefined), false);
});

test("the server refuses to bind a non-loopback address", async () => {
  await assert.rejects(
    () => startUiServer({ port: 0, host: "0.0.0.0", runsRoot }),
    /localhost-only/,
  );
  assert.throws(() => assertLoopbackHost("192.168.1.4"), /refusing to bind/);
});

test("GET /api/health reports a read-only viewer", async () => {
  const response = await api("/api/health");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.readOnly, true);
  assert.equal(body.ui.built, false);
  assert.match(body.telemetry.runsRoot, /runs$/);
});

test("GET /api/runs summarizes every run with short ids", async () => {
  const response = await api("/api/runs");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schema, "agent-manager.fleet.v1");
  assert.equal(body.runs.length, 2);

  const blocked = body.runs.find((run) => run.runId === "run-20260810-130000-bbbbbbbb");
  assert.equal(blocked.shortId, "bbbbbbbb");
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.needsInput, true);
  assert.equal(blocked.blocker.prompt, "Which database?");

  // Blocked runs sort ahead of running ones: the board leads with what is stuck.
  assert.equal(body.runs[0].runId, "run-20260810-130000-bbbbbbbb");
  assert.equal(body.counts.blocked, 1);
});

test("GET /api/runs/:id returns the full status and events", async () => {
  const response = await api("/api/runs/run-20260810-120000-aaaaaaaa");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.runId, "run-20260810-120000-aaaaaaaa");
  assert.equal(body.status.repo, "example-repo");
  assert.equal(body.status.lanes.length, 2);
  assert.equal(body.events.length, 1);
});

test("GET /api/runs/:id is 404 for an unknown run", async () => {
  const response = await api("/api/runs/run-20260810-999999-zzzzzzzz");
  assert.equal(response.status, 404);
});

test("GET /api/runs/:id refuses a traversal attempt", async () => {
  // Encoded so the client cannot normalize the path away before it is sent.
  const response = await api("/api/runs/%2e%2e%2f%2e%2e%2fsecrets");
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /safe slug|not safe/i);
});

test("write methods are rejected outright", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await fetch(new URL("/api/runs", instance.url), { method });
    assert.equal(response.status, 405, `${method} should not be served`);
  }
});

test("unknown API endpoints are 404, not the SPA", async () => {
  const response = await api("/api/nope");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /application\/json/);
});

test("GET /api/goals returns a goal payload even without a brain", async () => {
  const response = await api("/api/goals");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.available, "boolean");
  assert.ok(body.counts, "goal payload always carries counts");
  assert.ok(Array.isArray(body.groups));
});

test("GET /api/tokens returns usage windows", async () => {
  const response = await api("/api/tokens");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.available, true);
  assert.equal(body.schema, "agent-manager.tokens.v1");
  assert.ok(Array.isArray(body.byModel));
  assert.ok(Array.isArray(body.byRepo));
});

test("GET /api/events opens an SSE stream with an initial snapshot", async () => {
  const controller = new AbortController();
  const response = await fetch(new URL("/api/events", instance.url), {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  // The server writes retry + hello + an initial runs frame immediately.
  while (!text.includes("event: runs")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  assert.match(text, /event: hello/);
  assert.match(text, /event: runs/);
  const payload = JSON.parse(/event: runs\ndata: (.+)/.exec(text)[1]);
  assert.equal(payload.runs.length, 2);
  assert.equal(payload.counts.blocked, 1);

  await reader.cancel().catch(() => {});
  controller.abort();
});

test("the unbuilt SPA falls back to build instructions, not an error", async () => {
  const response = await api("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const body = await response.text();
  assert.match(body, /npm run build/);
  assert.match(body, /\/api\/runs/);
});

test("the instructions page names the two commands that fix it", () => {
  const page = buildInstructionsPage();
  assert.match(page, /cd ui/);
  assert.match(page, /npm install/);
});

test("a built SPA is served, and assets cannot escape dist", async () => {
  const dist = join(distRoot, "built");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>spa</title>");
  writeFileSync(join(dist, "assets", "app-abcd1234.js"), "export const ok = 1;\n");
  writeFileSync(join(root, "outside-secret.txt"), "should never be served");

  const served = await startUiServer({ port: 0, host: "127.0.0.1", runsRoot, brainRoot, distDir: dist });
  try {
    const index = await fetch(new URL("/", served.url));
    assert.equal(index.status, 200);
    assert.match(await index.text(), /<title>spa<\/title>/);

    const asset = await fetch(new URL("/assets/app-abcd1234.js", served.url));
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /javascript/);

    // Unknown client routes fall through to the SPA shell.
    const route = await fetch(new URL("/goals", served.url));
    assert.equal(route.status, 200);
    assert.match(await route.text(), /<title>spa<\/title>/);

    // ...but a traversal resolves outside dist and must not be served.
    const escape = await fetch(new URL("/%2e%2e%2foutside-secret.txt", served.url));
    const escaped = await escape.text();
    assert.doesNotMatch(escaped, /should never be served/);
  } finally {
    await served.close();
  }
});

test("buildRunDetail reads a run without a server", () => {
  const detail = buildRunDetail("run-20260810-120000-aaaaaaaa", { runsRoot });
  assert.equal(detail.status.state, "running");
  assert.equal(buildRunDetail("run-20260810-000000-missing", { runsRoot }), null);
  assert.throws(() => buildRunDetail("../escape", { runsRoot }), /safe slug|not safe/i);
});

test("runsFingerprint changes when a run's status is rewritten", () => {
  const before = runsFingerprint(runsRoot);
  writeRun("run-20260810-140000-cccccccc", { repo: "third-repo", state: "running", lanes: [] });
  const after = runsFingerprint(runsRoot);
  assert.notEqual(before, after);
  assert.match(after, /run-20260810-140000-cccccccc/);
  rmSync(join(runsRoot, "run-20260810-140000-cccccccc"), { recursive: true, force: true });
});

test("parseUiArgs validates ports, hosts, and unknown flags", () => {
  assert.deepEqual(parseUiArgs([]), {
    port: 4317,
    host: "127.0.0.1",
    open: true,
    json: false,
    help: false,
  });

  const parsed = parseUiArgs(["--port", "0", "--no-open", "--json"]);
  assert.equal(parsed.port, 0);
  assert.equal(parsed.open, false);
  assert.equal(parsed.json, true);

  assert.equal(parseUiArgs(["--host", "::1"]).host, "::1");
  assert.throws(() => parseUiArgs(["--host", "0.0.0.0"]), /localhost-only/);
  assert.throws(() => parseUiArgs(["--port", "99999"]), /--port must be/);
  assert.throws(() => parseUiArgs(["--port"]), /requires a value/);
  assert.throws(() => parseUiArgs(["--serve-everywhere"]), /unknown ui option/);
});

test("usage states the architecture boundary", () => {
  const text = uiUsage();
  assert.match(text, /read-only/i);
  assert.match(text, /localhost-only|localhost/i);
  assert.match(text, /No daemon/i);
});

test("the ui command is discoverable from the CLI", () => {
  // Also proves bin/agent-manager.mjs can import src/ui-server.mjs cleanly.
  const cli = join(process.cwd(), "bin", "agent-manager.mjs");
  const env = isolatedEnv();
  const help = execFileSync(process.execPath, [cli, "--help"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.match(help, /agent-manager ui /);
  assert.match(help, /--notify/);

  const uiHelp = execFileSync(process.execPath, [cli, "ui", "--help"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.match(uiHelp, /read-only dashboard/i);
});
