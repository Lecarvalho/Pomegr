import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { FOLLOW_UP_MAX_WAIT_MS, FOLLOW_UP_QUIET_MS } from "../../../server/tasks/task-aril-follow-ups.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { REPOSITORY as REPO, createTask, withDatabase } from "./queue-test-support.mjs";

// Aril's grant follow-ups (T-183): the monitor coalesces a grant's task-log entries into one batch per burst.
const actions = { start: true, review: true, sendBack: false, merge: false, writeTasks: false };
const limits = { hours: 2, tasks: 4, tasksAtATime: 3, sendBacks: null, usagePercent: 80 };

function setup(t) {
  const directory = mkdtempSync(path.join(process.cwd(), ".follow-up-test-"));
  const clock = { now: 1700000000000 };
  const store = openTaskStore({ directory, now: () => clock.now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  createTask(store, REPO, { text: "task one" });
  createTask(store, REPO, { text: "task two" });
  const set = (settings) => assert.equal(store.apply(REPO, "aril_settings_set", { settings }).ok, true);
  set({ actions, limits, workRules: [{ kind: "text", value: "task" }] });
  const log = (number, kind, reason = null) => withDatabase(directory, (db) => db.prepare(
    "INSERT INTO task_log(repository_id, number, kind, at, pull_request, reason) VALUES (?, ?, ?, ?, NULL, ?)").run(REPO, number, kind, clock.now, reason));
  const grantId = () => withDatabase(directory, (db) => db.prepare("SELECT MAX(id) AS id FROM aril_grants WHERE repository_id = ?").get(REPO).id);
  return { store, directory, clock, set, log, grantId, start: () => assert.equal(store.apply(REPO, "grant_start", {}).ok, true) };
}
const items = (...pairs) => pairs.map(([kind, task, provider = null]) => ({ kind, task, provider }));

test("a burst of grant entries is one batch once it is quiet, and the ack settles it", (t) => {
  const { store, clock, log, start, grantId } = setup(t);
  log(1, "started");
  start();
  clock.now += 1000; log(1, "grant_merge");
  clock.now += 15_000; log(1, "grant_branch_deleted");
  clock.now += 15_000; log(2, "grant_start");
  log(2, "checks_passed");
  assert.deepEqual(store.nextFollowUps(), { ok: true, batches: [] }, "the burst is not settled yet");
  clock.now += FOLLOW_UP_QUIET_MS;
  const { batches } = store.nextFollowUps();
  assert.equal(batches.length, 1);
  const [batch] = batches;
  assert.deepEqual({ ...batch, through: undefined }, { repositoryId: REPO, grant: grantId(), through: undefined, followUps: true,
    items: items(["grant_merge", "T-1"], ["grant_branch_deleted", "T-1"], ["grant_start", "T-2"]), more: 0, ended: null });
  const ack = store.ackFollowUp(REPO, { grant: batch.grant, through: batch.through, ended: null });
  assert.deepEqual(ack, { ok: true, followUp: { repositoryId: REPO, key: `${REPO}:${batch.grant}:${batch.through}`,
    items: batch.items, more: 0, ended: null, at: new Date(clock.now).toISOString() } });
  assert.deepEqual(store.nextFollowUps().batches, [], "an acknowledged burst is never sent again");
});

test("a steady stream still reports at the longest wait, and a full page reports at once", (t) => {
  const { store, clock, log, start } = setup(t);
  start();
  for (let step = 0; step * 30_000 <= FOLLOW_UP_MAX_WAIT_MS; step += 1) {
    log(1, step % 2 ? "grant_review" : "grant_start");
    if (step * 30_000 < FOLLOW_UP_MAX_WAIT_MS) { assert.deepEqual(store.nextFollowUps().batches, []); clock.now += 30_000; }
  }
  const [batch] = store.nextFollowUps().batches;
  assert.equal(batch.items.length, 7);
  store.ackFollowUp(REPO, { grant: batch.grant, through: batch.through, ended: null });
  for (let index = 0; index < 60; index += 1) log(2, "grant_start");
  const [full] = store.nextFollowUps().batches;
  assert.equal(full.items.length, 8);
  assert.equal(full.more, 42, "a page holds 50 entries; the rest wait for the next batch");
});

test("only the grant's own follow-up kinds count; a usage entry names its provider", (t) => {
  const { store, clock, log, start } = setup(t);
  start();
  log(1, "checks_passed"); log(1, "merged"); log(1, "rework");
  log(0, "grant_usage_hold", "codex");
  clock.now += FOLLOW_UP_QUIET_MS;
  assert.deepEqual(store.nextFollowUps().batches[0].items, items(["grant_usage_hold", null, "codex"]));
});

test("a grant's end is reported once, with its reason, even with no entries", (t) => {
  const { store, clock, log, start } = setup(t);
  start();
  log(1, "grant_merge_refused");
  assert.equal(store.apply(REPO, "grant_stop", {}).ok, true);
  const [batch] = store.nextFollowUps().batches;
  assert.equal(batch.ended, "stopped", "an end does not wait for the quiet period");
  assert.deepEqual(batch.items, items(["grant_merge_refused", "T-1"]));
  assert.deepEqual(store.ackFollowUp(REPO, { grant: batch.grant, through: batch.through, ended: "expired" }), { ok: false, error: "not_eligible" });
  assert.equal(store.ackFollowUp(REPO, { grant: batch.grant, through: batch.through, ended: "stopped" }).ok, true);
  clock.now += FOLLOW_UP_MAX_WAIT_MS;
  log(1, "grant_start");
  assert.deepEqual(store.nextFollowUps().batches, [], "an entry after the grant ended is not the grant's");
  assert.deepEqual(store.ackFollowUp(REPO, { grant: batch.grant, through: batch.through, ended: "stopped" }), { ok: false, error: "not_eligible" }, "the end is reported once");
});

test("with follow-ups off a batch is settled unwritten and commits no notification", (t) => {
  const { store, clock, log, set, start } = setup(t);
  set({ followUps: false });
  start();
  log(1, "grant_merge");
  clock.now += FOLLOW_UP_QUIET_MS;
  const [batch] = store.nextFollowUps().batches;
  assert.equal(batch.followUps, false);
  assert.deepEqual(store.ackFollowUp(REPO, { grant: batch.grant, through: batch.through, ended: null }), { ok: true, followUp: null });
  assert.deepEqual(store.nextFollowUps().batches, []);
});

test("a new grant starts at the log's end, and a repository seen first is a baseline", (t) => {
  const { store, clock, log, start, directory } = setup(t);
  start();
  log(1, "grant_start");
  assert.equal(store.apply(REPO, "grant_stop", {}).ok, true);
  withDatabase(directory, (db) => db.prepare("DELETE FROM task_log_cursors WHERE consumer = 'followups'").run());
  assert.deepEqual(store.nextFollowUps().batches, [], "what happened before follow-ups existed is not reported");
  clock.now += FOLLOW_UP_MAX_WAIT_MS;
  assert.deepEqual(store.nextFollowUps().batches, []);
  log(2, "grant_review");
  start();
  log(1, "grant_start");
  clock.now += FOLLOW_UP_QUIET_MS;
  assert.deepEqual(store.nextFollowUps().batches.map((batch) => batch.items), [items(["grant_start", "T-1"])]);
});

test("an ack is exact and only moves the cursor forward", (t) => {
  const { store, clock, log, start, grantId } = setup(t);
  start();
  log(1, "grant_start");
  clock.now += FOLLOW_UP_QUIET_MS;
  const [batch] = store.nextFollowUps().batches;
  for (const payload of [{}, { grant: batch.grant, through: batch.through }, { grant: "1", through: batch.through, ended: null },
    { grant: batch.grant, through: -1, ended: null }, { grant: batch.grant, through: batch.through, ended: null, extra: 1 }]) {
    assert.deepEqual(store.ackFollowUp(REPO, payload), { ok: false, error: "invalid" });
  }
  assert.deepEqual(store.ackFollowUp("repo-bad", { grant: batch.grant, through: batch.through, ended: null }), { ok: false, error: "invalid" });
  assert.deepEqual(store.ackFollowUp(REPO, { grant: grantId() + 1, through: batch.through, ended: null }), { ok: false, error: "not_eligible" });
  assert.deepEqual(store.ackFollowUp(REPO, { grant: batch.grant, through: batch.through + 99, ended: null }), { ok: false, error: "not_eligible" });
  assert.deepEqual(store.ackFollowUp(REPO, { grant: batch.grant, through: batch.through, ended: "stopped" }), { ok: false, error: "not_eligible" }, "an active grant has no end");
  assert.equal(store.ackFollowUp(REPO, { grant: batch.grant, through: batch.through, ended: null }).ok, true);
  assert.deepEqual(store.ackFollowUp(REPO, { grant: batch.grant, through: batch.through - 1, ended: null }), { ok: false, error: "not_eligible" });
});
