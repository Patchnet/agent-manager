import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSpawnCommand } from "./command.mjs";
import { buildMasterReturnEnv } from "./environment.mjs";
import { ensurePrivateDir, writePrivateFile } from "./fs-safe.mjs";
import { resumeClaude } from "./harness/claude.mjs";
import { resumeCodex } from "./harness/codex.mjs";
import { runDir } from "./paths.mjs";

const CHANNEL_SCHEMA = "agent-manager.master-return.v1";
const HANDOFF_SCHEMA = "agent-manager.master-handoff.v1";
const CHANNEL_FILE = "master-return.json";
const HANDOFF_FILE = "master-handoff.json";
const DIRECT_HOSTS = new Set(["codex", "claude", "cursor"]);

function cleanValue(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const cleaned = value.trim();
  if (cleaned.length > 256 || /[\u0000-\u001f\u007f]/.test(cleaned)) {
    throw new Error(`${label} contains unsupported characters or is too long`);
  }
  return cleaned;
}

export function resolveMasterReturn({
  host = null,
  sessionId = null,
  disabled = false,
  env = process.env,
} = {}) {
  if (disabled) return null;

  const explicitHost = host || env.AGENT_MANAGER_RETURN_HOST || null;
  const explicitSession = sessionId || env.AGENT_MANAGER_RETURN_SESSION || null;
  if (explicitHost || explicitSession) {
    if (!explicitHost) throw new Error("master return session id requires a host");
    const normalizedHost = cleanValue(explicitHost, "master return host").toLowerCase();
    if (!DIRECT_HOSTS.has(normalizedHost)) {
      throw new Error(`unsupported master return host: ${normalizedHost}`);
    }
    if (!explicitSession && normalizedHost !== "cursor") {
      throw new Error(`${normalizedHost} master return requires a session id`);
    }
    return {
      schema: CHANNEL_SCHEMA,
      host: normalizedHost,
      mode: explicitSession ? "direct" : "signal",
      ...(explicitSession
        ? { sessionId: cleanValue(explicitSession, "master return session id") }
        : {}),
      source: host || sessionId ? "cli" : "environment",
      configuredAt: new Date().toISOString(),
      state: "configured",
      attempts: 0,
    };
  }

  // Test subprocesses commonly inherit the developer's live Codex thread.
  // Never auto-resume that thread while exercising the fake harness.
  if (env.AGENT_MANAGER_TEST_MODE === "1") return null;

  if (env.CODEX_THREAD_ID) {
    return {
      schema: CHANNEL_SCHEMA,
      host: "codex",
      mode: "direct",
      sessionId: cleanValue(env.CODEX_THREAD_ID, "CODEX_THREAD_ID"),
      source: "CODEX_THREAD_ID",
      configuredAt: new Date().toISOString(),
      state: "configured",
      attempts: 0,
    };
  }

  if (env.CLAUDE_CODE_SESSION_ID) {
    return {
      schema: CHANNEL_SCHEMA,
      host: "claude",
      mode: "direct",
      sessionId: cleanValue(env.CLAUDE_CODE_SESSION_ID, "CLAUDE_CODE_SESSION_ID"),
      source: "CLAUDE_CODE_SESSION_ID",
      configuredAt: new Date().toISOString(),
      state: "configured",
      attempts: 0,
    };
  }

  if (env.CURSOR_AGENT) {
    return {
      schema: CHANNEL_SCHEMA,
      host: "cursor",
      mode: "signal",
      source: "CURSOR_AGENT",
      configuredAt: new Date().toISOString(),
      state: "configured",
      attempts: 0,
    };
  }

  return null;
}

export function masterReturnPath(runId) {
  return join(runDir(runId), CHANNEL_FILE);
}

export function masterHandoffPath(runId) {
  return join(runDir(runId), HANDOFF_FILE);
}

export function writeMasterReturn(runId, channel) {
  ensurePrivateDir(runDir(runId));
  writePrivateFile(masterReturnPath(runId), JSON.stringify(channel, null, 2) + "\n", "utf8");
  return channel;
}

export function readMasterReturn(runId) {
  const path = masterReturnPath(runId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function masterReturnSummary(channel) {
  if (!channel) return null;
  return {
    host: channel.host,
    mode: channel.mode || "direct",
    configured: true,
    state: channel.state || "configured",
    attempts: Number(channel.attempts || 0),
    lastAttemptAt: channel.lastAttemptAt || null,
    lastDeliveredAt: channel.lastDeliveredAt || null,
    lastSignaledAt: channel.lastSignaledAt || null,
    lastError: channel.lastError || null,
  };
}

export function shouldReturnToMaster(payload) {
  if (!payload) return false;
  if (["needs_input", "terminal"].includes(payload.reason)) return true;
  if (payload.reason === "state_change" && payload.cadence?.stage === "shipping_active") return true;
  return [
    "workers_complete",
    "correction_required",
    "ship_gate_ready",
    "conditional_authority_ready",
    "conditional_authority_blocked",
    "release_gate_ready",
  ].includes(payload.cadence?.stage);
}

export function buildMasterHandoff(runId, payload, status = null) {
  const dir = runDir(runId);
  const cadence = payload?.cadence || {};
  return {
    schema: HANDOFF_SCHEMA,
    createdAt: new Date().toISOString(),
    runId,
    title: status?.identity?.displayTitle || null,
    reason: payload?.reason || "state_change",
    state: payload?.state || null,
    cadence: {
      stage: cadence.stage || null,
      transition: cadence.transition || null,
      nextAction: cadence.nextAction || null,
      operatorInputRequired: cadence.operatorInputRequired || [],
      template: cadence.template || null,
    },
    statusPath: join(dir, "status.json"),
    reportPath: join(dir, "report.md"),
  };
}

export function masterReturnPrompt(handoff) {
  const inputs = handoff.cadence.operatorInputRequired?.length
    ? handoff.cadence.operatorInputRequired.join(" | ")
    : "none";
  return [
    `Agent Manager returned run ${handoff.runId} to the Master Dev thread.`,
    ...(handoff.title ? [`Run title: ${handoff.title}`] : []),
    `Reason: ${handoff.reason}`,
    `State: ${handoff.state || "unknown"}`,
    `Transition: ${handoff.cadence.transition || "unknown"}`,
    `Next action: ${handoff.cadence.nextAction || "Read status and determine the next action."}`,
    `Operator input required: ${inputs}`,
    "",
    `Read the authoritative status at: ${handoff.statusPath}`,
    `Read the run report when present at: ${handoff.reportPath}`,
    "Follow the installed agent-manager skill and its mandatory reporting templates.",
    "For AUTO_CONTINUE, take the stated next action before ending the turn.",
    "Do not stop after reporting worker completion. Preserve Delivery Review and Ship Gate approvals.",
  ].join("\n");
}

async function executeCodexReturn({ channel, handoff, status, runId }) {
  const returnDir = ensurePrivateDir(join(runDir(runId), "master-return"));
  const handle = resumeCodex({
    sessionId: channel.sessionId,
    cwd: status?.repoRoot || process.cwd(),
    prompt: masterReturnPrompt(handoff),
    laneDir: returnDir,
    permissionMode: "workspace-write",
    dangerouslySkipPermissions: false,
    envAllowlist: [],
    env: buildMasterReturnEnv(),
    logName: `attempt-${Number(channel.attempts || 1)}.log`,
  });
  return await handle.done;
}

async function executeClaudeReturn({ channel, handoff, status, runId }) {
  const returnDir = ensurePrivateDir(join(runDir(runId), "master-return"));
  const handle = resumeClaude({
    sessionId: channel.sessionId,
    cwd: status?.repoRoot || process.cwd(),
    prompt: masterReturnPrompt(handoff),
    laneDir: returnDir,
    permissionMode: "acceptEdits",
    dangerouslySkipPermissions: false,
    envAllowlist: [],
    env: buildMasterReturnEnv(),
    logName: `attempt-${Number(channel.attempts || 1)}.log`,
  });
  return await handle.done;
}

export function resolveCursorAgentBin(env = process.env) {
  if (env.CURSOR_AGENT_BIN && existsSync(env.CURSOR_AGENT_BIN)) {
    return env.CURSOR_AGENT_BIN;
  }
  return process.platform === "win32" ? "cursor-agent.cmd" : "cursor-agent";
}

async function executeCursorReturn({ channel, handoff, status, runId }) {
  const returnDir = ensurePrivateDir(join(runDir(runId), "master-return"));
  const prompt = masterReturnPrompt(handoff);
  const attempt = Number(channel.attempts || 1);
  writePrivateFile(join(returnDir, `attempt-${attempt}.prompt.md`), prompt, "utf8");
  const logPath = join(returnDir, `attempt-${attempt}.log`);
  const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  const args = [
    "-p",
    "--output-format", "stream-json",
    `--resume=${channel.sessionId}`,
    prompt,
  ];
  const command = resolveSpawnCommand(resolveCursorAgentBin(), args);
  const child = spawn(command.command, command.args, {
    cwd: status?.repoRoot || process.cwd(),
    env: buildMasterReturnEnv(),
    detached: process.platform !== "win32",
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let lastActivity = "cursor return spawned";
  const handleChunk = (chunk) => {
    const text = chunk.toString("utf8");
    log.write(text);
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        lastActivity = String(
          event.result || event.message?.content?.[0]?.text || event.type || lastActivity,
        ).slice(0, 200);
      } catch {
        lastActivity = line.slice(0, 200);
      }
    }
  };
  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", handleChunk);

  return await new Promise((resolve) => {
    child.on("close", (code, signal) => {
      log.end();
      resolve({ exitCode: code, signal, lastActivity, logPath, sessionId: channel.sessionId });
    });
    child.on("error", (error) => {
      log.write(String(error) + "\n");
      log.end();
      resolve({
        exitCode: 1,
        signal: null,
        lastActivity: `spawn error: ${error.message}`,
        logPath,
        sessionId: channel.sessionId,
        error,
      });
    });
  });
}

export async function dispatchMasterReturn(runId, payload, status, {
  executeCodex = executeCodexReturn,
  executeClaude = executeClaudeReturn,
  executeCursor = executeCursorReturn,
} = {}) {
  const channel = readMasterReturn(runId);
  if (!channel) return { delivered: false, skipped: true, reason: "not_configured" };
  if (!shouldReturnToMaster(payload)) {
    return { delivered: false, skipped: true, reason: "not_actionable" };
  }

  const handoff = buildMasterHandoff(runId, payload, status);
  writePrivateFile(masterHandoffPath(runId), JSON.stringify(handoff, null, 2) + "\n", "utf8");
  const attemptAt = new Date().toISOString();
  const nextChannel = {
    ...channel,
    state: "delivering",
    attempts: Number(channel.attempts || 0) + 1,
    lastAttemptAt: attemptAt,
    lastError: null,
  };
  writeMasterReturn(runId, nextChannel);

  try {
    if (nextChannel.mode === "signal") {
      const signaled = {
        ...nextChannel,
        state: "signal_ready",
        lastSignaledAt: new Date().toISOString(),
      };
      writeMasterReturn(runId, signaled);
      return {
        delivered: false,
        signaled: true,
        handoff,
        channel: masterReturnSummary(signaled),
      };
    }

    const executors = {
      codex: executeCodex,
      claude: executeClaude,
      cursor: executeCursor,
    };
    const execute = executors[nextChannel.host];
    if (!execute) throw new Error(`unsupported master return host: ${nextChannel.host}`);
    if (!nextChannel.sessionId) {
      throw new Error(`${nextChannel.host} direct return requires a session id`);
    }
    const result = await execute({
      channel: nextChannel,
      handoff,
      status,
      runId,
    });
    if (result?.exitCode !== 0) {
      throw new Error(
        result?.lastActivity || `${nextChannel.host} return exited ${result?.exitCode}`,
      );
    }
    const delivered = {
      ...nextChannel,
      state: "delivered",
      lastDeliveredAt: new Date().toISOString(),
      lastError: null,
    };
    writeMasterReturn(runId, delivered);
    return { delivered: true, handoff, channel: masterReturnSummary(delivered) };
  } catch (error) {
    const failed = {
      ...nextChannel,
      state: "failed",
      lastError: String(error?.message || error).slice(0, 500),
    };
    writeMasterReturn(runId, failed);
    return {
      delivered: false,
      handoff,
      channel: masterReturnSummary(failed),
      error: failed.lastError,
    };
  }
}
