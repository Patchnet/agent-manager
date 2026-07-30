import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function installCursor({ project = null, force = false } = {}) {
  const skillsRoot = project
    ? join(resolve(project), ".cursor", "skills")
    : join(homedir(), ".cursor", "skills");
  const skillTarget = project
    ? join(resolve(project), ".cursor", "skills", "agent-manager")
    : join(homedir(), ".cursor", "skills", "agent-manager");
  const prManagerTarget = join(skillsRoot, "pr-manager");
  for (const target of [skillTarget, prManagerTarget]) {
    if (existsSync(target) && !force) {
      throw new Error(`Cursor skill already exists: ${target}; use --force to replace it`);
    }
  }
  mkdirSync(skillsRoot, { recursive: true, mode: 0o700 });
  cpSync(join(PACKAGE_ROOT, "skills", "agent-manager"), skillTarget, { recursive: true, force });
  cpSync(join(PACKAGE_ROOT, "skills", "pr-manager"), prManagerTarget, { recursive: true, force });
  const installed = [skillTarget, prManagerTarget];
  if (project) {
    const ruleTarget = join(resolve(project), ".cursor", "rules", "agent-manager.mdc");
    if (existsSync(ruleTarget) && !force) throw new Error(`Cursor rule already exists: ${ruleTarget}; use --force to replace it`);
    mkdirSync(dirname(ruleTarget), { recursive: true });
    cpSync(join(PACKAGE_ROOT, "integrations", "cursor", "agent-manager.mdc"), ruleTarget, { force });
    installed.push(ruleTarget);
  }
  return { schema: "agent-manager.install.v1", host: "cursor", installed };
}
