import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPaths, globToRegExp, loadTiers, parseTiers, requireTiers } from "../tools/ship-tier.mjs";

const TIERS = parseTiers(`
# comment
default: 1
tier2:
  - "src/db/migrations/**"
  - ".github/**"   # infra
  - "**/*billing*"
tier0:
  - docs/**
  - "**/*.md"
  - 'tests/**'
`);

test("a tiers file parses into default, tier0, and tier2 patterns", () => {
  assert.equal(TIERS.default, 1);
  assert.deepEqual(TIERS.tier2, ["src/db/migrations/**", ".github/**", "**/*billing*"]);
  assert.deepEqual(TIERS.tier0, ["docs/**", "**/*.md", "tests/**"]);
});

test("each path takes the highest matching tier and the change takes the highest path", () => {
  assert.equal(classifyPaths(["docs/guide.md", "tests/a.test.ts"], TIERS).tier, 0);
  assert.equal(classifyPaths(["docs/guide.md", "src/app/page.tsx"], TIERS).tier, 1);
  const risky = classifyPaths(["README.md", "src/lib/billing-ledger.ts"], TIERS);
  assert.equal(risky.tier, 2);
  assert.deepEqual(risky.files.find((file) => file.tier === 2), {
    path: "src/lib/billing-ledger.ts", tier: 2, pattern: "**/*billing*",
  });
  // tier2 beats tier0 for the same path.
  assert.equal(classifyPaths(["src/db/migrations/README.md"], TIERS).tier, 2);
});

test("the tiers file itself is always tier 2, so a change cannot lower its own tier", () => {
  const permissive = parseTiers("default: 0\n");
  assert.equal(classifyPaths([".github/ship-tiers.yml"], permissive).tier, 2);
  assert.equal(classifyPaths(["anything.txt"], permissive).tier, 0);
});

test("a change with no paths is tier 0", () => {
  assert.equal(classifyPaths([], TIERS).tier, 0);
});

test("a missing or empty policy stops instead of defaulting to tier 1", () => {
  assert.throws(() => requireTiers(null), /no \.github\/ship-tiers\.yml: stop and ask the operator/);
  assert.throws(() => requireTiers(""), /is empty: stop and ask the operator/);
  assert.throws(() => requireTiers("# only a comment\n\n"), /is empty/);
  assert.equal(requireTiers("default: 1\n").default, 1, "one explicit key is a policy");
  assert.deepEqual(requireTiers("tier2:\n  - \"src/**\"\n").tier2, ["src/**"]);
});

test("loadTiers and the vendored CLI stop on a missing, empty, or malformed policy", () => {
  const repo = mkdtempSync(join(tmpdir(), "tier-policy-"));
  const cli = join(import.meta.dirname, "..", "tools", "ship-tier.mjs");
  const classify = () => spawnSync(process.execPath, [cli, "--stdin"], { cwd: repo, input: "src/x.ts\n", encoding: "utf8", windowsHide: true });
  try {
    assert.throws(() => loadTiers(repo), /stop and ask the operator/);
    assert.equal(classify().status, 2);
    mkdirSync(join(repo, ".github"));
    writeFileSync(join(repo, ".github", "ship-tiers.yml"), "# nothing yet\n");
    assert.equal(classify().status, 2);
    writeFileSync(join(repo, ".github", "ship-tiers.yml"), "default: 9\n");
    assert.equal(classify().status, 2);
    writeFileSync(join(repo, ".github", "ship-tiers.yml"), "default: 1\n");
    const ok = classify();
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /^tier 1/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the agent-manager tier command stops without a policy", () => {
  const repo = mkdtempSync(join(tmpdir(), "tier-cli-"));
  const bin = join(import.meta.dirname, "..", "bin", "agent-manager.mjs");
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo], { windowsHide: true });
    const result = spawnSync(process.execPath, [bin, "tier", "--repo", repo, "--base", "HEAD"], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stop and ask the operator/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the tier-gate template refuses an empty policy before it classifies", () => {
  const template = readFileSync(join(import.meta.dirname, "..", "templates", "github", "tier-gate.yml"), "utf8");
  assert.ok(
    template.indexOf("grep -qE '^(default|tier0|tier2):'") < template.indexOf("node .github/scripts/ship-tier.mjs --base"),
    "an older vendored classifier must not see an empty policy",
  );
  assert.match(template, /::error::No usable \.github\/ship-tiers\.yml/);
});

test("glob semantics: * stays in a segment, ** spans any depth", () => {
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/lib/a.ts"));
  assert.ok(globToRegExp("src/**/a.ts").test("src/a.ts"));
  assert.ok(globToRegExp("src/**/a.ts").test("src/x/y/a.ts"));
  assert.ok(globToRegExp("**/*.md").test("README.md"));
  assert.ok(!globToRegExp("docs/a.md").test("docs/aXmd"), "dots are literal");
});

test("malformed tiers files fail loudly instead of defaulting", () => {
  assert.throws(() => parseTiers("default: 3\n"), /default must be 0, 1, or 2/);
  assert.throws(() => parseTiers("tier2: src/**\n"), /own "- " lines/);
  assert.throws(() => parseTiers("tier1:\n  - x\n"), /expected default, tier0, tier2/);
});
