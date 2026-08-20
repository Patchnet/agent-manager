import { buildVerificationEnv } from "./environment.mjs";
import { spawnCommandSync } from "./command.mjs";

export function runVerification(
  worktree,
  verification = null,
  {
    envAllowlist = [],
    sourceEnv = process.env,
    previousVerification = null,
    setupRevision = null,
  } = {},
) {
  if (!verification?.commands?.length) {
    return {
      state: "not-configured",
      commands: [],
      passed: true,
    };
  }

  if (verification.setup?.commands?.length) {
    const setup = canReuseSetup(
      previousVerification?.setup,
      verification.setup,
      setupRevision,
    )
      ? previousVerification.setup
      : runCommandPlan(worktree, verification.setup, {
          envAllowlist,
          sourceEnv,
          failureLabel: "verification setup",
          revision: setupRevision,
        });
    if (!setup.passed) {
      return {
        state: "failed",
        setup,
        commands: [],
        passed: false,
        error: setup.error,
      };
    }

    const result = runCommandPlan(worktree, verification, {
      envAllowlist,
      sourceEnv,
      failureLabel: "verification",
    });
    return {
      state: result.state,
      setup,
      commands: result.commands,
      passed: result.passed,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  return runCommandPlan(worktree, verification, {
    envAllowlist,
    sourceEnv,
    failureLabel: "verification",
    includePhaseTiming: false,
  });
}

function runCommandPlan(
  worktree,
  plan,
  {
    envAllowlist,
    sourceEnv,
    failureLabel,
    revision = null,
    includePhaseTiming = true,
  },
) {
  const phaseStartedAt = new Date().toISOString();
  const phaseStarted = Date.now();
  const results = [];
  for (const item of plan.commands) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const env = buildVerificationEnv(envAllowlist, sourceEnv);
    const { result, resolved } = spawnCommandSync(item.command, item.args, {
      cwd: worktree,
      encoding: "utf8",
      windowsHide: true,
      timeout: plan.timeout_sec * 1000,
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
        error: `${failureLabel} failed: ${item.command} ${item.args.join(" ")}`.trim(),
        ...(includePhaseTiming ? {
          startedAt: phaseStartedAt,
          elapsedMs: Date.now() - phaseStarted,
          timeoutSec: plan.timeout_sec,
        } : {}),
        ...(revision ? { revision } : {}),
      };
    }
  }

  return {
    state: "passed",
    commands: results,
    passed: true,
    ...(includePhaseTiming ? {
      startedAt: phaseStartedAt,
      elapsedMs: Date.now() - phaseStarted,
      timeoutSec: plan.timeout_sec,
    } : {}),
    ...(revision ? { revision } : {}),
  };
}

function canReuseSetup(previous, plan, revision) {
  if (!revision || previous?.state !== "passed" || previous.passed !== true) return false;
  if (
    previous.revision !== revision ||
    previous.timeoutSec !== plan.timeout_sec ||
    previous.commands?.length !== plan.commands.length
  ) {
    return false;
  }
  return plan.commands.every((item, index) => {
    const expected = [item.command, ...item.args];
    const actual = previous.commands[index]?.command;
    return Array.isArray(actual) &&
      actual.length === expected.length &&
      actual.every((value, argIndex) => value === expected[argIndex]);
  });
}
