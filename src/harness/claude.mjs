import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { join, win32 as win32Path } from "node:path";
import { buildHarnessEnv } from "../environment.mjs";
import { resolveSpawnCommand } from "../command.mjs";
import { terminateProcessTree } from "../process.mjs";
import { ensurePrivateDir, writePrivateFile } from "../fs-safe.mjs";

export function resolveClaudeBin({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  if (typeof env.CLAUDE_BIN === "string" && env.CLAUDE_BIN.trim()) {
    return env.CLAUDE_BIN.trim();
  }
  if (platform === "win32") {
    const pathJoin = win32Path.join;
    const fromNpm = pathJoin(
      env.APPDATA || "",
      "npm",
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    const candidates = [
      pathJoin(env.APPDATA || "", "npm", "claude.cmd"),
      pathJoin(env.APPDATA || "", "npm", "claude.exe"),
      pathJoin(env.USERPROFILE || "", ".local", "bin", "claude.exe"),
      fromNpm,
    ];
    for (const candidate of candidates) {
      if (candidate && exists(candidate)) return candidate;
    }
  }
  return platform === "win32" ? "claude.cmd" : "claude";
}

/**
 * Spawn Claude Code print-mode in cwd. Inherits project CLAUDE.md / skills / MCP.
 * Never passes --bare or --dangerously-skip-permissions unless policy allows.
 */
export function spawnClaude({
  cwd,
  prompt,
  laneDir,
  permissionMode = "acceptEdits",
  dangerouslySkipPermissions = false,
  onActivity,
  onEvent,
  logName = "stdout.log",
  envAllowlist = [],
  model = null,
}) {
  return spawnClaudeProcess({
    cwd,
    prompt,
    laneDir,
    permissionMode,
    dangerouslySkipPermissions,
    onActivity,
    onEvent,
    logName,
    envAllowlist,
    model,
  });
}

export function permissionModeForClaude(permissionMode) {
  const mode = String(permissionMode || "").toLowerCase();
  if (mode === "readonly" || mode === "read-only" || mode === "read_only") {
    return "plan";
  }
  if (mode === "workspace-write") {
    return "acceptEdits";
  }
  return permissionMode || "acceptEdits";
}

export function resumeClaude({
  sessionId,
  cwd,
  prompt,
  laneDir,
  permissionMode = "acceptEdits",
  dangerouslySkipPermissions = false,
  onActivity,
  onEvent,
  logName = "resume.log",
  envAllowlist = [],
  env = null,
  model = null,
}) {
  if (!sessionId) throw new Error("Claude resume requires a session id");
  return spawnClaudeProcess({
    resumeSessionId: sessionId,
    cwd,
    prompt,
    laneDir,
    permissionMode,
    dangerouslySkipPermissions,
    onActivity,
    onEvent,
    logName,
    envAllowlist,
    env,
    model,
  });
}

function spawnClaudeProcess({
  resumeSessionId = null,
  cwd,
  prompt,
  laneDir,
  permissionMode,
  dangerouslySkipPermissions,
  onActivity,
  onEvent,
  logName,
  envAllowlist = [],
  env = null,
  model = null,
}) {
  ensurePrivateDir(laneDir);
  const promptPath = join(
    laneDir,
    resumeSessionId ? logName.replace(/\.log$/, ".prompt.md") : "prompt.md",
  );
  writePrivateFile(promptPath, prompt, "utf8");

  const logPath = join(laneDir, logName);
  const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });

  // Deliver prompt on stdin — Windows argv/shell mangling drops multiline -p args.
  const args = [];
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }
  args.push(
    "-p",
    "--output-format", "stream-json",
    "--verbose",
  );
  if (permissionMode) {
    args.push("--permission-mode", permissionModeForClaude(permissionMode));
  }
  if (typeof model === "string" && model.trim()) {
    args.push("--model", model.trim());
  }
  if (dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  const childEnv = env || buildHarnessEnv(envAllowlist);
  const cmd = resolveClaudeBin({ env: childEnv });
  const resolved = resolveSpawnCommand(cmd, args, { env: childEnv });
  const child = spawn(resolved.command, resolved.args, {
    cwd,
    env: childEnv,
    detached: process.platform !== "win32",
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let lastActivity = "spawned";
  let lastByteAt = Date.now();
  let buf = "";
  let sawEmptyPrompt = false;
  let sessionId = resumeSessionId;

  const handleChunk = (chunk) => {
    lastByteAt = Date.now();
    const text = chunk.toString("utf8");
    log.write(text);
    if (/came through empty|message came through empty/i.test(text)) {
      sawEmptyPrompt = true;
    }
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
        if (typeof summary === "string" && /came through empty/i.test(summary)) {
          sawEmptyPrompt = true;
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
      const emptyFail = sawEmptyPrompt;
      resolve({
        exitCode: emptyFail ? 2 : code,
        signal,
        lastActivity: emptyFail
          ? "failed: Claude received empty prompt (stdin/argv delivery)"
          : lastActivity,
        logPath,
        sessionId,
        emptyPrompt: emptyFail,
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
    event.session_id ||
    event.sessionId ||
    event.message?.session_id ||
    event.message?.sessionId ||
    null;
  return typeof value === "string" && value.trim() ? value : null;
}

export function parseModel(event) {
  if (!event || typeof event !== "object") return null;
  const value = event.model || event.model_id || event.modelId || event.message?.model || null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function summarizeEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (ev.type === "assistant" && ev.message?.content) {
    const parts = ev.message.content;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (p.type === "text" && p.text) return p.text.slice(0, 180);
        if (p.type === "tool_use") return `tool: ${p.name || "?"}`.slice(0, 180);
      }
    }
  }
  if (ev.type === "result") {
    return `result: ${ev.subtype || ev.result || "done"}`.slice(0, 180);
  }
  if (ev.type === "tool_result" || ev.type === "user") {
    return String(ev.type);
  }
  if (typeof ev.type === "string") return ev.type;
  return null;
}

export function detectNeedsInput(laneDir, worktreePath) {
  const candidates = [
    join(laneDir, "needs-input.json"),
    worktreePath ? join(worktreePath, "needs-input.json") : null,
  ].filter(Boolean);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return { type: "question", prompt: "needs-input.json present but unreadable", blocking: true };
    }
  }
  return null;
}
