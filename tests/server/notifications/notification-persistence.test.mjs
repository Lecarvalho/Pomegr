import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNotificationPersistence, normalizeNotificationPersistence } from "../../../server/notifications/notification-persistence.mjs";
import { createNotificationObservation } from "../../../server/runtime/notification-observation.mjs";
import { createMonitorRuntime } from "../../../server/server.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../../../shared/monitor-state.mjs";

const START = Date.parse("2026-10-03T12:00:00.000Z");
const profile = (value) => createHash("sha256").update(value).digest("hex");
const row = (needsInput, at, title = "Synthetic session") => ({
  id: "codex:synthetic", provider: "codex", title, updatedAt: new Date(at).toISOString(),
  isLive: true, needsInput,
});
const commit = (observation, revision, needsInput, at = START, title) => observation.acceptCatalogCommit({
  revision, readiness: "ready", sessions: [row(needsInput, at, title)], activeSessionOverflow: 0,
});

async function fixture(context, scope = "profile-a") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-notifications-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const persistence = (source = scope, options = {}) => createNotificationPersistence({
    directory, profileScope: profile(source), now: () => options.time ?? START, ...options,
  });
  return { directory, persistence };
}

test("missing store migrates to baseline; restart rebases producer revisions without replay or ID collision", async (context) => {
  const { directory, persistence } = await fixture(context);
  let clock = START;
  const first = createNotificationObservation({ now: () => clock, persistence: persistence(), sourceScope: "profile-a" });
  assert.equal(await first.start(), "missing");
  commit(first, 500, true);
  const original = first.readSnapshot().occurrences[0];
  assert.equal(original.deliveryEligible, false);
  await first.stop();

  const second = createNotificationObservation({ now: () => clock, persistence: persistence(), sourceScope: "profile-a" });
  assert.equal(await second.start(), "restored");
  assert.equal(second.readSnapshot().occurrences[0].id, original.id);
  commit(second, 1, true);
  assert.equal(second.readSnapshot().occurrences[0].id, original.id);
  assert.equal(second.readSnapshot().occurrences.length, 1);
  clock += 1000;
  commit(second, 2, false, clock);
  clock += 1000;
  commit(second, 3, true, clock);
  const recurrence = second.readSnapshot().occurrences.find((item) => item.lifecycle === "active");
  assert.notEqual(recurrence.id, original.id);
  assert.equal(recurrence.deliveryEligible, true);
  await second.stop();
  const bytes = await fs.readFile(path.join(directory, "notifications-v1.json"), "utf8");
  assert.doesNotMatch(bytes, /profile-a|Synthetic session.*profile-a/u);
  assert.equal(JSON.parse(bytes).sequence, 2);
});

test("changed private profile starts clean and replaces the prior valid scope only after a fresh baseline", async (context) => {
  const { directory, persistence } = await fixture(context);
  const first = createNotificationObservation({ now: () => START, persistence: persistence(), sourceScope: "profile-a" });
  await first.start();
  commit(first, 1, true);
  const priorId = first.readSnapshot().occurrences[0].id;
  await first.stop();

  const changed = createNotificationObservation({ now: () => START, persistence: persistence("profile-b"), sourceScope: "profile-b" });
  assert.equal(await changed.start(), "profile_changed");
  assert.equal(changed.readSnapshot().occurrences.length, 0);
  commit(changed, 1, true);
  assert.equal(changed.readSnapshot().occurrences[0].deliveryEligible, false);
  assert.notEqual(changed.readSnapshot().occurrences[0].id, priorId);
  await changed.stop();
  const record = JSON.parse(await fs.readFile(path.join(directory, "notifications-v1.json"), "utf8"));
  assert.equal(record.profileScope, profile("profile-b"));
});

test("resolved rows age out on restore while active conditions and original times survive", async (context) => {
  const { persistence } = await fixture(context);
  let clock = START;
  const first = createNotificationObservation({ now: () => clock, persistence: persistence(), sourceScope: "profile-a" });
  await first.start();
  commit(first, 1, true);
  commit(first, 2, false, START + 1000);
  await first.stop();
  clock += 31 * 24 * 60 * 60_000;
  const second = createNotificationObservation({ now: () => clock, persistence: persistence("profile-a", { now: () => clock }), sourceScope: "profile-a" });
  assert.equal(await second.start(), "restored");
  assert.equal(second.readSnapshot().occurrences.length, 0);
  commit(second, 1, true, clock);
  assert.equal(second.readSnapshot().occurrences[0].deliveryEligible, true, "retained baseline prevents startup replay while allowing a real recurrence");
  await second.stop();
});

test("corrupt, oversized, and newer records are rejected as a whole and never overwritten", async (context) => {
  const { directory, persistence } = await fixture(context);
  const target = path.join(directory, "notifications-v1.json");
  for (const content of ["{broken", JSON.stringify({ version: 99 }), "x".repeat(1024 * 1024 + 1)]) {
    await fs.writeFile(target, content);
    const store = persistence();
    assert.equal((await store.load()).status, "invalid");
    assert.equal(await store.write({}), false);
    assert.equal(await fs.readFile(target, "utf8"), content);
  }
});

test("whole-record validation rejects private fields, broken active mappings, and excess baselines", async (context) => {
  const { directory, persistence } = await fixture(context);
  const observation = createNotificationObservation({ now: () => START, persistence: persistence(), sourceScope: "profile-a" });
  await observation.start();
  commit(observation, 1, true);
  await observation.stop();
  const target = path.join(directory, "notifications-v1.json");
  const valid = JSON.parse(await fs.readFile(target, "utf8"));
  assert.ok(normalizeNotificationPersistence(valid, profile("profile-a"), START));
  for (const mutate of [
    (value) => { value.snapshot.occurrences[0].data.command = "PRIVATE"; },
    (value) => { value.active[0][1] = "0".repeat(32); },
    (value) => { value.snapshot.occurrences[0].id = [value.snapshot.occurrences[0].id]; },
    (value) => { value.identitySeed = [value.identitySeed]; },
    (value) => { value.profileScope = [value.profileScope]; },
    (value) => { value.active[0][1] = [value.active[0][1]]; },
    (value) => { value.baselines = Array.from({ length: 17 }, (_, index) => `needs_input\u0000${String(index).padStart(64, "0")}`); },
    (value) => { value.sourcePath = "PRIVATE"; },
  ]) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.equal(normalizeNotificationPersistence(candidate, profile("profile-a"), START), null);
  }
});

test("failed atomic replacement preserves the last durable revision", async (context) => {
  const { directory, persistence } = await fixture(context);
  const first = createNotificationObservation({ now: () => START, persistence: persistence(), sourceScope: "profile-a" });
  await first.start();
  commit(first, 1, true);
  await first.stop();
  const target = path.join(directory, "notifications-v1.json");
  const before = await fs.readFile(target, "utf8");
  const failing = persistence("profile-a", { filesystem: { ...fs, rename: async () => { throw new Error("synthetic rename failure"); } } });
  assert.equal((await failing.load()).status, "restored");
  const state = normalizeNotificationPersistence(JSON.parse(before), profile("profile-a"), START).state;
  state.snapshot.revision += 1;
  assert.equal(await failing.write(state), false);
  assert.equal(await fs.readFile(target, "utf8"), before);
});

test("monitor composition binds persistence to the real private provider-folder profile", async (context) => {
  const { directory } = await fixture(context);
  const makeRuntime = (scope) => {
    let publisher;
    const provider = { id: "codex", source: "Codex", catalogSourceScope: profile(scope), capabilities: createEmptyProviderCapabilities() };
    const registry = {
      providers: [provider], defaultProvider: provider,
      providerFolders: { folders: { codexHome: `C:/private/${scope}` } },
      async readUsageLimits() { return createEmptyUsageLimits(); },
      async readServiceStatus() { return { status: "operational", updatedAt: new Date(START).toISOString(), incidents: [] }; },
      async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
      async startObservers(value) { publisher = value; return { async stop() {} }; },
    };
    const runtime = createMonitorRuntime({ providerRegistry: registry, monitorStore: false,
      pomegrPaths: { environment: { POMEGR_DATA_DIR: directory } }, now: () => START,
      observationCommitDelayMs: 0, scheduleObservation: (task) => setTimeout(task, 0),
      resourceUsageSampler: { async sample() {}, get() { return null; } },
    });
    return { runtime, publish: (value) => publisher.publishCatalog("codex", value) };
  };
  const first = makeRuntime("a");
  await first.runtime.startObservation();
  first.publish([{ localId: "synthetic", title: "Synthetic", createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(), isLive: true, needsInput: true, activityStatus: "needs_input" }]);
  for (let attempt = 0; attempt < 50 && !first.runtime.serveNotifications().snapshot.value.occurrences.length; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const original = first.runtime.serveNotifications().snapshot.value.occurrences[0];
  assert.ok(original);
  await first.runtime.stopObservation();

  const second = makeRuntime("b");
  await second.runtime.startObservation();
  assert.equal(second.runtime.serveNotifications().snapshot.value.occurrences.length, 0);
  await second.runtime.stopObservation();
  const stored = await fs.readFile(path.join(directory, "notifications-v1", "notifications-v1.json"), "utf8");
  assert.doesNotMatch(stored, /C:\/private\/|"profile-a"|"profile-b"/u);
});
