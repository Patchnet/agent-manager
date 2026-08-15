import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { join, posix as posixPath, win32 as win32Path } from "node:path";
import { buildHarnessEnv } from "../environment.mjs";
import { resolveSpawnCommand } from "../command.mjs";
import { terminateProcessTree } from "../process.mjs";
import { ensurePrivateDir, writePrivateFile } from "../fs-safe.mjs";
import { detectNeedsInput } from "./claude.mjs";

export function resolveCodexBin({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  return resolveCodexInstallation({ env, platform, exists }).command;
}

export function resolveCodexInstallation({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  if (typeof env.CODEX_BIN === "string" && env.CODEX_BIN.trim()) {
    return {
      command: env.CODEX_BIN.trim(),
      source: "override",
      sandboxHelper: null,
      sandboxReady: null,
    };
  }
  if (platform === "win32") {
    const pathJoin = win32Path.join;
    const localRoot = pathJoin(env.LOCALAPPDATA || "", "Programs", "OpenAI", "Codex");
    const standaloneRoot = pathJoin(
      env.USERPROFILE || "",
      ".codex",
      "packages",
      "standalone",
      "current",
    );
    const packaged = [
      {
        source: "local-app",
        command: pathJoin(localRoot, "bin", "codex.exe"),
        helpers: [
          pathJoin(localRoot, "codex-resources", "codex-windows-sandbox-setup.exe"),
          pathJoin(localRoot, "resources", "codex-windows-sandbox-setup.exe"),
          pathJoin(localRoot, "bin", "codex-windows-sandbox-setup.exe"),
        ],
      },
      {
        source: "standalone",
        command: pathJoin(standaloneRoot, "bin", "codex.exe"),
        helpers: [
          pathJoin(standaloneRoot, "codex-resources", "codex-windows-sandbox-setup.exe"),
          pathJoin(standaloneRoot, "resources", "codex-windows-sandbox-setup.exe"),
          pathJoin(standaloneRoot, "bin", "codex-windows-sandbox-setup.exe"),
        ],
      },
    ];

    const available = packaged
      .filter((candidate) => candidate.command && exists(candidate.command))
      .map((candidate) => ({
        ...candidate,
        sandboxHelper: candidate.helpers.find((helper) => exists(helper)) || null,
      }));
    const complete = available.find((candidate) => candidate.sandboxHelper);
    if (complete) {
      return {
        command: complete.command,
        source: complete.source,
        sandboxHelper: complete.sandboxHelper,
        sandboxReady: true,
      };
    }

    const npmCandidates = [
      pathJoin(env.APPDATA || "", "npm", "codex.cmd"),
      pathJoin(env.APPDATA || "", "npm", "codex.exe"),
    ];
    for (const command of npmCandidates) {
      if (command && exists(command)) {
        return { command, source: "npm", sandboxHelper: null, sandboxReady: null };
      }
    }

    if (available[0]) {
      return {
        command: available[0].command,
        source: available[0].source,
        sandboxHelper: null,
        sandboxReady: false,
      };
    }
    return {
      command: "codex.cmd",
      source: "path",
      sandboxHelper: null,
      sandboxReady: null,
    };
  }
  return { command: "codex", source: "path", sandboxHelper: null, sandboxReady: null };
}

export const CODEX_MODELS_CACHE_FILE = "models_cache.json";

/**
 * Fields codex requires when it deserializes the models cache. A cache missing
 * one of these makes every run log `failed to load models cache: missing field
 * <name>` plus `failed to renew cache TTL` — degraded, not fatal, which is why
 * the doctor check warns rather than fails.
 */
export const CODEX_MODELS_CACHE_REQUIRED_FIELDS = ["base_instructions"];

export function codexHomeDir({ env = process.env, platform = process.platform } = {}) {
  if (typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim()) {
    return env.CODEX_HOME.trim();
  }
  const home = platform === "win32" ? env.USERPROFILE : env.HOME;
  if (typeof home !== "string" || !home.trim()) return null;
  const pathJoin = platform === "win32" ? win32Path.join : posixPath.join;
  return pathJoin(home.trim(), ".codex");
}

export function codexModelsCachePath({ env = process.env, platform = process.platform } = {}) {
  const home = codexHomeDir({ env, platform });
  if (!home) return null;
  const pathJoin = platform === "win32" ? win32Path.join : posixPath.join;
  return pathJoin(home, CODEX_MODELS_CACHE_FILE);
}

function hasFieldDeep(value, field, depth = 0) {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (!Array.isArray(value) && Object.hasOwn(value, field)) return true;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => hasFieldDeep(child, field, depth + 1));
}

function renameAsideCommand(path, platform) {
  return platform === "win32"
    ? `Rename-Item "${path}" "${CODEX_MODELS_CACHE_FILE}.bak"`
    : `mv "${path}" "${path}.bak"`;
}

/**
 * Inspect ~/.codex/models_cache.json. Fails soft: an absent cache is healthy
 * (codex regenerates it on demand); only a file that exists and cannot be used
 * is reported, with a rename-aside recommendation.
 */
export function inspectCodexModelsCache({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  const name = "codex models cache";
  const path = codexModelsCachePath({ env, platform });
  if (!path) {
    return { name, path: null, state: "skipped", ok: true, detail: "codex home not resolvable", recommendation: null };
  }
  if (!exists(path)) {
    return { name, path, state: "absent", ok: true, detail: `${path}: not created yet`, recommendation: null };
  }

  let raw;
  try {
    raw = String(readFile(path, "utf8"));
  } catch (error) {
    return {
      name,
      path,
      state: "unreadable",
      ok: false,
      detail: `${path}: ${error.message}`,
      recommendation: `codex cannot read its models cache; ${renameAsideCommand(path, platform)} so codex regenerates it`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      name,
      path,
      state: "invalid-json",
      ok: false,
      detail: `${path}: invalid JSON (${error.message})`,
      recommendation: `${renameAsideCommand(path, platform)} so codex regenerates it`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      name,
      path,
      state: "invalid-json",
      ok: false,
      detail: `${path}: expected a JSON object`,
      recommendation: `${renameAsideCommand(path, platform)} so codex regenerates it`,
    };
  }

  const missing = CODEX_MODELS_CACHE_REQUIRED_FIELDS.filter((field) => !hasFieldDeep(parsed, field));
  if (missing.length) {
    return {
      name,
      path,
      state: "missing-fields",
      ok: false,
      missingFields: missing,
      detail: `${path}: missing field ${missing.join(", ")}`,
      recommendation: `codex will log "failed to load models cache" every run; ${renameAsideCommand(path, platform)} so codex regenerates it`,
    };
  }

  return { name, path, state: "healthy", ok: true, detail: path, recommendation: null };
}

export function codexWindowsSandboxArgs({
  platform = process.platform,
  dangerouslySkipPermissions = false,
} = {}) {
  if (platform !== "win32" || dangerouslySkipPermissions) return [];
  return ["-c", "windows.sandbox_private_desktop=true"];
}

export function sandboxForPermissionMode(permissionMode) {
  const mode = String(permissionMode || "").toLowerCase();
  if (mode === "readonly" || mode === "read-only" || mode === "read_only") {
    return "read-only";
  }
  return "workspace-write";
}

/**
 * Option contract recorded from the installed Codex CLI on 2026-08-15
 * (`codex exec --help`, `codex exec resume --help`).
 *
 * `exec resume` is a clap subcommand with its own option set. It does NOT
 * accept `-C/--cd` or `-s/--sandbox`: those are exec-only, and when they land
 * after `resume` clap aborts the parse with exit 2 ("tip: to pass '-C' as a
 * value, use '-- -C'") before any work starts. Every flag agent-manager emits
 * must appear in the option set of the command it is attached to; the argv
 * contract test enforces that, so a CLI change fails a test instead of a run.
 *
 * These sets list the options agent-manager may emit — verified accepted, not
 * the CLI's full surface.
 */
export const CODEX_OPTION_CONTRACT = {
  exec: new Set([
    "--json",
    "-C", "--cd",
    "-m", "--model",
    "-s", "--sandbox",
    "-c", "--config",
    "-i", "--image",
    "--dangerously-bypass-approvals-and-sandbox",
  ]),
  "exec resume": new Set([
    "--json",
    "-m", "--model",
    "-c", "--config",
    "-i", "--image",
    "--last",
    "--dangerously-bypass-approvals-and-sandbox",
  ]),
};

/**
 * Build the argv for a fresh `codex exec` run or a `codex exec resume` run.
 * Prompt rides on stdin via the trailing `-` in both cases — multiline argv is
 * unreliable on Windows.
 */
export function buildCodexArgs({
  cwd,
  resumeSessionId = null,
  model = null,
  permissionMode = "acceptEdits",
  dangerouslySkipPermissions = false,
  platform = process.platform,
  env = process.env,
} = {}) {
  const resolvedModel =
    (typeof model === "string" && model.trim()) ||
    (typeof env.CODEX_MODEL === "string" && env.CODEX_MODEL.trim()) ||
    "";
  const args = ["exec"];

  if (resumeSessionId) {
    // `resume` is a subcommand, and `-C/--cd` + `-s/--sandbox` belong to the
    // parent `exec` command: after `resume` they abort the parse with exit 2.
    // So cwd and sandbox policy bind ahead of the subcommand, and only options
    // `exec resume` declares itself follow it.
    args.push(...codexWindowsSandboxArgs({ platform, dangerouslySkipPermissions }));
    args.push("-C", cwd);
    if (dangerouslySkipPermissions) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("-s", sandboxForPermissionMode(permissionMode));
    }
    args.push("resume", resumeSessionId, "--json");
    if (resolvedModel) args.push("-m", resolvedModel);
    args.push("-");
    return args;
  }

  args.push(...codexWindowsSandboxArgs({ platform, dangerouslySkipPermissions }));
  args.push("--json", "-C", cwd);
  if (resolvedModel) args.push("-m", resolvedModel);
  if (dangerouslySkipPermissions) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("-s", sandboxForPermissionMode(permissionMode));
  }
  args.push("-");
  return args;
}

/**
 * Spawn Codex non-interactive exec in cwd. Inherits project AGENTS.md / skills / MCP.
 * Never passes --dangerously-bypass-approvals-and-sandbox unless policy allows.
 */
export function spawnCodex(options) {
  return spawnCodexProcess({ ...options, resumeSessionId: null });
}

export function resumeCodex(options) {
  if (!options?.sessionId) throw new Error("Codex resume requires a session id");
  return spawnCodexProcess({
    ...options,
    resumeSessionId: options.sessionId,
  });
}

function spawnCodexProcess({
  resumeSessionId = null,
  cwd,
  prompt,
  laneDir,
  permissionMode = "acceptEdits",
  dangerouslySkipPermissions = false,
  model = null,
  onActivity,
  onEvent,
  logName = "stdout.log",
  envAllowlist = [],
  env = null,
}) {
  ensurePrivateDir(laneDir);
  const promptPath = join(
    laneDir,
    resumeSessionId ? logName.replace(/\.log$/, ".prompt.md") : "prompt.md",
  );
  writePrivateFile(promptPath, prompt, "utf8");

  const logPath = join(laneDir, logName);
  const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });

  const args = buildCodexArgs({
    cwd,
    resumeSessionId,
    model,
    permissionMode,
    dangerouslySkipPermissions,
  });

  const childEnv = env || buildHarnessEnv(envAllowlist);
  const cmd = resolveCodexBin({ env: childEnv });
  const resolved = resolveSpawnCommand(cmd, args, { env: childEnv });
  const child = spawn(resolved.command, resolved.args, {
    cwd,
    env: childEnv,
    detached: process.platform !== "win32",
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let lastActivity = resumeSessionId ? "codex resume spawned" : "codex spawned";
  let lastByteAt = Date.now();
  let buf = "";
  let sessionId = resumeSessionId;

  const handleChunk = (chunk) => {
    lastByteAt = Date.now();
    const text = chunk.toString("utf8");
    log.write(text);
    buf += text;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        sessionId = parseSessionId(ev) || sessionId;
        onEvent?.(ev);
        const summary = summarizeEvent(ev);
        if (summary) {
          lastActivity = summary;
          onActivity?.(summary, ev);
        }
      } catch {
        lastActivity = line.slice(0, 200);
        onActivity?.(lastActivity, null);
      }
    }
  };

  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", handleChunk);

  try {
    child.stdin.write(prompt);
    child.stdin.end();
  } catch (err) {
    lastActivity = `stdin write failed: ${err.message}`;
  }

  const done = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      log.end();
      resolve({
        exitCode: code,
        signal,
        lastActivity,
        logPath,
        sessionId,
      });
    });
    child.on("error", (err) => {
      log.write(String(err) + "\n");
      log.end();
      resolve({
        exitCode: 1,
        signal: null,
        lastActivity: `spawn error: ${err.message}`,
        logPath,
        sessionId,
        error: err,
      });
    });
  });

  return {
    pid: child.pid,
    child,
    done,
    getLastActivity: () => lastActivity,
    getLastByteAt: () => lastByteAt,
    getSessionId: () => sessionId,
    kill: () => terminateProcessTree(child),
  };
}

export function parseSessionId(event) {
  if (!event || typeof event !== "object") return null;
  const value =
    event.thread_id ||
    event.threadId ||
    event.session_id ||
    event.sessionId ||
    event.message?.thread_id ||
    event.message?.session_id ||
    null;
  return typeof value === "string" && value.trim() ? value : null;
}

export function parseModel(event) {
  if (!event || typeof event !== "object") return null;
  const value = event.model || event.model_id || event.modelId || event.message?.model || null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function summarizeEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (ev.type === "thread.started") {
    return "thread.started";
  }
  if (ev.type === "turn.started" || ev.type === "turn.completed") {
    return ev.type;
  }
  if (ev.type === "turn.failed") {
    return `turn.failed: ${String(ev.error?.message || ev.message || "failed").slice(0, 160)}`;
  }
  if (ev.type === "error") {
    return `error: ${String(ev.message || ev.error || "error").slice(0, 160)}`;
  }
  if (typeof ev.type === "string" && ev.type.startsWith("item.") && ev.item) {
    const item = ev.item;
    if (item.type === "agent_message" && item.text) {
      return String(item.text).slice(0, 180);
    }
    if (item.type === "command_execution" && item.command) {
      return `cmd: ${String(item.command).slice(0, 160)}`;
    }
    if (item.type === "file_change") {
      return `file_change: ${item.type}`;
    }
    if (item.type) return `${ev.type}:${item.type}`.slice(0, 180);
  }
  if (typeof ev.type === "string") return ev.type;
  return null;
}

export const codexAdapter = {
  name: "codex",
  supported: true,
  start: spawnCodex,
  resume: resumeCodex,
  cancel: (handle) => handle?.kill?.(),
  parseSessionId,
  parseModel,
  parseNeedsInput: detectNeedsInput,
};
