import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Directories a lane scope never means to describe. Walking them turns a scoped
// lint into a full-tree crawl.
const UNSCANNED_DIRECTORIES = new Set([
  ".git", ".claims", ".runs", ".agent-manager", ".next", "node_modules",
  "build", "coverage", "dist", "out",
]);
const IMPORT_EXTENSIONS = [
  ".mjs", ".js", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", ".json",
];

export function normalizeScopePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

export function matchesScope(file, rawPattern) {
  const value = normalizeScopePath(file);
  const pattern = normalizeScopePath(rawPattern);
  if (!pattern) return false;
  if (!/[?*[]/.test(pattern)) {
    return value === pattern || value.startsWith(pattern + "/");
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

export function scopePrefix(rawPattern) {
  const pattern = normalizeScopePath(rawPattern);
  const wildcard = pattern.search(/[?*[]/);
  const prefix = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
  return prefix.replace(/\/+$/, "");
}

export function scopesMayOverlap(left, right) {
  const a = normalizeScopePath(left);
  const b = normalizeScopePath(right);
  if (!a || !b) return true;
  if (a === b) return true;

  const aHasGlob = /[?*[]/.test(a);
  const bHasGlob = /[?*[]/.test(b);
  if (!aHasGlob && !bHasGlob) {
    return a.startsWith(b + "/") || b.startsWith(a + "/");
  }
  if (!aHasGlob && matchesScope(a, b)) return true;
  if (!bHasGlob && matchesScope(b, a)) return true;

  const aPrefix = scopePrefix(a);
  const bPrefix = scopePrefix(b);
  if (!aPrefix || !bPrefix) return true;
  return (
    aPrefix === bPrefix ||
    aPrefix.startsWith(bPrefix + "/") ||
    bPrefix.startsWith(aPrefix + "/")
  );
}

export function scopeConflictWitness(left, right) {
  const a = normalizeScopePath(left);
  const b = normalizeScopePath(right);
  if (a === b) return a;
  const aPrefix = scopePrefix(a);
  const bPrefix = scopePrefix(b);
  if (aPrefix && bPrefix) {
    if (aPrefix.startsWith(bPrefix + "/")) return a;
    if (bPrefix.startsWith(aPrefix + "/")) return b;
  }
  return `${a} <-> ${b}`;
}

/**
 * Repository-relative files that a set of scope patterns actually covers on disk.
 * Walks only the concrete prefix of each pattern, so a lint that reads lane scopes
 * never crawls the whole tree. Missing paths are not an error: a scope may name a
 * file the lane is about to create.
 */
export function listScopedFiles(repoRoot, patterns, { limit = 2_000 } = {}) {
  const scopes = (patterns || []).map((pattern) => normalizeScopePath(pattern)).filter(Boolean);
  if (!scopes.length) return [];
  const prefixes = [...new Set(scopes.map((pattern) => scopePrefix(pattern)))];
  const roots = prefixes.includes("")
    ? [""]
    : prefixes.filter((prefix, _index, all) =>
      !all.some((other) => other !== prefix && prefix.startsWith(other + "/")));
  const files = [];
  const seen = new Set();
  for (const root of roots) {
    if (files.length >= limit) break;
    let stats;
    try {
      stats = statSync(root ? join(repoRoot, root) : repoRoot);
    } catch {
      continue;
    }
    if (stats.isFile()) collectScopedFile(root, scopes, files, seen, limit);
    else if (stats.isDirectory()) walkScopedDirectory(repoRoot, root, scopes, files, seen, limit);
  }
  return files.sort();
}

function walkScopedDirectory(repoRoot, relativePath, scopes, files, seen, limit) {
  let entries;
  try {
    entries = readdirSync(relativePath ? join(repoRoot, relativePath) : repoRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= limit) return;
    const path = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (UNSCANNED_DIRECTORIES.has(entry.name)) continue;
      walkScopedDirectory(repoRoot, path, scopes, files, seen, limit);
      continue;
    }
    if (entry.isFile()) collectScopedFile(path, scopes, files, seen, limit);
  }
}

function collectScopedFile(path, scopes, files, seen, limit) {
  if (files.length >= limit || seen.has(path)) return;
  if (!scopes.some((pattern) => matchesScope(path, pattern))) return;
  seen.add(path);
  files.push(path);
}

/**
 * Repository-relative target of a relative import, or null when the specifier is a
 * package, an alias, or escapes the repository. `exists` answers whether a
 * repository-relative candidate is a real file, which is how extension and
 * directory-index resolution is settled without duplicating Node's algorithm.
 */
export function resolveImportPath(fromFile, specifier, exists = () => false) {
  const raw = String(specifier || "");
  if (!raw.startsWith("./") && !raw.startsWith("../")) return null;
  const cleaned = normalizeScopePath(raw.split("?")[0].split("#")[0]);
  if (!cleaned) return null;
  const stack = normalizeScopePath(fromFile).split("/").slice(0, -1).filter(Boolean);
  for (const segment of cleaned.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!stack.length) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (!stack.length) return null;
  const target = stack.join("/");
  const candidates = [
    target,
    ...IMPORT_EXTENSIONS.map((extension) => target + extension),
    ...IMPORT_EXTENSIONS.map((extension) => `${target}/index${extension}`),
  ];
  const resolved = candidates.find((candidate) => exists(candidate));
  if (resolved) return resolved;
  // Unresolvable on disk: keep it only when the specifier already names a file,
  // so a lane that is about to create the target still reads as a crossing edge.
  return IMPORT_EXTENSIONS.some((extension) => target.endsWith(extension)) ? target : null;
}

export function findChangedFileOverlaps(lanes) {
  const owners = new Map();
  for (const lane of lanes || []) {
    for (const file of lane.changedFiles || []) {
      const path = normalizeScopePath(file);
      if (!path) continue;
      if (!owners.has(path)) owners.set(path, []);
      owners.get(path).push(lane.id);
    }
  }
  return [...owners.entries()]
    .filter(([, laneIds]) => new Set(laneIds).size > 1)
    .map(([file, laneIds]) => ({ file, lanes: [...new Set(laneIds)] }))
    .sort((a, b) => a.file.localeCompare(b.file));
}
