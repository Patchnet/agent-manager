import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Detached supervisors have no console on Windows. Any console program they
// start without windowsHide (git, gh, npm, cmd) opens a new visible window, and
// a ship polling gh every few seconds turns that into a stream of windows.
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith(".mjs") ? [path] : [];
  });
}

function childProcessCalls(source) {
  const imported = /import\s*\{([^}]+)\}\s*from\s*"node:child_process"/.exec(source);
  if (!imported) return [];
  const names = imported[1]
    .split(",")
    .map((name) => name.trim().split(/\s+as\s+/).pop())
    .filter(Boolean);
  const pattern = new RegExp(`(?<![.\\w$])(${names.join("|")})\\(`, "g");
  const calls = [];
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    let index = match.index + match[0].length;
    for (let depth = 1; index < source.length && depth; index += 1) {
      if (source[index] === "(") depth += 1;
      else if (source[index] === ")") depth -= 1;
    }
    calls.push({
      text: source.slice(match.index, index),
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return calls;
}

test("every child process started by agent-manager hides its Windows console", () => {
  const files = [...sourceFiles("src"), "bin/agent-manager.mjs"];
  const unhidden = files.flatMap((file) =>
    childProcessCalls(readFileSync(file, "utf8"))
      .filter((call) => !/windowsHide/.test(call.text))
      .map((call) => `${file}:${call.line}`),
  );
  assert.deepEqual(unhidden, [], `child process calls without windowsHide: ${unhidden.join(", ")}`);
});
