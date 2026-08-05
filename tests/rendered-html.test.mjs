import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders Threadlight", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Threadlight<\/title>/i);
  assert.match(html, /Threadlight/);
  assert.match(html, /LIVE SESSION OBSERVER/);
  assert.match(html, /LIVE CONTEXT USE/);
  assert.match(html, /Usage limits/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("uses one provider-neutral identity and no starter preview", async () => {
  const [page, layout, packageJson, dashboard, styles, stateRoute, monitor] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/Dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/state/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../monitor/server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(packageJson, /"name": "threadlight"/);
  assert.doesNotMatch(packageJson, /claude-session-coach|session-pulse|react-loading-skeleton/);
  assert.match(page, /<Dashboard \/>/);
  assert.match(layout, /title: "Threadlight"/);
  assert.match(dashboard, /\$\{agent\.status\}Agent/);
  assert.match(styles, /\.agentRow\.idleAgent/);
  assert.match(dashboard, /60_000/);
  assert.match(dashboard, /refresh\(true\)/);
  assert.match(dashboard, /onClick=\{\(\) => refresh\(false\)\}/);
  assert.match(dashboard, /CACHE DETAILS/);
  assert.match(dashboard, /running now/);
  assert.match(dashboard, /wall time/);
  assert.match(dashboard, /TOOL CALL BREAKDOWN/);
  assert.match(dashboard, /toolPatterns/);
  assert.match(dashboard, /LOOP PATTERNS/);
  assert.match(dashboard, /role="dialog"/);
  assert.match(stateRoute, /refreshUsage=1/);
  assert.match(monitor, /refreshUsage \? await usageLimits\(\) : cachedUsageLimits\(\)/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});
