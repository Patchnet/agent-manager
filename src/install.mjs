import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function installCursor({ project = null, force = false } = {}) {
  const skillTarget = project
    ? join(resolve(project), ".cursor", "skills", "agent-manager")
    : join(homedir(), ".cursor", "skills", "agent-manager");
  if (existsSync(skillTarget) && !force) throw new Error(`Cursor skill already exists: ${skillTarget}; use --force to replace it`);
  mkdirSync(dirname(skillTarget), { recursive: true, mode: 0o700 });
  cpSync(join(PACKAGE_ROOT, "skills", "agent-manager"), skillTarget, { recursive: true, force });
  const installed = [skillTarget];
  if (project) {
    const ruleTarget = join(resolve(project), ".cursor", "rules", "agent-manager.mdc");
    if (existsSync(ruleTarget) && !force) throw new Error(`Cursor rule already exists: ${ruleTarget}; use --force to replace it`);
    mkdirSync(dirname(ruleTarget), { recursive: true });
    cpSync(join(PACKAGE_ROOT, "integrations", "cursor", "agent-manager.mdc"), ruleTarget, { force });
    installed.push(ruleTarget);
  }
  return { schema: "agent-manager.install.v1", host: "cursor", installed };
}
