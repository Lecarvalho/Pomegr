import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
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

async function workerScript() {
  const result = await build({
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:zlib"],
    write: false,
    stdin: {
      loader: "ts",
      resolveDir: process.cwd(),
      contents: `
        import { proxyMonitorJson } from "./app/api/monitor-proxy.ts";
        export default { fetch(request) {
          const url = new URL(request.url);
          return proxyMonitorJson({
            path: url.pathname + url.search,
            timeoutMs: 1000,
            unavailableBody: { error: "unavailable" },
            acceptEncoding: request.headers.get("accept-encoding"),
            ifNoneMatch: request.headers.get("if-none-match"),
          });
        } };
      `,
    },
  });
  return result.outputFiles[0].text;
}

test("serves monitor JSON through Workers with one encoding layer and preserves bodyless conditional revisions", async () => {
  const largePayload = { sessions: Array.from({ length: 100 }, (_, index) => ({ id: `codex:session-${index}`, title: `Session ${index}` })) };
  const miniflare = new Miniflare({
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    modules: true,
    script: await workerScript(),
    outboundService(request) {
      assert.equal(new URL(request.url).origin, "http://127.0.0.1:4317");
      assert.equal(request.headers.get("accept-encoding"), "identity");
      const pathname = new URL(request.url).pathname;
      if (pathname === "/unchanged") {
        return new Response(null, { status: 204, headers: { ETag: '"19"', "X-Pomegr-Revision": "19" } });
      }
      return Response.json(pathname === "/large" ? largePayload : { sessions: [] }, { headers: { ETag: '"18"', "X-Pomegr-Revision": "18" } });
    },
  });
  try {
    const large = await miniflare.dispatchFetch("http://pomegr.test/large", { headers: { "accept-encoding": "gzip" } });
    assert.equal(large.status, 200);
    assert.deepEqual(await large.json(), largePayload);

    const plain = await miniflare.dispatchFetch("http://pomegr.test/small", { headers: { "accept-encoding": "gzip;q=0, *;q=1" } });
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.deepEqual(await plain.json(), { sessions: [] });

    const unchanged = await miniflare.dispatchFetch("http://pomegr.test/unchanged", { headers: { "if-none-match": '"19"' } });
    assert.equal(unchanged.status, 204);
    assert.equal(unchanged.headers.get("etag"), '"19"');
    assert.equal(await unchanged.text(), "");
  } finally {
    await miniflare.dispose();
  }
});

async function sourceTree(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const sources = await Promise.all(entries.map(async (entry) => {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directoryUrl);
    if (entry.isDirectory()) return sourceTree(child);
    return /\.(?:ts|tsx|mjs)$/.test(entry.name) ? readFile(child, "utf8") : "";
  }));
  return sources.join("\n");
}

test("keeps browser components free of filesystem, process, and credential access and the state route a pure proxy", async () => {
  const [components, stateRoute] = await Promise.all([
    sourceTree(new URL("../app/components/", import.meta.url)),
    readFile(new URL("../app/api/state/route.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(components, /node:fs|node:child_process|CLAUDE_PROJECTS_DIR|credential-file|raw session/i);
  assert.doesNotMatch(stateRoute, /refreshUsage/);
  assert.match(stateRoute, /monitorParams\.set\("sessionId", sessionId\)/);
});
