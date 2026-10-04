import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inputNotificationTime } from "../../../../server/normalize/input-notification-facts.mjs";
import { codexSessionReference } from "../../../../server/providers/codex/session-discovery.mjs";
import { createCodexLivenessCoordinator } from "../../../../server/providers/codex/liveness.mjs";
import { incrementalSourceDescriptor } from "../../../../server/providers/kernel/incremental-provider-observer.mjs";
import { initialCodexRecordedLifecycle, reduceCodexRecordedLifecycle } from "../../../../server/providers/codex/recorded-lifecycle.mjs";
const START = Date.parse("2026-08-11T12:00:00.000Z");
function boundary(offset, type, turnId) {
  return { timestamp: new Date(START + offset).toISOString(), type: "event_msg", payload: { type, turn_id: turnId } };
}
function thread(localId, options = {}) {
  return { localId, sessionId: options.sessionId || localId, parentThreadId: options.parentThreadId || null,
    sourceKind: options.parentThreadId ? "subAgentThreadSpawn" : "cli",
    updatedAt: options.updatedAt || new Date(START).toISOString(), runtimeStatus: null, rolloutFile: options.rolloutFile || null };
}

test("continuous bounded tail retains accepted and uncertain async input after the call slides out", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-async-tail-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout.jsonl");
  const line = (offset, type, payload) => JSON.stringify({ timestamp: new Date(START + offset).toISOString(), type, payload }) + "\n";
  await writeFile(rolloutFile, line(0, "turn_started", { turn_id: "tail-turn" })
    + line(1_000, "response_item", { type: "function_call", name: "request_user_input_async", call_id: "tail-question" })
    + line(2_000, "response_item", { type: "function_call_output", call_id: "tail-question", output: '{"accepted":true}' }));
  let ownerPresent = true;
  const coordinator = createCodexLivenessCoordinator({ now: () => START + 60_000, cacheMs: 0,
    maximumTailBytes: 600, maximumOwnerTailBytes: 1200, writerLockState: () => "held",
    currentWriterOwner: () => ownerPresent ? { pid: 4242, processStartIdentity: "134000000000000000" } : null });
  const threads = [thread("tail-root", { rolloutFile })];
  assert.equal(coordinator.observe(threads).sessions.get("tail-root").needsInput, true);
  for (let n = 0; n < 15; n++) {
    await appendFile(rolloutFile, line(3_000 + n * 1_000, "response_item", { type: "function_call", name: "exec", call_id: `work-${n}` }));
    const pending = coordinator.observe(threads).sessions.get("tail-root");
    assert.equal(pending.needsInput, true);
    assert.equal(inputNotificationTime(pending), new Date(START + 1_000).toISOString());
  }
  ownerPresent = false;
  assert.equal(coordinator.observe(threads).sessions.get("tail-root").needsInput, true,
    "changing acquisition budget on unchanged evidence cannot discard the pending question");
  await appendFile(rolloutFile, line(20_000, "event_msg", { type: "user_message", message: "PRIVATE_ANSWER" }));
  assert.equal(coordinator.observe(threads).sessions.get("tail-root").activityStatus, "unknown");
  for (let n = 0; n < 15; n++) {
    await appendFile(rolloutFile, line(21_000 + n * 1_000, "response_item", { type: "function_call", name: "exec", call_id: `later-${n}` }));
    assert.equal(coordinator.observe(threads).sessions.get("tail-root").activityStatus, "unknown");
  }
  await appendFile(rolloutFile, line(40_000, "turn_completed", { turn_id: "tail-turn", status: "completed" }));
  assert.equal(coordinator.observe(threads).sessions.get("tail-root").activityStatus, "idle");
});

test("multiple waiting descendants select the oldest remaining question without replacing last activity", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-async-agents-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const records = (questionAt, callId) => [boundary(0, "task_started", "multi-turn"),
    { timestamp: new Date(START + questionAt).toISOString(), type: "response_item",
      payload: { type: "function_call", name: "request_user_input_async", call_id: callId } },
    { timestamp: new Date(START + questionAt + 1_000).toISOString(), type: "response_item",
      payload: { type: "function_call_output", call_id: callId, output: '{"accepted":true}' } }];
  const childA = path.join(root, "a.jsonl"); const childB = path.join(root, "b.jsonl");
  const childWork = path.join(root, "work.jsonl");
  await writeFile(childA, records(20_000, "a").map(JSON.stringify).join("\n") + "\n");
  await writeFile(childB, records(10_000, "b").map(JSON.stringify).join("\n") + "\n");
  await writeFile(childWork, [boundary(0, "task_started", "work-turn"), { timestamp: new Date(START + 80_000).toISOString(),
    type: "response_item", payload: { type: "function_call", name: "exec", call_id: "working" } }].map(JSON.stringify).join("\n") + "\n");
  const threads = [thread("multi-root", { updatedAt: new Date(START).toISOString() }),
    thread("multi-a", { sessionId: "multi-root", parentThreadId: "multi-root", rolloutFile: childA }),
    thread("multi-b", { sessionId: "multi-root", parentThreadId: "multi-root", rolloutFile: childB }),
    thread("multi-work", { sessionId: "multi-root", parentThreadId: "multi-root", rolloutFile: childWork })];
  const coordinator = createCodexLivenessCoordinator({ now: () => START + 100_000, cacheMs: 0 });
  coordinator.observeLifecycleSources([childA, childB, childWork].map((file) => ({ file,
    generation: incrementalSourceDescriptor(file), complete: true,
    state: fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse)
      .reduce(reduceCodexRecordedLifecycle, initialCodexRecordedLifecycle()) })));
  const first = coordinator.observe(threads).sessions.get("multi-root");
  assert.equal(inputNotificationTime(first), new Date(START + 10_000).toISOString());
  assert.equal(codexSessionReference(threads[0], first).updatedAt, new Date(START + 80_000).toISOString());
  await appendFile(childB, JSON.stringify(boundary(30_000, "task_complete", "multi-turn")) + "\n");
  const next = coordinator.observe(threads).sessions.get("multi-root");
  assert.equal(inputNotificationTime(next), new Date(START + 20_000).toISOString());
  assert.equal(codexSessionReference(threads[0], next).updatedAt, new Date(START + 80_000).toISOString());
});

