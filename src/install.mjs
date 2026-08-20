import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Each supported host reads skills from <root>/skills/<name>. Ship Gate is
// deliberately absent: approval policy belongs to the target repository, not
// to the orchestration runtime.
export const HOSTS = {
  claude: { label: "Claude Code", dir: ".claude" },
  codex: { label: "Codex", dir: ".codex" },
  cursor: {
    label: "Cursor",
    dir: ".cursor",
    rule: join("integrations", "cursor", "agent-manager.mdc"),
  },
};

export const INSTALLED_SKILLS = ["agent-manager", "pr-manager"];

export function hostNames() {
  return Object.keys(HOSTS);
}

/** Where a host looks for user-level skills. Exported so Doctor can inspect it. */
export function hostSkillsRoot(host, { home = homedir() } = {}) {
  const spec = requireHost(host);
  return join(resolve(home), spec.dir, "skills");
}

/**
 * Install the bundled operator skills for one host.
 *
 * Existing byte-identical files are reported as unchanged, which makes the
 * command safely repeatable. A locally modified target fails closed unless the
 * operator explicitly uses --force.
 */
export function installHost(host, {
  project = null,
  force = false,
  home = homedir(),
} = {}) {
  const spec = requireHost(host);
  const hostRoot = project ? join(resolve(project), spec.dir) : join(resolve(home), spec.dir);
  const skillsRoot = join(hostRoot, "skills");
  const managed = INSTALLED_SKILLS.map((skill) => ({
    source: join(PACKAGE_ROOT, "skills", skill),
    target: join(skillsRoot, skill),
    kind: "skill",
  }));

  if (project && spec.rule) {
    managed.push({
      source: join(PACKAGE_ROOT, spec.rule),
      target: join(hostRoot, "rules", "agent-manager.mdc"),
      kind: "rule",
    });
  }

  // Validate every target before writing any of them. A modified second skill
  // must not leave a surprise partial install of the first one.
  const plan = managed.map((item) => planManagedPath({ ...item, force }));
  mkdirSync(skillsRoot, { recursive: true, mode: 0o700 });
  const results = plan.map(applyManagedPath);

  return {
    schema: "agent-manager.install.v1",
    host,
    label: spec.label,
    scope: project ? "project" : "user",
    root: hostRoot,
    installed: results.map((item) => item.path),
    results,
  };
}

/** Retained for existing callers and the portable-install test. */
export function installCursor(options = {}) {
  return installHost("cursor", options);
}

export function formatInstall(result) {
  return [
    `${result.label} host integration (${result.scope}):`,
    ...result.results.map((item) => `${item.action.padEnd(9)} ${item.path}`),
  ].join("\n");
}

function requireHost(host) {
  const spec = HOSTS[host];
  if (!spec) {
    throw new Error(`unsupported install host: ${host || "(missing)"}; supported: ${hostNames().join(", ")}`);
  }
  return spec;
}

function planManagedPath({ source, target, force, kind }) {
  let action = "installed";
  if (existsSync(target)) {
    if (contentDigest(source) === contentDigest(target)) {
      return { source, target, kind, action: "unchanged" };
    }
    if (!force) {
      throw new Error(
        `${kind} differs from the bundled version: ${target}; ` +
        "review local changes, then rerun with --force to replace it",
      );
    }
    action = "replaced";
  }
  return { source, target, kind, action };
}

function applyManagedPath({ source, target, kind, action }) {
  if (action === "unchanged") return { kind, path: target, action };
  if (action === "replaced") rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  cpSync(source, target, { recursive: true, force: true });
  return { kind, path: target, action };
}

function contentDigest(root) {
  const hash = createHash("sha256");
  const visit = (path, relativePath = "") => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      hash.update(`d:${relativePath}\n`);
      for (const entry of readdirSync(path).sort()) {
        visit(join(path, entry), relative(root, join(path, entry)));
      }
      return;
    }
    if (!stat.isFile()) {
      hash.update(`unsupported:${relativePath}\n`);
      return;
    }
    hash.update(`f:${relativePath}:${stat.mode & 0o111 ? "x" : "-"}\n`);
    hash.update(readFileSync(path));
  };
  visit(root);
  return hash.digest("hex");
}
