import assert from "node:assert/strict";
import test from "node:test";
import {
  createHomeReadiness,
  createSessionReadiness,
  hasLoadingReadiness,
} from "../monitor/observation-readiness.mjs";

test("session readiness is explicit per independently produced domain", () => {
  const readiness = createSessionReadiness("loading", {
    core: "ready",
    usageLimits: "unavailable",
  });
  assert.deepEqual(readiness, {
    core: "ready",
    agentEvidence: "loading",
    contextEvidence: "loading",
    activityEvidence: "loading",
    repository: "loading",
    resources: "loading",
    usageLimits: "unavailable",
  });
  assert.equal(hasLoadingReadiness(readiness), true);
  assert.throws(() => createSessionReadiness("waiting"), TypeError);
});

test("Home readiness remains independent per provider, limit, and session", () => {
  const readiness = createHomeReadiness({
    catalog: "ready",
    providerLimits: { codex: "ready", claude: "loading" },
    limitActivity: { "codex:primary": "ready", "claude:current": "loading" },
    sessionSummaries: { "codex:one": "ready" },
  });
  assert.equal(readiness.providerLimits.codex, "ready");
  assert.equal(readiness.limitActivity["claude:current"], "loading");
  assert.equal(hasLoadingReadiness(readiness), true);
  assert.throws(() => createHomeReadiness({ providerLimits: { codex: "pending" } }), TypeError);
});
