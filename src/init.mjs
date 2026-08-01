import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import YAML from "yaml";
import { DEFAULT_MAX_CONCURRENCY, MAX_LANES } from "./constants.mjs";
import { writePrivateFile } from "./fs-safe.mjs";
import { assertPathInside } from "./paths.mjs";
import { resolveGitRef } from "./worktree.mjs";

export function initWorkflow({ repo = process.cwd(), output = "agent-manager.yaml", request = "Implement the requested change", harnesses = ["claude", "codex"] } = {}) {
  const target = resolve(repo, output);
  assertPathInside(repo, target, "workflow output");
  if (existsSync(target)) throw new Error(`refusing to overwrite existing workflow: ${target}`);
  const contextTarget = resolve(repo, "agent-manager.context.md");
  assertPathInside(repo, contextTarget, "planning context output");
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
    base_ref: "HEAD",
    claim_mode: "auto",
    max_concurrency: Math.min(DEFAULT_MAX_CONCURRENCY, lanes.length),
    integrate: true,
    policy: { allow_commit: false, allow_pr: false, permission_mode: "acceptEdits" },
    planning: {
      source_refs: ["replace-with-source-reference"],
      plan_ref: "replace-with-approved-plan-reference",
      context_file: relative(repo, contextTarget).replace(/\\/g, "/"),
      reviewed_base_sha: resolveGitRef(repo, "HEAD"),
      verified_by: "replace-with-manager-agent",
      verified_at: new Date().toISOString(),
      reviewed_paths: ["replace-with-reviewed-paths"],
      repository_instruction_refs: ["replace-with-reviewed-instruction-files"],
      attestations: {
        source_reviewed: false,
        repository_instructions_reviewed: false,
        relevant_code_reviewed: false,
        scope_verified: false,
      },
    },
    lanes,
  };
  if (!existsSync(contextTarget)) {
    writePrivateFile(contextTarget, [
      "# Shared planning context",
      "",
      `## Objective\n\n${request}`,
      "",
      "## Accepted decisions",
      "",
      "- Replace with the decisions every lane must follow.",
      "",
      "## Non-goals",
      "",
      "- Replace with work that is explicitly out of scope.",
      "",
      "## Contracts and constraints",
      "",
      "- Replace with repository instructions, interfaces, and ownership boundaries.",
      "",
      "## Validation",
      "",
      "- Replace with the commands and acceptance criteria for the completed run.",
      "",
    ].join("\n"), "utf8");
  }
  writePrivateFile(target, YAML.stringify(workflow), "utf8");
  return { path: target, contextPath: contextTarget, planningReady: false, workflow };
}
