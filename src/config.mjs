import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cwd } from "node:process";

export const CONFIG_KEYS = [
  "AGENT_MANAGER_DEV_ROOT",
  "AGENT_MANAGER_RUNS_ROOT",
  "AGENT_MANAGER_CLAIMS_ROOT",
  "AGENT_MANAGER_BRAIN_ROOT",
  "AGENT_MANAGER_CLAIM_BIN",
];

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
} = {}) {
  const resolvedConfigPath = resolveConfiguredPath(configPath, { home, baseDir: cwdValue });
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

  for (const key of CONFIG_KEYS) {
    const candidates = [
      [overrides[key], "command-line"],
      [env[key], "environment"],
      [fileValues[key], "user-config"],
      [defaults[key], "default"],
    ];
    const [rawValue, source] = candidates.find(([value]) => value !== undefined && value !== null && String(value).trim() !== "") || [null, "default"];
    values[key] = rawValue === null ? null : resolveConfiguredPath(rawValue, {
      home,
      baseDir: source === "user-config" ? baseDir : cwdValue,
    });
    sources[key] = source;
  }

  return {
    configPath: resolvedConfigPath,
    configExists: existsSync(resolvedConfigPath),
    values,
    sources,
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
} = {}) {
  const path = resolveConfiguredPath(configPath, { home, baseDir: cwdValue });
  if (existsSync(path) && !force) {
    throw new Error(`configuration already exists: ${path} (use --force to replace it)`);
  }
  const values = {
    AGENT_MANAGER_DEV_ROOT: resolveConfiguredPath(devRoot, { home, baseDir: cwdValue }),
    AGENT_MANAGER_RUNS_ROOT: resolveConfiguredPath(runsRoot, { home, baseDir: cwdValue }),
    AGENT_MANAGER_CLAIMS_ROOT: resolveConfiguredPath(claimsRoot, { home, baseDir: cwdValue }),
    AGENT_MANAGER_BRAIN_ROOT: resolveConfiguredPath(brainRoot, { home, baseDir: cwdValue }),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, [
    "# Agent Manager user paths. Process environment variables override these values.",
    envLine("AGENT_MANAGER_DEV_ROOT", values.AGENT_MANAGER_DEV_ROOT),
    envLine("AGENT_MANAGER_RUNS_ROOT", values.AGENT_MANAGER_RUNS_ROOT),
    envLine("AGENT_MANAGER_CLAIMS_ROOT", values.AGENT_MANAGER_CLAIMS_ROOT),
    envLine("AGENT_MANAGER_BRAIN_ROOT", values.AGENT_MANAGER_BRAIN_ROOT),
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  return { path, values };
}

export function formatAgentManagerConfig(config) {
  const labels = [
    ["dev root", "AGENT_MANAGER_DEV_ROOT"],
    ["runs root", "AGENT_MANAGER_RUNS_ROOT"],
    ["claims root", "AGENT_MANAGER_CLAIMS_ROOT"],
    ["brain root", "AGENT_MANAGER_BRAIN_ROOT"],
    ["claim bin", "AGENT_MANAGER_CLAIM_BIN"],
  ];
  return [
    `config: ${config.configPath}`,
    `config exists: ${config.configExists ? "yes" : "no"}`,
    ...labels.map(([label, key]) => `${label}: ${config.values[key] || "(bundled)"} [${config.sources[key]}]`),
  ].join("\n");
}
