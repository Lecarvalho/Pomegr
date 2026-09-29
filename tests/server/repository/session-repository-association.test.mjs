import assert from "node:assert/strict";
import test from "node:test";

test("repository association resolves launch and single evidence from the launch directory, never multiple or unknown", async () => {
  const { createSessionRepositoryAssociations } = await import("../../../server/repository/session-repository-association.mjs");
  const associateSession = async () => ({ repositoryId: "repo-0123456789abcdef01234567", contextInventoryRef: null });
  const associate = async (repositoryAttribution) => {
    const associations = createSessionRepositoryAssociations({ registry: { repositoryAttributionForSession: () => null }, inventory: { associateSession }, previousReference: () => null, onChange: () => {} });
    const candidate = { providerId: "claude", localSessionId: `s-${repositoryAttribution}`, evidence: { session: { cwd: "C:\\synthetic\\pomegr", startedAt: null, repositoryAttribution } } };
    associations.get(candidate);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return associations.get(candidate)?.repositoryId ?? null;
  };
  assert.equal(await associate("launch"), "repo-0123456789abcdef01234567");
  assert.equal(await associate("single"), "repo-0123456789abcdef01234567");
  assert.equal(await associate("multiple"), null);
  assert.equal(await associate("unknown"), null);
});

test("repository association eviction serves the committed value and never re-derives an unchanged session", async () => {
  const { createSessionRepositoryAssociations } = await import("../../../server/repository/session-repository-association.mjs");
  const value = { repositoryId: "repo-0123456789abcdef01234567", contextInventoryRef: null };
  const committed = new Map();
  let changes = 0;
  const associations = createSessionRepositoryAssociations({
    registry: { repositoryAttributionForSession: () => null }, inventory: { associateSession: async () => value },
    previousReference: () => null, previousAssociation: (candidate) => committed.get(candidate.localSessionId) || null,
    onChange: () => { changes += 1; },
  });
  // More sessions than the bounded cache holds: each settled lookup is committed, then re-derived.
  const candidates = Array.from({ length: 300 }, (_, index) => ({ providerId: "claude", localSessionId: `s-${index}`, evidence: { session: { cwd: "C:\\synthetic\\pomegr", startedAt: null, repositoryAttribution: "launch" } } }));
  for (const candidate of candidates) associations.get(candidate);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(changes, 300, "the first settled lookup rederives once");
  for (const candidate of candidates) committed.set(candidate.localSessionId, associations.get(candidate) || value);
  for (let round = 0; round < 3; round += 1) {
    for (const candidate of candidates) assert.deepEqual(associations.get(candidate), value, "an evicted session keeps its committed association");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(changes, 300, "eviction never re-derives an unchanged session");
});
