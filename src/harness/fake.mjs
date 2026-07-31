import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { detectNeedsInput } from "./claude.mjs";
import { assertPathInside } from "../paths.mjs";
import { ensurePrivateDir, writePrivateFile } from "../fs-safe.mjs";

function makeHandle(options, resumed = false) {
  const fixture = resumed ? options.lane?.fake?.resume || {} : options.lane?.fake || {};
  const sessionId = options.sessionId || "fake-" + randomUUID();
  const logPath = join(options.laneDir, options.logName || (resumed ? "resume.log" : "stdout.log"));
  const promptPath = join(
    options.laneDir,
    resumed
      ? (options.logName || "resume.log").replace(/\.log$/, ".prompt.md")
      : "prompt.md",
  );
  const delayMs = Number(fixture.delay_ms ?? 20);
  let killed = false;
  let lastActivity = resumed ? "fake resumed" : "fake spawned";
  let lastByteAt = Date.now();
  ensurePrivateDir(options.laneDir);
  writePrivateFile(promptPath, String(options.prompt || ""), "utf8");
  if (resumed) {
    rmSync(join(options.laneDir, "needs-input.json"), { force: true });
  }
  writePrivateFile(logPath, lastActivity + "\n", { flag: "a" });

  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      lastByteAt = Date.now();
      if (killed) {
        resolve({ exitCode: 143, signal: "SIGTERM", lastActivity: "cancelled", logPath, sessionId });
        return;
      }
      if (fixture.write) {
        const target = assertPathInside(options.cwd, join(options.cwd, fixture.write.path), "fake fixture path");
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, String(fixture.write.content ?? "fixture\n"), "utf8");
        lastActivity = "fake wrote " + fixture.write.path;
      }
      if (fixture.needs_input) {
        const needs = {
          type: "question",
          prompt: String(fixture.needs_input),
          blocking: true,
        };
        writePrivateFile(join(options.laneDir, "needs-input.json"), JSON.stringify(needs, null, 2));
        lastActivity = needs.prompt;
      }
      options.onActivity?.(lastActivity);
      resolve({
        exitCode: Number(fixture.exit_code ?? 0),
        signal: null,
        lastActivity,
        logPath,
        sessionId,
      });
    }, delayMs);
  });

  return {
    pid: null,
    done,
    getLastActivity: () => lastActivity,
    getLastByteAt: () => lastByteAt,
    getSessionId: () => sessionId,
    kill: () => {
      killed = true;
    },
  };
}

export const fakeAdapter = {
  name: "fake",
  supported: true,
  testOnly: true,
  start: (options) => makeHandle(options, false),
  resume: (options) => makeHandle(options, true),
  cancel: (handle) => handle?.kill?.(),
  parseSessionId: (event) => event?.sessionId || null,
  parseNeedsInput: detectNeedsInput,
};
