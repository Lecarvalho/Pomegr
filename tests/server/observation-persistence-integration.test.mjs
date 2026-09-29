import assert from "node:assert/strict";
import test from "node:test";
import { createSessionObservationCoordinator } from "../../server/runtime/session-observation-coordinator.mjs";
import { SessionObservationStore } from "../../server/sessions/checkpoints/session-observation-store.mjs";
import { PIPELINE_TRACE_DOMAINS, PIPELINE_TRACE_OUTCOMES, PIPELINE_TRACE_STAGES } from "../../server/diagnostics/pipeline-trace.mjs";

test("C-to-P drains latest accepted revisions after observer stop and emits only normalized diagnostics", async () => {
  const records = [];
  const trace = {
    begin(value) { records.push(value); return records.length; },
    end(_span, value) { records.push(value); },
    recordDuration(value) { records.push(value); },
    createFlow() { return null; }, finishFlow() {},
  };
  const order = [];
  const writes = [];
  let publisher;
  let attempts = 0;
  const store = new SessionObservationStore();
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex" }], async startObservers(value) {
      publisher = value;
      return { async stop() { order.push("observer-stop"); } };
    } },
    store,
    pipelineTrace: trace,
    checkpointStore: { async load() { return { records: [] }; }, async write(snapshot) {
      order.push("write"); attempts += 1;
      if (attempts === 1) throw new Error("private-storage-path-and-error");
      writes.push(snapshot);
    } },
    persistenceQueueOptions: { maxAttempts: 2, retryDelayMs: 1 },
    commitDelayMs: 0,
    checkpointDelayMs: 60_000,
    checkpointMaxDelayMs: 60_000,
    async deriveSession() { return { readiness: { core: "ready" }, publicState: { privateMarker: "browser-state-never-retained-in-P" } }; },
  });
  await coordinator.start();
  publisher.publishSession("codex", "private-synthetic-id", { historical: false, session: {}, revision: 1 });
  for (let n = 0; n < 100 && !store.getByQualifiedId("codex:private-synthetic-id"); n += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(store.getByQualifiedId("codex:private-synthetic-id"));
  await coordinator.stop();
  assert.deepEqual(order, ["observer-stop", "write", "write"]);
  assert.equal(writes.length, 1);
  assert.equal(Object.hasOwn(writes[0], "publicState"), false);
  assert.equal(Object.hasOwn(writes[0], "serializedState"), false);
  assert.ok(records.some((record) => record.stage === "source_queue" && record.domain === "persistence"));
  assert.ok(records.some((record) => record.stage === "checkpoint_storage"));
  for (const record of records) {
    if (record.stage) assert.ok(PIPELINE_TRACE_STAGES.includes(record.stage));
    if (record.domain) assert.ok(PIPELINE_TRACE_DOMAINS.includes(record.domain));
    if (record.outcome) assert.ok(PIPELINE_TRACE_OUTCOMES.includes(record.outcome));
  }
  assert.doesNotMatch(JSON.stringify(records), /private|browser-state|synthetic-id/);
});
