import assert from "node:assert/strict";
import test from "node:test";
import { createMonitorRuntime, createMonitorServer } from "../../../server/server.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../../../shared/monitor-state.mjs";
import { createNotificationObservation } from "../../../server/runtime/notification-observation.mjs";
import { withUsageNotificationSource } from "../../../server/normalize/usage-notification-facts.mjs";
import { createCoordinatedUsageLimitsReader } from "../../../server/normalize/usage-limits.mjs";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const timestamp = new Date(NOW).toISOString();

test("background usage commits drive notifications while GETs remain passive and deadlines obey cooldown", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  let reads = 0;
  const coordinator = createCoordinatedUsageLimitsReader({ read: async () => {
    reads += 1;
    return [
      { id: "current-session", label: "Current session", window: "5 hours", percent: reads === 1 ? 100 : 0,
        active: reads === 1, severity: reads === 1 ? "critical" : "normal", resetsAt: new Date(NOW + (reads === 1 ? 60_000 : 1000_000)).toISOString() },
      { id: "all-models", label: "All models", window: "7 days", percent: 100, active: true, severity: "critical", resetsAt: new Date(NOW + 7 * 86400_000).toISOString() },
    ];
  } });
  const provider = { id: "claude", source: "Claude Code", capabilities: createEmptyProviderCapabilities() };
  const registry = { providers: [provider], defaultProvider: provider,
    async readUsageLimits() { return withUsageNotificationSource(await coordinator.get(), "a".repeat(64)); },
    async readServiceStatus() { return { status: "operational", updatedAt: timestamp, incidents: [] }; },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    async startObservers() { return { async stop() {} }; },
  };
  const runtime = createMonitorRuntime({ providerRegistry: registry, monitorStore: false, checkpointStore: false,
    resourceUsageSampler: { async sample() {}, get() { return null; } } });
  context.after(() => runtime.stopObservation());
  await runtime.startObservation();
  await waitFor(() => runtime.serveUsageLimits().snapshot.value.providers.length === 1);
  assert.equal(reads, 1);
  context.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(runtime.serveNotifications().snapshot.value.occurrences.length, 0);
  context.mock.timers.tick(240_000);
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(60_000); // Existing coordinator publishes its completed cached read on the next observation.
  await waitFor(() => runtime.serveNotifications().snapshot.value.occurrences.length === 1);
  const server = createMonitorServer({ runtime });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/notifications`;
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(body.occurrences[0].kind, "usage_window_reset");
  assert.equal(body.occurrences[0].data.otherExhausted, true);
  const before = reads;
  for (let index = 0; index < 5; index += 1) assert.deepEqual(await (await fetch(url)).json(), body);
  assert.equal(reads, before);
  assert.doesNotMatch(JSON.stringify(body), /sourceScope|comparison|percent|resetsAt/);
});

test("failed notification derivation retains serialized cache and shutdown rejects new commits", () => {
  let clock = NOW;
  const observation = createNotificationObservation({ now: () => clock });
  const row = { id: "codex:synthetic", provider: "codex", title: "Synthetic", updatedAt: timestamp, isLive: true, needsInput: true };
  observation.acceptCatalogCommit({ revision: 1, readiness: "ready", sessions: [row] });
  const previous = observation.read();
  clock = NaN;
  assert.doesNotThrow(() => observation.acceptCatalogCommit({ revision: 2, readiness: "ready", sessions: [{ ...row, needsInput: false }] }));
  assert.equal(observation.read().snapshot.value, previous.snapshot.value);
  assert.equal(observation.read().snapshot.serialized, previous.snapshot.serialized);
  clock = NOW;
  observation.stop();
  observation.acceptCatalogCommit({ revision: 3, readiness: "ready", sessions: [{ ...row, needsInput: false }] });
  assert.equal(observation.read().revision, previous.revision);
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("Expected committed notification revision");
}

test("committed catalog projection retains older Needs input beyond the browser shell", async (context) => {
  let publisher;
  let statusReads = 0;
  let catalogReads = 0;
  const providers = ["claude", "codex"].map((id) => ({
    id, source: id === "claude" ? "Claude Code" : "Codex", capabilities: createEmptyProviderCapabilities(),
  }));
  const registry = {
    providers, defaultProvider: providers[0], providerForSessionId: (id) => providers.find((provider) => id.startsWith(`${provider.id}:`)),
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async readServiceStatus() { statusReads += 1; return { status: "operational", updatedAt: timestamp, incidents: [] }; },
    async inspectSessions() { catalogReads += 1; return { sessions: [], resourceTargets: [] }; },
    async startObservers(value) { publisher = value; return { async stop() {} }; },
  };
  const runtime = createMonitorRuntime({ providerRegistry: registry, monitorStore: false, checkpointStore: false,
    now: () => NOW, observationCommitDelayMs: 0, scheduleObservation: (task) => setTimeout(task, 0),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  context.after(() => runtime.stopObservation());
  const server = createMonitorServer({ runtime });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/notifications`;

  const initial = await fetch(url);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).revision, 0);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  const eventsController = new AbortController();
  const events = await fetch(`http://127.0.0.1:${server.address().port}/api/events`, { signal: eventsController.signal });
  const firstEvent = new TextDecoder().decode((await events.body.getReader().read()).value);
  assert.match(firstEvent, /event: notifications\ndata: \{"domain":"notifications","revision":0\}/);
  eventsController.abort();

  await runtime.startObservation();
  const newRows = Array.from({ length: 240 }, (_, index) => ({ localId: `new-${index}`, title: "Recent session",
    createdAt: new Date(NOW - index * 1000).toISOString(), updatedAt: timestamp,
    isLive: true, needsInput: false, activityStatus: "working" }));
  const oldNeeds = { localId: "older-needs", title: "Older needs input", createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: timestamp, isLive: true, needsInput: true, activityStatus: "needs_input" };
  publisher.publishCatalog("claude", newRows);
  publisher.publishCatalog("codex", [oldNeeds]);
  await waitFor(() => runtime.serveNotifications().snapshot.value.occurrences.some((row) => row.kind === "needs_input"));
  assert.equal(runtime.serveCatalog().snapshot.value.sessions.length, 200);
  assert.equal(runtime.serveCatalog().snapshot.value.sessions.some((row) => row.id === "codex:older-needs"), false);
  const snapshot = runtime.serveNotifications().snapshot.value;
  assert.equal(snapshot.occurrences.find((row) => row.kind === "needs_input").data.sessionId, "codex:older-needs");
  assert.equal(snapshot.activeSessionOverflow, 0);
  assert.equal(snapshot.occurrences[0].deliveryEligible, false, "startup condition stays in-app without a native alert");

  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-pomegr-revision"), String(snapshot.revision));
  assert.equal((await response.json()).occurrences[0].data.sessionId, "codex:older-needs");
  assert.equal((await fetch(`${url}?revision=${snapshot.revision}`)).status, 204);
  const readsBefore = { statusReads, catalogReads };
  for (let index = 0; index < 5; index += 1) await fetch(url);
  assert.deepEqual({ statusReads, catalogReads }, readsBefore, "notification GETs never acquire provider facts");

  for (const [readiness, detailReadiness] of [["partial", null], ["ready", "unavailable"]]) {
    const before = runtime.serveCatalog().revision;
    publisher.publishCatalog("codex", [{ ...oldNeeds, needsInput: false, activityStatus: "unknown", detailReadiness }], readiness);
    await waitFor(() => runtime.serveCatalog().revision > before);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.serveNotifications().snapshot.value.occurrences[0]?.lifecycle, "active", "incomplete catalog evidence cannot resolve Needs input");
  }
  publisher.publishCatalog("codex", [{ ...oldNeeds, needsInput: false, activityStatus: "working" }]);
  await waitFor(() => runtime.serveNotifications().snapshot.value.occurrences[0]?.lifecycle === "resolved");
  assert.equal(runtime.serveNotifications().snapshot.value.occurrences[0].kind, "needs_input");

  const needsRows = (prefix, active) => Array.from({ length: 100 }, (_, index) => ({
    localId: `${prefix}-${index}`, title: `${prefix} ${index}`, createdAt: timestamp, updatedAt: timestamp,
    isLive: true, needsInput: active, activityStatus: active ? "needs_input" : "working",
  }));
  const previousNeeds = needsRows("previous", true);
  const incomingNeeds = needsRows("incoming", true);
  publisher.publishCatalog("claude", previousNeeds);
  await waitFor(() => runtime.serveNotifications().snapshot.value.occurrences.filter((row) => row.lifecycle === "active").length === 100);
  publisher.publishCatalog("claude", incomingNeeds);
  await waitFor(() => runtime.serveNotifications().snapshot.value.activeSessionOverflow === 100);
  assert.equal(runtime.serveNotifications().snapshot.value.occurrences.filter((row) => row.lifecycle === "active").length, 100,
    "missing old rows reserve the 100 bounded active slots");
  publisher.publishCatalog("claude", [...needsRows("previous", false), ...incomingNeeds]);
  await waitFor(() => runtime.serveNotifications().snapshot.value.occurrences
    .filter((row) => row.lifecycle === "active" && row.data.sessionId.startsWith("claude:incoming-")).length === 100);
  assert.equal(runtime.serveNotifications().snapshot.value.activeSessionOverflow, 0,
    "explicit false rows release slots for new occurrences");
});

test("provider commits update notifications without interrupting status observation", async (context) => {
  let status = "operational";
  const provider = { id: "claude", source: "Claude Code", capabilities: createEmptyProviderCapabilities() };
  const registry = {
    providers: [provider], defaultProvider: provider,
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async readServiceStatus() { return { status, updatedAt: timestamp,
      incidents: status === "operational" ? [] : [{ id: "incident_1", label: "Service degraded",
        status: "investigating", impact: "minor", updatedAt: timestamp, url: "https://status.claude.com/incidents/incident_1" }] }; },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    async startObservers() { return { async stop() {} }; },
  };
  const timers = [];
  const runtime = createMonitorRuntime({ providerRegistry: registry, monitorStore: false, checkpointStore: false,
    now: () => NOW, providerStatusObservationOptions: {
      schedule(task, delay) { timers.push({ task, delay }); return { unref() {} }; }, cancel() {}, random: () => 0.5,
    }, resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  context.after(() => runtime.stopObservation());
  await runtime.startObservation();
  await waitFor(() => runtime.serveProviderStatus().snapshot.value.providers[0].readiness === "ready");
  await waitFor(() => timers.length >= 3);
  const baseline = runtime.serveNotifications().snapshot.value.revision;
  status = "degraded";
  timers.find((timer) => timer.delay === 300_000)?.task();
  await waitFor(() => runtime.serveProviderStatus().snapshot.value.providers[0].status === "degraded");
  await waitFor(() => runtime.serveNotifications().snapshot.value.occurrences.some((row) => row.kind === "provider_incident"));
  assert.ok(runtime.serveProviderStatus().snapshot.value.providers[0].status === "degraded");
  assert.ok(runtime.serveNotifications().snapshot.value.revision > baseline);
});
