import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_ROLLOUT_LIVE_WINDOW_MS } from "../../../../server/providers/codex/lifecycle-constants.mjs";
import { codexRecordedLiveness, initialCodexRecordedLifecycle, reduceCodexRecordedLifecycle } from "../../../../server/providers/codex/recorded-lifecycle.mjs";
import { parseCodexRolloutLiveness } from "../../../../server/providers/codex/rollout-lifecycle.mjs";

const START = Date.parse("2026-08-11T12:00:00.000Z");

function record(offset, type, payload = {}) {
  return { timestamp: new Date(START + offset).toISOString(), type, payload };
}

function reduce(records) {
  return records.reduce(reduceCodexRecordedLifecycle, initialCodexRecordedLifecycle());
}

const asyncCall = (offset = 1_000, call_id = "async-private", extra = {}) => record(offset, "response_item", {
  type: "function_call", name: "functions.request_user_input_async", call_id,
  arguments: JSON.stringify({ questions: [{ title: "PRIVATE_QUESTION", options: ["PRIVATE_OPTION"] }] }),
  internal_chat_message_metadata_passthrough: { turn_id: "async-turn" }, ...extra,
});
const asyncOutput = (offset = 2_000, call_id = "async-private", output = '{"accepted":true}', extra = {}) => record(offset, "response_item", {
  type: "function_call_output", call_id, output,
  internal_chat_message_metadata_passthrough: { turn_id: "async-turn" }, ...extra,
});
const asyncStart = record(0, "turn_started", { turn_id: "async-turn" });

function equivalentInputs(records, expected, now = START + 8_000) {
  const state = reduce(records);
  const retained = codexRecordedLiveness(state, { now });
  const tail = parseCodexRolloutLiveness(records, { now });
  assert.equal(retained?.status, expected);
  assert.equal(tail?.status, expected);
  if (["needs_input", "unknown"].includes(expected)) assert.deepEqual(tail, retained);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_QUESTION|PRIVATE_OPTION|PRIVATE_ANSWER|PRIVATE_RESULT/);
  return state;
}

test("async acceptance confirms outstanding action through continued work and repeated acknowledgements", () => {
  equivalentInputs([asyncStart, asyncCall()], "unknown");
  const records = [asyncStart, asyncCall(), asyncOutput(), record(3_000, "response_item", {
    type: "function_call", name: "exec", call_id: "work", arguments: "PRIVATE_RESULT",
  }), asyncCall(4_000), asyncOutput(5_000)];
  const state = equivalentInputs(records, "needs_input", START + 4 * 60 * 60_000);
  assert.equal(state.pendingInputs[0].observedAt, new Date(START + 1_000).toISOString());
  assert.equal(codexRecordedLiveness(state, { now: START + 20_000, complete: false }).status, "unknown");
});

test("async rejected submissions cannot leave a confirmed wait; malformed results stay uncertain", () => {
  equivalentInputs([asyncStart, asyncCall(), asyncOutput(2_000, "async-private", '{"accepted":false}')], "active");
  for (const output of ["PRIVATE_RESULT", '{"error":"PRIVATE_RESULT"}', "x".repeat(65_537), '{"accepted":"true"}']) {
    equivalentInputs([asyncStart, asyncCall(), asyncOutput(2_000, "async-private", output)], "unknown");
  }
});

test("generic user arrivals create uncertainty without answering async or clearing synchronous questions", () => {
  for (const user of [record(3_000, "event_msg", { type: "user_message", message: "PRIVATE_ANSWER" }),
    record(3_000, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "PRIVATE_ANSWER" }],
      internal_chat_message_metadata_passthrough: { turn_id: "async-turn", content_item_kinds: ["user.text"] } })]) {
    const records = [asyncStart, asyncCall(), asyncOutput(), user, asyncOutput(4_000)];
    const state = equivalentInputs(records, "unknown");
    assert.equal(state.pendingInputs.length, 1, "uncertainty is retained rather than asserted answered");
    const sync = record(2_500, "response_item", { type: "custom_tool_call", name: "functions/request_user_input", call_id: "sync" });
    equivalentInputs([asyncStart, asyncCall(), asyncOutput(), sync, user], "needs_input");
    equivalentInputs([asyncStart, asyncCall(), asyncOutput(), sync, user,
      record(4_000, "response_item", { type: "custom_tool_call_output", call_id: "sync" })], "unknown");
  }
});

test("wrong-turn, unrelated and older records never resolve or manufacture an async question", () => {
  const base = [asyncStart, asyncCall(), asyncOutput()];
  for (const extra of [asyncOutput(3_000, "other", '{"accepted":false}'),
    asyncOutput(3_000, "async-private", '{"accepted":false}', { turn_id: "wrong-turn" }),
    record(3_000, "response_item", { type: "message", role: "user", content: "PRIVATE_ANSWER",
      internal_chat_message_metadata_passthrough: { turn_id: "wrong-turn" } }),
    record(500, "event_msg", { type: "user_message", message: "PRIVATE_ANSWER" }),
    asyncOutput(500, "async-private", '{"accepted":false}')]) equivalentInputs([...base, extra], "needs_input");
  equivalentInputs([asyncStart, asyncOutput(), asyncCall(500)], "active");
  equivalentInputs([asyncStart, asyncCall(1_000, "wrong", { turn_id: "wrong-turn" }), asyncOutput(2_000, "wrong")], "active");
  for (const name of ["request_user_input_async_extra", "some_request_user_input_async", "exec"]) {
    equivalentInputs([asyncStart, asyncCall(1_000, "async-private", { name }), asyncOutput()], "active");
  }
});

test("multiple questions preserve the oldest outstanding time and turn boundaries cancel their turn scope", () => {
  const base = [asyncStart, asyncCall(), asyncOutput(), asyncCall(3_000, "second"), asyncOutput(4_000, "second")];
  const state = equivalentInputs(base, "needs_input");
  assert.equal(state.pendingInputs.length, 2);
  assert.equal(codexRecordedLiveness(state, { now: START + 20_000 }).observedAt, new Date(START + 1_000).toISOString());
  for (const type of ["task_complete", "turn_aborted", "task_failed"]) {
    const ended = equivalentInputs([...base, record(5_000, "event_msg", { type, turn_id: "async-turn" })],
      type === "task_complete" ? "idle" : "stopped");
    assert.equal(ended.pendingInputs.length, 0);
  }
  equivalentInputs([...base, record(5_000, "turn_started", { turn_id: "new-turn" }), asyncOutput(6_000)], "active");
  equivalentInputs([...base, record(5_000, "turn_context", { turn_id: "async-turn" })], "needs_input");
});

test("delayed completion and new-turn context cannot cancel a newer accepted question", () => {
  const base = [asyncStart, asyncCall(), asyncOutput()];
  for (const older of [record(500, "turn_completed", { turn_id: "async-turn", status: "completed" }),
    record(500, "turn_context", { turn_id: "different-turn" })]) {
    const state = reduce([...base, older]);
    assert.equal(codexRecordedLiveness(state, { now: START + 8_000 }).status, "needs_input");
    assert.equal(state.turn.turnId, "async-turn");
    assert.equal(state.pendingInputs.length, 1);
  }
});

test("overflow stays bounded and uncertain until a turn boundary; restart replay reconstructs private state", () => {
  const records = [asyncStart];
  for (let n = 0; n < 20; n++) records.push(asyncCall(100 + n * 2, `q-${n}`), asyncOutput(101 + n * 2, `q-${n}`));
  const pending = equivalentInputs(records, "needs_input");
  assert.equal(pending.pendingInputs.length, 16);
  assert.equal(pending.inputOverflow, true);
  assert.deepEqual(reduce(records), pending, "cold replay reconstructs the same private state");
  records.push(record(1_000, "event_msg", { type: "user_message", message: "PRIVATE_ANSWER" }));
  const uncertain = equivalentInputs(records, "unknown");
  assert.equal(uncertain.pendingInputs.length, 16);
  const ended = reduce([...records, record(2_000, "turn_completed", { turn_id: "async-turn" })]);
  assert.equal(ended.inputOverflow, false);
});

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
