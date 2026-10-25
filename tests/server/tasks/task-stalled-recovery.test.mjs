import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveTaskCheckFacts, resolveTaskSessionFacts } from "../../../server/runtime/task-session-lookup.mjs";
import { createTaskStallWatcher, END_CONFIRM_DELAY_MS } from "../../../server/tasks/task-stall.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { passingGates } from "./queue-test-support.mjs";

test("Pokrr T-3 shape: an ended session leaves dirty work and no report, then the persisted stall needs the owner", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-t3-stalled-"));
  const repositoryId = `repo-${"a1".repeat(12)}`;
  const sessionId = "codex:019a0000-2222-7333-8444-555566667777";
  let now = Date.parse("2026-10-25T12:00:00Z");
  let state = "working";
  const committed = {
    session: { repository: { available: true, branch: "tasks/T-3", readAt: new Date(now).toISOString(), files: [] } },
    agents: [{ id: "primary", liveness: { reason: "writer_present" } }],
  };
  const observation = {
    observationStore: { get: () => ({ publicState: committed }) },
    catalogSessions: () => [{ id: sessionId, activityStatus: state }],
  };
  const facts = (id) => resolveTaskSessionFacts(id, observation);
  const storeOptions = { directory, now: () => now };
  let store = openTaskStore(storeOptions);
  const timers = [];
  const watcher = createTaskStallWatcher({ taskStore: store, resolveSessionFacts: facts,
    subscribe: () => () => {}, now: () => now,
    setTimer: (run, delay) => { timers.push({ run, delay }); return timers.length; },
    clearTimer: (handle) => { timers[handle - 1] = null; },
  });
  try {
    for (let number = 1; number <= 3; number += 1) {
      assert.equal(store.apply(repositoryId, "create", { text: `Synthetic task ${number}`,
        completeWhen: { checks: ["tree_clean"], own: null } }).ok, true);
    }
    const planned = store.planStart(repositoryId, { id: "T-3" },
      () => ({ root: directory, pluginReady: true }), passingGates);
    assert.equal(planned.ok, true);
    assert.deepEqual(store.bindSession({ token: planned.plan.token, sessionId }), { ok: true });
    const task = () => store.readBoard(repositoryId).tasks.find((item) => item.id === "T-3");
    assert.equal(task().session?.id, sessionId);
    assert.equal(task().report, null);
    committed.session.repository.files.push({ status: "modified", path: "src/example.ts" });
    assert.equal(resolveTaskCheckFacts(sessionId, observation).treeClean, false);
    watcher.sweep();
    assert.equal(task().state, "not_queued");

    state = "stopped";
    committed.agents[0].liveness.reason = "writer_released";
    watcher.sweep();
    assert.equal(task().state, "not_queued");
    now += END_CONFIRM_DELAY_MS - 1;
    watcher.sweep();
    assert.equal(task().state, "not_queued");
    // A quiet catalog still confirms the end through the watcher's own timer.
    assert.equal(timers.at(-1).delay, END_CONFIRM_DELAY_MS + 50);
    now += 51;
    timers.at(-1).run();
    assert.equal(task().state, "stalled");
    assert.equal(task().report, null);
    assert.equal(resolveTaskCheckFacts(sessionId, observation).treeClean, false);
    watcher.stop();

    store.close();
    store = openTaskStore(storeOptions);
    assert.equal(task().state, "stalled");
    assert.equal(task().session?.id, sessionId);
    assert.equal(task().report, null);
    assert.deepEqual(store.readHome()?.attention, [
      { repositoryId, taskId: "T-3", title: "Synthetic task 3", state: "stalled" },
    ]);
  } finally {
    watcher.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
