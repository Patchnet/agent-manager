import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { matchesScope } from "./scope.mjs";

export { matchesScope } from "./scope.mjs";

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

export function inspectInitialRepo(repoRoot) {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const status = git(repoRoot, ["status", "--porcelain=v1"]);
  if (!head.ok || !status.ok) {
    throw new Error(head.stderr || status.stderr || "unable to inspect initial repo state");
  }
  const changes = status.stdout ? status.stdout.split(/\r?\n/).filter(Boolean) : [];
  return {
    head: head.stdout,
    dirty: changes.length > 0,
    changes,
  };
}

export function currentHead(worktree) {
  const result = git(worktree, ["rev-parse", "HEAD"]);
  if (!result.ok) throw new Error(result.stderr || "git rev-parse failed");
  return result.stdout;
}

export function inspectLaneChanges(worktree, baseCommit = "HEAD") {
  const committed = git(worktree, ["diff", "--name-only", baseCommit + "...HEAD"]);
  const working = git(worktree, ["diff", "--name-only", "HEAD"]);
  const untracked = git(worktree, ["ls-files", "--others", "--exclude-standard"]);
  if (!committed.ok || !working.ok || !untracked.ok) {
    throw new Error(
      committed.stderr || working.stderr || untracked.stderr || "unable to inspect lane changes",
    );
  }
  return [...new Set([
    ...splitLines(committed.stdout),
    ...splitLines(working.stdout),
    ...splitLines(untracked.stdout),
  ].map(normalizePath))].sort();
}

const PORTABLE_SHELL_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".ksh"]);

export function inspectPortableScriptLineEndings({
  worktree,
  baseCommit = "HEAD",
  changedFiles = null,
}) {
  const files = changedFiles || inspectLaneChanges(worktree, baseCommit);
  const violations = [];
  for (const file of files) {
    let contents;
    try {
      contents = readEffectiveChangedFile(worktree, file);
      if (!contents) continue;
    } catch {
      // Deleted paths and non-files cannot carry accepted script contents.
      continue;
    }
    const portable = PORTABLE_SHELL_EXTENSIONS.has(extname(file).toLowerCase()) ||
      (contents[0] === 0x23 && contents[1] === 0x21);
    if (portable && contents.includes(Buffer.from("\r\n"))) violations.push(file);
  }
  return violations;
}

function readEffectiveChangedFile(worktree, file) {
  const path = join(worktree, file);
  const tracked = git(worktree, ["ls-files", "--error-unmatch", "--", file]).ok;
  const clean = tracked && git(worktree, ["diff", "--quiet", "HEAD", "--", file]).ok;
  if (!clean) {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path);
  }
  const result = spawnSync("git", ["-C", worktree, "show", `HEAD:${file}`], {
    encoding: null,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout : null;
}

/**
 * The patterns a lane may write to: its declared scope plus every scope
 * extension Master granted while answering the lane. A grant is recorded on the
 * lane before the harness resumes, so work done under it cannot fail the lane
 * at exit. Read-only paths are deliberately not unioned — an extension widens
 * what the lane owns, it never reopens a path someone else owns.
 */
export function laneScopePatterns(scope, scopeExtensions = []) {
  const extensions = (Array.isArray(scopeExtensions) ? scopeExtensions : [])
    .flatMap((grant) => parseScope(grant?.patterns ?? grant));
  return [...new Set([...parseScope(scope), ...extensions])];
}

export function validateLaneGuardrails({
  worktree,
  scope,
  scopeExtensions = [],
  readOnlyScope = [],
  baseCommit,
  policy = {},
}) {
  if (!baseCommit) throw new Error("guardrail inspection requires baseCommit");
  const changedFiles = inspectLaneChanges(worktree, baseCommit);
  const patterns = laneScopePatterns(scope, scopeExtensions);
  const scopeViolations = changedFiles.filter((file) => !patterns.some((pattern) => matchesScope(file, pattern)));
  const readOnlyPatterns = parseScope(readOnlyScope);
  const readOnlyViolations = changedFiles.filter((file) =>
    readOnlyPatterns.some((pattern) => matchesScope(file, pattern)),
  );
  const portableScriptViolations = inspectPortableScriptLineEndings({
    worktree,
    baseCommit,
    changedFiles,
  });
  const commits = git(worktree, ["rev-list", "--count", baseCommit + "..HEAD"]);
  if (!commits.ok) throw new Error(commits.stderr || "unable to inspect worker commits");
  const commitCount = Number.parseInt(commits.stdout || "0", 10);
  if (!Number.isSafeInteger(commitCount) || commitCount < 0) {
    throw new Error("invalid worker commit count returned by Git");
  }
  const policyViolations = [];
  if (policy.allow_commit !== true && commitCount > 0) {
    policyViolations.push("worker created " + commitCount + " commit(s) while allow_commit=false");
  }
  for (const file of portableScriptViolations) {
    policyViolations.push(`portable Unix script uses CRLF line endings: ${file}`);
  }
  return {
    ok:
      scopeViolations.length === 0 &&
      readOnlyViolations.length === 0 &&
      policyViolations.length === 0,
    changedFiles,
    scopeViolations,
    readOnlyViolations,
    portableScriptViolations,
    commitCount,
    policyViolations,
  };
}

export function createPolicyEventInspector(policy = {}) {
  return function inspect(event) {
    const commands = extractCommands(event);
    for (const command of commands) {
      if (policy.allow_commit !== true && isForbiddenGitMutation(command)) {
        return "forbidden git operation while allow_commit=false: " + command.slice(0, 180);
      }
      if (policy.allow_pr !== true && /(^\s*|[;&|\n]\s*)gh\s+pr\s+(create|merge|close|ready|edit)\b/i.test(command)) {
        return "forbidden PR operation while allow_pr=false: " + command.slice(0, 180);
      }
    }
    return null;
  };
}

/**
 * True when a shell command includes a git mutation we block under allow_commit=false.
 * Read-only inspection (status/log/show/branch/tag --contains/merge-base/…) is allowed.
 */
export function isForbiddenGitMutation(command) {
  if (typeof command !== "string" || !/\bgit(?:\.exe)?\b/i.test(command)) return false;
  for (const candidate of commandCandidates(command)) {
    // Split only on unquoted shell separators. Search patterns and script
    // arguments may legitimately contain text such as `git commit|git push`.
    for (const segment of splitShellSegments(candidate)) {
      if (segmentHasForbiddenGit(segment)) return true;
    }
  }
  return false;
}

function segmentHasForbiddenGit(segment) {
  const match = segment.trim().match(
    /^(?:(?:&|call)\s+)?(?:(?:"(?:[^"]*[\\/])?git(?:\.exe)?"|'(?:[^']*[\\/])?git(?:\.exe)?')|(?:\S*[\\/])?git(?:\.exe)?)(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))*(?:\s+-c\s+\S+=\S+)*\s+([a-z0-9][-a-z0-9]*)\b([\s\S]*)$/i,
  );
  if (!match) return false;
  const sub = match[1].toLowerCase();
  if (sub === "commit" || sub === "push" || sub === "rebase" || sub === "cherry-pick") {
    return true;
  }
  // `git merge` mutates; `git merge-base` / `git merge-tree` do not (different subcommands).
  if (sub === "merge") return true;
  if (sub === "tag") return isMutatingGitTag(match[2] || "");
  return false;
}

function isMutatingGitTag(rest) {
  // Explicit read-only query forms (the false-positive that killed Wave 3 lanes).
  if (
    /(?:^|\s)--(?:contains|list|points-at|merged|no-merged|sort|format|color|column|ignore-case)\b/i.test(
      rest,
    )
  ) {
    return false;
  }
  if (/(?:^|\s)-l(?:\s|$|=)/.test(rest)) return false;
  // Create / delete / force / sign mutators.
  if (
    /(?:^|\s)(?:-[adfsu]\b|--(?:annotate|delete|force|sign|local-user|message|file|cleanup)\b)/i.test(
      rest,
    )
  ) {
    return true;
  }
  // Lightweight create: `git tag v1.2.3` or `git tag my-tag` (positional name left).
  const positional = rest
    .replace(/(?:^|\s)--?[a-z][\w-]*=(?:"[^"]*"|'[^']*'|\S+)/gi, " ")
    .replace(/(?:^|\s)--?[a-z][\w-]*/gi, " ")
    .trim();
  return positional.length > 0;
}

function commandCandidates(command) {
  const candidates = [String(command)];
  const seen = new Set(candidates);
  for (let i = 0; i < candidates.length; i++) {
    const payload = unwrapShellPayload(candidates[i]);
    if (payload && !seen.has(payload)) {
      seen.add(payload);
      candidates.push(payload);
    }
  }
  return candidates;
}

function unwrapShellPayload(command) {
  const wrappers = [
    /\b(?:powershell|pwsh)(?:\.exe)?["']?(?:\s+-[^\s]+)*\s+-(?:Command|c)\s+([\s\S]+)$/i,
    /\bcmd(?:\.exe)?["']?(?:\s+\/[^\s]+)*\s+\/c\s+([\s\S]+)$/i,
    /\b(?:bash|sh|zsh)(?:\.exe)?["']?(?:\s+-[^\s]+)*\s+-[^\s]*c\s+([\s\S]+)$/i,
  ];
  for (const pattern of wrappers) {
    const match = String(command).match(pattern);
    if (match) return stripOuterQuotes(match[1].trim());
  }
  return null;
}

function stripOuterQuotes(value) {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote === "'" || quote === '"') && value[value.length - 1] === quote) {
    return value.slice(1, -1);
  }
  return value;
}

function splitShellSegments(command) {
  const segments = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" || char === "`") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const pair = command.slice(i, i + 2);
    if (pair === "&&" || pair === "||") {
      segments.push(command.slice(start, i));
      start = i + 2;
      i++;
      continue;
    }
    if (char === ";" || char === "|" || char === "\n") {
      segments.push(command.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(command.slice(start));
  return segments;
}

function parseScope(scope) {
  return (Array.isArray(scope) ? scope : String(scope || "").split(","))
    .map((value) => String(value).trim())
    .filter(Boolean);
}

function splitLines(value) {
  return value ? value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

function normalizePath(value) {
  return String(value).replace(/\\/g, "/");
}

function extractCommands(event) {
  const commands = [];
  const content = event?.message?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type !== "tool_use") continue;
      const input = part.input || {};
      if (typeof input.command === "string") commands.push(input.command);
      if (typeof input.cmd === "string") commands.push(input.cmd);
    }
  }
  // Codex exec --json: item.*.item.command_execution
  if (
    typeof event?.type === "string" &&
    event.type.startsWith("item.") &&
    event.item?.type === "command_execution" &&
    typeof event.item.command === "string"
  ) {
    commands.push(event.item.command);
  }
  return commands;
}
