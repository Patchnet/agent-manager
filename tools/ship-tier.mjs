#!/usr/bin/env node
// Deterministic ship tier for a change, from file paths only. Zero dependencies,
// so a repository can vendor this one file into its CI.
//
//   node ship-tier.mjs [--base origin/main] [--head HEAD] [--file .github/ship-tiers.yml] [--json]
//   git diff --name-only origin/main...HEAD | node ship-tier.mjs --stdin
//
// Tiers file (.github/ship-tiers.yml), a strict YAML subset:
//   default: 1
//   tier2:
//     - "src/db/migrations/**"
//   tier0:
//     - "docs/**"
//
// A path takes tier 2 if any tier2 pattern matches, else tier 0 if any tier0
// pattern matches, else `default`. The change's tier is the highest path tier,
// and the tiers file itself is always tier 2.
// Patterns are repository-relative: `*` stays in one segment, `**` spans any.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TIERS_FILE = ".github/ship-tiers.yml";

export function parseTiers(text) {
  const tiers = { default: 1, tier0: [], tier2: [] };
  let list = null;
  for (const [index, raw] of String(text).split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const key = /^(default|tier0|tier2):\s*(.*)$/.exec(line);
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (key) {
      list = null;
      if (key[1] === "default") {
        const value = Number(key[2]);
        if (![0, 1, 2].includes(value)) throw new Error(`ship-tiers line ${index + 1}: default must be 0, 1, or 2`);
        tiers.default = value;
      } else if (key[2].trim() === "" || key[2].trim() === "[]") {
        list = key[2].trim() === "[]" ? null : tiers[key[1]];
      } else {
        throw new Error(`ship-tiers line ${index + 1}: list ${key[1]} items go on their own "- " lines`);
      }
    } else if (item && list) {
      list.push(item[1].trim().replace(/^(["'])(.*)\1$/, "$2"));
    } else {
      throw new Error(`ship-tiers line ${index + 1}: expected default, tier0, tier2, or a "- pattern" item`);
    }
  }
  return tiers;
}

export function loadTiers(repoRoot, file = TIERS_FILE) {
  const path = resolve(repoRoot, file);
  if (!existsSync(path)) return { ...parseTiers(""), missing: true, path };
  return { ...parseTiers(readFileSync(path, "utf8")), missing: false, path };
}

export function globToRegExp(pattern) {
  let source = "";
  const text = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "*" && text[i + 1] === "*") {
      const slash = text[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function classifyPaths(paths, tiers) {
  const tier2 = tiers.tier2.map((pattern) => [pattern, globToRegExp(pattern)]);
  const tier0 = tiers.tier0.map((pattern) => [pattern, globToRegExp(pattern)]);
  const files = [...new Set(paths.map((path) => path.replace(/\\/g, "/")).filter(Boolean))].sort().map((path) => {
    // The policy file can only change at the top tier, so no change lowers its own tier.
    if (path === TIERS_FILE) return { path, tier: 2, pattern: "(tiers file)" };
    const high = tier2.find(([, regex]) => regex.test(path));
    if (high) return { path, tier: 2, pattern: high[0] };
    const low = tier0.find(([, regex]) => regex.test(path));
    if (low) return { path, tier: 0, pattern: low[0] };
    return { path, tier: tiers.default, pattern: null };
  });
  const tier = files.length ? Math.max(...files.map((file) => file.tier)) : 0;
  return { tier, files };
}

/** Changed paths between base and head, counting both sides of a rename. */
export function changedPaths(repoRoot, base, head = "HEAD") {
  const output = execFileSync("git", ["diff", "--name-status", "-M", `${base}...${head}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return output.split(/\r?\n/).filter(Boolean).flatMap((line) => line.split("\t").slice(1));
}

function main(argv) {
  const option = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const repoRoot = process.cwd();
  const tiers = loadTiers(repoRoot, option("--file", TIERS_FILE));
  const paths = argv.includes("--stdin")
    ? readFileSync(0, "utf8").split(/\r?\n/)
    : changedPaths(repoRoot, option("--base", "origin/main"), option("--head", "HEAD"));
  const result = { ...classifyPaths(paths, tiers), tiersFile: tiers.missing ? null : TIERS_FILE };
  if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`tier ${result.tier}${tiers.missing ? ` (no ${TIERS_FILE}; default 1 for every path)` : ""}`);
    for (const file of result.files) console.log(`  ${file.tier}  ${file.path}${file.pattern ? `  (${file.pattern})` : ""}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

