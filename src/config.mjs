import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { cwd } from "node:process";

export const CONFIG_KEYS = [
  "AGENT_MANAGER_DEV_ROOT",
  "AGENT_MANAGER_RUNS_ROOT",
  "AGENT_MANAGER_CLAIMS_ROOT",
  "AGENT_MANAGER_BRAIN_ROOT",
  "AGENT_MANAGER_CLAIM_BIN",
];

/**
 * When set to `1` / `true`, ambient environment and command-line path overrides
 * may beat `~/.agent-manager/config.env`. Default is locked: user-config wins
 * for every key present in that file so agents cannot redirect telemetry.
 */
export const PATH_OVERRIDE_ENV = "AGENT_MANAGER_ALLOW_PATH_OVERRIDE";

/**
 * Test runs must never resolve onto an operator's real runs, claims, or brain
 * root. Individual tests cannot be trusted to remember that, so isolation is
 * enforced here — the single place every root passes through — instead of in
 * each test file. See `test/isolation.test.mjs`.
 */
export const TEST_SANDBOX_ENV = "AGENT_MANAGER_TEST_ROOT";

export function pathOverridesAllowed(env = process.env) {
  const raw = env?.[PATH_OVERRIDE_ENV];
  if (raw === undefined || raw === null || raw === "") return false;
  return raw === "1" || String(raw).toLowerCase() === "true";
}

function hasConfiguredValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function pathsEqual(left, right) {
  if (!hasConfiguredValue(left) || !hasConfiguredValue(right)) return false;
  return resolve(String(left)) === resolve(String(right));
}

/** Keys whose *default* moves into the sandbox; the rest keep their defaults. */
const SANDBOX_SUBDIRS = {
  AGENT_MANAGER_RUNS_ROOT: "runs",
  AGENT_MANAGER_CLAIMS_ROOT: "claims",
  AGENT_MANAGER_BRAIN_ROOT: "brain",
};

function temporaryRoots(tempDir) {
  const roots = new Set([resolve(tempDir)]);
  try {
    roots.add(resolve(realpathSync.native(tempDir)));
  } catch {
    // A missing or unreadable temp dir just means one fewer accepted prefix.
  }
  return [...roots];
}

function isInside(root, value) {
  const rel = relative(resolve(root), resolve(value));
  return Boolean(rel) && rel !== "." && !rel.startsWith("..") && !isAbsolute(rel);
}

/** True when `value` lives under the OS temp directory. */
export function isTemporaryPath(value, tempDir = tmpdir()) {
  if (!value) return false;
  return temporaryRoots(tempDir).some((root) => isInside(root, String(value)));
}

/**
 * Under test, a path is only trustworthy if it is disposable: somewhere in the
 * OS temp directory, or inside the sandbox this session already declared.
 */
export function isIsolatedPath(value, { env = process.env, tempDir = tmpdir() } = {}) {
  if (!value) return false;
  if (isTemporaryPath(value, tempDir)) return true;
  const declared = env[TEST_SANDBOX_ENV];
  return Boolean(declared) && isAbsolute(declared) && isInside(declared, String(value));
}

/**
 * Detects a test process. `NODE_TEST_CONTEXT` covers `node --test` children
 * (the default process isolation), `--test` in `execArgv` covers
 * `--test-isolation=none`, and the two Agent Manager variables cover child
 * processes a test spawns plus explicit opt-in.
 */
export function detectTestContext({ env = process.env, execArgv = process.execArgv } = {}) {
  if (env[TEST_SANDBOX_ENV]) return true;
  if (env.NODE_TEST_CONTEXT) return true;
  if (env.AGENT_MANAGER_TEST_MODE === "1") return true;
  return Array.isArray(execArgv) && execArgv.some((arg) => arg === "--test" || arg.startsWith("--test-") || arg.startsWith("--test="));
}

/**
 * Returns the sandbox root for this test session, creating it on first use.
 * The path is published to `env` so every child process a test spawns joins the
 * same sandbox instead of minting its own.
 */
export function testSandboxRoot({ env = process.env, tempDir = tmpdir() } = {}) {
  const existing = env[TEST_SANDBOX_ENV];
  if (existing && isAbsolute(existing)) {
    const root = resolve(existing);
    mkdirSync(root, { recursive: true });
    return root;
  }
  const root = mkdtempSync(join(resolve(tempDir), "agent-manager-test-"));
  env[TEST_SANDBOX_ENV] = root;
  process.once("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort: the sandbox lives in the OS temp directory either way.
    }
  });
  return root;
}

export function defaultConfigPath(home = homedir()) {
  return join(home, ".agent-manager", "config.env");
}

export function parseConfigEnv(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !CONFIG_KEYS.includes(match[1])) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function expandHome(value, home) {
  if (value === "~") return home;
  if (/^~[\\/]/.test(value)) return join(home, value.slice(2));
  return value;
}

function resolveConfiguredPath(value, { home, baseDir }) {
  const expanded = expandHome(String(value), home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

export function resolveAgentManagerConfig({
  env = process.env,
  home = homedir(),
  cwdValue = cwd(),
  configPath = env.AGENT_MANAGER_CONFIG || defaultConfigPath(home),
  overrides = {},
  execArgv = process.execArgv,
  tempDir = tmpdir(),
} = {}) {
  const sandboxed = detectTestContext({ env, execArgv });
  let sandbox = null;
  // Created lazily: a test that already points every root at its own temp
  // directory never needs a sandbox directory at all.
  const sandboxRoot = () => {
    if (!sandbox) sandbox = testSandboxRoot({ env, tempDir });
    return sandbox;
  };
  const isolated = (value) => isIsolatedPath(value, { env, tempDir });

  let resolvedConfigPath = resolveConfiguredPath(configPath, { home, baseDir: cwdValue });
  if (sandboxed && !isolated(resolvedConfigPath)) {
    // Never read (or later write) the operator's real config from a test.
    resolvedConfigPath = join(sandboxRoot(), "config.env");
  }
  const fileValues = existsSync(resolvedConfigPath)
    ? parseConfigEnv(readFileSync(resolvedConfigPath, "utf8"))
    : {};
  const baseDir = dirname(resolvedConfigPath);
  const defaults = {
    AGENT_MANAGER_DEV_ROOT: resolve(cwdValue),
    AGENT_MANAGER_RUNS_ROOT: join(home, ".agent-manager", "runs"),
    AGENT_MANAGER_CLAIMS_ROOT: join(home, ".agent-manager", "claims"),
    AGENT_MANAGER_BRAIN_ROOT: join(home, ".agent-manager", "brain"),
    AGENT_MANAGER_CLAIM_BIN: null,
  };
  const values = {};
  const sources = {};
  const ignoredOverrides = [];
  // Outside tests, keys present in config.env beat ambient env / CLI unless the
  // operator explicitly unlocks overrides. Test sandboxes keep the old order so
  // fixtures can still point roots at disposable temp dirs.
  const unlocked = sandboxed || pathOverridesAllowed(env);
  const pathLockActive = !sandboxed && Object.keys(fileValues).some((key) => hasConfiguredValue(fileValues[key]));

  for (const key of CONFIG_KEYS) {
    const fileConfigured = hasConfiguredValue(fileValues[key]);
    const locked = !unlocked && fileConfigured;
    const candidates = locked
      ? [
        [fileValues[key], "user-config"],
        [defaults[key], "default"],
      ]
      : [
        [overrides[key], "command-line"],
        [env[key], "environment"],
        [fileValues[key], "user-config"],
        [defaults[key], "default"],
      ];
    const supplied = candidates.filter(([value]) => hasConfiguredValue(value));
    let [rawValue, source] = supplied[0] || [null, "default"];
    if (rawValue !== null) {
      rawValue = resolveConfiguredPath(rawValue, {
        home,
        baseDir: source === "user-config" ? baseDir : cwdValue,
      });
    }
    if (sandboxed && source !== "default" && !isolated(rawValue)) {
      // Ambient operator configuration reached a test process. Drop it rather
      // than let the test write into a real registry.
      rawValue = null;
      source = "default";
    }
    if (sandboxed && source === "default" && SANDBOX_SUBDIRS[key]) {
      rawValue = join(sandboxRoot(), SANDBOX_SUBDIRS[key]);
      source = "test-sandbox";
    } else if (rawValue === null && source === "default") {
      rawValue = defaults[key] === null ? null : resolveConfiguredPath(defaults[key], { home, baseDir: cwdValue });
    }

    if (locked && rawValue !== null) {
      for (const [overrideValue, overrideSource] of [
        [overrides[key], "command-line"],
        [env[key], "environment"],
      ]) {
        if (!hasConfiguredValue(overrideValue)) continue;
        const resolvedOverride = resolveConfiguredPath(overrideValue, { home, baseDir: cwdValue });
        if (!pathsEqual(resolvedOverride, rawValue)) {
          ignoredOverrides.push({
            key,
            source: overrideSource,
            value: resolvedOverride,
            configured: rawValue,
          });
        }
      }
    }

    values[key] = rawValue;
    sources[key] = source;
  }

  return {
    configPath: resolvedConfigPath,
    configExists: existsSync(resolvedConfigPath),
    values,
    sources,
    pathLock: {
      active: pathLockActive,
      unlocked,
      allowOverrideEnv: PATH_OVERRIDE_ENV,
    },
    ignoredOverrides,
    testSandbox: sandboxed ? sandbox || env[TEST_SANDBOX_ENV] || null : null,
  };
}

function envLine(key, value) {
  const text = String(value);
  return /[\s#'\"]/.test(text) ? `${key}=${JSON.stringify(text)}` : `${key}=${text}`;
}

export function initAgentManagerConfig({
  env = process.env,
  home = homedir(),
  cwdValue = cwd(),
  configPath = env.AGENT_MANAGER_CONFIG || defaultConfigPath(home),
  devRoot = cwdValue,
  runsRoot = join(home, ".agent-manager", "runs"),
  claimsRoot = join(home, ".agent-manager", "claims"),
  brainRoot = join(home, ".agent-manager", "brain"),
  force = false,
  execArgv = process.execArgv,
  tempDir = tmpdir(),
} = {}) {
  const path = resolveConfiguredPath(configPath, { home, baseDir: cwdValue });
  if (detectTestContext({ env, execArgv }) && !isIsolatedPath(path, { env, tempDir })) {
    throw new Error(
      `refusing to write agent-manager configuration outside the test sandbox: ${path}`,
    );
  }
  if (existsSync(path) && !force) {
    throw new Error(`configuration already exists: ${path} (use --force to replace it)`);
  }
  const sandboxed = detectTestContext({ env, execArgv });
  if (force && existsSync(path) && !sandboxed && !pathOverridesAllowed(env)) {
    throw new Error(
      `refusing config init --force while path lock is active (set ${PATH_OVERRIDE_ENV}=1 to replace ${path})`,
    );
  }
  const values = {
    AGENT_MANAGER_DEV_ROOT: resolveConfiguredPath(devRoot, { home, baseDir: cwdValue }),
    AGENT_MANAGER_RUNS_ROOT: resolveConfiguredPath(runsRoot, { home, baseDir: cwdValue }),
    AGENT_MANAGER_CLAIMS_ROOT: resolveConfiguredPath(claimsRoot, { home, baseDir: cwdValue }),
    AGENT_MANAGER_BRAIN_ROOT: resolveConfiguredPath(brainRoot, { home, baseDir: cwdValue }),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, [
    "# Agent Manager user paths.",
    `# Keys present here beat process environment and CLI overrides unless ${PATH_OVERRIDE_ENV}=1.`,
    "# Agents must not invent or export AGENT_MANAGER_*_ROOT values.",
    envLine("AGENT_MANAGER_DEV_ROOT", values.AGENT_MANAGER_DEV_ROOT),
    envLine("AGENT_MANAGER_RUNS_ROOT", values.AGENT_MANAGER_RUNS_ROOT),
    envLine("AGENT_MANAGER_CLAIMS_ROOT", values.AGENT_MANAGER_CLAIMS_ROOT),
    envLine("AGENT_MANAGER_BRAIN_ROOT", values.AGENT_MANAGER_BRAIN_ROOT),
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  return { path, values };
}

export function formatIgnoredPathOverrides(ignoredOverrides = []) {
  if (!Array.isArray(ignoredOverrides) || ignoredOverrides.length === 0) return "";
  return [
    "ignored path overrides (user-config wins):",
    ...ignoredOverrides.map(
      (entry) => `  ${entry.key} [${entry.source}] ${entry.value} (configured ${entry.configured})`,
    ),
    `set ${PATH_OVERRIDE_ENV}=1 to honor environment/CLI path overrides`,
  ].join("\n");
}

export function formatAgentManagerConfig(config) {
  const labels = [
    ["dev root", "AGENT_MANAGER_DEV_ROOT"],
    ["runs root", "AGENT_MANAGER_RUNS_ROOT"],
    ["claims root", "AGENT_MANAGER_CLAIMS_ROOT"],
    ["brain root", "AGENT_MANAGER_BRAIN_ROOT"],
    ["claim bin", "AGENT_MANAGER_CLAIM_BIN"],
  ];
  const lock = config.pathLock || {};
  const lockLine = lock.active
    ? `path lock: active${lock.unlocked ? " (unlocked)" : ""} — user-config beats env/CLI; unlock with ${lock.allowOverrideEnv || PATH_OVERRIDE_ENV}=1`
    : "path lock: inactive (no user-config path keys, test sandbox, or unlocked)";
  const ignored = formatIgnoredPathOverrides(config.ignoredOverrides);
  return [
    `config: ${config.configPath}`,
    `config exists: ${config.configExists ? "yes" : "no"}`,
    lockLine,
    ...labels.map(([label, key]) => `${label}: ${config.values[key] || "(bundled)"} [${config.sources[key]}]`),
    ...(ignored ? [ignored] : []),
  ].join("\n");
}
