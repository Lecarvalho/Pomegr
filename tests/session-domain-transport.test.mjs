import assert from "node:assert/strict";
import test from "node:test";
import { createMonitorServer } from "../monitor/server.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("session domains and history use revision ETags with bodyless 204 responses", async (context) => {
  const domainValue = { domain: "session-summary", sessionId: "codex:transport", revision: 7, readiness: "ready", observedAt: null };
  const runtime = {
    serveSessionDomain(_sessionId, _domain, _agentId, revision) {
      return revision === 7
        ? { status: "unchanged", revision: 7, snapshot: null }
        : { status: "ready", revision: 7, snapshot: { revision: 7, serialized: JSON.stringify(domainValue), value: domainValue } };
    },
    async serveSessionHistory(_sessionId, query) {
      return { status: "ready", kind: query.kind, revision: "9", total: 0, offset: 0, items: [], linkedCount: 0,
        ...(query.kind === "activity" ? { requestGroups: [], range: { from: 0, to: 0 }, requestTotal: 0, callTotal: 0, byKind: [], shellTasks: { total: 0, failed: 0 } } : {}) };
    },
  };
  const server = createMonitorServer({ runtime });
  const origin = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const initial = await fetch(`${origin}/api/session-domain?sessionId=codex%3Atransport&domain=session-summary`);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("etag"), '"7"');
  assert.equal(initial.headers.get("x-pomegr-revision"), "7");
  assert.deepEqual(await initial.json(), domainValue);

  for (const url of [
    `${origin}/api/session-domain?sessionId=codex%3Atransport&domain=session-summary&revision=7`,
    `${origin}/api/session-domain?sessionId=codex%3Atransport&domain=session-summary`,
  ]) {
    const response = url.endsWith("revision=7")
      ? await fetch(url)
      : await fetch(url, { headers: { "If-None-Match": 'W/"7"' } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("etag"), '"7"');
    assert.equal(response.headers.get("x-pomegr-revision"), "7");
    assert.equal(await response.text(), "");
  }

  const history = await fetch(`${origin}/api/session-history?sessionId=codex%3Atransport&kind=activity&revision=9`);
  assert.equal(history.status, 204);
  assert.equal(history.headers.get("etag"), '"9"');
  assert.equal(history.headers.get("x-pomegr-revision"), "9");
  assert.equal(await history.text(), "");
});

test("session-domain and range-history requests reject invalid methods, identities, and paging values", async (context) => {
  const runtime = {
    serveSessionDomain() { throw new Error("invalid requests must not reach serving"); },
    serveSessionHistory() { throw new Error("invalid requests must not reach serving"); },
  };
  const server = createMonitorServer({ runtime });
  const origin = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal((await fetch(`${origin}/api/session-domain?sessionId=codex%3Ax&domain=session-summary`, { method: "POST" })).status, 405);
  for (const query of [
    "sessionId=codex%3A..%2Fsecret&domain=session-summary",
    "sessionId=codex%3Ax&domain=unknown",
    "sessionId=codex%3Ax&domain=agent",
    "sessionId=codex%3Ax&domain=details&agentId=primary",
    "sessionId=codex%3Ax&domain=details&domain=signals",
  ]) assert.equal((await fetch(`${origin}/api/session-domain?${query}`)).status, 400);
  for (const query of [
    "from=1",
    "from=4&to=2",
    "from=1&to=65",
    "from=1&to=2&workKind=private-command",
    "from=1&to=2&continuation=..%2Fprivate",
  ]) assert.equal((await fetch(`${origin}/api/session-history?sessionId=codex%3Ax&kind=activity&${query}`)).status, 400);
});

test("SSE carries session-scoped domain revisions and history totals", async (context) => {
  const runtime = {
    subscribeRevisionEvents(subscriber) {
      subscriber({ domain: "signals", sessionId: "codex:events", revision: 3 });
      subscriber({ domain: "history", sessionId: "codex:events", revision: 4, total: 12 });
      return () => {};
    },
  };
  const server = createMonitorServer({ runtime });
  const origin = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`${origin}/api/events`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  try {
    const source = new TextDecoder().decode((await reader.read()).value);
    assert.match(source, /event: signals\ndata: \{"domain":"signals","sessionId":"codex:events","revision":3\}/u);
    assert.match(source, /event: history\ndata: \{"domain":"history","sessionId":"codex:events","revision":4,"total":12\}/u);
    assert.doesNotMatch(source, /prompt|response|credential|path/iu);
  } finally {
    await reader.cancel();
  }
});

test("a startup loading domain is a 200 loading envelope, and a failed serve does not stick", async (context) => {
  const value = { domain: "session-summary", sessionId: "claude:startup", revision: 9, readiness: "ready", observedAt: null };
  let mode = "loading";
  const runtime = {
    serveSessionDomain() {
      if (mode === "loading") return { status: "loading", revision: 0, snapshot: null };
      if (mode === "throw") throw new Error("PRIVATE_FAILURE_DETAIL");
      if (mode === "unavailable") return { status: "unavailable", revision: 0, snapshot: null };
      return { status: "ready", revision: 9, snapshot: { revision: 9, serialized: JSON.stringify(value), value } };
    },
  };
  const server = createMonitorServer({ runtime });
  const origin = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `${origin}/api/session-domain?sessionId=claude%3Astartup&domain=session-summary&revision=238`;

  const loading = await fetch(url);
  assert.equal(loading.status, 200, "startup loading must not surface as a 404 the proxy reports as a 503");
  assert.deepEqual(await loading.json(), { domain: "session-summary", sessionId: "claude:startup", revision: 0, readiness: "loading", observedAt: null });

  mode = "throw";
  const failed = await fetch(url);
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /PRIVATE_FAILURE_DETAIL/u);
  mode = "ready";
  const recovered = await fetch(url);
  assert.equal(recovered.status, 200, "the next GET after a failure serves the committed revision");
  assert.deepEqual(await recovered.json(), value);

  mode = "unavailable";
  assert.equal((await fetch(url)).status, 404);
});

test("the proxy passes a definitive monitor 404 through only for the session-domain route", async (context) => {
  const { proxyMonitorJson } = await import("../app/api/monitor-proxy.ts");
  const { readFile, readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const runtime = { serveSessionDomain: () => ({ status: "unavailable", revision: 0, snapshot: null }) };
  const server = createMonitorServer({ runtime });
  const origin = await listen(server);
  const previousOrigin = process.env.POMEGR_MONITOR_ORIGIN;
  process.env.POMEGR_MONITOR_ORIGIN = origin;
  context.after(() => {
    if (previousOrigin === undefined) delete process.env.POMEGR_MONITOR_ORIGIN;
    else process.env.POMEGR_MONITOR_ORIGIN = previousOrigin;
    return new Promise((resolve) => server.close(resolve));
  });
  const unavailableBody = { domain: "session-summary", sessionId: "claude:absent", revision: 0, readiness: "unavailable", observedAt: null };
  const domainPath = "/api/session-domain?sessionId=claude%3Aabsent&domain=session-summary";

  const definitive = await proxyMonitorJson({ path: domainPath, timeoutMs: 2_000, unavailableBody, passThroughNotFound: true });
  assert.equal(definitive.status, 404);
  assert.equal(definitive.headers.get("cache-control"), "no-store");
  assert.deepEqual(await definitive.json(), unavailableBody, "the monitor's own 404 body is never forwarded");

  // Without the option (every other proxy route) a monitor 404 keeps its transient 503 mapping.
  const transient = await proxyMonitorJson({ path: domainPath, timeoutMs: 2_000, unavailableBody });
  assert.equal(transient.status, 503);
  // A monitor failure is still a transient 503 even for the session-domain route.
  runtime.serveSessionDomain = () => { throw new Error("PRIVATE_FAILURE_DETAIL"); };
  const failed = await proxyMonitorJson({ path: domainPath, timeoutMs: 2_000, unavailableBody, passThroughNotFound: true });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /PRIVATE_FAILURE_DETAIL/u);

  // Only the session-domain route opts in.
  const apiRoot = path.resolve(import.meta.dirname, "../app/api");
  const optedIn = [];
  for (const entry of await readdir(apiRoot, { recursive: true })) {
    if (!/\.tsx?$/u.test(entry) || entry === "monitor-proxy.ts") continue;
    if ((await readFile(path.join(apiRoot, entry), "utf8")).includes("passThroughNotFound")) optedIn.push(entry.replaceAll("\\", "/"));
  }
  assert.deepEqual(optedIn, ["session-domain/route.ts"]);
});
