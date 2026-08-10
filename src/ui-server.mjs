import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFleetSnapshot } from "./fleet.mjs";
import { buildGoalsSnapshot } from "./goals-board.mjs";
import { buildTokensSnapshot } from "./tokens.mjs";
import { BRAIN_ROOT, RUNS_ROOT, RUNS_ROOT_SOURCE, assertSafeSlug } from "./paths.mjs";
import { AGENT_MANAGER_VERSION, currentVersionInfo } from "./version.mjs";

// Optional read-only glass over the run telemetry contract.
//
// The CLI is the product. This server exists only while `agent-manager ui` is
// in the foreground: there is no daemon, no background install, no writes, and
// no network exposure. Every route reads the same files the terminal boards
// read, so the dashboard can never disagree with `agent-manager fleet` — and
// can never move a run into a state the CLI did not put it in.

export const UI_SCHEMA = "agent-manager.ui.v1";
export const DEFAULT_UI_PORT = 4317;
export const DEFAULT_UI_HOST = "127.0.0.1";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIST_DIR = join(PACKAGE_ROOT, "ui", "dist");
const DEFAULT_POLL_MS = 1_500;
const SSE_HEARTBEAT_MS = 25_000;
const MAX_DETAIL_EVENTS = 400;
const READ_ONLY_HINT = "read-only dashboard: only GET and HEAD are served";

const MIME_TYPES = new Map(Object.entries({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}));

/**
 * Loopback-only by design.
 *
 * There is no auth layer here because there is nothing to authenticate: the
 * server never leaves this machine. That guarantee is only true while the bind
 * address is a loopback address, so a non-loopback host is a hard error rather
 * than a warning — binding 0.0.0.0 would publish fleet telemetry to the LAN.
 */
export function isLoopbackHost(host) {
  const value = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!value) return false;
  if (value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return false;
  return octets[0] === 127;
}

export function assertLoopbackHost(host) {
  if (!isLoopbackHost(host)) {
    throw new Error(
      `refusing to bind ${host}: the dashboard is localhost-only and has no authentication`,
    );
  }
  return host;
}

function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readRunDirectories(runsRoot) {
  if (!existsSync(runsRoot)) return [];
  try {
    return readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Cheap change fingerprint for the runs root.
 *
 * `status.json` is rewritten atomically on every transition, so its size and
 * mtime are enough to notice work happening without parsing anything. The SSE
 * stream only emits when this string changes, which keeps a chatty `fs.watch`
 * (Windows fires several events per atomic replace) down to one client event.
 */
export function runsFingerprint(runsRoot) {
  const parts = [];
  for (const runId of readRunDirectories(runsRoot).sort()) {
    try {
      const stats = statSync(join(runsRoot, runId, "status.json"));
      parts.push(`${runId}:${stats.mtimeMs}:${stats.size}`);
    } catch {
      parts.push(`${runId}:absent`);
    }
  }
  return parts.join("|");
}

/**
 * Watch the runs root, preferring the OS watcher and always keeping a poll.
 *
 * Recursive `fs.watch` is unavailable on some platforms and silently misses
 * events on network and container filesystems, so the poll is the contract and
 * the watcher is only an accelerator for the common case.
 */
export function watchRunsRoot(runsRoot, onChange, { pollMs = DEFAULT_POLL_MS } = {}) {
  let fingerprint = runsFingerprint(runsRoot);
  let closed = false;

  const check = () => {
    if (closed) return;
    const next = runsFingerprint(runsRoot);
    if (next === fingerprint) return;
    fingerprint = next;
    onChange();
  };

  let debounce = null;
  const schedule = () => {
    if (closed || debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      check();
    }, 120);
    debounce.unref?.();
  };

  let watcher = null;
  if (existsSync(runsRoot)) {
    try {
      watcher = watch(runsRoot, { recursive: true }, schedule);
      watcher.on("error", () => {}); // the poll below is the real contract
    } catch {
      watcher = null;
    }
  }

  const timer = setInterval(check, Math.max(250, pollMs));
  timer.unref?.();

  return {
    get fingerprint() {
      return fingerprint;
    },
    check,
    close() {
      closed = true;
      clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      try {
        watcher?.close();
      } catch {
        // already gone
      }
    },
  };
}

/** Compact per-run shape for the live stream; the SPA refetches for detail. */
function liveRunSummary(run) {
  return {
    runId: run.runId,
    shortId: run.shortId,
    state: run.state,
    needsInput: run.needsInput,
    blocker: run.blocker,
    updatedAt: run.updatedAt,
    laneCounts: run.laneCounts,
    shipState: run.shipState,
    deliveryState: run.deliveryState,
  };
}

export function buildRunsPayload({ runsRoot = RUNS_ROOT, runsRootSource = RUNS_ROOT_SOURCE, ...options } = {}) {
  return buildFleetSnapshot({ ...options, runsRoot }, { runsRootSource });
}

export function buildLivePayload({ runsRoot = RUNS_ROOT } = {}) {
  const snapshot = buildFleetSnapshot({ runsRoot, limit: 200 }, { runsRootSource: "ui" });
  return {
    at: snapshot.at,
    counts: snapshot.counts,
    runs: snapshot.runs.map(liveRunSummary),
    recentEvents: snapshot.recentEvents.slice(0, 30),
  };
}

export function buildRunDetail(runId, { runsRoot = RUNS_ROOT } = {}) {
  const safeId = assertSafeSlug(runId, "run id");
  const dir = join(runsRoot, safeId);
  const status = safeJson(join(dir, "status.json"));
  if (!status) return null;
  let events = [];
  const eventsPath = join(dir, "events.jsonl");
  if (existsSync(eventsPath)) {
    try {
      events = readFileSync(eventsPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(-MAX_DETAIL_EVENTS);
    } catch {
      events = [];
    }
  }
  return { schema: UI_SCHEMA, runId: safeId, status, events };
}

/**
 * Goals and tokens are best-effort surfaces.
 *
 * A missing brain or an unreadable provider root is an ordinary state on a
 * fresh machine, not a server error — the view renders its own empty state, so
 * degrade with an explanation instead of failing the request.
 */
async function goalsPayload({ brainRoot }) {
  try {
    const snapshot = await buildGoalsSnapshot({ root: brainRoot, limit: 200 });
    return { ...snapshot, available: true, error: null };
  } catch (error) {
    return {
      schema: "agent-manager.goals-board.v2",
      available: false,
      error: String(error?.message || error),
      brain: { root: brainRoot, source: "unavailable" },
      at: new Date().toISOString(),
      counts: { roots: 0, total: 0, open: 0, stale: 0, hidden: 0 },
      groups: [],
      rows: [],
    };
  }
}

function tokensPayload(tokensOptions) {
  try {
    return { ...buildTokensSnapshot(tokensOptions), available: true, error: null };
  } catch (error) {
    return {
      schema: "agent-manager.tokens.v1",
      available: false,
      error: String(error?.message || error),
      at: new Date().toISOString(),
      sources: [],
      warnings: [],
      totals: null,
      windows: null,
      byDay: [],
      byModel: [],
      byRepo: [],
      bySource: [],
    };
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

/**
 * Serve one built asset, refusing anything that resolves outside `ui/dist`.
 *
 * The URL is decoded before resolution, so containment has to be re-checked
 * against the resolved path rather than trusted from the request string.
 */
function serveStatic(res, distDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  if (decoded.includes("\0")) return false;
  const target = resolve(distDir, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  const rel = relative(resolve(distDir), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  let stats;
  try {
    stats = statSync(target);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  const type = MIME_TYPES.get(extname(target).toLowerCase()) || "application/octet-stream";
  const immutable = /\/assets\//.test(decoded) && /-[A-Za-z0-9_]{8,}\./.test(decoded);
  res.writeHead(200, {
    "content-type": type,
    "content-length": stats.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(readFileSync(target));
  return true;
}

/**
 * Shown when `ui/dist` has not been built.
 *
 * A dashboard that 500s on a fresh clone reads as broken tooling, so the
 * unbuilt state is a first-class page: it proves the API is already live and
 * says exactly which two commands produce the real thing.
 */
export function buildInstructionsPage({ apiOnly = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Manager dashboard</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #17150f; color: #e8e3d8;
    font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  main { max-width: 46rem; padding: 2.5rem 1.5rem; }
  h1 { font-size: 1.1rem; letter-spacing: .14em; text-transform: uppercase; margin: 0 0 .25rem; }
  p { color: #a39a89; }
  code, pre { background: #211e17; border: 1px solid #332e24; border-radius: 6px; }
  code { padding: .1rem .35rem; }
  pre { padding: .9rem 1rem; overflow-x: auto; color: #e8e3d8; }
  a { color: #3da8dc; }
  .mark { display: grid; grid-template-columns: repeat(3, 12px); gap: 4px; margin-bottom: 1.25rem; }
  .mark i { width: 12px; height: 12px; border-radius: 3px; background: #2a2620; }
  .mark i:nth-child(2), .mark i:nth-child(4), .mark i:nth-child(6), .mark i:nth-child(8) { background: #3da8dc; }
  .mark i:nth-child(5) { background: #d97757; }
  ul { color: #a39a89; padding-left: 1.1rem; }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
  <h1>Agent Manager dashboard</h1>
  <p>The read-only API is serving. The single-page app has not been built yet.</p>
  <pre>cd ui
npm install
npm run build</pre>
  <p>Then restart <code>agent-manager ui</code>. For live reload during UI work, run
  <code>npm run dev</code> in <code>ui/</code> — it proxies <code>/api</code> to this server.</p>
  <p>Available now:</p>
  <ul>
    <li><a href="/api/runs">/api/runs</a> — run board summaries</li>
    <li><a href="/api/goals">/api/goals</a> — goal graph with progress</li>
    <li><a href="/api/tokens">/api/tokens</a> — token usage windows</li>
    <li><code>/api/runs/&lt;runId&gt;</code> — full status and events</li>
    <li><code>/api/events</code> — server-sent live updates</li>
  </ul>
  <p>${apiOnly ? "Serving the API only." : "Optional, read-only, localhost, no daemon."}</p>
</main>
</body>
</html>
`;
}

/**
 * Build the request handler and its live-update fan-out.
 *
 * Split from `startUiServer` so tests can drive the routes over an ephemeral
 * port without reaching into module-level path constants.
 */
export function createUiApp({
  runsRoot = RUNS_ROOT,
  runsRootSource = RUNS_ROOT_SOURCE,
  brainRoot = BRAIN_ROOT,
  distDir = DEFAULT_DIST_DIR,
  tokensOptions = {},
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  const clients = new Set();
  let watcher = null;

  const broadcast = (event, data) => {
    if (!clients.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  };

  const ensureWatcher = () => {
    if (watcher) return watcher;
    watcher = watchRunsRoot(runsRoot, () => {
      try {
        broadcast("runs", buildLivePayload({ runsRoot }));
      } catch (error) {
        broadcast("warning", { message: String(error?.message || error) });
      }
    }, { pollMs });
    return watcher;
  };

  const openStream = (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    res.write(`event: hello\ndata: ${JSON.stringify({
      schema: UI_SCHEMA,
      version: AGENT_MANAGER_VERSION,
      at: new Date().toISOString(),
    })}\n\n`);
    try {
      res.write(`event: runs\ndata: ${JSON.stringify(buildLivePayload({ runsRoot }))}\n\n`);
    } catch {
      // an unreadable runs root still gets a live stream; the poll retries
    }

    clients.add(res);
    ensureWatcher();

    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    const drop = () => {
      clearInterval(heartbeat);
      clients.delete(res);
    };
    req.on("close", drop);
    req.on("error", drop);
    res.on("error", drop);
  };

  const handle = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "method not allowed", detail: READ_ONLY_HINT });
      return;
    }

    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/health") {
      sendJson(res, 200, {
        schema: UI_SCHEMA,
        ok: true,
        version: AGENT_MANAGER_VERSION,
        viewer: currentVersionInfo(),
        readOnly: true,
        telemetry: { runsRoot: resolve(runsRoot), source: runsRootSource },
        ui: { built: existsSync(join(distDir, "index.html")), distDir },
        at: new Date().toISOString(),
      });
      return;
    }

    if (path === "/api/runs") {
      const limit = Number(url.searchParams.get("limit"));
      sendJson(res, 200, buildRunsPayload({
        runsRoot,
        runsRootSource,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.trunc(limit)) : 200,
        activeOnly: url.searchParams.get("active") === "1",
        sinceMs: Number.POSITIVE_INFINITY,
      }));
      return;
    }

    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
    if (runMatch) {
      let detail;
      try {
        detail = buildRunDetail(decodeURIComponent(runMatch[1]), { runsRoot });
      } catch (error) {
        sendJson(res, 400, { error: String(error?.message || error) });
        return;
      }
      if (!detail) {
        sendJson(res, 404, { error: "run not found", runId: runMatch[1] });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }

    if (path === "/api/goals") {
      sendJson(res, 200, await goalsPayload({ brainRoot }));
      return;
    }

    if (path === "/api/tokens") {
      sendJson(res, 200, tokensPayload(tokensOptions));
      return;
    }

    if (path === "/api/events") {
      if (req.method === "HEAD") {
        sendText(res, 200, "", "text/event-stream; charset=utf-8");
        return;
      }
      openStream(req, res);
      return;
    }

    if (path.startsWith("/api/")) {
      sendJson(res, 404, { error: "unknown endpoint", path });
      return;
    }

    if (existsSync(join(distDir, "index.html"))) {
      if (path !== "/" && serveStatic(res, distDir, path)) return;
      // Unknown non-asset paths fall through to the SPA so client routing works.
      if (serveStatic(res, distDir, "/index.html")) return;
    }

    sendText(res, 200, buildInstructionsPage(), "text/html; charset=utf-8");
  };

  return {
    handle: (req, res) => {
      Promise.resolve(handle(req, res)).catch((error) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        sendJson(res, 500, { error: String(error?.message || error) });
      });
    },
    broadcast,
    get clientCount() {
      return clients.size;
    },
    close() {
      watcher?.close();
      watcher = null;
      for (const client of clients) {
        try {
          client.end();
        } catch {
          // client already gone
        }
      }
      clients.clear();
    },
  };
}

export async function startUiServer({
  port = DEFAULT_UI_PORT,
  host = DEFAULT_UI_HOST,
  ...appOptions
} = {}) {
  assertLoopbackHost(host);
  const app = createUiApp(appOptions);
  const server = createServer(app.handle);

  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      rejectPromise(error?.code === "EADDRINUSE"
        ? new Error(`port ${port} is already in use — pass --port <n> to pick another`)
        : error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  const displayHost = host === "::1" ? "[::1]" : host;

  return {
    server,
    app,
    host,
    port: boundPort,
    url: `http://${displayHost}:${boundPort}/`,
    async close() {
      app.close();
      // Keep-alive sockets (and any SSE client that never sent FIN) would
      // otherwise hold `server.close` open indefinitely.
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    },
  };
}

export function uiUsage() {
  return [
    "agent-manager ui - optional read-only dashboard",
    "",
    "Serves a localhost-only web view of the same telemetry the terminal",
    "boards read. Read-only: it never writes run state. No daemon — the",
    "server lives only while this command runs.",
    "",
    "Usage:",
    "  agent-manager ui [options]",
    "",
    "Options:",
    `  --port <n>          listen port (default: ${DEFAULT_UI_PORT}; 0 picks a free one)`,
    `  --host <addr>       loopback address (default: ${DEFAULT_UI_HOST})`,
    "  --open              open the dashboard in a browser (default)",
    "  --no-open           do not launch a browser",
    "  --json              print the bound address as JSON and keep serving",
    "  -h, --help          show this help",
    "",
    "Endpoints:",
    "  /api/runs           run board summaries",
    "  /api/runs/<runId>   full status and event history",
    "  /api/goals          goal graph with progress and temporal context",
    "  /api/tokens         token usage windows and breakdowns",
    "  /api/events         server-sent live updates",
    "",
    "Build the SPA once with `npm install && npm run build` in ui/.",
    "Without it, the server explains how and still serves the API.",
  ].join("\n");
}

export function parseUiArgs(argv = []) {
  const options = {
    port: DEFAULT_UI_PORT,
    host: DEFAULT_UI_HOST,
    open: true,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--port") {
      const value = Number(nextValue());
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      options.port = value;
    } else if (arg === "--host") options.host = assertLoopbackHost(nextValue());
    else if (arg === "--open") options.open = true;
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown ui option: ${arg}`);
  }
  return options;
}

/** Best-effort browser launch; a headless box just keeps the printed URL. */
function openBrowser(url, { platform = process.platform } = {}) {
  const spec = platform === "win32"
    ? { command: "cmd", args: ["/c", "start", "", url] }
    : platform === "darwin"
      ? { command: "open", args: [url] }
      : { command: "xdg-open", args: [url] };
  import("node:child_process")
    .then(({ spawn }) => {
      const child = spawn(spec.command, spec.args, { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    })
    .catch(() => {});
}

export async function runUi(options = {}) {
  const instance = await startUiServer(options);
  const built = existsSync(join(options.distDir || DEFAULT_DIST_DIR, "index.html"));

  if (options.json) {
    console.log(JSON.stringify({
      schema: UI_SCHEMA,
      url: instance.url,
      host: instance.host,
      port: instance.port,
      readOnly: true,
      built,
    }));
  } else {
    console.log([
      `agent-manager ui v${AGENT_MANAGER_VERSION} — read-only dashboard`,
      `  ${instance.url}`,
      built ? "  serving ui/dist" : "  ui/dist not built — serving the API and build instructions",
      "  localhost only · no daemon · never writes run state",
      "  ctrl-c to stop",
    ].join("\n"));
  }

  if (options.open !== false) openBrowser(instance.url);

  await new Promise((done) => {
    const stop = () => {
      instance.close().then(done, done);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    instance.server.once("close", done);
  });

  return instance;
}
