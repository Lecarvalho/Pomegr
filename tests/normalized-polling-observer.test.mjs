import assert from "node:assert/strict";
import test from "node:test";
import { createNormalizedPollingObserver } from "../monitor/providers/normalized-polling-observer.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function waitFor(predicate, attempts = 100, detail = () => "") {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for observer state ${detail()}`);
}

test("a queued maintenance hydration starts when selection promotes that same session", async (context) => {
  const releases = new Map([["background-1", deferred()], ["background-2", deferred()]]);
  const started = [];
  let entries = [];
  let eager = false;
  const controller = new AbortController();
  const observer = createNormalizedPollingObserver({
    list: async () => entries,
    shouldEagerHydrate: () => eager,
    prepare: async (entries) => new Map(entries.map((entry) => [entry.localId, entry])),
    ingest: async (localSessionId) => {
      started.push(localSessionId);
      await releases.get(localSessionId).promise;
      return null;
    },
    intervalMs: 60_000,
    interactiveConcurrency: 1,
    backgroundConcurrency: 1,
    async yieldControl() {},
  });
  context.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await waitFor(() => observer.diagnostics().reconciliationRuns === 1);
  entries = [
    { localId: "background-1", detailReadiness: "ready" },
    { localId: "background-2", detailReadiness: "ready" },
  ];
  await observer.refresh({ fresh: true });
  eager = true;

  await observer.refresh({ fresh: true });
  await waitFor(() => started.includes("background-1") && observer.diagnostics().pendingHydrations === 1);
  assert.deepEqual(started, ["background-1"]);

  const selected = observer.hydrate("background-2");
  await waitFor(() => started.includes("background-2"), 100, () => JSON.stringify({ started, diagnostics: observer.diagnostics() }));
  assert.deepEqual(started, ["background-1", "background-2"]);

  releases.get("background-2").resolve();
  await selected;
  releases.get("background-1").resolve();
});
