import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertProviderConformance,
  createProviderEvidenceAvailability,
  PROVIDER_CAPABILITY_CATALOG,
  parseProviderSessionEvidence,
} from "../monitor/providers/provider-contract.mjs";
import { providerRegistry } from "../monitor/providers/index.mjs";

async function fixture(providerId) {
  const file = new URL(`./fixtures/providers/${providerId}/expected-session-evidence.json`, import.meta.url);
  return JSON.parse(await readFile(file, "utf8"));
}

function valuesAtPath(value, path) {
  return path.split(".").reduce((values, segment) => values.flatMap((item) => {
    if (Array.isArray(item)) return item.flatMap((entry) => entry?.[segment] ?? []);
    const next = item?.[segment];
    return next === undefined || next === null ? [] : [next];
  }), [value]);
}

function hasEvidence(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return value > 0;
  if (typeof value === "boolean") return value;
  return value !== null && value !== undefined && value !== "";
}

for (const provider of providerRegistry.providers) {
  test(`${provider.source} satisfies the shared adapter and normalized evidence contract`, async () => {
    const evidence = await fixture(provider.id);
    assert.equal(assertProviderConformance(provider, [evidence]), true);
    assert.deepEqual(parseProviderSessionEvidence(evidence), evidence);
    const availability = createProviderEvidenceAvailability(provider.capabilityManifest, evidence);

    for (const capability of PROVIDER_CAPABILITY_CATALOG) {
      const declaration = provider.capabilityManifest[capability.key];
      assert.ok(declaration, `${provider.id} must classify ${capability.key}`);
      if (declaration.status === "supported") {
        assert.equal(typeof provider[capability.requiredOperation], "function", `${capability.key} requires ${capability.requiredOperation}`);
        if (!capability.evidencePath.startsWith("catalog.") && !capability.evidencePath.startsWith("repository.") && capability.evidencePath !== "usageLimits") {
          assert.equal(valuesAtPath(evidence, capability.evidencePath).some(hasEvidence), true,
            `${provider.id} fixture must demonstrate supported ${capability.key} evidence`);
        }
        assert.notEqual(availability[capability.key].status, "not_applicable");
        continue;
      }
      assert.equal(availability[capability.key].status, "not_applicable");
      assert.ok(declaration.limitation.code);
      assert.ok(declaration.limitation.documentation);
      if (!capability.evidencePath.startsWith("catalog.") && !capability.evidencePath.startsWith("repository.") && capability.evidencePath !== "usageLimits") {
        assert.equal(valuesAtPath(evidence, capability.evidencePath).some(hasEvidence), false,
          `${provider.id} fixture must not produce unsupported ${capability.key} evidence`);
      }
    }
  });
}

test("deep evidence parsing rejects unsafe normalized text before projection", async () => {
  const evidence = await fixture("codex");
  evidence.agents[0].assignment = "safe label\nPROMPT_MUST_NOT_LEAK";
  assert.throws(() => parseProviderSessionEvidence(evidence), /one-line text/);
});

test("missing session evidence does not rewrite static support or runtime readiness", async () => {
  const provider = providerRegistry.providers.find(({ id }) => id === "codex");
  const evidence = await fixture("codex");
  evidence.session.signal = null;
  const availability = createProviderEvidenceAvailability(provider.capabilityManifest, parseProviderSessionEvidence(evidence));

  assert.equal(provider.capabilityManifest.signals.status, "supported");
  assert.equal(provider.capabilities.signals, true);
  assert.deepEqual(availability.signals, { status: "unavailable" });
});
