import { spawnSync } from "node:child_process";

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

export function inspectLaneChanges(worktree) {
  const tracked = git(worktree, ["diff", "--name-only", "HEAD"]);
  const untracked = git(worktree, ["ls-files", "--others", "--exclude-standard"]);
  if (!tracked.ok || !untracked.ok) {
    throw new Error(tracked.stderr || untracked.stderr || "unable to inspect lane changes");
  }
  return [...new Set([
    ...splitLines(tracked.stdout),
    ...splitLines(untracked.stdout),
  ].map(normalizePath))].sort();
}

export function validateLaneGuardrails({ worktree, scope, baseCommit, policy = {} }) {
  const changedFiles = inspectLaneChanges(worktree);
  const patterns = parseScope(scope);
  const scopeViolations = changedFiles.filter((file) => !patterns.some((pattern) => matchesScope(file, pattern)));
  const commits = git(worktree, ["rev-list", "--count", baseCommit + "..HEAD"]);
  const commitCount = commits.ok ? Number.parseInt(commits.stdout || "0", 10) : 0;
  const policyViolations = [];
  if (policy.allow_commit !== true && commitCount > 0) {
    policyViolations.push("worker created " + commitCount + " commit(s) while allow_commit=false");
  }
  return {
    ok: scopeViolations.length === 0 && policyViolations.length === 0,
    changedFiles,
    scopeViolations,
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
  // Split on common shell separators so `git log && git tag -a` is checked per segment.
  const segments = String(command).split(/(?:&&|\|\||[;&|\n])/);
  for (const segment of segments) {
    if (segmentHasForbiddenGit(segment)) return true;
  }
  return false;
}

function segmentHasForbiddenGit(segment) {
  const match = segment.match(
    /\bgit(?:\.exe)?(?:\s+-C\s+\S+)*(?:\s+-c\s+\S+=\S+)*\s+([a-z0-9][-a-z0-9]*)\b/i,
  );
  if (!match) return false;
  const sub = match[1].toLowerCase();
  if (sub === "commit" || sub === "push" || sub === "rebase" || sub === "cherry-pick") {
    return true;
  }
  // `git merge` mutates; `git merge-base` / `git merge-tree` do not (different subcommands).
  if (sub === "merge") return true;
  if (sub === "tag") return isMutatingGitTag(segment);
  return false;
}

function isMutatingGitTag(segment) {
  const afterMatch = segment.match(
    /\bgit(?:\.exe)?(?:\s+-C\s+\S+)*(?:\s+-c\s+\S+=\S+)*\s+tag\b([\s\S]*)/i,
  );
  if (!afterMatch) return false;
  const rest = afterMatch[1] || "";
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

export function matchesScope(file, rawPattern) {
  const value = normalizePath(file);
  const pattern = normalizePath(rawPattern).replace(/^\.\//, "");
  if (!pattern) return false;
  if (!/[?*]/.test(pattern)) {
    return value === pattern || value.startsWith(pattern.replace(/\/$/, "") + "/");
  }
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  const regex = escaped
    .replace(/\*\*\//g, "::DOUBLE_STAR_SLASH::")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/::DOUBLE_STAR_SLASH::/g, "(?:.*/)?")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp("^" + regex + "$").test(value);
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
