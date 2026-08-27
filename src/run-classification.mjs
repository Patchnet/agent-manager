import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalRepoIdentity } from "./brain.mjs";
import { RUNS_ROOT, assertSafeSlug } from "./paths.mjs";

export const RUN_CLASSIFICATIONS = Object.freeze([
  "operational",
  "benchmark",
  "demo",
  "retry",
  "recovery",
]);

export const FLEET_CLASSIFICATIONS = Object.freeze([
  ...RUN_CLASSIFICATIONS,
  "unknown",
]);

const LINEAGE_CLASSIFICATIONS = new Set(["retry", "recovery"]);

export function normalizeClassification(value, {
  defaultValue = "operational",
  allowUnknown = false,
  label = "classification",
} = {}) {
  const classification = String(value ?? defaultValue).trim().toLowerCase();
  const allowed = allowUnknown ? FLEET_CLASSIFICATIONS : RUN_CLASSIFICATIONS;
  if (!allowed.includes(classification)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return classification;
}

export function classificationForRecord(record) {
  const value = record?.classification;
  return RUN_CLASSIFICATIONS.includes(value) ? value : "unknown";
}

export function normalizeRunContract({
  classification = undefined,
  parentRunId = undefined,
} = {}, {
  defaultClassification = "operational",
} = {}) {
  const normalizedClassification = normalizeClassification(classification, {
    defaultValue: defaultClassification,
    label: "run classification",
  });
  const normalizedParent = parentRunId == null || String(parentRunId).trim() === ""
    ? null
    : assertSafeSlug(String(parentRunId).trim(), "parent run id");

  if (LINEAGE_CLASSIFICATIONS.has(normalizedClassification) && !normalizedParent) {
    throw new Error(`${normalizedClassification} runs require a valid local parent run ID`);
  }
  if (!LINEAGE_CLASSIFICATIONS.has(normalizedClassification) && normalizedParent) {
    throw new Error(`${normalizedClassification} runs cannot declare retry or recovery lineage`);
  }

  return {
    classification: normalizedClassification,
    lineage: normalizedParent
      ? { parentRunId: normalizedParent, relationship: normalizedClassification }
      : null,
  };
}

export function validateRunLineage(contract, {
  repoRoot,
  remote = "origin",
  runsRoot = RUNS_ROOT,
} = {}) {
  if (!contract?.lineage) return contract;
  const parentRunId = contract.lineage.parentRunId;
  const statusPath = join(resolve(runsRoot), parentRunId, "status.json");
  if (!existsSync(statusPath)) {
    throw new Error(`${contract.classification} parent run not found locally: ${parentRunId}`);
  }
  let parent;
  try {
    parent = JSON.parse(readFileSync(statusPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read parent run ${parentRunId}: ${error.message}`);
  }
  if (parent?.runId !== parentRunId) {
    throw new Error(`parent run status does not match requested run ID: ${parentRunId}`);
  }

  const currentRepo = canonicalRepoIdentity(repoRoot, { remote });
  let parentRepoKey = parent?.awareness?.repoKey || null;
  if (!parentRepoKey && parent?.repoRoot) {
    parentRepoKey = canonicalRepoIdentity(parent.repoRoot, { remote: parent.remote || "origin" }).key;
  }
  if (!parentRepoKey || parentRepoKey !== currentRepo.key) {
    throw new Error(
      `${contract.classification} parent ${parentRunId} must belong to the same canonical repository`,
    );
  }

  return { ...contract, parent };
}

export function resolveRunContract(workflow, overrides = {}, options = {}) {
  const contract = normalizeRunContract({
    classification: overrides.classification ?? workflow.classification,
    parentRunId: overrides.parentRunId ?? workflow.parent_run_id,
  });
  return validateRunLineage(contract, {
    repoRoot: workflow.repoRoot,
    remote: workflow.remote,
    ...options,
  });
}
