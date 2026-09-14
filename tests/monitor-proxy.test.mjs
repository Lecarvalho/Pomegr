import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { acceptsGzipEncoding, proxyMonitorJson } from "../app/api/monitor-proxy.ts";

async function withFetch(fetchImpl, action) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await action();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("selects gzip conservatively and gives explicit gzip precedence", () => {
  assert.equal(acceptsGzipEncoding(null), false);
  assert.equal(acceptsGzipEncoding("br, *;q=.5"), true);
  assert.equal(acceptsGzipEncoding("gzip;q=.5"), true);
  assert.equal(acceptsGzipEncoding("gzip;q=0, *;q=1"), false);
  assert.equal(acceptsGzipEncoding("gzip;q=broken, *;q=1"), false);
  assert.equal(acceptsGzipEncoding("gzip;q=.5000"), false);
  assert.equal(acceptsGzipEncoding("gzip;q=1.001"), false);
  assert.equal(acceptsGzipEncoding("gzip;q=.5, gzip;q=.7"), true);
});

test("asks the loopback monitor for identity and gzip-encodes a sufficiently large decoded body", async () => {
  const body = JSON.stringify({ payload: "x".repeat(1_100) });
  let request;
  await withFetch(async (url, options) => {
    request = { url, options };
    return new Response(body, {
      status: 200,
      headers: { ETag: '"17"', "X-Pomegr-Revision": "17", "Content-Encoding": "br" },
    });
  }, async () => {
    const response = await proxyMonitorJson({
      path: "/api/session-history?kind=activity",
      timeoutMs: 100,
      unavailableBody: {},
      acceptEncoding: "br, gzip;q=.5",
    });
    assert.equal(request.url, "http://127.0.0.1:4317/api/session-history?kind=activity");
    assert.equal(request.options.headers["accept-encoding"], "identity");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), "gzip");
    assert.equal(response.headers.get("vary"), "Accept-Encoding");
    assert.equal(response.headers.get("etag"), '"17"');
    assert.equal(response.headers.get("x-pomegr-revision"), "17");
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(gunzipSync(Buffer.from(await response.arrayBuffer())).toString(), body);
  });
});

test("leaves small or disallowed decoded bodies uncompressed and does not forward unsafe metadata", async () => {
  const upstream = {
    ok: true,
    status: 200,
    headers: { get: (name) => (name === "etag" ? "unquoted" : name === "x-pomegr-revision" ? "not-a-revision" : null) },
    text: async () => '{"ok":true}',
  };
  await withFetch(async () => upstream, async () => {
    const response = await proxyMonitorJson({
      path: "/api/state",
      timeoutMs: 100,
      unavailableBody: {},
      acceptEncoding: "gzip;q=0, *;q=1",
    });
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("etag"), null);
    assert.equal(response.headers.get("x-pomegr-revision"), null);
    assert.equal(await response.text(), '{"ok":true}');
  });
});

test("preserves a bodyless unchanged response and varies fallback responses by encoding", async () => {
  await withFetch(async () => new Response(null, {
    status: 204,
    headers: { ETag: 'W/"19"', "X-Pomegr-Revision": "19" },
  }), async () => {
    const response = await proxyMonitorJson({ path: "/api/agents", timeoutMs: 100, unavailableBody: {} });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("vary"), "Accept-Encoding");
    assert.equal(response.headers.get("etag"), 'W/"19"');
    assert.equal(response.headers.get("x-pomegr-revision"), "19");
    assert.equal(await response.text(), "");
  });

  await withFetch(async () => { throw new Error("unavailable"); }, async () => {
    const response = await proxyMonitorJson({ path: "/api/agents", timeoutMs: 100, unavailableBody: { status: "unavailable" } });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("vary"), "Accept-Encoding");
    assert.deepEqual(await response.json(), { status: "unavailable" });
  });
});

test("forwards a validated conditional ETag and retains the monitor's bodyless 204", async () => {
  await withFetch(async (_url, options) => {
    assert.equal(options.headers["if-none-match"], 'W/"19"');
    return new Response(null, { status: 204, headers: { ETag: '"19"', "X-Pomegr-Revision": "19" } });
  }, async () => {
    const response = await proxyMonitorJson({ path: "/api/session-domain", timeoutMs: 100, unavailableBody: {}, ifNoneMatch: 'W/"19"' });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("etag"), '"19"');
  });
  for (const ifNoneMatch of ['19', '"19"\r\nx-private: value', '"' + 'x'.repeat(511) + '"']) {
    await withFetch(async (_url, options) => {
      assert.equal(options.headers["if-none-match"], undefined);
      return Response.json({});
    }, () => proxyMonitorJson({ path: "/api/session-domain", timeoutMs: 100, unavailableBody: {}, ifNoneMatch }));
  }
});
