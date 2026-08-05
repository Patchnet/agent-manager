import { basename } from "node:path";

const MAX_LABEL_LENGTH = 120;
const MAX_SUBJECT_LENGTH = 160;

function optionalText(value, label, maxLength = MAX_LABEL_LENGTH) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${label} contains unsupported characters or is too long`);
  }
  return text;
}

export function shortRunId(runId) {
  const value = String(runId || "-");
  const match = /^run-\d{8}-\d{6}-(.+)$/.exec(value);
  return match ? match[1].slice(-8) : value.slice(-8);
}

function workflowSubject(workflow) {
  const file = basename(workflow.absPath || "run").replace(/\.(?:ya?ml|json)$/i, "");
  return workflow.title || workflow.planning?.planRef || file || "Run";
}

export function buildRunIdentity({ runId, workflow, overrides = {} }) {
  const repoShorthand = optionalText(
    overrides.repoShorthand || workflow.repo_shorthand || basename(workflow.repoRoot || workflow.repo || "repo"),
    "repo shorthand",
    64,
  );
  const subject = optionalText(
    overrides.title || workflowSubject(workflow),
    "run title",
    MAX_SUBJECT_LENGTH,
  );
  const managerHarness = optionalText(overrides.managerHarness, "manager harness", 64);
  const managerModel = optionalText(overrides.managerModel, "manager model");
  const managerThreadTitle = optionalText(overrides.managerThreadTitle, "manager thread title", 256);
  const displayRepo = repoShorthand.length > 28 ? repoShorthand.slice(0, 27) + "…" : repoShorthand;
  const prefix = `[AM ${shortRunId(runId)}] ${displayRepo} · `;
  const subjectWidth = Math.max(12, 80 - prefix.length);
  const displaySubject = subject.length > subjectWidth ? subject.slice(0, subjectWidth - 1) + "…" : subject;
  const displayTitle = prefix + displaySubject;

  return {
    schema: "agent-manager.run-identity.v1",
    displayTitle,
    suggestedThreadTitle: displayTitle,
    repoShorthand,
    subject,
    manager: {
      harness: managerHarness,
      model: managerModel,
      modelSource: managerModel ? (overrides.managerModelSource || "declared") : "unavailable",
      threadTitle: managerThreadTitle,
    },
  };
}
