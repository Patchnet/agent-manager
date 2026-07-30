import { mkdirSync, writeFileSync } from "node:fs";

export function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function writePrivateFile(path, content, options = {}) {
  const normalized = typeof options === "string" ? { encoding: options } : options;
  writeFileSync(path, content, { mode: 0o600, ...normalized });
  return path;
}
