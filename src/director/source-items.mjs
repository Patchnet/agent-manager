import { dirname, isAbsolute, resolve } from "node:path";
import { normalizeScopePath } from "../scope.mjs";
import {
  assertKnownKeys,
  assertMapping,
  boundedInteger,
  nonEmptyString,
  readDocument,
  sha256,
  stableValue,
  stringArray,
} from "./util.mjs";

const ITEM_KEYS = new Set([
  "schema", "source", "repository", "objective", "acceptance_criteria", "priority",
  "dependencies", "automation_eligible", "labels", "risks", "scope", "planning",
  "goal_refs",
]);
const IMPLEMENTED_PROVIDERS = new Set(["fixture"]);
const SOURCE_KEYS = new Set(["provider", "item_id", "ref"]);
const REPOSITORY_KEYS = new Set(["path", "base_ref", "reviewed_base_sha"]);
const PLANNING_KEYS = new Set([
  "plan_ref", "verified_by", "verified_at", "repository_instruction_refs", "reviewed_paths",
]);

function normalizeItem(item, index, filePath) {
  const label = `Director source item[${index}]`;
  assertMapping(item, label);
  assertKnownKeys(item, ITEM_KEYS, label);
  if (item.schema !== "agent-manager.director-source-item.v1") {
    throw new Error(`${label}.schema must be agent-manager.director-source-item.v1`);
  }

  const source = assertMapping(item.source, `${label}.source`);
  assertKnownKeys(source, SOURCE_KEYS, `${label}.source`);
  const normalizedSource = {
    provider: nonEmptyString(source.provider, `${label}.source.provider`),
    item_id: nonEmptyString(source.item_id, `${label}.source.item_id`),
    ref: nonEmptyString(source.ref, `${label}.source.ref`),
  };

  const repository = assertMapping(item.repository, `${label}.repository`);
  assertKnownKeys(repository, REPOSITORY_KEYS, `${label}.repository`);
  const repositoryPath = nonEmptyString(repository.path, `${label}.repository.path`);
  const reviewedBaseSha = nonEmptyString(repository.reviewed_base_sha, `${label}.repository.reviewed_base_sha`).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(reviewedBaseSha)) {
    throw new Error(`${label}.repository.reviewed_base_sha must be a full 40-character Git SHA`);
  }

  const planning = assertMapping(item.planning, `${label}.planning`);
  assertKnownKeys(planning, PLANNING_KEYS, `${label}.planning`);
  const verifiedAt = nonEmptyString(planning.verified_at, `${label}.planning.verified_at`);
  if (!Number.isFinite(Date.parse(verifiedAt))) throw new Error(`${label}.planning.verified_at must be an ISO date-time`);

  if (typeof item.automation_eligible !== "boolean") {
    throw new Error(`${label}.automation_eligible must be a boolean`);
  }
  const scope = stringArray(item.scope, `${label}.scope`, { minimum: 1 }).map((path, scopeIndex) => {
    const normalized = normalizeScopePath(path);
    if (
      !normalized || normalized === "." || normalized.startsWith("/")
      || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")
    ) {
      throw new Error(`${label}.scope[${scopeIndex}] must be a repository-relative path or glob`);
    }
    return normalized;
  });

  const resolvedRepository = resolve(isAbsolute(repositoryPath)
    ? repositoryPath
    : resolve(dirname(filePath), repositoryPath));
  return stableValue({
    schema: item.schema,
    source: normalizedSource,
    repository: {
      path: repositoryPath,
      base_ref: nonEmptyString(repository.base_ref, `${label}.repository.base_ref`),
      reviewed_base_sha: reviewedBaseSha,
    },
    objective: nonEmptyString(item.objective, `${label}.objective`),
    acceptance_criteria: stringArray(item.acceptance_criteria, `${label}.acceptance_criteria`, { minimum: 1 }),
    priority: boundedInteger(item.priority, 0, 100, `${label}.priority`),
    dependencies: stringArray(item.dependencies, `${label}.dependencies`),
    automation_eligible: item.automation_eligible,
    labels: stringArray(item.labels, `${label}.labels`),
    risks: stringArray(item.risks, `${label}.risks`),
    scope,
    goal_refs: item.goal_refs === undefined
      ? []
      : stringArray(item.goal_refs, `${label}.goal_refs`).map((ref, refIndex) => {
        if (!/^goal-[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(ref) || ref.length > 128) {
          throw new Error(`${label}.goal_refs[${refIndex}] must be a valid local goal ID`);
        }
        return ref;
      }),
    planning: {
      plan_ref: nonEmptyString(planning.plan_ref, `${label}.planning.plan_ref`),
      verified_by: nonEmptyString(planning.verified_by, `${label}.planning.verified_by`),
      verified_at: new Date(verifiedAt).toISOString(),
      repository_instruction_refs: stringArray(planning.repository_instruction_refs, `${label}.planning.repository_instruction_refs`, { minimum: 1 }),
      reviewed_paths: stringArray(planning.reviewed_paths, `${label}.planning.reviewed_paths`, { minimum: 1 }),
    },
    repositoryRoot: resolvedRepository,
    sourceKey: `${normalizedSource.provider}:${normalizedSource.item_id}`,
  });
}

export { IMPLEMENTED_PROVIDERS };

export function loadDirectorSourceItems(filePath) {
  if (!filePath) throw new Error("Director cycle source fixtures are required; pass --items <file>");
  const { path, value } = readDocument(filePath, "Director source fixture");
  assertKnownKeys(value, new Set(["schema", "items"]), "Director source fixture");
  if (value.schema !== "agent-manager.director-source-list.v1") {
    throw new Error("Director source fixture.schema must be agent-manager.director-source-list.v1");
  }
  if (!Array.isArray(value.items)) throw new Error("Director source fixture.items must be an array");
  const items = value.items.map((item, index) => normalizeItem(item, index, path));
  const keys = items.map((item) => item.sourceKey);
  if (new Set(keys).size !== keys.length) throw new Error("Director source fixture contains duplicate source items");
  return { absPath: path, items, digest: sha256(items.map(({ repositoryRoot, sourceKey, ...item }) => item)) };
}
