import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { join, win32 as win32Path, posix as posixPath } from "node:path";
import { buildHarnessEnv } from "../environment.mjs";
import { resolveSpawnCommand } from "../command.mjs";
import { terminateProcessTree } from "../process.mjs";
import { ensurePrivateDir, writePrivateFile } from "../fs-safe.mjs";
import { detectNeedsInput } from "./claude.mjs";

/**
 * Cursor Agent CLI adapter.
 *
 * Headless shape (verified against `agent --help`, CLI 2026.08.04):
 *   agent -p --output-format stream-json [--model <slug>] [--resume=<chatId>] "<prompt>"
 *
 * The native Windows installer places both `agent` and `cursor-agent` launchers
 * in %LOCALAPPDATA%\cursor-agent. WSL is no longer required.
 */

export function resolveCursorBin({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  if (typeof env.CURSOR_AGENT_BIN === "string" && env.CURSOR_AGENT_BIN.trim()) {
    return env.CURSOR_AGENT_BIN.trim();
  }
  if (platform === "win32") {
    const pathJoin = win32Path.join;
    const installRoot = pathJoin(env.LOCALAPPDATA || "", "cursor-agent");
    const candidates = [
      pathJoin(installRoot, "agent.cmd"),
      pathJoin(installRoot, "cursor-agent.cmd"),
      pathJoin(installRoot, "agent.ps1"),
      pathJoin(installRoot, "cursor-agent.ps1"),
      pathJoin(env.USERPROFILE || "", ".local", "bin", "cursor-agent.cmd"),
      pathJoin(env.APPDATA || "", "npm", "cursor-agent.cmd"),
    ];
    for (const candidate of candidates) {
      if (candidate && exists(candidate)) return candidate;
    }
    return "cursor-agent.cmd";
  }
  const pathJoin = posixPath.join;
  const candidates = [
    pathJoin(env.HOME || "", ".local", "bin", "cursor-agent"),
    pathJoin(env.HOME || "", ".local", "bin", "agent"),
  ];
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate;
  }
  return "cursor-agent";
}

const PLAN_MODES = new Set(["readonly", "read-only", "read_only", "plan"]);
const DEFAULT_MODES = new Set(["acceptedits", "workspace-write", "workspace_write", "default", ""]);

/**
 * Map manager policy onto Cursor's native flags. `--force` / `--yolo` is only
 * reachable through an explicit dangerous-skip policy; everything else keeps
 * Cursor's own approval and sandbox behavior.
 */
export function cursorPermissionArgs({
  permissionMode = "acceptEdits",
  dangerouslySkipPermissions = false,
} = {}) {
  if (dangerouslySkipPermissions) return ["--force"];
  const mode = String(permissionMode || "").toLowerCase();
  if (PLAN_MODES.has(mode)) return ["--mode", "plan"];
  if (mode === "ask") return ["--mode", "ask"];
  if (mode === "auto") return ["--auto-review"];
  if (DEFAULT_MODES.has(mode)) return [];
  throw new Error(
    `cursor lanes do not support permission_mode "${permissionMode}"; ` +
    "use plan, ask, auto, or acceptEdits",
  );
}

/**
 * Cursor takes the prompt as an argv value and does not read it from stdin.
 * On Windows the launcher is a `.cmd`/`.ps1` shim, and both cmd.exe and
 * PowerShell corrupt a multiline argument (cmd truncates at the first newline;
 * PowerShell strips quotes). Windows lanes therefore receive a single-line
 * pointer to the prompt file that every lane already writes.
 */
export function cursorPromptDelivery({ prompt, promptPath, platform = process.platform }) {
  if (platform !== "win32") return { mode: "inline", arg: prompt };
  return {
    mode: "file",
    arg:
      `Your complete task briefing is the file ${promptPath}. ` +
      "Read that file first and follow it exactly; it is the only instruction set for this lane.",
  };
}

export function buildCursorArgs({
  laneDir,
  promptArg,
  model = null,
  permissionMode = "acceptEdits",
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  env = process.env,
}) {
  const args = ["-p", "--output-format", "stream-json"];
  const resolvedModel =
    (typeof model === "string" && model.trim()) ||
    (typeof env.CURSOR_MODEL === "string" && env.CURSOR_MODEL.trim()) ||
    "";
  if (resolvedModel) {
    args.push("--model", resolvedModel);
  }
  args.push(...cursorPermissionArgs({ permissionMode, dangerouslySkipPermissions }));
  // The worktree is the operator's own repo checkout that Agent Manager created;
  // --trust only skips the workspace-trust prompt a detached lane cannot answer.
  args.push("--trust");
  // The lane directory holds prompt.md and needs-input.json and lives outside
  // the workspace root, so it has to be an explicit additional root.
  if (laneDir) args.push("--add-dir", laneDir);
  if (resumeSessionId) {
    // `--resume [chatId]` takes an optional value: only the `=` form binds it.
    args.push(`--resume=${resumeSessionId}`);
  }
  args.push(promptArg);
  return args;
}

export function spawnCursor(options) {
  return spawnCursorProcess({ ...options, resumeSessionId: null });
}

export function resumeCursor(options) {
  if (!options?.sessionId) throw new Error("Cursor resume requires a session id");
  return spawnCursorProcess({ ...options, resumeSessionId: options.sessionId });
}

function spawnCursorProcess({
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
  platform = process.platform,
}) {
  ensurePrivateDir(laneDir);
  const promptPath = join(
    laneDir,
    resumeSessionId ? logName.replace(/\.log$/, ".prompt.md") : "prompt.md",
  );
  writePrivateFile(promptPath, prompt, "utf8");

  const logPath = join(laneDir, logName);
  const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });

  const childEnv = env || buildHarnessEnv(envAllowlist);
  const delivery = cursorPromptDelivery({ prompt, promptPath, platform });
  const args = buildCursorArgs({
    laneDir,
    promptArg: delivery.arg,
    model,
    permissionMode,
    dangerouslySkipPermissions,
    resumeSessionId,
    env: childEnv,
  });

  const cmd = resolveCursorBin({ env: childEnv, platform });
  const resolved = resolveSpawnCommand(cmd, args, { env: childEnv, platform });
  const child = spawn(resolved.command, resolved.args, {
    cwd,
    env: childEnv,
    detached: process.platform !== "win32",
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let lastActivity = resumeSessionId ? "cursor resume spawned" : "cursor spawned";
  let lastByteAt = Date.now();
  let buf = "";
  let sessionId = resumeSessionId;
  let reportedNeedsInput = null;

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
        reportedNeedsInput ||= parseResultNeedsInput(ev);
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

  // Cursor reads the prompt from argv; close stdin so nothing waits on input.
  try {
    child.stdin.end();
  } catch (err) {
    lastActivity = `stdin close failed: ${err.message}`;
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
        promptDelivery: delivery.mode,
        needsInput: reportedNeedsInput,
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
        needsInput: reportedNeedsInput,
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
    event.session_id ||
    event.sessionId ||
    event.chat_id ||
    event.chatId ||
    event.message?.session_id ||
    null;
  return typeof value === "string" && value.trim() ? value : null;
}

export function parseModel(event) {
  if (!event || typeof event !== "object") return null;
  const value = event.model || event.model_id || event.modelId || event.message?.model || null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseResultNeedsInput(event) {
  if (event?.type !== "result" || typeof event.result !== "string") return null;
  const text = event.result.trim();
  if (!/^\s*(?:\*\*)?BLOCKED\b/i.test(text)) return null;
  return {
    type: "blocked",
    prompt: text.slice(0, 8_000),
    blocking: true,
    source: "harness-result",
  };
}

export function summarizeEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (ev.type === "system") {
    return ev.subtype === "init"
      ? `system.init: ${ev.model || "model unknown"}`.slice(0, 180)
      : `system.${ev.subtype || "event"}`.slice(0, 180);
  }
  if (ev.type === "assistant") {
    const parts = ev.message?.content;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part?.type === "text" && part.text) return String(part.text).slice(0, 180);
      }
    }
    return "assistant";
  }
  if (ev.type === "tool_call") {
    const name = ev.tool_call?.tool?.case || Object.keys(ev.tool_call || {})[0] || "tool";
    return `tool: ${name} (${ev.subtype || "started"})`.slice(0, 180);
  }
  if (ev.type === "thinking") {
    return `thinking.${ev.subtype || "delta"}`;
  }
  if (ev.type === "result") {
    return `result: ${ev.subtype || ev.result || "done"}`.slice(0, 180);
  }
  if (ev.type === "error") {
    const message = ev.message || ev.error?.message || ev.error || "error";
    return `error: ${String(message).slice(0, 160)}`;
  }
  if (typeof ev.type === "string") return ev.type;
  return null;
}

export const cursorAdapter = {
  name: "cursor",
  supported: true,
  start: spawnCursor,
  resume: resumeCursor,
  cancel: (handle) => handle?.kill?.(),
  parseSessionId,
  parseModel,
  parseNeedsInput: detectNeedsInput,
};
