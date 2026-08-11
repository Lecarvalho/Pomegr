import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderCapabilities,
  defineProvider,
  parseProviderSessionId,
  providerSource,
  qualifyProviderSessionId,
} from "../monitor/providers/provider-contract.mjs";
import { createEmptyMonitorState } from "../shared/monitor-state.mjs";

test("qualifies provider-local session IDs without accepting paths", () => {
  assert.equal(qualifyProviderSessionId("claude", "session_123"), "claude:session_123");
  assert.equal(qualifyProviderSessionId("codex", "019fedff-eed0-7ce3-ad7d-f2fc749783d8"), "codex:019fedff-eed0-7ce3-ad7d-f2fc749783d8");
  assert.deepEqual(parseProviderSessionId("codex:thread-1"), { providerId: "codex", localSessionId: "thread-1" });
  assert.equal(parseProviderSessionId("unknown:thread-1"), null);
  assert.equal(parseProviderSessionId("codex:../thread-1"), null);
  assert.equal(parseProviderSessionId("codex:C:\\private\\thread.jsonl"), null);
  assert.equal(parseProviderSessionId("codex:thread:child"), null);
  assert.throws(() => qualifyProviderSessionId("codex", "../private"), /Unsafe provider-local session ID/);
});

test("keeps optional provider capabilities deny-by-default", () => {
  const capabilities = createProviderCapabilities({ liveSessions: true, needsInput: true });
  assert.equal(capabilities.liveSessions, true);
  assert.equal(capabilities.needsInput, true);
  assert.equal(capabilities.estimatedCost, false);
  assert.equal(capabilities.contextMachinery, false);
  assert.equal(Object.isFrozen(capabilities), true);
  assert.throws(() => createProviderCapabilities({ futureCapability: true }), /Unknown provider capability/);
  assert.throws(() => createProviderCapabilities({ liveSessions: "yes" }), /must be boolean/);
});

test("validates provider declarations and optional usage readers", () => {
  const base = {
    id: "codex",
    source: "Codex",
    capabilities: { liveSessions: true },
    watchTargets: ["synthetic-root"],
    async listSessions() { return []; },
    async readSession() { return null; },
  };
  const provider = defineProvider(base);
  assert.equal(provider.source, providerSource("codex"));
  assert.equal(provider.capabilities.liveSessions, true);
  assert.deepEqual(provider.watchTargets, ["synthetic-root"]);
  assert.equal(Object.isFrozen(provider.watchTargets), true);
  assert.equal(Object.isFrozen(provider), true);
  assert.throws(() => defineProvider({ ...base, source: "Claude Code" }), /source must be Codex/);
  assert.throws(() => defineProvider({ ...base, capabilities: { usageLimits: true } }), /must implement readUsageLimits/);
  assert.throws(() => defineProvider({ ...base, watchTargets: [""] }), /watchTargets/);
  assert.throws(() => defineProvider({ ...base, unavailableMessage: "private" }), /unavailableMessage/);
});

test("creates provider-aware empty state while preserving the Claude default", () => {
  assert.equal(createEmptyMonitorState().source, "Claude Code");
  assert.equal(createEmptyMonitorState({ source: "Codex", connected: true }).source, "Codex");
});
