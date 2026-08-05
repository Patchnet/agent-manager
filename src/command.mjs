import { spawnSync } from "node:child_process";

export function resolveSpawnCommand(command, args = [], {
  platform = process.platform,
  env = process.env,
  override = null,
} = {}) {
  if (override?.endsWith(".mjs")) {
    return { command: process.execPath, args: [override, ...args] };
  }
  if (override) return { command: override, args };

  const extension = String(command).toLowerCase().match(/\.(cmd|bat)$/)?.[0];
  if (platform === "win32" && (command === "npm" || command === "npx" || extension)) {
    return {
      command: env.ComSpec || env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  if (platform === "win32" && String(command).toLowerCase().endsWith(".ps1")) {
    return {
      command: env.SystemRoot
        ? `${env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        : "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
    };
  }
  return { command, args };
}

export function spawnCommandSync(command, args = [], options = {}) {
  const { platform, env = process.env, override, ...spawnOptions } = options;
  const resolved = resolveSpawnCommand(command, args, { platform, env, override });
  return {
    resolved,
    result: spawnSync(resolved.command, resolved.args, {
      ...spawnOptions,
      env,
    }),
  };
}
