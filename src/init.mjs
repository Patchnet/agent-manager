import { existsSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { DEFAULT_MAX_CONCURRENCY, MAX_LANES } from "./constants.mjs";
import { writePrivateFile } from "./fs-safe.mjs";
import { assertPathInside } from "./paths.mjs";
import { recommendedNodeDependencySetup } from "./workflow.mjs";

export function initWorkflow({ repo = process.cwd(), output = "agent-manager.yaml", request = "Implement the requested change", harnesses = ["claude"] } = {}) {
  const target = resolve(repo, output);
  assertPathInside(repo, target, "workflow output");
  if (existsSync(target)) throw new Error(`refusing to overwrite existing workflow: ${target}`);
  const selected = harnesses.slice(0, MAX_LANES);
  if (!selected.length) throw new Error("at least one harness is required");
  const laneTemplates = [
    { id: "implementation", scope: ["src/**", "test/**"], subject: "implementation" },
    { id: "docs-review", scope: ["docs/**", "README.md"], subject: "documentation" },
    { id: "examples", scope: ["examples/**"], subject: "examples" },
    { id: "tooling", scope: ["scripts/**", "bin/**"], subject: "tooling" },
    { id: "integrations", scope: ["integrations/**"], subject: "integrations" },
  ];
  const lanes = selected.map((harness, index) => ({
    id: laneTemplates[index].id,
    harness,
    scope: laneTemplates[index].scope,
    prompt:
      index === 0
        ? request
        : `Review and improve the ${laneTemplates[index].subject} for: ${request}`,
  }));
  const workflow = {
    repo: ".",
    title: request.length > 120 ? request.slice(0, 119) + "…" : request,
    goal: request,
    base_ref: "HEAD",
    claim_mode: "auto",
    max_concurrency: Math.min(DEFAULT_MAX_CONCURRENCY, lanes.length),
    integrate: true,
    policy: { allow_commit: false, allow_pr: false, permission_mode: "acceptEdits" },
    lanes,
  };
  const dependencySetup = recommendedNodeDependencySetup(repo);
  if (dependencySetup) {
    workflow.verification = {
      setup: {
        commands: dependencySetup.commands,
        timeout_sec: dependencySetup.timeout_sec,
      },
      commands: [{ command: "npm", args: ["test"] }],
      timeout_sec: 900,
    };
  }
  writePrivateFile(target, YAML.stringify(workflow), "utf8");
  return { path: target, workflow };
}
