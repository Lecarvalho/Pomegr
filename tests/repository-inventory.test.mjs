import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRepositoryInventoryRuntime } from "../monitor/repository-inventory-runtime.mjs";

function inventory(observedAt, machineryTokens = 1200) {
  return { observedAt, model: "claude-test", machineryTokens,
    categories: [{ name: "System prompt", tokens: "1.2k", percentage: 12 }],
    groups: [{ id: "tools", label: "Tools", items: [{ name: "Read", detail: "provider tool", tokens: "200" }] }] };
}

test("repository inventories use opaque identities, immutable revisions, and future-only bindings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-repository-inventory-"));
  const storeFile = path.join(directory, "inventory.json");
  let clock = Date.parse("2026-09-04T10:00:00.000Z");
  let captureResult = { status: "completed", inventory: inventory("2026-09-04T10:05:00.000Z") };
  const provider = { id: "claude", source: "Claude Code", capabilities: { repositoryContextInventory: true },
    async captureRepositoryContextInventory() { return captureResult; } };
  const runtime = createRepositoryInventoryRuntime({ registry: { providers: [provider] }, storeFile, now: () => clock,
    gitRoot: async () => "C:\\private\\Pomegr" });
  await runtime.ready;
  const existing = await runtime.associateSession({ sessionId: "claude:existing", provider: "claude",
    cwd: "C:\\private\\Pomegr", startedAt: "2026-09-04T09:59:00.000Z" });
  assert.match(existing.repositoryId, /^repo-[a-f0-9]{24}$/u);
  assert.equal(JSON.stringify(existing).includes("private"), false);
  assert.equal(existing.contextInventoryRef, null);

  assert.equal(await runtime.capture(existing.repositoryId, "claude"), "completed");
  const future = await runtime.associateSession({ sessionId: "claude:future", provider: "claude",
    cwd: "C:\\private\\Pomegr", startedAt: "2026-09-04T10:06:00.000Z" });
  assert.equal(future.contextInventoryRef.revisionId, "ctx-001");
  assert.equal((await runtime.associateSession({ sessionId: "claude:existing", provider: "claude",
    cwd: "C:\\private\\Pomegr", startedAt: "2026-09-04T10:06:00.000Z" })).contextInventoryRef, null);

  await runtime.reconcile([{ id: "claude:future", provider: "claude", project: "Pomegr", repositoryId: future.repositoryId,
    updatedAt: "2026-09-04T10:06:00.000Z", isLive: true }]);
  const snapshot = runtime.readRepositories().snapshot.value;
  assert.equal(snapshot.repositories[0].providers[0].currentRevision.id, "ctx-001");
  assert.equal(JSON.stringify(snapshot).includes("C:\\private"), false);
  const detail = await runtime.readRevision(future.repositoryId, "claude", "ctx-001");
  assert.equal(detail.groups[0].items[0].name, "Read");
  assert.equal(Object.hasOwn(detail, "fingerprint"), false);

  captureResult = { status: "failed", failureKind: "runtime_unavailable" };
  assert.equal(await runtime.capture(future.repositoryId, "claude"), "failed");
  assert.equal(runtime.readRepositories().snapshot.value.repositories[0].providers[0].currentRevision.id, "ctx-001");

  clock += 60_000;
  const restored = createRepositoryInventoryRuntime({ registry: { providers: [provider] }, storeFile, now: () => clock,
    gitRoot: async () => "C:\\private\\Pomegr" });
  await restored.ready;
  const identity = await restored.identify("C:\\private\\Pomegr");
  assert.equal(identity.repositoryId, future.repositoryId);
  assert.doesNotMatch(await readFile(storeFile, "utf8"), /C:\\\\private/u);
});

test("repository inventory retention preserves compact bindings and restores the last valid checkpoint", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-repository-retention-"));
  const storeFile = path.join(directory, "inventory.json");
  let revision = 0;
  const provider = { id: "claude", source: "Claude Code", capabilities: { repositoryContextInventory: true },
    async captureRepositoryContextInventory() {
      revision += 1;
      return { status: "completed", inventory: inventory(`2026-09-04T10:${String(revision).padStart(2, "0")}:00.000Z`, 1_000 + revision) };
    } };
  const options = { registry: { providers: [provider] }, storeFile, now: () => Date.parse("2026-09-04T10:00:00.000Z"),
    gitRoot: async () => "C:\\private\\Pomegr" };
  const runtime = createRepositoryInventoryRuntime(options);
  const identity = await runtime.identify("C:\\private\\Pomegr");
  assert.equal(await runtime.capture(identity.repositoryId, "claude"), "completed");
  const bound = await runtime.associateSession({ sessionId: "claude:retained-ref", provider: "claude",
    cwd: "C:\\private\\Pomegr", startedAt: "2026-09-04T10:02:00.000Z" });
  assert.equal(bound.contextInventoryRef.revisionId, "ctx-001");
  for (let index = 1; index < 12; index += 1) assert.equal(await runtime.capture(identity.repositoryId, "claude"), "completed");
  assert.equal((await runtime.readRevision(identity.repositoryId, "claude", "ctx-001")), null);
  const preserved = await runtime.associateSession({ sessionId: "claude:retained-ref", provider: "claude",
    cwd: "C:\\private\\Pomegr", startedAt: "2026-09-04T10:30:00.000Z" });
  assert.equal(preserved.contextInventoryRef.revisionId, "ctx-001");
  assert.equal(preserved.contextInventoryRef.detailRetained, false);
  await writeFile(storeFile, "{malformed", "utf8");
  const restored = createRepositoryInventoryRuntime(options);
  await restored.ready;
  const restoredIdentity = await restored.identify("C:\\private\\Pomegr");
  assert.equal(restoredIdentity.repositoryId, identity.repositoryId);
  assert.equal((await restored.readRevision(identity.repositoryId, "claude", "ctx-012")).id, "ctx-012");
});

test("repository order stays alphabetical across session updates and catalog reordering", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-repository-order-"));
  const runtime = createRepositoryInventoryRuntime({ registry: { providers: [] }, storeFile: path.join(directory, "inventory.json") });
  const session = (id, project, repositoryId, updatedAt) => ({ id: `claude:${id}`, provider: "claude", project, repositoryId, updatedAt, isLive: false });
  const alpha = session("alpha", "Alpha", "repo-000000000000000000000001", "2026-09-04T10:00:00.000Z");
  const zulu = session("zulu", "Zulu", "repo-000000000000000000000002", "2026-09-04T11:00:00.000Z");
  // Identical short disambiguators exercise the full opaque-ID tie-breaker.
  const twinA = session("twin-a", "Twin", "repo-000000000000000000010003", null);
  const twinB = session("twin-b", "Twin", "repo-000000000000000000020003", null);
  await runtime.reconcile([zulu, twinB, alpha, twinA]);
  const initial = runtime.readRepositories().snapshot;
  const expected = [alpha.repositoryId, twinA.repositoryId, twinB.repositoryId, zulu.repositoryId];
  assert.deepEqual(initial.value.repositories.map((entry) => entry.id), expected);

  const updatedZulu = { ...zulu, updatedAt: "2026-09-04T12:00:00.000Z", isLive: true };
  await runtime.reconcile([twinA, updatedZulu, twinB, alpha, { ...updatedZulu, id: "claude:zulu-new" }]);
  const updated = runtime.readRepositories().snapshot;
  assert.notEqual(updated.revision, initial.revision);
  assert.deepEqual(updated.value.repositories.map((entry) => entry.id), expected);
  const zuluRow = updated.value.repositories.at(-1);
  assert.equal(zuluRow.updatedAt, updatedZulu.updatedAt);
  assert.equal(zuluRow.sessionCount, 2);
  assert.equal(zuluRow.liveCount, 2);
  assert.equal(initial.value.repositories.at(-1).sessionCount, 1);

  await runtime.reconcile([alpha, twinB, twinA, updatedZulu, { ...updatedZulu, id: "claude:zulu-new" }]);
  assert.equal(runtime.readRepositories().snapshot.revision, updated.revision);
});

test("repository inventory capture is single-flight per repository and provider", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-repository-busy-"));
  let complete;
  const provider = { id: "claude", source: "Claude Code", capabilities: { repositoryContextInventory: true },
    captureRepositoryContextInventory: () => new Promise((resolve) => { complete = resolve; }) };
  const runtime = createRepositoryInventoryRuntime({ registry: { providers: [provider] }, storeFile: path.join(directory, "inventory.json"),
    gitRoot: async () => "C:\\private\\Pomegr" });
  const identity = await runtime.identify("C:\\private\\Pomegr");
  const first = runtime.capture(identity.repositoryId, "claude");
  assert.equal(await runtime.capture(identity.repositoryId, "claude"), "busy");
  complete({ status: "completed", inventory: inventory("2026-09-04T10:05:00.000Z") });
  assert.equal(await first, "completed");
});
