import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { USAGE_REFRESH_INTERVAL_MS, usageRefreshDelay } from "../app/usage-refresh.mjs";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function sourceTree(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const sources = await Promise.all(entries.map(async (entry) => {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directoryUrl);
    if (entry.isDirectory()) return sourceTree(child);
    return /\.(?:ts|tsx|mjs)$/.test(entry.name) ? readFile(child, "utf8") : "";
  }));
  return sources.join("\n");
}

test("server-renders the composed Threadlight dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Threadlight<\/title>/i);
  assert.match(html, /LIVE SESSION OBSERVER/);
  assert.match(html, /CONTEXT GROWTH/);
  assert.match(html, /Usage limits/);
  assert.match(html, /Generate report/);
  assert.match(html, /Agent activity/);
  assert.match(html, /Recent activity/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps the privacy explanation on the about page", async () => {
  const response = await render("/about");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /About .* Threadlight/);
  assert.match(html, /Watching Claude Code quietly/);
  assert.match(html, /Prompt and response text stay out of the dashboard/);
  assert.match(html, /Back to dashboard/);
});

test("keeps browser modules provider-safe and reuses the vector close control", async () => {
  const [components, closeButton, monitor, stateRoute] = await Promise.all([
    sourceTree(new URL("../app/components/", import.meta.url)),
    readFile(new URL("../app/components/CloseButton.tsx", import.meta.url), "utf8"),
    readFile(new URL("../monitor/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/state/route.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(components, /node:fs|node:child_process|CLAUDE_PROJECTS_DIR|credential-file|raw session/i);
  assert.match(closeButton, /<svg viewBox="0 0 12 12"/);
  assert.match(components, /<CloseButton\b/);
  assert.match(monitor, /listen\(PORT, "127\.0\.0\.1"/);
  assert.match(stateRoute, /monitorParams\.set\("refreshUsage", "1"\)/);
  assert.match(stateRoute, /monitorParams\.set\("sessionId", sessionId\)/);
});

test("refreshes stale usage immediately and waits out a recent attempt", () => {
  const now = Date.parse("2026-08-06T14:00:00.000Z");
  assert.equal(usageRefreshDelay(null, now), 0);
  assert.equal(usageRefreshDelay("invalid", now), 0);
  assert.equal(usageRefreshDelay("2026-08-06T13:58:59.999Z", now), 0);
  assert.equal(usageRefreshDelay("2026-08-06T13:59:20.000Z", now), 20_100);
  assert.equal(usageRefreshDelay("2026-08-06T14:00:10.000Z", now), USAGE_REFRESH_INTERVAL_MS);
});
