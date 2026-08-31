import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createProviderStatusObservation } from "../monitor/provider-status-observation.mjs";
import { createRequestHandler } from "../monitor/request-handler.mjs";
import { PROVIDER_STATUS_STALE_MS } from "../shared/provider-status.mjs";
import { createMonitorRuntime } from "../monitor/server.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../shared/monitor-state.mjs";

const BASE = Date.parse("2026-08-31T12:00:00Z");
const good = (status = "operational", incidents = []) => ({ status, updatedAt: new Date(BASE).toISOString(), incidents });
const incident = (id = "incident_a", impact = "minor") => ({
  id, label: "Elevated service errors", status: "investigating", impact,
  updatedAt: new Date(BASE).toISOString(), url: `https://status.claude.com/incidents/${id}`,
});
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

function clock() {
  let current = BASE;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => current,
    schedule(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: current + delay }); return id; },
    cancel(id) { timers.delete(id); },
    size: () => timers.size,
    async advance(ms) {
      const target = current + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        current = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await settle();
      }
      current = target;
      await settle();
    },
  };
}
function create(readStatus) {
  const time = clock();
  const observation = createProviderStatusObservation({ readStatus, ...time, random: () => 0.5 });
  return { ...time, ...observation, row: (provider = "claude") => observation.read().snapshot.value.providers.find((row) => row.provider === provider) };
}

test("startup publishes loading without waiting; providers commit independently and GET reads never acquire", async () => {
  let calls = 0;
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const status = create((provider) => { calls++; return provider === "codex" ? slow : good(); });
  status.start();
  assert.equal(status.row().readiness, "loading");
  await settle();
  assert.equal(status.row().status, "operational");
  assert.equal(status.row("codex").readiness, "loading");
  const first = status.read().snapshot;
  for (let i = 0; i < 20; i++) assert.equal(status.read(first.revision).status, "unchanged");
  assert.equal(calls, 2);
  release(good("degraded"));
  await settle();
  assert.equal(status.row("codex").status, "degraded");
  assert.ok(status.read().snapshot.revision > first.revision);
  assert.equal(first.value.providers[1].status, "unknown", "earlier immutable revision stays unchanged");
  await status.stop();
  assert.equal(status.size(), 0);
});

test("healthy checks use five minutes; incidents use one minute and recovery restores normal cadence", async () => {
  const calls = { claude: 0, codex: 0 };
  let next = good();
  const status = create((provider) => { calls[provider]++; return provider === "claude" ? next : good(); });
  status.start();
  await settle();
  await status.advance(299_999);
  assert.deepEqual(calls, { claude: 1, codex: 1 });
  next = good("degraded", [incident()]);
  await status.advance(1);
  assert.deepEqual(calls, { claude: 2, codex: 2 });
  const key = status.row().incidentKey;
  next = good("outage", [incident("incident_a", "major")]);
  await status.advance(60_000);
  assert.deepEqual(calls, { claude: 3, codex: 2 });
  assert.equal(status.row().incidentKey, key, "severity changes retain incident identity");
  next = good();
  await status.advance(60_000);
  assert.equal(status.row().incidentKey, null);
  await status.advance(60_000);
  assert.equal(calls.claude, 4);
  await status.stop();
});

test("invalid or failed replacement retains evidence, backs off, and independently commits expiry", async () => {
  let next = good("degraded", [incident()]);
  let fail = false;
  const calls = [];
  const status = create((provider) => {
    if (provider === "codex") return good();
    calls.push(status.now());
    if (fail) throw new Error("SECRET RAW PROVIDER FAILURE");
    return next;
  });
  status.start();
  await settle();
  const original = status.row();
  next = { ...good(), prompt: "PRIVATE_PROMPT_SENTINEL" };
  await status.advance(60_000);
  assert.equal(status.row().readiness, "unavailable");
  assert.equal(status.row().checkedAt, original.checkedAt);
  assert.equal(status.row().incidentKey, original.incidentKey);
  assert.deepEqual(status.row().incidents, original.incidents);
  fail = true;
  await status.advance(PROVIDER_STATUS_STALE_MS - 60_000);
  assert.equal(status.row().freshness, "stale");
  assert.deepEqual(calls.map((time) => (time - BASE) / 1000), [0, 60, 120, 240, 540]);
  assert.equal(status.row("codex").freshness, "fresh");
  assert.doesNotMatch(status.read().snapshot.serialized, /SECRET|PRIVATE_PROMPT/);
  await status.stop();
});

test("new incidents and recurring component outages get distinct notice identities", async () => {
  let next = good("degraded", [incident()]);
  const status = create((provider) => provider === "claude" ? next : good());
  status.start();
  await settle();
  const firstKey = status.row().incidentKey;
  next = good("degraded", [incident(), incident("incident_b")]);
  await status.advance(60_000);
  const secondKey = status.row().incidentKey;
  assert.notEqual(secondKey, firstKey);
  next = good("degraded", [incident()]);
  await status.advance(60_000);
  assert.equal(status.row().incidentKey, secondKey, "resolving one incident does not redisplay another");
  next = good();
  await status.advance(60_000);
  next = good("degraded");
  await status.advance(300_000);
  assert.notEqual(status.row().incidentKey, secondKey);
  await status.stop();
});

test("timeout isolates an uncooperative reader; shutdown cancels and discards late results", async () => {
  let release;
  let signal;
  const status = create((provider, options) => {
    if (provider === "codex") return good();
    signal = options.signal;
    return new Promise((resolve) => { release = resolve; });
  });
  status.start();
  await settle();
  await status.advance(10_000);
  assert.equal(signal.aborted, true);
  assert.equal(status.row().readiness, "unavailable");
  assert.equal(status.row("codex").status, "operational");
  await status.advance(60_000);
  await status.stop();
  const revision = status.read().snapshot.revision;
  assert.equal(signal.aborted, true);
  release(good());
  await settle();
  assert.equal(status.read().snapshot.revision, revision);
  assert.equal(status.size(), 0);
});

test("normalization boundary rejects unsafe URLs, duplicate IDs, unbounded or contradictory evidence", async () => {
  const malformed = [
    good("degraded", [{ ...incident(), url: "https://evil.example/incidents/phishing" }]),
    good("degraded", [{ ...incident(), url: "https://status.claude.com/incidents/a?secret=value" }]),
    good("degraded", [incident(), incident()]),
    good("degraded", [{ ...incident(), label: "<script>bad</script>" }]),
    good("operational", [incident()]),
    good("degraded", Array.from({ length: 9 }, (_, index) => incident(`incident_${index}`))),
  ];
  for (const value of malformed) {
    const status = create(() => value);
    status.start();
    await settle();
    assert.equal(status.row().readiness, "unavailable");
    assert.equal(status.row().status, "unknown");
    assert.deepEqual(status.row().incidents, []);
    await status.stop();
  }
});

test("HTTP provider-status serves only committed responses, with revisions and no acquisition", async (t) => {
  let calls = 0;
  const status = create(() => { calls++; return good(); });
  status.start();
  await settle();
  t.after(() => status.stop());
  const server = http.createServer(createRequestHandler({ runtime: { serveProviderStatus: status.read } }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/provider-status`;
  const responses = await Promise.all(Array.from({ length: 10 }, () => fetch(url)));
  const bodies = await Promise.all(responses.map((response) => response.text()));
  assert.equal(new Set(bodies).size, 1);
  assert.equal(calls, 2);
  assert.equal(responses[0].headers.get("cache-control"), "no-store");
  const revision = responses[0].headers.get("x-pomegr-revision");
  assert.equal((await fetch(`${url}?revision=${revision}`)).status, 204);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  const body = JSON.parse(bodies[0]);
  assert.deepEqual(Object.keys(body).sort(), ["generatedAt", "providers", "revision"]);
  assert.deepEqual(Object.keys(body.providers[0]).sort(), ["checkedAt", "freshness", "incidentKey", "incidents", "provider", "readiness", "source", "status", "statusPageUrl", "updatedAt"]);
});

test("monitor lifecycle owns status work without waiting for session observers or revising their caches", async () => {
  const time = clock();
  let releaseObserver;
  let statusReads = 0;
  const provider = { id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities() };
  const registry = {
    providers: [provider], defaultProvider: provider,
    readServiceStatus: async () => { statusReads++; return good(); },
    readUsageLimits: async () => createEmptyUsageLimits(),
    inspectSessions: async () => ({ sessions: [], resourceTargets: [] }),
    startObservers: () => new Promise((resolve) => { releaseObserver = resolve; }),
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry, checkpointStore: false,
    providerStatusObservationOptions: { ...time, random: () => 0.5 },
    resourceUsageSampler: { sample: async () => {}, get: () => null },
  });
  assert.equal(runtime.serveProviderStatus().status, "empty");
  assert.equal(statusReads, 0);
  const starting = runtime.startObservation();
  await settle();
  assert.equal(statusReads, 2);
  assert.equal(runtime.serveProviderStatus().snapshot.value.providers[0].readiness, "ready");
  releaseObserver({ stop: async () => {} });
  await starting;
  await settle();
  const catalogRevision = runtime.serveCatalog().revision;
  const statusRevision = runtime.serveProviderStatus().revision;
  await time.advance(300_000);
  assert.ok(runtime.serveProviderStatus().revision > statusRevision);
  assert.equal(runtime.serveCatalog().revision, catalogRevision);
  await runtime.stopObservation();
  assert.equal(time.size(), 0);
});
