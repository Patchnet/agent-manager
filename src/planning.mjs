import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { assertPathInside } from "./paths.mjs";
import { resolveGitRef } from "./worktree.mjs";

const PLANNING_KEYS = new Set([
  "source_refs",
  "plan_ref",
  "context",
  "context_file",
  "reviewed_base_sha",
  "verified_by",
  "verified_at",
  "reviewed_paths",
  "repository_instruction_refs",
  "attestations",
]);

const ATTESTATION_KEYS = [
  "source_reviewed",
  "repository_instructions_reviewed",
  "relevant_code_reviewed",
  "scope_verified",
];

const MAX_CONTEXT_BYTES = 128 * 1024;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function normalizePlanning(input, { repoRoot, contextOverridePath = null } = {}) {
  if (input === undefined) return null;
  if (!isMapping(input)) throw new Error("workflow.planning must be a mapping");
  assertKnownKeys(input, PLANNING_KEYS, "workflow.planning");

  const sourceRefs = stringList(input.source_refs, "workflow.planning.source_refs");
  const reviewedPaths = stringList(input.reviewed_paths, "workflow.planning.reviewed_paths");
  const instructionRefs = stringList(
    input.repository_instruction_refs,
    "workflow.planning.repository_instruction_refs",
  );
  const planRef = nonEmptyString(input.plan_ref, "workflow.planning.plan_ref");
  const verifiedBy = nonEmptyString(input.verified_by, "workflow.planning.verified_by");
  const verifiedAt = nonEmptyString(input.verified_at, "workflow.planning.verified_at");
  if (!ISO_DATE_TIME.test(verifiedAt) || !Number.isFinite(Date.parse(verifiedAt))) {
    throw new Error("workflow.planning.verified_at must be an ISO date-time");
  }

  const reviewedBaseSha = nonEmptyString(
    input.reviewed_base_sha,
    "workflow.planning.reviewed_base_sha",
  ).toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(reviewedBaseSha)) {
    throw new Error("workflow.planning.reviewed_base_sha must be a full Git commit SHA");
  }

  if (input.context !== undefined && input.context_file !== undefined) {
    throw new Error("workflow.planning must use context or context_file, not both");
  }
  let contextBody;
  let contextFile = null;
  let contextPath = null;
  if (contextOverridePath) {
    contextPath = contextOverridePath;
    if (!existsSync(contextPath) || !statSync(contextPath).isFile()) {
      throw new Error(`workflow planning context file not found: ${contextPath}`);
    }
    contextBody = readFileSync(contextPath, "utf8");
    contextFile = "<private-override>";
  } else if (input.context !== undefined) {
    if (typeof input.context !== "string") {
      throw new Error("workflow.planning.context must be a string");
    }
    contextBody = input.context;
    contextFile = "<inline>";
  } else {
    contextFile = nonEmptyString(
      input.context_file,
      "workflow.planning.context_file",
    );
    if (isAbsolute(contextFile) || /\0|[\r\n]/.test(contextFile)) {
      throw new Error("workflow.planning.context_file must be a relative repository path");
    }
    const declaredContextPath = assertPathInside(
      repoRoot,
      resolve(repoRoot, contextFile),
      "workflow.planning.context_file",
    );
    if (!existsSync(declaredContextPath) || !statSync(declaredContextPath).isFile()) {
      throw new Error(`workflow planning context file not found: ${declaredContextPath}`);
    }
    contextPath = assertPathInside(
      realpathSync(repoRoot),
      realpathSync(declaredContextPath),
      "workflow.planning.context_file",
    );
    contextBody = readFileSync(contextPath, "utf8");
    contextFile = relative(repoRoot, declaredContextPath).replace(/\\/g, "/");
  }
  if (!contextBody.trim()) throw new Error("workflow planning context file must not be empty");
  if (Buffer.byteLength(contextBody, "utf8") > MAX_CONTEXT_BYTES) {
    throw new Error(`workflow planning context exceeds ${MAX_CONTEXT_BYTES} bytes`);
  }

  if (!isMapping(input.attestations)) {
    throw new Error("workflow.planning.attestations must be a mapping");
  }
  assertKnownKeys(
    input.attestations,
    new Set(ATTESTATION_KEYS),
    "workflow.planning.attestations",
  );
  const attestations = {};
  for (const key of ATTESTATION_KEYS) {
    if (typeof input.attestations[key] !== "boolean") {
      throw new Error(`workflow.planning.attestations.${key} must be a boolean`);
    }
    attestations[key] = input.attestations[key];
  }

  return {
    source_refs: sourceRefs,
    plan_ref: planRef,
    context_file: contextFile,
    reviewed_base_sha: reviewedBaseSha,
    verified_by: verifiedBy,
    verified_at: new Date(verifiedAt).toISOString(),
    reviewed_paths: reviewedPaths,
    repository_instruction_refs: instructionRefs,
    attestations,
    context_digest: sha256(contextBody),
    _contextBody: contextBody,
    _contextPath: contextPath,
  };
}

export function assertPlanningReady(workflow, baseCommit = null) {
  const planning = workflow.planning;
  if (!planning) {
    throw new Error(
      "workflow planning preflight is required before launch; add workflow.planning",
    );
  }
  const missing = ATTESTATION_KEYS.filter((key) => planning.attestations[key] !== true);
  if (missing.length) {
    throw new Error(
      "workflow planning preflight is incomplete; attest true: " + missing.join(", "),
    );
  }
  const actualBaseSha = (baseCommit || resolveGitRef(workflow.repoRoot, workflow.base_ref))
    .toLowerCase();
  if (planning.reviewed_base_sha !== actualBaseSha) {
    throw new Error(
      `workflow planning base is stale: reviewed ${planning.reviewed_base_sha}, launch resolves ${actualBaseSha}`,
    );
  }
  return planningEvidence(planning, actualBaseSha);
}

export function planningEvidence(planning, actualBaseSha = planning?.reviewed_base_sha) {
  if (!planning) return null;
  return {
    state: "verified",
    sourceRefs: [...planning.source_refs],
    planRef: planning.plan_ref,
    contextFile: planning.context_file,
    contextDigest: planning.context_digest,
    reviewedBaseSha: planning.reviewed_base_sha,
    actualBaseSha,
    verifiedBy: planning.verified_by,
    verifiedAt: planning.verified_at,
    reviewedPaths: [...planning.reviewed_paths],
    repositoryInstructionRefs: [...planning.repository_instruction_refs],
    attestations: { ...planning.attestations },
  };
}

export function planningPrompt(planning) {
  if (!planning) return "";
  return [
    "## Verified shared planning context",
    `- Plan reference: ${planning.plan_ref}`,
    `- Source references: ${planning.source_refs.join(", ")}`,
    `- Reviewed base: ${planning.reviewed_base_sha}`,
    `- Context SHA-256: ${planning.context_digest}`,
    `- Verified by: ${planning.verified_by} at ${planning.verified_at}`,
    `- Reviewed paths: ${planning.reviewed_paths.join(", ")}`,
    `- Repository instructions: ${planning.repository_instruction_refs.join(", ")}`,
    "- This exact frozen context packet is shared by every lane in this run.",
    "",
    "### Shared context packet",
    planning._contextBody.trim(),
  ].join("\n");
}

function stringList(input, label) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return [...new Set(input.map((value) => nonEmptyString(value, `${label} item`)))];
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (/\0|[\r\n]/.test(value)) throw new Error(`${label} contains invalid characters`);
  return value.trim();
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function isMapping(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
