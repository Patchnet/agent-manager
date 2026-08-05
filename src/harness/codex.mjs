import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";
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
  if (typeof env.CODEX_BIN === "string" && env.CODEX_BIN.trim()) {
    return env.CODEX_BIN.trim();
  }
  if (platform === "win32") {
    const candidates = [
      join(env.LOCALAPPDATA || "", "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
      join(env.USERPROFILE || "", ".codex", "packages", "standalone", "current", "bin", "codex.exe"),
      join(env.APPDATA || "", "npm", "codex.cmd"),
      join(env.APPDATA || "", "npm", "codex.exe"),
    ];
    for (const candidate of candidates) {
      if (candidate && exists(candidate)) return candidate;
    }
  }
  return platform === "win32" ? "codex.cmd" : "codex";
}

function sandboxForPermissionMode(permissionMode) {
  const mode = String(permissionMode || "").toLowerCase();
  if (mode === "readonly" || mode === "read-only" || mode === "read_only") {
    return "read-only";
  }
  return "workspace-write";
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

  // Prompt on stdin via `-` — multiline argv is unreliable on Windows.
  const args = ["exec"];
  if (resumeSessionId) {
    args.push("resume", resumeSessionId);
  }
  args.push("--json", "-C", cwd);
  const resolvedModel =
    (typeof model === "string" && model.trim()) ||
    (typeof process.env.CODEX_MODEL === "string" && process.env.CODEX_MODEL.trim()) ||
    "";
  if (resolvedModel) {
    args.push("-m", resolvedModel);
  }
  if (dangerouslySkipPermissions) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("-s", sandboxForPermissionMode(permissionMode));
  }
  args.push("-");

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
