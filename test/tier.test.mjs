import test from "node:test";
import assert from "node:assert/strict";
import { classifyPaths, globToRegExp, parseTiers } from "../tools/ship-tier.mjs";

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

test("no changes and no tiers file are both safe defaults", () => {
  assert.equal(classifyPaths([], TIERS).tier, 0);
  assert.equal(classifyPaths(["src/x.ts"], parseTiers("")).tier, 1);
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
