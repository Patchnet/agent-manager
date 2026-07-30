import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import YAML from "yaml";
import { repoPath } from "./paths.mjs";

/**
 * Load workflow YAML/JSON and resolve target-repo dev_flow.
 * Workflow may set target_dev_flow; else read target Version.md; else "simple".
 */
export function loadWorkflow(filePath) {
  const abs = resolve(filePath);
  if (!existsSync(abs)) throw new Error(`workflow not found: ${abs}`);
  const raw = readFileSync(abs, "utf8");
  const doc = extname(abs).toLowerCase() === ".json" ? JSON.parse(raw) : YAML.parse(raw);
  if (!doc || typeof doc !== "object") throw new Error("workflow must be a mapping");
  if (!doc.repo) throw new Error("workflow.repo is required");
  if (!Array.isArray(doc.lanes) || doc.lanes.length === 0) {
    throw new Error("workflow.lanes must be a non-empty array");
  }
  for (const lane of doc.lanes) {
    if (!lane.id) throw new Error("each lane needs id");
    if (!lane.prompt && !lane.prompt_file) throw new Error(`lane ${lane.id}: prompt or prompt_file required`);
    if (!lane.scope) throw new Error(`lane ${lane.id}: scope required`);
  }
  if (doc.lanes.length > 3) throw new Error("max 3 lanes per run (agent-coordination)");

  const feed = normalizeFeed(doc.feed, doc.repo);

  const root = repoPath(doc.repo);
  if (!existsSync(root)) throw new Error(`repo not found: ${root}`);

  const targetDevFlow =
    doc.target_dev_flow ||
    readTargetDevFlow(root) ||
    "simple";

  return {
    ...doc,
    absPath: abs,
    repoRoot: root,
    harness_default: doc.harness_default || "claude",
    target_dev_flow: targetDevFlow,
    /** When true, after all coding lanes succeed, fold into am/<runId>/integrate. */
    integrate: doc.integrate === true,
    feed,
    policy: {
      allow_commit: false,
      allow_pr: false,
      stall_timeout_sec: 600,
      permission_mode: "acceptEdits",
      ...(doc.policy || {}),
    },
  };
}

function normalizeFeed(input, repo) {
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    throw new Error("workflow.feed must be a mapping");
  }
  const raw = input || {};
  const enabled = raw.enabled === true;
  const baseUrl =
    raw.baseUrl || process.env.AGENT_FEED_BASE_URL || "http://localhost:8787";
  const topic =
    raw.topic || process.env.AGENT_FEED_TOPIC || "agent-manager/" + repo;
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new Error("workflow.feed.baseUrl must be a non-empty string");
  }
  if (typeof topic !== "string" || topic.trim() === "") {
    throw new Error("workflow.feed.topic must be a non-empty string");
  }
  return {
    enabled,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    topic,
  };
}

function readTargetDevFlow(repoRoot) {
  const v = resolve(repoRoot, "Version.md");
  if (!existsSync(v)) return null;
  const text = readFileSync(v, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const flow = m[1].match(/^dev_flow:\s*(\w+)/m);
  return flow ? flow[1] : null;
}

export function lanePrompt(lane, workflow) {
  let body = lane.prompt || "";
  if (lane.prompt_file) {
    const p = resolve(workflow.repoRoot, lane.prompt_file);
    body = readFileSync(p, "utf8");
  }
  const policyBlock = `
## agent-manager policy (mandatory)
- Stay inside scope: ${Array.isArray(lane.scope) ? lane.scope.join(", ") : lane.scope}
- Work only in this worktree / branch. Do not switch repos.
- Do NOT commit, push, merge, tag, or bump Version.md unless the prompt explicitly says otherwise (default: no).
- Target repo dev_flow: ${workflow.target_dev_flow}
- If blocked on a product/architecture decision, write needs-input.json in the lane run directory (path will be given) with { "type":"question", "prompt":"...", "blocking":true } and stop.
- Prefer finishing a thin slice over expanding scope.
`.trim();
  return `${body.trim()}\n\n${policyBlock}\n`;
}
