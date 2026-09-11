import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { rendererTraceDevelopmentProxy, rendererTraceLocalGate } from "../scripts/renderer-trace-local-gate.mjs";

function invoke(remoteAddress, headers = {}) {
  let forwarded = false;
  let status = null;
  const request = { method: "POST", url: "/api/renderer-trace", socket: { remoteAddress, localPort: 3003 },
    headers: { host: "localhost:3003", origin: "http://localhost:3003", "sec-fetch-site": "same-origin", ...headers } };
  rendererTraceLocalGate(request, { writeHead(code) { status = code; }, end() {} }, () => { forwarded = true; },
    { hostname: "workstation", addresses: ["192.168.1.20"] });
  return { forwarded, status, headers: request.headers };
}

test("renderer trace development transport requires an actual same-computer peer", () => {
  assert.equal(invoke("127.0.0.1").forwarded, true);
  assert.equal(invoke("192.168.1.20", { host: "workstation:3003", origin: "http://workstation:3003" }).forwarded, true);
  const alias = invoke("192.168.1.20", { host: "workstation:3003", origin: "http://workstation:3003" });
  assert.equal(alias.headers.host, "127.0.0.1:3003");
  assert.equal(alias.headers.origin, "http://127.0.0.1:3003");
  for (const result of [
    invoke("192.168.1.10"), invoke("192.168.1.10", { "x-forwarded-for": "127.0.0.1" }),
    invoke("127.0.0.1", { host: "attacker.example:3003" }), invoke("127.0.0.1", { origin: "https://attacker.example" }),
  ]) {
    assert.equal(result.forwarded, false);
    assert.equal(result.status, 404);
  }
});

test("development middleware forwards only the fixed renderer route to loopback monitor", async () => {
  const request = Readable.from(["{}"]);
  Object.assign(request, { method: "POST", url: "/api/renderer-trace", headers: { "content-type": "application/json" } });
  const response = { status: null, writeHead(status) { this.status = status; }, end() {} };
  const calls = [];
  await rendererTraceDevelopmentProxy(request, response, () => assert.fail("trace route must not fall through"), {
    monitorOrigin: "http://127.0.0.1:4317",
    fetchImpl: async (...args) => { calls.push(args); return { ok: true }; },
  });
  assert.equal(response.status, 204);
  assert.deepEqual(calls, [["http://127.0.0.1:4317/internal/renderer-trace", {
    method: "POST", body: "{}", headers: { "content-type": "application/json" }, signal: calls[0][1].signal,
  }]]);
});

test("development middleware refuses a monitor origin outside loopback", async () => {
  const request = Readable.from(["{}"]);
  Object.assign(request, { method: "POST", url: "/api/renderer-trace", headers: { "content-type": "application/json" } });
  const response = { status: null, writeHead(status) { this.status = status; }, end() {} };
  await rendererTraceDevelopmentProxy(request, response, () => assert.fail("trace route must not fall through"), {
    monitorOrigin: "https://example.test",
    fetchImpl: () => assert.fail("remote telemetry must not be forwarded"),
  });
  assert.equal(response.status, 503);
});
