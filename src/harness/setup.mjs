const SETUP = {
  claude: {
    displayName: "Claude Code",
    command: "claude",
    overrideEnv: "CLAUDE_BIN",
    docs: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
    win32: "npm install -g @anthropic-ai/claude-code",
    default: "npm install -g @anthropic-ai/claude-code",
  },
  codex: {
    displayName: "Codex CLI",
    command: "codex",
    overrideEnv: "CODEX_BIN",
    docs: "https://github.com/openai/codex#installing-and-running-codex-cli",
    win32: "powershell -ExecutionPolicy Bypass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"",
    default: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  },
  cursor: {
    displayName: "Cursor Agent CLI",
    command: "cursor-agent",
    overrideEnv: "CURSOR_AGENT_BIN",
    docs: "https://cursor.com/docs/cli/installation",
    win32: "powershell -ExecutionPolicy Bypass -c \"irm 'https://cursor.com/install?win32=true' | iex\"",
    default: "curl https://cursor.com/install -fsS | bash",
  },
};

export function harnessSetup(name, { platform = process.platform } = {}) {
  const config = SETUP[name];
  if (!config) throw new Error(`unknown harness setup: ${name}`);
  return {
    harness: name,
    displayName: config.displayName,
    command: config.command,
    overrideEnv: config.overrideEnv,
    install: config[platform] || config.default,
    verify: `${config.command} --version`,
    docs: config.docs,
    restartRequired: true,
    environmentRule: "Install and verify the CLI in the same OS environment that launches Agent Manager.",
    sandboxNote: "Agent Manager does not override the launching harness sandbox or executable permissions.",
    ...(platform === "win32"
      ? { shimGuidance: `If a launcher shim is installed, point ${config.overrideEnv} to its full .cmd path and restart the launching harness.` }
      : {}),
  };
}

export function harnessFailureRecommendation(name, options = {}) {
  const setup = harnessSetup(name, options);
  return [
    `${setup.displayName} is not executable from this Agent Manager process; this does not prove it is uninstalled.`,
    `Verify from the same environment: ${setup.verify}`,
    setup.shimGuidance,
    `If verification succeeds, configure ${setup.overrideEnv}, restart the launching harness, and confirm its sandbox permits the executable.`,
    `If verification fails because the CLI is absent, install: ${setup.install}`,
    "Restart Codex, Claude Code, Cursor, or the terminal after PATH/environment changes.",
    `Official guide: ${setup.docs}`,
  ].filter(Boolean).join(" ");
}
