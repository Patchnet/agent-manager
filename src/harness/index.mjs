import {
  detectNeedsInput,
  parseModel as parseClaudeModel,
  parseSessionId as parseClaudeSessionId,
  resumeClaude,
  spawnClaude,
} from "./claude.mjs";
import { codexAdapter } from "./codex.mjs";
import { cursorAdapter } from "./cursor.mjs";
import { fakeAdapter } from "./fake.mjs";
import { fakeHarnessAllowed } from "../constants.mjs";

const claudeAdapter = {
  name: "claude",
  supported: true,
  start: spawnClaude,
  resume: resumeClaude,
  cancel: (handle) => handle?.kill?.(),
  parseSessionId: parseClaudeSessionId,
  parseModel: parseClaudeModel,
  parseNeedsInput: detectNeedsInput,
};

const adapters = new Map([
  ["claude", claudeAdapter],
  ["codex", codexAdapter],
  ["cursor", cursorAdapter],
  ["fake", fakeAdapter],
]);

const SUPPORTED_NAMES = [...adapters.values()]
  .filter((adapter) => adapter.supported && !adapter.testOnly)
  .map((adapter) => adapter.name);

export function getHarnessAdapter(name) {
  const adapter = adapters.get(name);
  if (!adapter) throw new Error('unknown harness "' + name + '"');
  if (adapter.testOnly && !fakeHarnessAllowed()) {
    throw new Error(
      'harness "fake" is test-only outside the explicit local demo; use "agent-manager demo" or set AGENT_MANAGER_TEST_MODE=1 in tests',
    );
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
