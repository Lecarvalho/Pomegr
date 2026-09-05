import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createMonitorRuntime, createMonitorServer } from "../monitor/server.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../shared/monitor-state.mjs";

const evidence = JSON.parse(await readFile(new URL("./fixtures/providers/codex/expected-session-evidence.json", import.meta.url), "utf8"));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("concurrent state GETs consume one committed response without provider transcript reads", async (context) => {
  let compatibilityReads = 0;
  let stopped = false;
  let resourceState = null;
  const resourceSamples = [];
  const provider = {
    id: "codex",
    source: "Codex",
    capabilities: createEmptyProviderCapabilities(),
    homePolicy: { requestModelObservations: true, modelSelection: false, usageLimitActivity: { enabled: false } },
  };
  const registry = {
    providers: [provider],
    defaultProvider: provider,
    providerForSessionId: () => provider,
    async resolveCapabilities() { return provider.capabilities; },
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async readSession() { compatibilityReads += 1; throw new Error("raw request path read"); },
    async inspectSessions() {
      return {
        sessions: [],
        resourceTargets: [{ sessionId: `codex:${evidence.localId}`, status: "unavailable" }],
      };
    },
    unavailableMessage: () => "Unavailable",
    async startObservers(publisher) {
      publisher.publishCatalog("codex", [{
        localId: evidence.localId,
        title: evidence.session.title,
        project: evidence.session.project,
        updatedAt: evidence.session.updatedAt,
        isLive: true,
        needsInput: false,
        activityStatus: "working",
      }]);
      publisher.publishSession("codex", evidence.localId, evidence);
      return { async hydrate() { return true; }, async stop() { stopped = true; } };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry,
    checkpointStore: false,
    observationCommitDelayMs: 0,
    scheduleObservation: (task) => setTimeout(task, 0),
    resourceUsageSampler: {
      async sample(targets) {
        resourceSamples.push(targets);
        resourceState = {
          status: "unavailable",
          reason: "missing_owner",
          current: null,
          observedPeak: null,
          samples: [],
        };
      },
      get() { return resourceState; },
    },
  });
  await runtime.startObservation();
  context.after(async () => runtime.stopObservation());
  for (let attempt = 0; attempt < 50 && runtime.serveSession(`codex:${evidence.localId}`).status !== "ready"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (let attempt = 0; attempt < 50 && runtime.serveSession(`codex:${evidence.localId}`).snapshot?.readiness?.resources !== "unavailable"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(runtime.serveSession(`codex:${evidence.localId}`).status, "ready");
  assert.equal(await runtime.sessionFeed(), runtime.serveCatalog().snapshot.value);
  assert.equal(runtime.serveSession(`codex:${evidence.localId}`).snapshot.readiness.resources, "unavailable");
  assert.deepEqual(resourceSamples, [[{ sessionId: `codex:${evidence.localId}`, status: "unavailable" }]]);

  const server = createMonitorServer({ runtime });
  const origin = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const eventResponse = await fetch(`${origin}/api/events`);
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get("content-type") || "", /^text\/event-stream/u);
  const eventReader = eventResponse.body.getReader();
  const initialEvent = new TextDecoder().decode((await eventReader.read()).value);
  assert.match(initialEvent, /^event: catalog\ndata: \{"domain":"sessions","revision":\d+\}\n\n/u);
  assert.match(initialEvent, /event: repositories\ndata: \{"domain":"repositories","revision":\d+\}\n\n/u);
  assert.doesNotMatch(initialEvent, /codex-fixture|prompt|response|path|credential/iu);
  await eventReader.cancel();
  const responses = await Promise.all(Array.from({ length: 8 }, () => (
    fetch(`${origin}/api/state?sessionId=codex%3Acodex-fixture-parent`)
  )));
  assert.equal(responses.every((response) => response.status === 200), true);
  const revision = responses[0].headers.get("x-pomegr-revision");
  const bodies = await Promise.all(responses.map((response) => response.text()));
  assert.equal(new Set(bodies).size, 1);
  assert.equal(compatibilityReads, 0);
  assert.equal(JSON.parse(bodies[0]).metrics.tokens.reportEvidence.version, 1);
  assert.equal(JSON.parse(bodies[0]).metrics.tokens.reportEvidence.cache.status, "unavailable");
  assert.deepEqual(JSON.parse(bodies[0]).metrics.resources, {
    status: "unavailable",
    reason: "missing_owner",
    current: null,
    observedPeak: null,
    samples: [],
  });
  assert.doesNotMatch(bodies[0], /raw request path read|prompt|response|credential/i);

  const unchanged = await fetch(`${origin}/api/state?sessionId=codex%3Acodex-fixture-parent&revision=${revision}`);
  assert.equal(unchanged.status, 204);
  await runtime.stopObservation();
  assert.equal(stopped, true);
});

test("a committed registry-only catalog row serves cached unavailable detail without hydration", async (context) => {
  let transcriptReads = 0;
  let hydrations = 0;
  let stopped = false;
  const localId = "registry-only";
  const provider = {
    id: "claude",
    source: "Claude Code",
    capabilities: createEmptyProviderCapabilities(),
    homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } },
  };
  const registry = {
    providers: [provider],
    defaultProvider: provider,
    providerForSessionId: () => provider,
    async resolveCapabilities() { return provider.capabilities; },
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async readSession() { transcriptReads += 1; return null; },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    unavailableMessage: () => "Unavailable",
    async startObservers(publisher) {
      publisher.publishCatalog("claude", [{
        localId,
        title: "Claude session",
        project: "Unknown project",
        updatedAt: "2026-09-02T12:00:00.000Z",
        isLive: true,
        needsInput: false,
        activityStatus: "open",
        detailReadiness: "unavailable",
      }]);
      return { async hydrate() { hydrations += 1; return false; }, async stop() { stopped = true; } };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry,
    checkpointStore: false,
    observationCommitDelayMs: 0,
    scheduleObservation: (task) => setTimeout(task, 0),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  await runtime.startObservation();
  context.after(async () => runtime.stopObservation());
  for (let attempt = 0; attempt < 50 && runtime.serveSession(`claude:${localId}`).status !== "unavailable"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const catalog = runtime.serveCatalog().snapshot.value.sessions;
  assert.deepEqual(catalog.map(({ id, summaryReadiness, agentCount, activeAgentCount, latestContextTotal }) => ({
    id, summaryReadiness, agentCount, activeAgentCount, latestContextTotal,
  })), [{
    id: `claude:${localId}`, summaryReadiness: "unavailable", agentCount: null, activeAgentCount: null, latestContextTotal: null,
  }]);
  assert.equal(Object.hasOwn(catalog[0], "detailReadiness"), false);
  // The catalog is now committed; subsequent cache-only detail reads must not
  // enqueue a source acquisition for this confirmed absence.
  hydrations = 0;
  assert.equal(runtime.serveSession(`claude:${localId}`).status, "unavailable");
  assert.equal(hydrations, 0);

  const server = createMonitorServer({ runtime });
  const origin = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`${origin}/api/state?sessionId=claude%3A${localId}&revision=1`);
  assert.equal(response.status, 200, "catalog-only availability never shares a session-evidence revision");
  assert.equal(response.headers.get("x-pomegr-revision"), null);
  const body = await response.json();
  assert.equal(body.session, null);
  assert.equal(body.view, "live", "an expired Open catalog row is not a historical snapshot");
  assert.deepEqual(body.readiness, {
    core: "unavailable", agentEvidence: "unavailable", contextEvidence: "unavailable",
    activityEvidence: "unavailable", repository: "unavailable", resources: "unavailable", usageLimits: "unavailable",
  });
  assert.deepEqual(body.catalogIdentity, catalog[0]);
  assert.equal(Object.hasOwn(body.catalogIdentity, "detailReadiness"), false);
  assert.equal(hydrations, 0);
  assert.equal(transcriptReads, 0);
  await runtime.stopObservation();
  assert.equal(stopped, true);
});
