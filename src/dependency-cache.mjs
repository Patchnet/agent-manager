import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const CACHE_SCHEMA = "agent-manager.setup-cache.v1";
const MANIFEST_FILE = "manifest.json";

class UnsupportedTreeError extends Error {}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableEnvironment(environment = {}) {
  return Object.fromEntries(
    Object.entries(environment)
      .filter(([, value]) => typeof value === "string")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function createSetupCacheKey({ plan, revision, environment = {} }) {
  return sha256(JSON.stringify({
    schema: CACHE_SCHEMA,
    plan: {
      timeout_sec: plan.timeout_sec,
      commands: plan.commands.map((item) => ({
        command: item.command,
        args: [...item.args],
      })),
    },
    revision,
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    environment: stableEnvironment(environment),
  }));
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error("cache manifest contains an invalid path");
  }
  const portable = value.replaceAll("\\", "/");
  if (
    portable === ".git" ||
    portable.startsWith(".git/") ||
    portable.startsWith("/") ||
    isAbsolute(value) ||
    portable.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`cache manifest path is unsafe: ${value}`);
  }
  return portable;
}

function contained(root, portablePath) {
  const safe = normalizeRelativePath(portablePath);
  const target = resolve(root, ...safe.split("/"));
  const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`cache path escapes its root: ${portablePath}`);
  }
  return target;
}

function fileHash(path) {
  return sha256(readFileSync(path));
}

function inspectTree(root) {
  const entries = [];
  function walk(directory, prefix = "") {
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (!prefix && child.name === ".git") continue;
      const portablePath = prefix ? `${prefix}/${child.name}` : child.name;
      const absolutePath = join(directory, child.name);
      const stat = lstatSync(absolutePath);
      const mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) {
        throw new UnsupportedTreeError(`symbolic link is not cacheable: ${portablePath}`);
      }
      if (stat.isDirectory()) {
        entries.push({ path: portablePath, type: "directory", mode });
        walk(absolutePath, portablePath);
      } else if (stat.isFile()) {
        entries.push({
          path: portablePath,
          type: "file",
          mode,
          size: stat.size,
          sha256: fileHash(absolutePath),
        });
      } else {
        throw new UnsupportedTreeError(`unsupported file type is not cacheable: ${portablePath}`);
      }
    }
  }
  walk(root);
  return { entries, digest: sha256(JSON.stringify(entries)) };
}

function git(worktree, args) {
  const result = spawnSync("git", ["-C", worktree, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: String(result.stdout || "").trim(),
  };
}

function pristineAtRevision(worktree, revision) {
  if (typeof revision !== "string" || !revision) {
    return { ok: false, reason: "revision-unavailable" };
  }
  const head = git(worktree, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout !== revision) {
    return { ok: false, reason: "revision-mismatch" };
  }
  const status = git(worktree, ["status", "--porcelain", "--untracked-files=no"]);
  if (!status.ok || status.stdout) {
    return { ok: false, reason: "worktree-not-pristine" };
  }
  return { ok: true };
}

function setupDidNotMutateGitState(worktree, revision) {
  const head = git(worktree, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout !== revision) return false;
  return git(worktree, ["diff", "--cached", "--quiet"]).status === 0;
}

function entryMap(tree) {
  return new Map(tree.entries.map((entry) => [entry.path, entry]));
}

function sameEntry(left, right) {
  return left.type === right.type &&
    left.mode === right.mode &&
    (left.type === "directory" ||
      (left.size === right.size && left.sha256 === right.sha256));
}

function createDelta(before, after) {
  const beforeByPath = entryMap(before);
  const afterByPath = entryMap(after);
  const added = [];
  const modified = [];
  const removed = [];
  for (const entry of after.entries) {
    const prior = beforeByPath.get(entry.path);
    if (!prior) added.push(entry);
    else if (prior.type !== entry.type) {
      throw new UnsupportedTreeError(`file type changed during setup: ${entry.path}`);
    } else if (!sameEntry(prior, entry)) modified.push(entry);
  }
  for (const entry of before.entries) {
    if (!afterByPath.has(entry.path)) removed.push(entry);
  }
  return { added, modified, removed };
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

function copyEntry(sourceRoot, targetRoot, entry) {
  const target = contained(targetRoot, entry.path);
  if (entry.type === "directory") {
    mkdirSync(target, { recursive: true, mode: entry.mode });
    chmodSync(target, entry.mode);
    return;
  }
  const source = contained(sourceRoot, entry.path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  chmodSync(target, entry.mode);
}

function storeSnapshot({ cacheRoot, cachePath, key, revision, before, after, delta, setup, worktree }) {
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  if (existsSync(cachePath)) return false;
  const temporary = join(cacheRoot, `.tmp-${key}-${randomBytes(6).toString("hex")}`);
  mkdirSync(join(temporary, "overlay"), { recursive: true, mode: 0o700 });
  try {
    for (const entry of [...delta.added, ...delta.modified]) {
      if (entry.type === "file") copyEntry(worktree, join(temporary, "overlay"), entry);
    }
    writeJson(join(temporary, MANIFEST_FILE), {
      schema: CACHE_SCHEMA,
      key,
      revision,
      before,
      after,
      delta,
      result: setup,
    });
    renameSync(temporary, cachePath);
    return true;
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  }
}

function readManifest(cachePath, key, revision) {
  const manifest = JSON.parse(readFileSync(join(cachePath, MANIFEST_FILE), "utf8"));
  if (
    manifest?.schema !== CACHE_SCHEMA ||
    manifest.key !== key ||
    manifest.revision !== revision ||
    manifest.result?.state !== "passed" ||
    manifest.result?.passed !== true ||
    !Array.isArray(manifest.before?.entries) ||
    !Array.isArray(manifest.after?.entries) ||
    !Array.isArray(manifest.delta?.added) ||
    !Array.isArray(manifest.delta?.modified) ||
    !Array.isArray(manifest.delta?.removed)
  ) {
    throw new Error("cache manifest is incomplete");
  }
  for (const entry of [...manifest.before.entries, ...manifest.after.entries]) {
    normalizeRelativePath(entry.path);
    if (!["file", "directory"].includes(entry.type)) {
      throw new Error(`cache manifest has unsupported type: ${entry.type}`);
    }
  }
  if (
    sha256(JSON.stringify(manifest.before.entries)) !== manifest.before.digest ||
    sha256(JSON.stringify(manifest.after.entries)) !== manifest.after.digest
  ) {
    throw new Error("cache manifest tree digest is invalid");
  }
  const expectedDelta = createDelta(manifest.before, manifest.after);
  if (JSON.stringify(expectedDelta) !== JSON.stringify(manifest.delta)) {
    throw new Error("cache manifest delta is incomplete");
  }
  const overlayRoot = join(cachePath, "overlay");
  inspectTree(overlayRoot);
  for (const entry of [...manifest.delta.added, ...manifest.delta.modified]) {
    if (entry.type !== "file") continue;
    const overlayPath = contained(overlayRoot, entry.path);
    const stat = lstatSync(overlayPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== entry.size ||
      fileHash(overlayPath) !== entry.sha256
    ) {
      throw new Error(`cache overlay integrity failed: ${entry.path}`);
    }
  }
  return manifest;
}

function depth(entry) {
  return entry.path.split("/").length;
}

function restoreSnapshot({ worktree, cacheRoot, cachePath, manifest }) {
  const current = inspectTree(worktree);
  if (current.digest !== manifest.before.digest) {
    return { ok: false, reason: "baseline-drift", safeToRun: true };
  }
  const transaction = join(cacheRoot, `.restore-${randomBytes(8).toString("hex")}`);
  const backup = join(transaction, "backup");
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  const changedFiles = manifest.delta.modified.filter((entry) => entry.type === "file");
  const removedFiles = manifest.delta.removed.filter((entry) => entry.type === "file");
  try {
    for (const entry of [...changedFiles, ...removedFiles]) copyEntry(worktree, backup, entry);
    for (const entry of [...manifest.delta.removed].sort((a, b) => depth(b) - depth(a))) {
      rmSync(contained(worktree, entry.path), {
        recursive: entry.type === "directory",
        force: true,
      });
    }
    for (const entry of [...manifest.delta.added, ...manifest.delta.modified]
      .filter((item) => item.type === "directory")
      .sort((a, b) => depth(a) - depth(b))) {
      copyEntry(join(cachePath, "overlay"), worktree, entry);
    }
    for (const entry of [...manifest.delta.added, ...manifest.delta.modified]
      .filter((item) => item.type === "file")) {
      copyEntry(join(cachePath, "overlay"), worktree, entry);
    }
    if (inspectTree(worktree).digest !== manifest.after.digest) {
      throw new Error("restored worktree does not match the cache manifest");
    }
    return { ok: true };
  } catch (error) {
    try {
      for (const entry of [...manifest.delta.added].sort((a, b) => depth(b) - depth(a))) {
        rmSync(contained(worktree, entry.path), {
          recursive: entry.type === "directory",
          force: true,
        });
      }
      for (const entry of manifest.delta.removed
        .filter((item) => item.type === "directory")
        .sort((a, b) => depth(a) - depth(b))) {
        copyEntry(backup, worktree, entry);
      }
      for (const entry of [...removedFiles, ...changedFiles]) copyEntry(backup, worktree, entry);
      for (const entry of manifest.delta.modified.filter((item) => item.type === "directory")) {
        const prior = manifest.before.entries.find((item) => item.path === entry.path);
        chmodSync(contained(worktree, entry.path), prior.mode);
      }
      if (inspectTree(worktree).digest !== manifest.before.digest) throw new Error("rollback mismatch");
      return { ok: false, reason: `restore-failed: ${error.message}`, safeToRun: true };
    } catch (rollbackError) {
      return {
        ok: false,
        reason: `restore-failed: ${error.message}; rollback-failed: ${rollbackError.message}`,
        safeToRun: false,
      };
    }
  } finally {
    rmSync(transaction, { recursive: true, force: true });
  }
}

function cacheEvidence(outcome, key, reason, { restored = false, stored = false } = {}) {
  return {
    schema: CACHE_SCHEMA,
    outcome,
    key,
    reason,
    restored,
    stored,
  };
}

function withEvidence(result, evidence) {
  return { ...result, cache: evidence };
}

function cachedResult(manifest, key, elapsedMs) {
  return {
    ...manifest.result,
    commands: manifest.result.commands.map((command) => ({ ...command, cached: true })),
    startedAt: new Date().toISOString(),
    elapsedMs,
    cache: cacheEvidence("hit", key, "snapshot-restored", {
      restored: true,
      stored: true,
    }),
  };
}

/**
 * Reuse a complete setup overlay inside one private run. Every hit is copied
 * into the destination worktree; no mutable cache files are shared.
 */
export function runSetupWithCache({
  worktree,
  cacheRoot,
  plan,
  revision,
  environment = {},
  runSetup,
}) {
  const key = createSetupCacheKey({ plan, revision, environment });
  const cachePath = join(cacheRoot, key);
  const pristine = pristineAtRevision(worktree, revision);
  let before = null;
  if (pristine.ok) {
    try {
      before = inspectTree(worktree);
    } catch (error) {
      if (!(error instanceof UnsupportedTreeError)) throw error;
      return withEvidence(
        runSetup(),
        cacheEvidence("fallback", key, error.message),
      );
    }
  } else {
    return withEvidence(
      runSetup(),
      cacheEvidence("fallback", key, pristine.reason),
    );
  }

  let outcome = "miss";
  let reason = "not-found";
  if (existsSync(cachePath)) {
    const restoreStarted = Date.now();
    try {
      const manifest = readManifest(cachePath, key, revision);
      const restored = restoreSnapshot({ worktree, cacheRoot, cachePath, manifest });
      if (restored.ok) return cachedResult(manifest, key, Date.now() - restoreStarted);
      outcome = "fallback";
      reason = restored.reason;
      if (!restored.safeToRun) {
        return {
          state: "failed",
          commands: [],
          passed: false,
          error: `setup cache restore could not return the worktree to a safe state: ${reason}`,
          cache: cacheEvidence(outcome, key, reason),
        };
      }
    } catch (error) {
      outcome = "fallback";
      reason = `cache-invalid: ${error.message}`;
      rmSync(cachePath, { recursive: true, force: true });
    }
  }

  const setup = runSetup();
  let stored = false;
  if (setup.passed) {
    try {
      if (!setupDidNotMutateGitState(worktree, revision)) {
        outcome = "fallback";
        reason = "setup-mutated-git-state";
      } else {
        const after = inspectTree(worktree);
        const delta = createDelta(before, after);
        stored = storeSnapshot({
          cacheRoot,
          cachePath,
          key,
          revision,
          before,
          after,
          delta,
          setup,
          worktree,
        });
        if (!stored && !existsSync(cachePath)) {
          outcome = "fallback";
          reason = "snapshot-not-stored";
        }
      }
    } catch (error) {
      outcome = "fallback";
      reason = `snapshot-failed: ${error.message}`;
    }
  }
  return withEvidence(setup, cacheEvidence(outcome, key, reason, { stored }));
}
