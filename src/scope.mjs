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
