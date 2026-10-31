import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRepositoryInventoryRuntime } from "../../../server/repository/repository-inventory-runtime.mjs";
import { DAILY_SESSION_DAYS, dailySessionCounts, nextLocalDayMs } from "../../../server/repository/repository-daily-sessions.mjs";

// Dates are built from local calendar fields, so the days are the monitor machine's days in any time zone.
const local = (month, day, hour = 12, minute = 0) => new Date(2026, month - 1, day, hour, minute).toISOString();
const NOW = new Date(2026, 9, 31, 15, 30).getTime();
const REPOSITORY_ID = `repo-${"a".repeat(24)}`;
const row = (createdAt, extra = {}) => ({ repositoryId: REPOSITORY_ID, provider: "claude", project: "Example", createdAt, updatedAt: createdAt, isLive: false, ...extra });

test("a series holds one count for each of the last 14 local days, the oldest day first and today last", () => {
  assert.equal(DAILY_SESSION_DAYS, 14);
  const counts = dailySessionCounts([
    row(local(10, 31, 0, 0)), row(local(10, 31, 15, 0)), row(local(10, 30, 23, 59)), row(local(10, 18, 0, 0)), row(local(10, 17, 23, 59)),
  ], NOW);
  assert.equal(counts.length, 14);
  // Today and yesterday, then the 14th day back (October 18) is the first bar; October 17 is outside the window.
  assert.deepEqual(counts, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
});

test("a session with no start counts on its last update, and a row with no valid date counts nowhere", () => {
  const counts = dailySessionCounts([
    { createdAt: null, updatedAt: local(10, 29) }, { createdAt: "", updatedAt: "" }, { createdAt: "not a date", updatedAt: "nope" }, {}, null,
    // A start in the future beyond today is clock skew and counts nowhere.
    row(local(11, 2)),
  ], NOW);
  assert.deepEqual(counts, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
});

test("the series moves on at the next local midnight", () => {
  assert.equal(nextLocalDayMs(NOW), new Date(2026, 10, 1).getTime());
  const sessions = [row(local(10, 31)), row(local(10, 30))];
  assert.deepEqual(dailySessionCounts(sessions, nextLocalDayMs(NOW) + 60_000).slice(-3), [1, 1, 0]);
});

test("a repository projection carries its series, counts only, and builds it again at midnight", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-repository-daily-"));
  let clock = NOW;
  const runtime = createRepositoryInventoryRuntime({ registry: { providers: [] }, persistence: false, now: () => clock,
    storeFile: path.join(directory, "inventory.json"), gitRoot: async (cwd) => cwd });
  await runtime.ready;
  await runtime.reconcile([row(local(10, 31, 9)), row(local(10, 30, 9), { isLive: true }), row(local(10, 5, 9))]);
  const first = runtime.readRepositories().snapshot;
  const [repository] = first.value.repositories;
  assert.deepEqual(repository.dailySessions, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  assert.equal(repository.sessionCount, 3);
  // Nothing but the counts crosses: no title, working folder, or session identity.
  const allowed = new Set(["dailySessions", "displayName", "historyCount", "id", "liveCount", "name", "providerCount", "providers", "reporting", "sessionCount", "updatedAt"]);
  assert.deepEqual(Object.keys(repository).filter((key) => !allowed.has(key)), []);

  clock = nextLocalDayMs(NOW) + 5_000;
  await runtime.reconcile([row(local(10, 31, 9)), row(local(10, 30, 9), { isLive: true }), row(local(10, 5, 9))]);
  const second = runtime.readRepositories().snapshot;
  assert.ok(second.revision > first.revision, "the changed series commits a new revision");
  assert.deepEqual(second.value.repositories[0].dailySessions, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0]);
  await runtime.stopPluginObservation();
});
