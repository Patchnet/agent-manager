import { release as osRelease } from "node:os";
import { basename } from "node:path";

const OS_NAMES = {
  win32: "windows",
  darwin: "macos",
  linux: "linux",
};

export function detectRuntimeProfile({
  platform = process.platform,
  arch = process.arch,
  release = osRelease(),
  env = process.env,
} = {}) {
  const shell = platform === "win32"
    ? "powershell"
    : basename(env.SHELL || "/bin/sh");
  return {
    hostPlatform: platform,
    os: OS_NAMES[platform] || platform,
    arch,
    release,
    shell,
    commandMode: "spawn-no-shell",
    pathStyle: platform === "win32" ? "windows" : "posix",
  };
}

export function runtimePrompt(profile = detectRuntimeProfile()) {
  return [
    "## Host runtime (automatic; authoritative)",
    `- OS: ${profile.os} (${profile.hostPlatform})`,
    `- Architecture: ${profile.arch}`,
    `- Shell for authored commands: ${profile.shell}`,
    `- Command execution: ${profile.commandMode}`,
    `- Path style: ${profile.pathStyle}`,
    "- Use commands and quoting that match this host. Do not assume Bash on Windows.",
  ].join("\n");
}

export function runtimeEnv(profile = detectRuntimeProfile()) {
  return {
    AGENT_MANAGER_HOST_PLATFORM: profile.hostPlatform,
    AGENT_MANAGER_HOST_OS: profile.os,
    AGENT_MANAGER_HOST_ARCH: profile.arch,
    AGENT_MANAGER_HOST_SHELL: profile.shell,
    AGENT_MANAGER_COMMAND_MODE: profile.commandMode,
    AGENT_MANAGER_PATH_STYLE: profile.pathStyle,
  };
}

export function formatRuntime(profile) {
  if (!profile) return "n/a";
  return `${profile.os}/${profile.arch} (${profile.hostPlatform}) · ${profile.shell} · ${profile.commandMode}`;
}
