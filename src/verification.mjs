import { buildVerificationEnv } from "./environment.mjs";
import { spawnCommandSync } from "./command.mjs";

export function runVerification(
  worktree,
  verification = null,
  { envAllowlist = [], sourceEnv = process.env } = {},
) {
  if (!verification?.commands?.length) {
    return {
      state: "not-configured",
      commands: [],
      passed: true,
    };
  }

  const results = [];
  for (const item of verification.commands) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const env = buildVerificationEnv(envAllowlist, sourceEnv);
    const { result, resolved } = spawnCommandSync(item.command, item.args, {
      cwd: worktree,
      encoding: "utf8",
      windowsHide: true,
      timeout: verification.timeout_sec * 1000,
      env,
    });
    const record = {
      command: [item.command, ...item.args],
      invocation: [resolved.command, ...resolved.args],
      startedAt,
      elapsedMs: Date.now() - started,
      exitCode: result.status ?? 1,
      signal: result.signal || null,
      stdout: String(result.stdout || "").trim().slice(-8_000),
      stderr: String(result.stderr || result.error?.message || "").trim().slice(-8_000),
      passed: result.status === 0,
    };
    results.push(record);
    if (!record.passed) {
      return {
        state: "failed",
        commands: results,
        passed: false,
        error: `verification failed: ${item.command} ${item.args.join(" ")}`.trim(),
      };
    }
  }

  return {
    state: "passed",
    commands: results,
    passed: true,
  };
}
