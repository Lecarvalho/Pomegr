import assert from "node:assert/strict";
import test from "node:test";
import { providerFoldersLocalGate, providerFoldersLocalGatePlugin } from "../scripts/provider-folders-local-gate.mjs";

function request(url, remoteAddress, suppliedHeaders = {}) {
  let forwarded = false, status = null, headers = null, body = "";
  const input = { url, socket: { remoteAddress, localPort: 3003 }, headers: { host: "localhost:3003", "x-forwarded-for": "127.0.0.1", ...suppliedHeaders } };
  input.rawHeaders = Object.entries(input.headers).flatMap(([key, value]) => [key, value]);
  providerFoldersLocalGate(input, {
    writeHead(code, value) { status = code; headers = value; }, end(value) { body = value; },
  }, () => { forwarded = true; }, { hostname: "workstation", addresses: ["192.168.1.20", "fd00::20"] });
  return { forwarded, status, headers, body, input };
}

test("development provider folder reads reject remote LAN peers even with spoofed local headers", () => {
  for (const remote of ["192.168.1.10", "::ffff:192.168.1.10", undefined]) {
    for (const url of ["/api/provider-folders", "/api/provider-folders/", "/api/provider%2Dfolders", "/api/provider-folders?path=ignored"]) {
      const result = request(url, remote);
      assert.equal(result.forwarded, false);
      assert.equal(result.status, 404);
      assert.equal(result.headers["Cache-Control"], "no-store");
      assert.equal(result.headers["Access-Control-Allow-Origin"], undefined);
    }
  }
  for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(request("/api/provider-folders", remote).forwarded, true);
  assert.equal(request("/api/state", "192.168.1.10").forwarded, true);
  let installed;
  providerFoldersLocalGatePlugin().configureServer({ middlewares: { use(fn) { installed = fn; } } });
  assert.equal(installed, providerFoldersLocalGate);
  assert.equal(installed.length, 3, "Connect must recognize this as normal middleware, not an error handler");
});

test("local computer reads accept machine names and interface IPs and canonicalize the trusted origin", () => {
  for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "192.168.1.20", "::ffff:192.168.1.20", "fd00::20"]) {
    for (const host of ["localhost:3003", "workstation:3003", "WorkStation:3003", "workstation.local:3003", "192.168.1.20:3003", "[fd00::20]:3003"]) {
      const result = request("/api/provider-folders", remote, { host, origin: `http://${host}`, "sec-fetch-site": "same-origin" });
      assert.equal(result.forwarded, true, `${remote} -> ${host}`);
      assert.equal(result.input.headers.host, "localhost:3003");
      assert.equal(result.input.headers.origin, "http://localhost:3003");
      const fetchHeaders = new Headers();
      for (let index = 0; index < result.input.rawHeaders.length; index += 2) fetchHeaders.append(result.input.rawHeaders[index], result.input.rawHeaders[index + 1]);
      assert.equal(fetchHeaders.get("host"), "localhost:3003");
      assert.equal(fetchHeaders.get("origin"), "http://localhost:3003");
    }
  }
});

test("local peers cannot authorize arbitrary hosts, ports, or cross-origin requests", () => {
  for (const headers of [
    { host: "attacker.example:3003" }, { host: "192.168.1.10:3003" },
    { host: "localhost:3004" }, { host: "user@localhost:3003" },
    { host: "localhost:3003/path" }, { host: undefined },
    { origin: "http://attacker.example" }, { origin: "null" },
    { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" },
  ]) {
    const result = request("/api/provider-folders", "192.168.1.20", headers);
    assert.equal(result.forwarded, false);
    assert.equal(result.status, 404);
  }
});
