import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { createMonitorRuntime } from "../../../server/server.mjs";
import { readSessionContinuePlan } from "../../../server/runtime/session-continue-plan.mjs";
import { DESKTOP_AUTH_HEADER } from "../../../shared/local-auth.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../../../shared/monitor-state.mjs";
import { syntheticProviders } from "../../helpers/api-serialization-fixtures.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";
const SESSION_ID = "codex:session-one";

async function listen(context, runtime, authorizationToken = TOKEN) {
  const server = http.createServer(createRequestHandler({ runtime, authorizationToken }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (base, body = { sessionId: SESSION_ID }, headers = {}) => fetch(`${base}/internal/sessions/continue-plan`, {
  method: "POST", headers: { [DESKTOP_AUTH_HEADER]: TOKEN, "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

test("Continue plan has the history-read desktop private action gate", async (context) => {
  let reads = 0;
  const runtime = { async readSessionContinuePlan() { reads += 1; return { ok: false, reason: "unknown" }; } };
  const base = await listen(context, runtime);
  assert.equal((await post(base, undefined, { [DESKTOP_AUTH_HEADER]: "wrong" })).status, 401);
  assert.equal((await post(base, undefined, { Origin: base })).status, 401);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.request(`${base}/internal/sessions/continue-plan`, {
      method: "POST", headers: { Host: "wrong.invalid", [DESKTOP_AUTH_HEADER]: TOKEN },
    }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end(JSON.stringify({ sessionId: SESSION_ID }));
  });
  assert.equal(wrongHost, 401);
  assert.equal((await fetch(`${base}/internal/sessions/continue-plan`, { headers: { [DESKTOP_AUTH_HEADER]: TOKEN } })).status, 401);
  const noToken = await listen(context, runtime, "");
  assert.equal((await post(noToken)).status, 401);
  assert.equal(reads, 0);
  const response = await post(base);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: false, reason: "unknown" });
});

test("Continue plan validates only a qualified session ID and returns fixed errors", async (context) => {
  const base = await listen(context, { async readSessionContinuePlan() { return null; } });
  for (const body of ["{", {}, [], { sessionId: "bad" }, { sessionId: "codex:../private" },
    { sessionId: SESSION_ID, cwd: "PRIVATE" }, { sessionId: SESSION_ID, command: "PRIVATE" }]) {
    const response = await post(base, body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid" });
  }
  const missing = await post(base);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found" });
  const unavailable = await listen(context, { readSessionContinuePlan() { throw new Error("PRIVATE_PATH"); } });
  const failed = await post(unavailable);
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "unavailable" });
});

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-continue-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "checkout");
  const transcript = path.join(root, "session.jsonl");
  await mkdir(cwd);
  await writeFile(transcript, "PRIVATE_TRANSCRIPT_MUST_NOT_BE_READ\n");
  let snapshot = { evidence: { historical: true, session: { cwd, title: "Title\n" + "x".repeat(200) },
    agents: [{ id: "primary", status: "stopped", liveness: { freshness: "current", evidence: "observed" } }] },
    publicState: { session: { isLive: false } } };
  let source = transcript;
  const calls = [];
  const provider = { id: "codex", peekSessionSource(localId) { calls.push(localId); return source; } };
  const runtime = createMonitorRuntime({
    providerRegistry: { providers: [provider], providerForSessionId: () => provider,
      readSession() { assert.fail("Continue never acquires provider evidence"); },
      listSessions() { assert.fail("Continue never discovers sources"); } },
    observationStore: { entries: () => [], getByQualifiedId: (id) => id === SESSION_ID ? snapshot : null },
    checkpointStore: false, monitorStore: false, notificationPersistence: false,
  });
  return { runtime, cwd, transcript, calls, provider,
    snapshot: () => snapshot, setSnapshot: (value) => { snapshot = value; }, setSource: (value) => { source = value; } };
}

test("Continue uses committed liveness and private evidence only, with bounded launch fields", async (context) => {
  const f = await fixture(context);
  const response = await post(await listen(context, f.runtime));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, plan: {
    provider: "codex", sessionId: SESSION_ID, localId: "session-one", cwd: f.cwd, title: ("Title " + "x".repeat(200)).slice(0, 160),
  } });
  assert.deepEqual(f.calls, ["session-one"]);
  assert.equal(await f.runtime.readSessionContinuePlan("codex:missing"), null);
  assert.equal(await f.runtime.readSessionContinuePlan("codex:../private"), null);
});

test("Continue refuses live, unknown, absent, and stale observations including writer_released unknown", async (context) => {
  const f = await fixture(context);
  for (const status of ["active", "waiting", "needs_input", "warm", "unknown"]) {
    f.snapshot().evidence.agents[0].status = status;
    f.snapshot().evidence.agents[0].liveness.reason = "writer_released";
    assert.deepEqual(await f.runtime.readSessionContinuePlan(SESSION_ID), { ok: false, reason: status === "unknown" ? "unknown" : "live" });
  }
  f.snapshot().evidence.agents[0].status = "stopped";
  f.snapshot().evidence.agents[0].liveness.freshness = "stale";
  assert.deepEqual(await f.runtime.readSessionContinuePlan(SESSION_ID), { ok: false, reason: "unknown" });
  f.snapshot().evidence.agents = [];
  assert.deepEqual(await f.runtime.readSessionContinuePlan(SESSION_ID), { ok: false, reason: "unknown" });
  assert.deepEqual(f.calls, []);
});

test("a newer unknown catalog lifecycle cannot authorize an older ended evidence revision", async (context) => {
  const f = await fixture(context);
  assert.deepEqual(await readSessionContinuePlan(SESSION_ID, {
    store: { getByQualifiedId: () => f.snapshot() },
    coordinator: { catalogIdentity: () => ({ isLive: false, activityStatus: "unknown" }) },
  }, { providerForSessionId: () => f.provider }), { ok: false, reason: "unknown" });
});

test("historical Claude ended evidence needs no optional live bridge metadata", async (context) => {
  const f = await fixture(context);
  delete f.snapshot().evidence.agents[0].liveness;
  const runtime = createMonitorRuntime({
    providerRegistry: { providers: [{ ...f.provider, id: "claude" }], providerForSessionId: () => f.provider },
    observationStore: { entries: () => [], getByQualifiedId: () => f.snapshot() },
    checkpointStore: false, monitorStore: false, notificationPersistence: false,
  });
  assert.equal((await runtime.readSessionContinuePlan("claude:session-one")).ok, true);
  f.snapshot().evidence.historical = false;
  assert.deepEqual(await runtime.readSessionContinuePlan("claude:session-one"), { ok: false, reason: "unknown" });
});

test("provider source peeks consult only an already held primary source", async (context) => {
  const { claude, codex } = await syntheticProviders(context);
  for (const [provider, localId] of [[claude, "claude-fixture-parent"], [codex, "codex-fixture-parent"]]) {
    assert.equal(provider.peekSessionSource(localId), null, "a peek must not discover a source");
    await provider.listSessions();
    const held = provider.peekSessionSource(localId);
    assert.equal(path.isAbsolute(held), true);
    assert.equal(provider.peekSessionSource("missing"), null);
    await rm(held);
    assert.equal(provider.peekSessionSource(localId), held, "a peek must not inspect or acquire a source");
    assert.equal(await provider.readTranscriptPath(localId, "primary"), null);
  }
});

test("Continue refuses missing folders, relative cwd, and missing primary history without substituting a root", async (context) => {
  const f = await fixture(context);
  f.snapshot().evidence.session.cwd = "relative/checkout";
  assert.deepEqual(await f.runtime.readSessionContinuePlan(SESSION_ID), { ok: false, reason: "folder_missing" });
  f.snapshot().evidence.session.cwd = f.transcript;
  assert.deepEqual(await f.runtime.readSessionContinuePlan(SESSION_ID), { ok: false, reason: "folder_missing" });
  f.snapshot().evidence.session.cwd = f.cwd;
  for (const source of [null, f.cwd, path.join(f.cwd, "missing.jsonl")]) {
    f.setSource(source);
    assert.deepEqual(await f.runtime.readSessionContinuePlan(SESSION_ID), { ok: false, reason: "history_missing" });
  }
});

test("terminal process identity resolves only a unique committed owner without provider acquisition", async (context) => {
  const provider = { id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities(),
    homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } } };
  let inspections = 0;
  const runtime = createMonitorRuntime({
    providerRegistry: {
      providers: [provider], defaultProvider: provider,
      async resolveCapabilities() { return provider.capabilities; },
      async readUsageLimits() { return createEmptyUsageLimits(); },
      async inspectSessions() { inspections += 1; return { sessions: [], resourceTargets: [
        { sessionId: "codex:fork", pid: 123, processStartIdentity: "start-1" },
        { sessionId: "codex:shared-one", pid: 456, processStartIdentity: "start-2" },
        { sessionId: "codex:shared-two", pid: 456, processStartIdentity: "start-2" },
      ] }; },
      async startObservers() { return { async stop() {} }; },
      unavailableMessage: () => "Unavailable",
    },
    resourceUsageSampler: { async sample() {}, get() { return null; } },
    checkpointStore: false, monitorStore: false, notificationPersistence: false,
  });
  context.after(() => runtime.stopObservation());
  await runtime.startObservation();
  for (let attempt = 0; attempt < 50 && !inspections; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  await new Promise((resolve) => setImmediate(resolve));
  const before = inspections;
  assert.equal(runtime.sessionForTerminalProcess(123), "codex:fork");
  assert.equal(runtime.sessionForTerminalProcess(456), null);
  for (const pid of [0, -1, 1.5, "123", 999]) assert.equal(runtime.sessionForTerminalProcess(pid), null);
  assert.equal(inspections, before);
});
