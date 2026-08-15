import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_MODELS_CACHE_FILE,
  codexHomeDir,
  codexModelsCachePath,
  inspectCodexModelsCache,
} from "../src/harness/codex.mjs";
import { formatDoctor, runDoctor } from "../src/doctor.mjs";

const WIN_ENV = { USERPROFILE: "C:\\Users\\operator", LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local" };
const POSIX_ENV = { HOME: "/home/operator" };

// Shape codex writes; only `base_instructions` is load-bearing for the check.
const HEALTHY = {
  updated_at: "2026-08-15T00:00:00Z",
  models: [
    { slug: "gpt-5", base_instructions: "You are a coding agent.", context_window: 400_000 },
    { slug: "gpt-5-codex", base_instructions: "You are a coding agent.", context_window: 400_000 },
  ],
};

function withCache(contents) {
  const home = mkdtempSync(join(tmpdir(), "am-codex-home-"));
  if (contents !== null) {
    writeFileSync(join(home, CODEX_MODELS_CACHE_FILE), contents, "utf8");
  }
  return home;
}

test("models cache path follows CODEX_HOME, then the per-platform home", () => {
  assert.equal(codexHomeDir({ env: WIN_ENV, platform: "win32" }), "C:\\Users\\operator\\.codex");
  assert.equal(codexHomeDir({ env: POSIX_ENV, platform: "linux" }), "/home/operator/.codex");
  assert.equal(
    codexHomeDir({ env: { ...POSIX_ENV, CODEX_HOME: "/srv/codex" }, platform: "linux" }),
    "/srv/codex",
  );
  assert.equal(codexHomeDir({ env: {}, platform: "linux" }), null);

  assert.equal(
    codexModelsCachePath({ env: WIN_ENV, platform: "win32" }),
    "C:\\Users\\operator\\.codex\\models_cache.json",
  );
  assert.equal(
    codexModelsCachePath({ env: POSIX_ENV, platform: "linux" }),
    "/home/operator/.codex/models_cache.json",
  );
  assert.equal(codexModelsCachePath({ env: {}, platform: "linux" }), null);
});

test("an absent or unresolvable cache is healthy — codex regenerates it on demand", () => {
  const home = withCache(null);
  try {
    const absent = inspectCodexModelsCache({ env: { CODEX_HOME: home }, platform: process.platform });
    assert.equal(absent.ok, true);
    assert.equal(absent.state, "absent");
    assert.equal(absent.recommendation, null);

    const skipped = inspectCodexModelsCache({ env: {}, platform: "linux" });
    assert.equal(skipped.ok, true);
    assert.equal(skipped.state, "skipped");
    assert.equal(skipped.path, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a well-formed cache passes wherever base_instructions lives", () => {
  const nested = { providers: { openai: { models: { "gpt-5": { base_instructions: "..." } } } } };
  for (const contents of [HEALTHY, nested]) {
    const home = withCache(JSON.stringify(contents));
    try {
      const result = inspectCodexModelsCache({ env: { CODEX_HOME: home }, platform: process.platform });
      assert.equal(result.ok, true);
      assert.equal(result.state, "healthy");
      assert.equal(result.recommendation, null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("a corrupt cache is reported with a rename-aside fix, never a delete", () => {
  const cases = [
    { name: "truncated json", contents: '{"models": [{"slug": "gpt-5"', state: "invalid-json" },
    { name: "not an object", contents: "[]", state: "invalid-json" },
    // The exact production symptom: `failed to load models cache: missing
    // field base_instructions` on every codex lane.
    { name: "missing base_instructions", contents: JSON.stringify({ models: [{ slug: "gpt-5" }] }), state: "missing-fields" },
  ];

  for (const { name, contents, state } of cases) {
    const home = withCache(contents);
    try {
      const result = inspectCodexModelsCache({ env: { CODEX_HOME: home }, platform: process.platform });
      assert.equal(result.ok, false, name);
      assert.equal(result.state, state, name);
      assert.ok(result.detail.includes(home), `${name}: detail names the file`);
      assert.match(result.recommendation, /rename|Rename-Item|mv /i, name);
      assert.ok(
        !/(?:^|\s)(?:rm|del|Remove-Item)\s/.test(result.recommendation),
        `${name}: never recommends deletion`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  const home = withCache(JSON.stringify({ models: [{ slug: "gpt-5" }] }));
  try {
    const missing = inspectCodexModelsCache({ env: { CODEX_HOME: home }, platform: process.platform });
    assert.deepEqual(missing.missingFields, ["base_instructions"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unreadable cache is reported instead of crashing the doctor", () => {
  const result = inspectCodexModelsCache({
    env: { CODEX_HOME: "/srv/codex" },
    platform: "linux",
    exists: () => true,
    readFile: () => {
      throw new Error("EACCES: permission denied");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, "unreadable");
  assert.match(result.detail, /EACCES/);
});

test("doctor warns on a corrupt cache without failing the overall check", () => {
  const home = withCache(JSON.stringify({ models: [{ slug: "gpt-5" }] }));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const result = runDoctor({ repo: process.cwd() });
    const check = result.checks.find((entry) => entry.name === "codex models cache");
    assert.ok(check, "doctor reports the codex models cache");
    assert.equal(check.ok, false);
    assert.equal(check.optional, true, "a degraded cache must not gate readiness");
    assert.equal(check.state, "missing-fields");

    // Optional checks never enter coreReady, so `ok` tracks the rest of the run.
    const core = result.checks.filter((entry) => !entry.optional).every((entry) => entry.ok);
    const harness = result.checks.filter((entry) => entry.harness).some((entry) => entry.ok);
    assert.equal(result.ok, core && harness);

    const rendered = formatDoctor(result);
    assert.match(rendered, /WARN {2}codex models cache: .*missing field base_instructions/);
    assert.match(rendered, /fix: .*so codex regenerates it/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
