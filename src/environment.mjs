const BASE_ENV = [
  "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "TMPDIR", "SHELL", "COMSPEC", "ComSpec", "SYSTEMROOT", "SystemRoot",
  "WINDIR", "SystemDrive", "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY", "CODEX_MODEL",
];

export function buildHarnessEnv(extraNames = [], source = process.env) {
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
  return env;
}

export function visibleHarnessEnvNames(extraNames = [], source = process.env) {
  return Object.keys(buildHarnessEnv(extraNames, source)).sort();
}
