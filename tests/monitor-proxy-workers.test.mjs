import assert from "node:assert/strict";
import test from "node:test";

import { build } from "esbuild";
import { Miniflare } from "miniflare";

const largePayload = Object.freeze({ sessions: Array.from({ length: 100 }, (_, index) => ({
  id: `codex:session-${index}`,
  title: `Session ${index}`,
})) });

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

async function runtime() {
  return new Miniflare({
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
      const body = pathname === "/large" ? largePayload : { sessions: [] };
      return Response.json(body, { headers: { ETag: '"18"', "X-Pomegr-Revision": "18" } });
    },
  });
}

test("serves precompressed monitor JSON through Workers with exactly one encoding layer", async () => {
  const miniflare = await runtime();
  try {
    const response = await miniflare.dispatchFetch("http://pomegr.test/large", {
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), largePayload);
  } finally {
    await miniflare.dispose();
  }
});

test("keeps identity responses plain and preserves bodyless conditional revisions", async () => {
  const miniflare = await runtime();
  try {
    const plain = await miniflare.dispatchFetch("http://pomegr.test/small", {
      headers: { "accept-encoding": "gzip;q=0, *;q=1" },
    });
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.deepEqual(await plain.json(), { sessions: [] });

    const unchanged = await miniflare.dispatchFetch("http://pomegr.test/unchanged", {
      headers: { "if-none-match": '"19"' },
    });
    assert.equal(unchanged.status, 204);
    assert.equal(unchanged.headers.get("etag"), '"19"');
    assert.equal(await unchanged.text(), "");
  } finally {
    await miniflare.dispose();
  }
});
