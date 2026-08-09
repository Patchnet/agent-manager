import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { RUNS_ROOT, assertSafeSlug } from "../paths.mjs";
import { matchesScope, normalizeScopePath, scopePrefix } from "../scope.mjs";
import { acquireRepositoryLease } from "./lease.mjs";
import { loadDirectorPolicy, pathCoveredByAllowlist } from "./policy.mjs";
import { IMPLEMENTED_PROVIDERS, loadDirectorSourceItems } from "./source-items.mjs";
import { atomicWriteJson, sha256 } from "./util.mjs";
import { writeWorkflowDrafts } from "./workflow-draft.mjs";

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function scopeAllowed(requested, allowedPaths) {
  const path = normalizeScopePath(requested);
  if (/[?*[]/.test(path)) {
    if (allowedPaths.includes(path)) return true;
    const requestedPrefix = scopePrefix(path);
    return allowedPaths.some((allowed) => {
      const normalizedAllowed = normalizeScopePath(allowed);
      if (!normalizedAllowed.endsWith("/**")) return false;
      const allowedPrefix = scopePrefix(normalizedAllowed);
      return requestedPrefix === allowedPrefix || requestedPrefix.startsWith(`${allowedPrefix}/`);
    });
  }
  return allowedPaths.some((allowed) => matchesScope(path, allowed));
}

function sourceDecision(item, reason) {
  const keyDigest = sha256(item.sourceKey).slice(0, 24);
  return {
    sourceKey: item.sourceKey,
    sourceRef: item.source.ref,
    reason,
    idempotencyKeys: [
      `source-claim:${keyDigest}`,
      `run-create:${keyDigest}`,
      `source-closeout:${keyDigest}`,
    ],
  };
}

function compareItems(left, right) {
  return right.priority - left.priority
    || left.source.provider.localeCompare(right.source.provider)
    || left.source.item_id.localeCompare(right.source.item_id);
}

function riskExceptionCovers(item, risk, exceptions) {
  return exceptions.some((exception) => {
    if (exception.risk !== risk) return false;
    if (!exception.require_labels.every((label) => item.labels.includes(label))) return false;
    return item.scope.every((path) => pathCoveredByAllowlist(path, exception.allowed_paths));
  });
}

function triage(items, policy) {
  const eligible = [];
  const quarantined = [];
  const skipped = [];
  for (const item of [...items].sort(compareItems)) {
    if (!IMPLEMENTED_PROVIDERS.has(item.source.provider)) {
      quarantined.push(sourceDecision(item, `connector-not-implemented:${item.source.provider}`));
      continue;
    }
    if (!samePath(item.repositoryRoot, policy.repoRoot)) {
      quarantined.push(sourceDecision(item, "repository-outside-policy"));
      continue;
    }
    if (item.repository.base_ref !== policy.repository.base_ref) {
      quarantined.push(sourceDecision(item, "base-ref-outside-policy"));
      continue;
    }
    const forbiddenRisks = item.risks.filter((risk) => {
      if (!policy.autopilot.forbidden_risks.includes(risk)) return false;
      return !riskExceptionCovers(item, risk, policy.autopilot.risk_exceptions || []);
    });
    if (forbiddenRisks.length) {
      quarantined.push(sourceDecision(item, `forbidden-risk:${forbiddenRisks.sort().join(",")}`));
      continue;
    }
    const outsideScope = item.scope.filter((path) => !scopeAllowed(path, policy.autopilot.allowed_paths));
    if (outsideScope.length) {
      quarantined.push(sourceDecision(item, `scope-outside-policy:${outsideScope.sort().join(",")}`));
      continue;
    }
    if (!item.automation_eligible) {
      skipped.push(sourceDecision(item, "not-automation-eligible"));
      continue;
    }
    if (!item.labels.includes(policy.autopilot.source_filter)) {
      skipped.push(sourceDecision(item, "source-filter-not-matched"));
      continue;
    }
    if (item.dependencies.length) {
      skipped.push(sourceDecision(item, "dependency-state-unavailable-in-local-fixture"));
      continue;
    }
    eligible.push(item);
  }

  const selectedItems = eligible.slice(0, policy.autopilot.max_items_per_cycle);
  for (const item of eligible.slice(policy.autopilot.max_items_per_cycle)) {
    skipped.push(sourceDecision(item, "cycle-capacity"));
  }
  return {
    selected: selectedItems.map((item) => sourceDecision(item, "policy-eligible")),
    selectedItems,
    quarantined,
    skipped,
  };
}

function transition(state, to, decision, at) {
  state.transitions.push({ from: state.transitions.at(-1)?.to || null, to, at, decision });
  state.phase = to;
  state.updatedAt = at;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function collectExistingDrafts(cycleDir) {
  const workflowsDir = join(cycleDir, "workflows");
  if (!existsSync(workflowsDir)) return [];
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort()
    .map((name) => {
      const path = join(workflowsDir, name);
      return {
        path,
        draftId: name.replace(/\.ya?ml$/i, ""),
        sourceKeys: [],
        validateOk: true,
        kickoff: `agent-manager run ${JSON.stringify(path)} --detach`,
      };
    });
}

export function defaultDirectorStateRoot() {
  return join(RUNS_ROOT, "director");
}

export async function runDirectorCycle({
  policyPath,
  itemsPath,
  repoOverride = null,
  stateRoot = defaultDirectorStateRoot(),
  cycleId = null,
  dryRun = false,
  now = () => new Date(),
} = {}) {
  if (dryRun !== true) {
    throw new Error("Director proposal cycles require --dry-run; auto-detach worker launch is not enabled");
  }
  const policy = loadDirectorPolicy(policyPath, { repoOverride });
  const source = loadDirectorSourceItems(itemsPath);
  const derivedCycleId = `director-cycle-${sha256(`${policy.digest}\0${source.digest}`).slice(0, 20)}`;
  const id = assertSafeSlug(cycleId || derivedCycleId, "Director cycle id");
  const root = resolve(stateRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lease = acquireRepositoryLease({ stateRoot: root, repoRoot: policy.repoRoot, cycleId: id, now });

  try {
    const cycleDir = join(root, "cycles", id);
    const statePath = join(cycleDir, "state.json");
    const cyclePath = join(cycleDir, "cycle.json");
    if (existsSync(cyclePath)) {
      const existing = readJson(cyclePath);
      if (existing.policyDigest !== policy.digest || existing.sourceDigest !== source.digest) {
        throw new Error(`Director cycle id ${id} is already bound to different policy or source input`);
      }
      return { ...existing, replayed: true };
    }

    mkdirSync(cycleDir, { recursive: true, mode: 0o700 });
    let resumed = false;
    let state;
    let drafts = [];
    if (existsSync(statePath)) {
      resumed = true;
      state = readJson(statePath);
      if (
        state.cycleId !== id || state.policyDigest !== policy.digest
        || state.sourceDigest !== source.digest || !samePath(state.repository, policy.repoRoot)
      ) {
        throw new Error(`Director cycle id ${id} has incompatible persisted state`);
      }
      if (!["running", "dry-run-complete"].includes(state.status)) {
        throw new Error(`Director cycle id ${id} cannot resume from state ${state.status}`);
      }
      if (state.status === "dry-run-complete") {
        drafts = collectExistingDrafts(cycleDir);
      }
    } else {
      const startedAt = now().toISOString();
      state = {
        schema: "agent-manager.director-state.v1",
        cycleId: id,
        repository: policy.repoRoot,
        policyDigest: policy.digest,
        sourceDigest: source.digest,
        phase: "DISCOVER",
        status: "running",
        dryRun: true,
        director: policy.director,
        createdAt: startedAt,
        updatedAt: startedAt,
        items: { selected: [], quarantined: [], skipped: [] },
        transitions: [],
      };
      transition(state, "DISCOVER", `loaded ${source.items.length} local source item fixture${source.items.length === 1 ? "" : "s"}`, startedAt);
      atomicWriteJson(statePath, state);
    }

    if (state.status === "running") {
      let selectedItems = [];
      if (state.phase === "DISCOVER") {
        const triageResult = triage(source.items, policy);
        state.items = {
          selected: triageResult.selected,
          quarantined: triageResult.quarantined,
          skipped: triageResult.skipped,
        };
        selectedItems = triageResult.selectedItems;
        transition(state, "TRIAGE", `selected ${state.items.selected.length}; quarantined ${state.items.quarantined.length}; skipped ${state.items.skipped.length}`, now().toISOString());
        atomicWriteJson(statePath, state);
      }
      if (state.phase === "TRIAGE") {
        if (!selectedItems.length) {
          selectedItems = state.items.selected
            .map((decision) => source.items.find((item) => item.sourceKey === decision.sourceKey))
            .filter(Boolean);
        }
        drafts = writeWorkflowDrafts({
          policy,
          selectedItems,
          cycleId: id,
          cycleDir,
        });
        const invalid = drafts.filter((draft) => !draft.validateOk);
        if (invalid.length) {
          throw new Error(
            `Director workflow draft validation failed: ${
              invalid.map((draft) => `${draft.draftId}: ${draft.validateError}`).join("; ")
            }`,
          );
        }
        transition(
          state,
          "PLAN",
          `wrote ${drafts.length} validated workflow draft${drafts.length === 1 ? "" : "s"}`,
          now().toISOString(),
        );
        atomicWriteJson(statePath, state);
      }
      if (state.phase === "PLAN") {
        transition(state, "VALIDATE", "policy, repository, planning evidence, risk, and scope checks passed for selected items", now().toISOString());
        atomicWriteJson(statePath, state);
      }
      if (state.phase === "VALIDATE") {
        transition(state, "CLOSE", "proposal boundary reached; Master may kick off draft workflows with run --detach", now().toISOString());
        atomicWriteJson(statePath, state);
      }
      if (state.phase !== "CLOSE") {
        throw new Error(`Director cycle id ${id} cannot resume from phase ${state.phase}`);
      }
      state.status = "dry-run-complete";
      atomicWriteJson(statePath, state);
      if (!drafts.length) drafts = collectExistingDrafts(cycleDir);
    }

    const cycle = {
      schema: "agent-manager.director-cycle.v1",
      cycleId: id,
      status: state.status,
      dryRun: true,
      repository: policy.repoRoot,
      director: policy.director,
      policyDigest: policy.digest,
      sourceDigest: source.digest,
      startedAt: state.createdAt,
      endedAt: state.updatedAt,
      selected: state.items.selected,
      quarantined: state.items.quarantined,
      skipped: state.items.skipped,
      transitions: state.transitions,
      drafts,
      statePath,
      replayed: false,
    };
    atomicWriteJson(cyclePath, cycle);
    return resumed ? { ...cycle, replayed: true } : cycle;
  } finally {
    lease.release();
  }
}
