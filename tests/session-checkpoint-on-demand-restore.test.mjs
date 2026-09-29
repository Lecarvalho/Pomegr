import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionObservationCheckpointStore, checkpointFilename } from "../monitor/session-observation-checkpoints.mjs";
import { SessionObservationStore } from "../monitor/session-observation-store.mjs";
import { createSessionObservationCoordinator } from "../monitor/session-observation-coordinator.mjs";

const observedAt = "2026-01-01T00:00:00.000Z";

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for coordinator state");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function evidenceFor(id, version = 1) {
  return { historical: true, version, session: { id, updatedAt: observedAt } };
}

// A real checkpoint directory whose bulk `load()` is held until the test releases it,
// standing in for a startup restore that has not reached the selected session yet.
async function harness(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-on-demand-restore-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const checkpoints = new SessionObservationCheckpointStore({ directory });
  let releaseBulk;
  const bulkGate = new Promise((resolve) => { releaseBulk = resolve; });
  const bulkLoad = checkpoints.load.bind(checkpoints);
  checkpoints.load = async (options) => { await bulkGate; return bulkLoad(options); };
  const store = new SessionObservationStore();
  const restores = [];
  const storeRestore = store.restore.bind(store);
  store.restore = (candidate) => { restores.push(candidate.localSessionId); return storeRestore(candidate); };
  const hydrations = [];
  let restoreComplete = false;
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    store,
    checkpointStore: checkpoints,
    commitDelayMs: 0,
    checkpointDelayMs: 60_000,
    onRestoreComplete: () => { restoreComplete = true; },
    registry: {
      providers: [{ id: "claude", source: "Claude Code" }],
      async startObservers(value) {
        publisher = value;
        return { hydrate: async (id) => { hydrations.push(id); return false; }, stop() {} };
      },
    },
    deriveSession: async ({ evidence }) => ({ readiness: { core: "ready" }, publicState: evidence }),
  });
  context.after(() => coordinator.stop());
  return { directory, checkpoints, store, restores, hydrations, coordinator, releaseBulk,
    publisher: () => publisher, restoreComplete: () => restoreComplete };
}

async function writeCheckpoint(checkpoints, localSessionId, revision) {
  await checkpoints.write({ providerId: "claude", localSessionId, source: { fingerprint: "fp", completeOffset: 10 },
    evidence: evidenceFor(localSessionId), readiness: { core: "ready" }, revision, observedAt });
}

test("a selection during a slow bulk restore is served from its own checkpoint without acquisition", async (context) => {
  const h = await harness(context);
  await writeCheckpoint(h.checkpoints, "one", 7);
  await writeCheckpoint(h.checkpoints, "two", 3);
  await h.coordinator.start();
  assert.equal(h.coordinator.session("claude:one").status, "loading");
  await waitFor(() => h.store.get("claude", "one"));
  const served = h.coordinator.session("claude:one");
  assert.equal(served.status, "ready");
  assert.equal(served.snapshot.revision, 7, "the checkpoint revision is preserved");
  assert.deepEqual(h.hydrations, [], "the provider's acquire is never called");
  assert.equal(h.checkpoints.stats().singleLoads, 1, "one identity-keyed file is read");
  assert.equal(h.store.get("claude", "two"), null, "other sessions still wait for the bulk restore");
  assert.equal(h.coordinator.session("claude:one").status, "ready");
  assert.equal(h.checkpoints.stats().singleLoads, 1, "a repeated request does not reread");

  h.releaseBulk();
  await waitFor(() => h.restoreComplete());
  assert.deepEqual(h.restores.sort(), ["one", "two"], "the bulk pass does not restore the session again");
  assert.equal(h.store.get("claude", "one").revision, 7);
  assert.deepEqual(h.hydrations, []);
});

test("a later bulk restore never replaces a newer committed revision", async (context) => {
  const h = await harness(context);
  await writeCheckpoint(h.checkpoints, "one", 7);
  await h.coordinator.start();
  h.coordinator.session("claude:one");
  await waitFor(() => h.store.get("claude", "one"));
  h.publisher().publishSession("claude", "one", evidenceFor("one", 2));
  await waitFor(() => h.store.get("claude", "one").evidence.version === 2);
  const newer = h.store.get("claude", "one").revision;
  assert.ok(newer > 7);
  h.releaseBulk();
  await waitFor(() => h.restoreComplete());
  assert.equal(h.store.get("claude", "one").revision, newer);
  assert.equal(h.store.get("claude", "one").evidence.version, 2);
  assert.deepEqual(h.restores, ["one"]);
});

test("a missing or invalid checkpoint falls back to selected hydration", async (context) => {
  const h = await harness(context);
  await writeCheckpoint(h.checkpoints, "valid", 1);
  await writeFile(path.join(h.directory, checkpointFilename("claude", "broken")), "{not json", "utf8");
  await h.coordinator.start();
  assert.equal(h.coordinator.session("claude:broken").status, "loading");
  assert.equal(h.coordinator.session("claude:absent").status, "loading");
  assert.deepEqual(h.hydrations, [], "hydration waits for the one-file checkpoint answer");
  await waitFor(() => h.hydrations.length === 2);
  assert.deepEqual(h.hydrations.sort(), ["claude:absent", "claude:broken"]);
  assert.equal(h.store.get("claude", "broken"), null);
  h.releaseBulk();
  await waitFor(() => h.restoreComplete());
  // After the restore window closes, a miss hydrates directly as before.
  assert.equal(h.coordinator.session("claude:later").status, "loading");
  assert.equal(h.checkpoints.stats().singleLoads, 2);
  await waitFor(() => h.hydrations.includes("claude:later"));
});
