import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_MANAGER_VERSION } from "./version.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const INSTALL_MARKER = ".agent-manager-install.json";

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

export function bundledSkillDigest(skill) {
  if (!INSTALLED_SKILLS.includes(skill)) throw new Error("unknown managed skill");
  return contentDigest(join(PACKAGE_ROOT, "skills", skill));
}

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
    version: AGENT_MANAGER_VERSION,
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
    const sourceDigest = contentDigest(source);
    const targetDigest = contentDigest(target);
    if (sourceDigest === targetDigest) {
      return { source, target, kind, action: "unchanged" };
    }
    const marker = readInstallMarker(target);
    if (marker?.contentDigest === targetDigest) {
      return { source, target, kind, action: "updated" };
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
  if (action !== "unchanged") {
    if (["replaced", "updated"].includes(action)) rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(source, target, { recursive: true, force: true });
  }
  if (kind === "skill") writeInstallMarker(target);
  return { kind, path: target, action, version: kind === "skill" ? AGENT_MANAGER_VERSION : null };
}

export function contentDigest(root) {
  const hash = createHash("sha256");
  const visit = (path, relativePath = "") => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      hash.update(`d:${relativePath}\n`);
      for (const entry of readdirSync(path).sort()) {
        if (entry === INSTALL_MARKER) continue;
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

function writeInstallMarker(target) {
  const marker = {
    schema: "agent-manager.skill-install.v1",
    version: AGENT_MANAGER_VERSION,
    contentDigest: contentDigest(target),
  };
  writeFileSync(join(target, INSTALL_MARKER), JSON.stringify(marker, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function readInstallMarker(target) {
  try {
    const marker = JSON.parse(readFileSync(join(target, INSTALL_MARKER), "utf8"));
    return marker?.schema === "agent-manager.skill-install.v1" ? marker : null;
  } catch {
    return null;
  }
}
