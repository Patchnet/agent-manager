import {
  detectNeedsInput,
  parseSessionId as parseClaudeSessionId,
  resumeClaude,
  spawnClaude,
} from "./claude.mjs";
import { codexAdapter } from "./codex.mjs";
import { fakeAdapter } from "./fake.mjs";

const claudeAdapter = {
  name: "claude",
  supported: true,
  start: spawnClaude,
  resume: resumeClaude,
  cancel: (handle) => handle?.kill?.(),
  parseSessionId: parseClaudeSessionId,
  parseNeedsInput: detectNeedsInput,
};

function unsupportedAdapter(name) {
  const fail = () => {
    throw new Error('harness "' + name + '" is declared but not implemented');
  };
  return {
    name,
    supported: false,
    start: fail,
    resume: fail,
    cancel: fail,
    parseSessionId: () => null,
    parseNeedsInput: () => null,
  };
}

const adapters = new Map([
  ["claude", claudeAdapter],
  ["codex", codexAdapter],
  ["cursor", unsupportedAdapter("cursor")],
  ["fake", fakeAdapter],
]);

const SUPPORTED_NAMES = [...adapters.values()]
  .filter((adapter) => adapter.supported && !adapter.testOnly)
  .map((adapter) => adapter.name);

export function getHarnessAdapter(name, { allowTest = false } = {}) {
  const adapter = adapters.get(name);
  if (!adapter) throw new Error('unknown harness "' + name + '"');
  if (adapter.testOnly && !allowTest && process.env.AGENT_MANAGER_ALLOW_FAKE !== "1") {
    throw new Error('harness "fake" is test-only; set policy.allow_test_harness: true');
  }
  if (!adapter.supported) {
    throw new Error(
      'harness "' + name + '" is not implemented; supported harnesses: ' + SUPPORTED_NAMES.join(", "),
    );
  }
  return adapter;
}

export function listHarnessAdapters() {
  return [...adapters.values()].map(({ name, supported, testOnly = false }) => ({
    name,
    supported,
    testOnly,
  }));
}
