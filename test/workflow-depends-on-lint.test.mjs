import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-lint-"));
process.env.AGENT_MANAGER_DEV_ROOT = root;
process.env.AGENT_MANAGER_RUNS_ROOT = join(root, "runs");
process.env.AGENT_MANAGER_CLAIMS_ROOT = join(root, "claims");

test.after(() => rmSync(root, { recursive: true, force: true }));

const { loadWorkflow } = await import("../src/workflow.mjs?depends-on-lint-test");

let counter = 0;

/** A fixture repo plus a workflow that points at it, loaded through the real loader. */
function load(files, lanes, overrides = {}) {
  counter += 1;
  const repo = join(root, `repo-${counter}`);
  for (const [path, contents] of Object.entries(files)) {
    const abs = join(repo, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  mkdirSync(repo, { recursive: true });
  const workflowPath = join(root, `workflow-${counter}.json`);
  writeFileSync(workflowPath, JSON.stringify({
    repo: `repo-${counter}`,
    integrate: true,
    lanes: lanes.map((lane) => ({ prompt: "work", ...lane })),
    ...overrides,
  }));
  return loadWorkflow(workflowPath);
}

const CORE_LANE = { id: "core", scope: "src/core/**" };
const UI_LANE = { id: "ui", scope: "src/ui/**" };

const CROSSING_TREE = {
  "src/core/product-ref.mjs": "export const productRef = () => \"ref\";\n",
  "src/ui/panel.mjs": [
    "import { render } from \"./widget.mjs\";",
    "import { productRef } from \"../core/product-ref.mjs\";",
    "",
    "export const panel = () => render(productRef());",
  ].join("\n"),
  "src/ui/widget.mjs": "export const render = (value) => value;\n",
};

test("a crossing import without depends_on warns and names the importing file", () => {
  const workflow = load(CROSSING_TREE, [UI_LANE, CORE_LANE]);

  assert.equal(workflow.lint_warnings.length, 1);
  const [warning] = workflow.lint_warnings;
  assert.equal(warning.type, "missing-depends-on");
  assert.equal(warning.lane, "ui");
  assert.equal(warning.dependency, "core");
  assert.equal(warning.file, "src/ui/panel.mjs");
  assert.equal(warning.line, 2, "the line of the crossing import, not the in-scope one");
  assert.equal(warning.specifier, "../core/product-ref.mjs");
  assert.equal(warning.target, "src/core/product-ref.mjs");
  assert.equal(warning.crossings, 1);
  assert.match(warning.message, /lane "ui" imports from lane "core" scope without depends_on/);
  assert.match(warning.message, /src\/ui\/panel\.mjs:2/);
  assert.match(warning.message, /depends_on: \[core\]/);
});

test("the advisory never fails the load", () => {
  const workflow = load(CROSSING_TREE, [UI_LANE, CORE_LANE]);
  assert.equal(workflow.lanes.length, 2, "the workflow still loads with a crossing edge");
});

test("a declared depends_on silences the warning", () => {
  const workflow = load(CROSSING_TREE, [{ ...UI_LANE, depends_on: ["core"] }, CORE_LANE]);
  assert.equal(
    workflow.lint_warnings.some((warning) => warning.type === "missing-depends-on"),
    false,
  );
});

test("a transitive depends_on silences the warning", () => {
  const workflow = load(
    { ...CROSSING_TREE, "src/api/route.mjs": "export const route = () => null;\n" },
    [
      { ...UI_LANE, depends_on: ["api"] },
      { id: "api", scope: "src/api/**", depends_on: ["core"] },
      CORE_LANE,
    ],
  );
  assert.equal(
    workflow.lint_warnings.some((warning) => warning.type === "missing-depends-on"),
    false,
  );
});

test("disjoint scopes with no import edge stay silent", () => {
  const workflow = load(
    {
      "src/core/product-ref.mjs": "export const productRef = () => \"ref\";\n",
      "src/ui/panel.mjs": "import { render } from \"./widget.mjs\";\nexport const panel = render;\n",
      "src/ui/widget.mjs": "export const render = (value) => value;\n",
    },
    [UI_LANE, CORE_LANE],
  );
  assert.deepEqual(workflow.lint_warnings, []);
});

test("package and alias specifiers are not crossing edges", () => {
  const workflow = load(
    {
      "src/core/product-ref.mjs": "export const productRef = () => \"ref\";\n",
      "src/ui/panel.mjs": [
        "import YAML from \"yaml\";",
        "import { core } from \"@scope/core\";",
        "import { alias } from \"#internal/core\";",
        "export const panel = () => [YAML, core, alias];",
      ].join("\n"),
    },
    [UI_LANE, CORE_LANE],
  );
  assert.deepEqual(workflow.lint_warnings, []);
});

test("review and read-only lanes are not part of the pairing", () => {
  const readOnly = load(CROSSING_TREE, [
    { ...UI_LANE, permission_mode: "readOnly" },
    CORE_LANE,
  ]);
  assert.deepEqual(readOnly.lint_warnings, [], "a read-only importer cannot race the seam");

  const review = load(CROSSING_TREE, [
    UI_LANE,
    { ...CORE_LANE, kind: "review", permission_mode: "readOnly" },
  ]);
  assert.deepEqual(review.lint_warnings, [], "a review lane owns no writable scope to depend on");
});

test("dynamic import and require are read as crossing edges", () => {
  for (const line of [
    "const mod = await import(\"../core/product-ref.mjs\");",
    "const mod = require(\"../core/product-ref.mjs\");",
  ]) {
    const workflow = load(
      { ...CROSSING_TREE, "src/ui/panel.mjs": `${line}\nexport const panel = mod;\n` },
      [UI_LANE, CORE_LANE],
    );
    assert.equal(workflow.lint_warnings.length, 1, line);
    assert.equal(workflow.lint_warnings[0].dependency, "core");
  }
});

test("extensionless and directory-index specifiers resolve against the tree", () => {
  const workflow = load(
    {
      "src/core/index.mjs": "export const core = 1;\n",
      "src/core/helpers.mjs": "export const help = 1;\n",
      "src/ui/panel.mjs": [
        "import { core } from \"../core\";",
        "import { help } from \"../core/helpers\";",
        "export const panel = () => [core, help];",
      ].join("\n"),
    },
    [UI_LANE, CORE_LANE],
  );
  assert.equal(workflow.lint_warnings.length, 1, "one warning per lane pair");
  assert.equal(workflow.lint_warnings[0].crossings, 2, "both edges are counted");
  assert.match(workflow.lint_warnings[0].message, /and 1 more crossing import\b/);
});

test("a crossing import into a file the other lane has yet to create still warns", () => {
  const workflow = load(
    {
      "src/core/existing.mjs": "export const existing = 1;\n",
      "src/ui/panel.mjs": "import { planned } from \"../core/planned.mjs\";\nexport const panel = planned;\n",
    },
    [UI_LANE, CORE_LANE],
  );
  assert.equal(workflow.lint_warnings.length, 1);
  assert.equal(workflow.lint_warnings[0].target, "src/core/planned.mjs");
});

test("each direction of a mutual seam is reported separately", () => {
  const workflow = load(
    {
      "src/core/product-ref.mjs": "import { render } from \"../ui/widget.mjs\";\nexport const productRef = render;\n",
      "src/ui/widget.mjs": "import { productRef } from \"../core/product-ref.mjs\";\nexport const render = productRef;\n",
    },
    [UI_LANE, CORE_LANE],
  );
  assert.deepEqual(
    workflow.lint_warnings.map((warning) => `${warning.lane}->${warning.dependency}`).sort(),
    ["core->ui", "ui->core"],
  );
});

test("non-source files inside a lane scope are not scanned", () => {
  const workflow = load(
    {
      "src/core/product-ref.mjs": "export const productRef = () => \"ref\";\n",
      "src/ui/notes.md": "import { productRef } from \"../core/product-ref.mjs\";\n",
      "src/ui/panel.mjs": "export const panel = () => null;\n",
    },
    [UI_LANE, CORE_LANE],
  );
  assert.deepEqual(workflow.lint_warnings, []);
});

test("a single writable lane is never linted", () => {
  const workflow = load(
    CROSSING_TREE,
    [UI_LANE, { ...CORE_LANE, kind: "review", permission_mode: "read-only" }],
    { integrate: false },
  );
  assert.deepEqual(workflow.lint_warnings, []);
});
