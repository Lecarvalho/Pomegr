import assert from "node:assert/strict";
import test from "node:test";
import { createSessionHistoryRuntime } from "../monitor/session-history-runtime.mjs";

test("shutdown fences an active history read without waiting for unrelated provider IO", async () => {
  let release;
  let entered;
  let active = true;
  let publications = 0;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const history = createSessionHistoryRuntime({
    registry: { providers: [{ id: "codex", async readSessionHistory() {
      entered(); await gate; return { complete: true, requests: [], activity: [] };
    } }] },
    observationStore: { getByQualifiedId: () => ({ providerId: "codex", localSessionId: "synthetic", revision: 1 }) },
    historyStore: { async activityFence() { return {}; }, async publishOutcome() { publications += 1; return { accepted: true, record: {} }; } },
    ownedTraceScope: () => null,
    isActive: () => active,
  });
  history.start();
  history.refresh("codex:synthetic", 0);
  await started;
  active = false;
  history.stop();
  // Even a subsequent lifetime cannot publish an obsolete read's result.
  active = true;
  history.start();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(publications, 0);
  assert.equal(history.diagnostics().pending, 0);
});
