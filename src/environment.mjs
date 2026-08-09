import { detectRuntimeProfile, runtimeEnv } from "./runtime.mjs";

const BASE_ENV = [
  "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "TMPDIR", "SHELL", "COMSPEC", "ComSpec", "SYSTEMROOT", "SystemRoot",
  "WINDIR", "SystemDrive", "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY", "CODEX_MODEL", "CLAUDE_BIN", "CODEX_BIN", "CURSOR_AGENT_BIN",
  // Cursor worker lanes authenticate the same way Claude and Codex lanes do:
  // through the CLI's own login state, or through its documented API key.
  "CURSOR_API_KEY", "CURSOR_API_ENDPOINT", "CURSOR_MODEL",
];

const VERIFICATION_ENV = [
  "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "TMPDIR", "SHELL", "COMSPEC", "ComSpec", "SYSTEMROOT", "SystemRoot",
  "WINDIR", "SystemDrive", "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS", "CI",
];

const MASTER_RETURN_ENV = [
  ...BASE_ENV,
  "ANTHROPIC_AUTH_TOKEN",
];

export function buildHarnessEnv(
  extraNames = [],
  source = process.env,
  runtime = detectRuntimeProfile({ env: source }),
) {
  const requested = String(source.AGENT_MANAGER_ENV_ALLOWLIST || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const names = new Set([...BASE_ENV, ...requested, ...extraNames]);
  const env = {};
  for (const name of names) {
    if (typeof source[name] === "string") env[name] = source[name];
  }
  env.AGENT_MANAGER_WORKER = "1";
  Object.assign(env, runtimeEnv(runtime));
  return env;
}

export function visibleHarnessEnvNames(extraNames = [], source = process.env) {
  return Object.keys(buildHarnessEnv(extraNames, source)).sort();
}

export function buildVerificationEnv(
  extraNames = [],
  source = process.env,
  runtime = detectRuntimeProfile({ env: source }),
) {
  const names = new Set([...VERIFICATION_ENV, ...extraNames]);
  const env = {};
  for (const name of names) {
    if (typeof source[name] === "string") env[name] = source[name];
  }
  env.AGENT_MANAGER_VERIFICATION = "1";
  Object.assign(env, runtimeEnv(runtime));
  return env;
}

export function buildMasterReturnEnv(extraNames = [], source = process.env) {
  const names = new Set([...MASTER_RETURN_ENV, ...extraNames]);
  const env = {};
  for (const name of names) {
    if (typeof source[name] === "string") env[name] = source[name];
  }
  env.AGENT_MANAGER_MASTER_RETURN = "1";
  Object.assign(env, runtimeEnv(detectRuntimeProfile({ env: source })));
  return env;
}
