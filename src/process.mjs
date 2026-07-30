import { spawnSync } from "node:child_process";

export function terminateProcessTree(child, signal = "SIGTERM") {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return false;
  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return result.status === 0;
    }
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}
