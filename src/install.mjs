import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Every supported host reads skills from <root>/skills/<name>. Only the root
// differs, so one table covers them. Ship Gate is deliberately absent: approval
// policy belongs to the target repository, not to the orchestration runtime.
export const HOSTS = {
  claude: { label: "Claude Code", dir: ".claude" },
  codex: { label: "Codex CLI", dir: ".codex" },
  cursor: { label: "Cursor", dir: ".cursor", rule: join("integrations", "cursor", "agent-manager.mdc") },
};

export const INSTALLED_SKILLS = ["agent-manager", "pr-manager"];

export function hostNames() {
  return Object.keys(HOSTS);
}

/** Where a host looks for user-level skills. Exported so doctor can check it. */
export function hostSkillsRoot(host, { home = homedir() } = {}) {
  const spec = HOSTS[host];
  if (!spec) throw new Error(`unknown host: ${host}; supported: ${hostNames().join(", ")}`);
  return join(home, spec.dir, "skills");
}

export function installHost(host, { project = null, force = false, home = homedir() } = {}) {
  const spec = HOSTS[host];
  if (!spec) throw new Error(`unknown host: ${host}; supported: ${hostNames().join(", ")}`);
  const skillsRoot = project
    ? join(resolve(project), spec.dir, "skills")
    : hostSkillsRoot(host, { home });
  const targets = INSTALLED_SKILLS.map((skill) => join(skillsRoot, skill));
  for (const target of targets) {
    if (existsSync(target) && !force) {
      throw new Error(`${spec.label} skill already exists: ${target}; use --force to replace it`);
    }
  }
  mkdirSync(skillsRoot, { recursive: true, mode: 0o700 });
  const installed = [];
  for (const skill of INSTALLED_SKILLS) {
    const target = join(skillsRoot, skill);
    cpSync(join(PACKAGE_ROOT, "skills", skill), target, { recursive: true, force });
    installed.push(target);
  }
  // Only Cursor carries a project rule; the others read the skill directly.
  if (project && spec.rule) {
    const ruleTarget = join(resolve(project), spec.dir, "rules", "agent-manager.mdc");
    if (existsSync(ruleTarget) && !force) throw new Error(`${spec.label} rule already exists: ${ruleTarget}; use --force to replace it`);
    mkdirSync(dirname(ruleTarget), { recursive: true });
    cpSync(join(PACKAGE_ROOT, spec.rule), ruleTarget, { force });
    installed.push(ruleTarget);
  }
  return { schema: "agent-manager.install.v1", host, installed };
}

/** Retained so existing callers and docs keep working. */
export function installCursor(options = {}) {
  return installHost("cursor", options);
}
