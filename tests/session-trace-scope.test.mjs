import test from "node:test";
import assert from "node:assert/strict";
import { createNormalizedPollingObserver } from "../monitor/providers/normalized-polling-observer.mjs";

function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("Timed out waiting for observer"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

test("normalized observer scopes hydration flow, queue, and acquisition spans to its owner", async (context) => {
  const controller = new AbortController();
  context.after(() => controller.abort());
  const calls = { flows: [], begins: [], durations: [], finishes: [] };
  let flowId = 0;
  const trace = {
    createFlow(options) { const flow = { id: ++flowId }; calls.flows.push({ flow, options }); return flow; },
    begin(options) { calls.begins.push(options); return {}; },
    end() {},
    recordDuration(options) { calls.durations.push(options); },
    finishFlow(flow, options) { calls.finishes.push({ flow, options }); },
  };
  const observer = createNormalizedPollingObserver({
    async list() { listCalls += 1; return listCalls === 1 ? [] : listed; },
    async ingest() { return { session: { id: "normalized" } }; },
    intervalMs: 60_000,
    monotonicNow: () => 20,
    yieldControl: async () => {},
  });
  const scope = Object.freeze({});
  let listCalls = 0;
  const listed = [{ localId: "local-a" }];
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal, {
    trace,
    traceScopeForLocalId: (localId) => localId === "local-a" ? scope : null,
  });
  await waitFor(() => observer.diagnostics().reconciliationRuns === 1);
  await observer.refresh({ sessionIds: ["local-a"], sourceEventAt: 0 });
  await waitFor(() => calls.finishes.length === 1);

  assert.equal(calls.flows[0].options.scope, scope);
  assert.ok(calls.begins.some((entry) => entry.flow === calls.flows[0].flow
    && entry.scope === scope && entry.stage === "acquisition_normalization"));
  assert.ok(calls.durations.some((entry) => entry.stage === "source_queue" && entry.scope === scope));
  assert.equal(calls.finishes[0].flow, calls.flows[0].flow);
  assert.equal(calls.finishes[0].options.outcome, "completed");
});
