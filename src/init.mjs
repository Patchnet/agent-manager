import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import YAML from "yaml";
import { writePrivateFile } from "./fs-safe.mjs";

export function initWorkflow({ repo = process.cwd(), output = "agent-manager.yaml", request = "Implement the requested change", harnesses = ["claude", "codex"] } = {}) {
  const target = resolve(repo, output);
  if (existsSync(target)) throw new Error(`refusing to overwrite existing workflow: ${target}`);
  const selected = [...new Set(harnesses)].slice(0, 3);
  if (!selected.length) throw new Error("at least one harness is required");
  const lanes = selected.map((harness, index) => ({
    id: index === 0 ? "implementation" : index === 1 ? "docs-review" : `lane-${index + 1}`,
    harness,
    scope: index === 0 ? ["src/**", "test/**"] : index === 1 ? ["docs/**", "README.md"] : ["examples/**"],
    prompt: index === 0 ? request : `Review and improve the ${index === 1 ? "documentation" : "examples"} for: ${request}`,
  }));
  const workflow = {
    repo: ".",
    claim_mode: "auto",
    integrate: false,
    policy: { allow_commit: false, allow_pr: false, permission_mode: "acceptEdits" },
    lanes,
  };
  writePrivateFile(target, YAML.stringify(workflow), "utf8");
  return { path: target, workflow };
}
