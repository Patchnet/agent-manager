import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const AGENT_INSTRUCTION_FILES = [
  "AGENTS.md",
  "AGENTS.override.md",
  "AGENTS.local.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "Codex.local.md",
];

function git(repoRoot, args) {
  const r = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: r.status === 0,
    status: r.status ?? 1,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}

export function currentBranch(repoRoot) {
  const r = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok ? r.stdout : "main";
}

export function resolveGitRef(repoRoot, ref = "HEAD") {
  const result = git(repoRoot, ["rev-parse", "--verify", ref + "^{commit}"]);
  if (!result.ok) {
    throw new Error(`unable to resolve immutable base ${ref}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export function addWorktree({ repoRoot, worktreePath, branch, baseBranch }) {
  mkdirSync(dirname(worktreePath), { recursive: true });
  if (existsSync(worktreePath)) {
    throw new Error(`worktree path already exists: ${worktreePath}`);
  }
  // Create new branch from base (default: current HEAD of main repo).
  const base = baseBranch || "HEAD";
  const r = git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, base]);
  if (!r.ok) {
    throw new Error(`worktree add failed: ${r.stderr || r.stdout}`);
  }
  return worktreePath;
}

export function inheritIgnoredAgentFiles(repoRoot, worktreePath) {
  const pathspecs = AGENT_INSTRUCTION_FILES.flatMap((name) => [
    name,
    `:(glob)**/${name}`,
  ]);
  const listed = git(repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
    "--",
    ...pathspecs,
  ]);
  if (!listed.ok || !listed.stdout) return [];

  const copied = [];
  for (const relativePath of new Set(listed.stdout.split("\0").filter(Boolean))) {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) continue;
    const source = join(repoRoot, relativePath);
    const target = join(worktreePath, relativePath);
    if (relative(repoRoot, source).startsWith("..") || relative(worktreePath, target).startsWith("..")) {
      continue;
    }
    if (!existsSync(source) || existsSync(target) || !lstatSync(source).isFile()) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied.push(relativePath.replace(/\\/g, "/"));
  }
  return copied.sort();
}

export function removeWorktree({ repoRoot, worktreePath, force = true, bestEffort = false }) {
  if (!existsSync(worktreePath)) return;
  const args = ["worktree", "remove", worktreePath];
  if (force) args.push("--force");
  const r = git(repoRoot, args);
  if (!r.ok) {
    const message = `worktree remove failed: ${r.stderr || r.stdout}`;
    if (bestEffort) console.error(message);
    else throw new Error(message);
  }
}

export function branchOf(worktreePath) {
  const r = spawnSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const branch = r.status === 0 ? (r.stdout || "").trim() : null;
  return branch === "HEAD" ? null : branch;
}

export function assertWorktreeIdentity({ worktreePath, expectedBranch, expectedHead = null }) {
  const branch = branchOf(worktreePath);
  if (branch !== expectedBranch) {
    throw new Error(
      `worktree identity mismatch: expected branch ${expectedBranch}, found ${branch || "detached HEAD"}`,
    );
  }
  const top = git(worktreePath, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new Error(`unable to validate worktree root: ${top.stderr || top.stdout}`);
  const actualRoot = realpathSync(top.stdout);
  const expectedRoot = realpathSync(resolve(worktreePath));
  const actualStat = statSync(actualRoot);
  const expectedStat = statSync(expectedRoot);
  if (actualStat.dev !== expectedStat.dev || actualStat.ino !== expectedStat.ino) {
    throw new Error(`worktree identity mismatch: expected root ${expectedRoot}, found ${actualRoot}`);
  }
  const head = resolveGitRef(worktreePath, "HEAD");
  if (expectedHead && head.toLowerCase() !== expectedHead.toLowerCase()) {
    throw new Error(`worktree identity mismatch: expected HEAD ${expectedHead}, found ${head}`);
  }
  return { branch, head, root: actualRoot };
}
