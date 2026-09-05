// These settings belong to the harness. Omission deliberately preserves its
// own defaults; a requested value is never reported as an observed value.
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function normalizeHarnessOptions(input, harness, model = null) {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("harness_options must be a mapping");
  }
  for (const key of Object.keys(input)) {
    if (!["effort", "profile"].includes(key)) throw new Error(`unknown harness_options field: ${key}`);
  }
  if (Object.keys(input).length && !["codex", "claude", "fake"].includes(harness)) {
    throw new Error(`harness_options are not supported by ${harness}`);
  }
  if (input.effort !== undefined) {
    if (!EFFORTS.has(input.effort)) throw new Error("harness_options.effort is not a supported effort level");
    if ((harness === "claude" || /^gpt-6-astra(?:$|-)/.test(model || ""))
      && ["none", "minimal"].includes(input.effort)) {
      throw new Error(`${model || harness} does not support effort ${input.effort}`);
    }
  }
  if (input.profile !== undefined) {
    if (harness !== "codex") throw new Error("harness_options.profile is only supported by codex");
    if (typeof input.profile !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input.profile)) {
      throw new Error("harness_options.profile must be a simple profile name");
    }
  }
  return { ...input };
}

export function parseEffort(event) {
  const value = event?.reasoning_effort ?? event?.effort ?? event?.payload?.reasoning_effort;
  return typeof value === "string" && EFFORTS.has(value) ? value : null;
}
