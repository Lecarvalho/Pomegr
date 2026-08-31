import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_ROLLOUT_LIVE_WINDOW_MS } from "../monitor/providers/codex-lifecycle-constants.mjs";
import { codexRecordedLiveness, initialCodexRecordedLifecycle, reduceCodexRecordedLifecycle } from "../monitor/providers/codex-recorded-lifecycle.mjs";

const START = Date.parse("2026-08-11T12:00:00.000Z");

function record(offset, type, payload = {}) {
  return { timestamp: new Date(START + offset).toISOString(), type, payload };
}

function reduce(records) {
  return records.reduce(reduceCodexRecordedLifecycle, initialCodexRecordedLifecycle());
}

test("recent provider activity keeps a long-running open turn active", () => {
  const state = reduce([
    record(0, "event_msg", { type: "task_started", turn_id: "turn-long" }),
    record(20 * 60_000, "response_item", { type: "function_call", name: "shell", call_id: "tool-1", turn_id: "turn-long" }),
  ]);
  assert.equal(codexRecordedLiveness(state, { now: START + 20 * 60_000 + 1_000 }).status, "active");
  assert.equal(state.latestActivityAt, new Date(START + 20 * 60_000).toISOString());
});

test("same-turn context preserves a pending structured input until its matching output", () => {
  const waiting = reduce([
    record(0, "turn_started", { turn_id: "turn-input" }),
    record(1_000, "response_item", { type: "function_call", name: "request_user_input", call_id: "input-1", turn_id: "turn-input" }),
    record(2_000, "turn_context", { turn_id: "turn-input" }),
  ]);
  assert.equal(codexRecordedLiveness(waiting, { now: START + 3_000 }).status, "needs_input");
  const answered = reduceCodexRecordedLifecycle(waiting, record(4_000, "response_item", { type: "function_call_output", call_id: "input-1", turn_id: "turn-input" }));
  assert.equal(codexRecordedLiveness(answered, { now: START + 5_000 }).status, "active");
});

test("native completion is retained while mismatched terminal boundaries are ignored", () => {
  const state = reduce([
    record(0, "turn_started", { turn_id: "turn-complete" }),
    record(1_000, "turn_completed", { turn_id: "other-turn", status: "completed" }),
    record(2_000, "turn_completed", { turn_id: "turn-complete", status: "completed" }),
  ]);
  const liveness = codexRecordedLiveness(state, { now: START + 3_000 });
  assert.equal(liveness.status, "idle");
  assert.equal(liveness.observedAt, new Date(START + 2_000).toISOString());
});

test("wrong-turn outputs and unrelated records cannot refresh or clear retained lifecycle", () => {
  const waiting = reduce([
    record(0, "turn_started", { turn_id: "turn-current" }),
    record(1_000, "response_item", { type: "function_call", name: "request_user_input", call_id: "input-current", turn_id: "turn-current" }),
    record(2_000, "response_item", { type: "function_call_output", call_id: "input-current", turn_id: "other-turn" }),
  ]);
  assert.equal(waiting.latestActivityAt, new Date(START + 1_000).toISOString());
  assert.equal(codexRecordedLiveness(waiting, { now: START + 3_000 }).status, "needs_input");

  const completed = reduce([
    record(0, "turn_started", { turn_id: "turn-idle" }),
    record(1_000, "turn_completed", { turn_id: "turn-idle", status: "completed" }),
    record(119_000, "response_item", { type: "not_a_provider_activity", turn_id: "turn-idle" }),
  ]);
  const stale = codexRecordedLiveness(completed, { now: START + CODEX_ROLLOUT_LIVE_WINDOW_MS + 1_001 });
  assert.equal(stale.status, "idle");
  assert.equal(stale.live, false);
  assert.equal(stale.observedAt, new Date(START + 1_000).toISOString());
});

test("an explicit typed pending input can prove needs-input without a turn boundary", () => {
  const state = reduce([record(0, "response_item", {
    type: "custom_tool_call", name: "request_user_input", call_id: "input-without-turn",
  })]);
  const liveness = codexRecordedLiveness(state, { now: START + 1_000 });
  assert.equal(liveness.status, "needs_input");
  assert.equal(liveness.needsInputKind, "user_input");
});

test("malformed records and incomplete acquisition never claim a known lifecycle", () => {
  const initial = initialCodexRecordedLifecycle();
  const malformed = reduceCodexRecordedLifecycle(initial, record(0, "response_item", { type: "not_a_provider_activity", secret: "MUST_NOT_RETAIN" }));
  assert.deepEqual(malformed, initial);
  const active = reduceCodexRecordedLifecycle(initial, record(0, "turn_started", { turn_id: "turn-partial" }));
  const incomplete = codexRecordedLiveness(active, { now: START + 1_000, complete: false });
  assert.equal(incomplete.status, "unknown");
  assert.equal(incomplete.evidence, "unavailable");
});

test("quiet recorded lifecycle retains an open turn without manufacturing a heartbeat", () => {
  const state = reduce([record(0, "turn_started", { turn_id: "turn-silent" })]);
  const stale = codexRecordedLiveness(state, { now: START + CODEX_ROLLOUT_LIVE_WINDOW_MS + 1 });
  assert.deepEqual(stale, {
    live: true,
    status: "active",
    needsInput: false,
    source: "structured_lifecycle",
    observedAt: new Date(START).toISOString(),
    evidence: "observed",
    freshness: "current",
  });
});

test("silent work and typed input remain unresolved for hours, then matching evidence ends them", () => {
  let state = reduce([record(0, "event_msg", { type: "task_started", turn_id: "long-turn" })]);
  const hoursLater = 4 * 60 * 60_000;
  const active = codexRecordedLiveness(state, { now: START + hoursLater });
  assert.equal(active.status, "active");
  assert.equal(active.live, true);
  assert.equal(active.observedAt, new Date(START).toISOString());
  state = reduceCodexRecordedLifecycle(state, record(1_000, "response_item", {
    type: "function_call", name: "request_user_input", call_id: "input", turn_id: "long-turn",
  }));
  assert.equal(codexRecordedLiveness(state, { now: START + hoursLater }).status, "needs_input");
  state = reduceCodexRecordedLifecycle(state, record(hoursLater, "response_item", {
    type: "function_call_output", call_id: "input", turn_id: "long-turn",
  }));
  assert.equal(codexRecordedLiveness(state, { now: START + hoursLater + 1 }).status, "active");
  state = reduceCodexRecordedLifecycle(state, record(hoursLater + 2, "event_msg", {
    type: "task_complete", turn_id: "long-turn",
  }));
  const completed = codexRecordedLiveness(state, { now: START + 2 * hoursLater });
  assert.equal(completed.status, "idle");
  assert.equal(completed.live, false);
  state = reduceCodexRecordedLifecycle(state, record(hoursLater + 3, "turn_context", { turn_id: "long-turn" }));
  assert.equal(codexRecordedLiveness(state, { now: START + 2 * hoursLater }).status, "idle");
});

test("interrupted and failed turns stay stopped while incomplete observation stays unknown", () => {
  for (const type of ["task_interrupted", "task_failed"]) {
    const state = reduce([
      record(0, "event_msg", { type: "task_started", turn_id: "stopped-turn" }),
      record(1_000, "event_msg", { type, turn_id: "stopped-turn" }),
    ]);
    const now = START + 60 * 60_000;
    assert.equal(codexRecordedLiveness(state, { now }).status, "stopped");
    assert.equal(codexRecordedLiveness(state, { now }).live, false);
    assert.equal(codexRecordedLiveness(state, { now, complete: false }).status, "unknown");
  }
});
