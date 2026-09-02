import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createIncrementalProviderObserver, incrementalSourceDescriptor } from "../monitor/providers/incremental-provider-observer.mjs";
import { SessionObservationStore } from "../monitor/session-observation-store.mjs";
import { createSessionObservationCoordinator } from "../monitor/session-observation-coordinator.mjs";

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for observer state");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function watchHarness() {
  const listeners = [];
  return {
    watch(_target, options, callback) {
      listeners.push(typeof options === "function" ? options : callback);
      return { close() {} };
    },
    emit(eventType, filename, index = 0) {
      listeners[index]?.(eventType, filename);
    },
  };
}

test("selected historical sessions recover after eviction without rebuilding unchanged background history", async (context) => {
  const observedAt = "2020-01-01T00:00:00.000Z";
  const fixture = path.resolve("tests/fixtures/providers/claude/session.jsonl");
  const store = new SessionObservationStore({ maxEntries: 1 });
  const watcher = watchHarness();
  let reads = 0;
  const observer = createIncrementalProviderObserver({
    providerId: "claude",
    list: async () => ["one", "two"].map((localId) => ({ localId, title: localId, updatedAt: observedAt, isLive: false })),
    resolveSource: async () => incrementalSourceDescriptor(fixture, true),
    readEvidence: async (localId) => {
      reads += 1;
      return { historical: true, session: { id: localId, updatedAt: observedAt } };
    },
    watchTargets: [path.dirname(fixture)],
    watchSource: watcher.watch,
    intervalMs: 60_000,
  });
  const coordinator = createSessionObservationCoordinator({
    store,
    commitDelayMs: 0,
    registry: {
      providers: [{ id: "claude", source: "Claude Code" }],
      async startObservers(publisher, signal) {
        await observer.start({
          publishCatalog: (entries) => publisher.publishCatalog("claude", entries),
          publishSession: (id, evidence) => publisher.publishSession("claude", id, evidence),
          invalidateSession: (id, reason) => publisher.invalidateSession("claude", id, reason),
          checkpointFor: (id) => publisher.checkpointFor("claude", id),
        }, signal);
        return { hydrate: (id) => observer.hydrate(id.slice("claude:".length)), stop: observer.stop };
      },
    },
    deriveSession: async ({ evidence }) => ({ readiness: { core: "ready" }, publicState: evidence }),
  });
  context.after(() => coordinator.stop());
  await coordinator.start();
  await waitFor(() => coordinator.catalog().snapshot?.value.sessions.length === 2);
  assert.equal(reads, 0, "old history starts as catalog-only");
  assert.equal(coordinator.session("claude:one").status, "loading");
  assert.equal(reads, 0, "serving never synchronously acquires provider evidence");
  await waitFor(() => store.get("claude", "one"));
  const original = coordinator.session("claude:one").snapshot;
  await waitFor(() => observer.diagnostics().activeHydrations === 0);
  assert.equal(await observer.hydrate("one"), false, "retained unchanged evidence does not reparse");
  assert.equal(reads, 1);

  assert.equal(coordinator.session("claude:two").status, "loading");
  await waitFor(() => store.get("claude", "two"));
  assert.equal(store.get("claude", "one"), null, "the previous selection can be evicted");
  await waitFor(() => observer.diagnostics().activeHydrations === 0);
  const attempts = observer.diagnostics().hydrationAttempts;
  watcher.emit("change", path.basename(fixture));
  await waitFor(() => observer.diagnostics().hydrationAttempts >= attempts + 2 && observer.diagnostics().activeHydrations === 0);
  assert.equal(reads, 2, "ordinary notifications do not rebuild evicted unchanged history");

  assert.equal(coordinator.session("claude:one", original.revision).status, "loading");
  assert.equal(reads, 2);
  await waitFor(() => store.get("claude", "one"));
  store.publish({ providerId: "claude", localSessionId: "background", evidence: {}, publicState: {}, readiness: {}, observedAt });
  const recovered = coordinator.session("claude:one", original.revision);
  assert.equal(recovered.status, "ready", "a competing commit cannot evict the selected snapshot before serving");
  assert.ok(recovered.snapshot.revision > original.revision, "recovery cannot reuse the client's old revision");
  assert.deepEqual(recovered.snapshot.publicState, original.publicState);
  assert.equal(recovered.snapshot.observedAt, observedAt);
  assert.equal(reads, 3);
  assert.equal(coordinator.session("claude:one", recovered.snapshot.revision).status, "unchanged");
});

test("switching away from a loading selection releases its historical pin", async (context) => {
  const observedAt = "2020-01-01T00:00:00.000Z";
  const store = new SessionObservationStore({ maxEntries: 1 });
  const coordinator = createSessionObservationCoordinator({
    store, commitDelayMs: 0,
    registry: {
      providers: [{ id: "claude", source: "Claude Code" }],
      async startObservers(publisher) {
        publisher.publishCatalog("claude", ["one", "two"].map((localId) => ({ localId, title: localId, updatedAt: observedAt })));
        return { async hydrate() {} };
      },
    },
    deriveSession: async ({ evidence }) => ({ readiness: {}, publicState: evidence }),
  });
  context.after(() => coordinator.stop());
  await coordinator.start();
  await waitFor(() => coordinator.catalog().snapshot?.value.sessions.length === 2);
  assert.equal(coordinator.session("claude:one").status, "loading");
  assert.equal(coordinator.session("claude:two").status, "loading");
  for (const localSessionId of ["one", "two", "background"]) {
    store.publish({ providerId: "claude", localSessionId, evidence: { historical: true }, publicState: {}, readiness: {}, observedAt });
  }
  assert.equal(store.get("claude", "one"), null);
  assert.ok(store.get("claude", "two"));
  assert.equal(store.stats().pinnedEntries, 1);
});

test("requested cache recovery waits for a complete source and retries failed normalization", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  await writeFile(file, '{"id":"one"}\n');
  const controller = new AbortController();
  context.after(() => controller.abort());
  let retained = null;
  let fail = false;
  let reads = 0;
  const observer = createIncrementalProviderObserver({
    providerId: "claude", list: async () => [], intervalMs: 60_000,
    resolveSource: async () => incrementalSourceDescriptor(file, true),
    readEvidence: async () => { reads += 1; if (fail) throw new Error("Synthetic normalization failure"); return {}; },
  });
  await observer.start({
    publishCatalog() {}, invalidateSession() {},
    checkpointFor: () => retained?.observationSource || null,
    publishSession: (_id, candidate) => { retained = candidate; },
  }, controller.signal);
  assert.equal(await observer.hydrate("one"), true);
  await waitFor(() => observer.diagnostics().activeHydrations === 0);
  retained = null;
  await appendFile(file, '{"id":"partial"');
  assert.equal(await observer.hydrate("one"), false);
  assert.equal(retained, null);
  assert.equal(reads, 1, "incomplete cold recovery cannot publish a partial snapshot");
  await waitFor(() => observer.diagnostics().activeHydrations === 0);
  await appendFile(file, '}\n');
  fail = true;
  assert.equal(await observer.hydrate("one"), false);
  assert.equal(retained, null);
  await waitFor(() => observer.diagnostics().activeHydrations === 0);
  fail = false;
  assert.equal(await observer.hydrate("one"), true, "normalization can retry without another append");
  assert.ok(retained.observationSource.completeOffset > 0);
});
