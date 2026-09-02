import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test, { after } from "node:test";

import { createProductionBuildFixture } from "./helpers/production-build.mjs";

const productionBuild = await createProductionBuildFixture();
after(() => productionBuild.close());

async function render(pathname = "/") {
  const workerUrl = pathToFileURL(path.join(productionBuild.outDir, "server", "index.js"));
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

test("server-renders the personal Pomegr Home", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Pomegr<\/title>/i);
  assert.match(html, /Welcome to Pomegr/);
  assert.match(html, /Understand your sessions/);
  assert.match(html, /Session coach/);
  assert.match(html, /Coming soon/);
  assert.doesNotMatch(html, /Usage &amp; activity|Active now|All-agent context/);
  assert.match(html, /Connecting/);
  assert.doesNotMatch(html, /Local monitor offline/);
  assert.doesNotMatch(html, /Read-only · normalized metadata only/);
  assert.match(html, /Dashboards/);
  assert.match(html, /Usage limits/);
  assert.match(html, /Local profile/);
  assert.doesNotMatch(html, /Generate report|Flow score|Recent activity/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps the privacy explanation on the about page", async () => {
  const response = await render("/about");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /About .* Pomegr/);
  assert.match(html, /Observe coding-agent sessions without exposing prompts or responses/);
  assert.match(html, /Pomegr analyzes normalized execution metadata only/);
  assert.match(html, /What the estimate means/);
  assert.match(html, /cost\.total_cost_usd/);
  assert.match(html, /may differ from an actual API bill/);
  assert.match(html, /Source and license/);
  assert.match(html, /GNU Affero General Public License version 3/);
  assert.match(html, /provided without warranty/);
  assert.match(html, /corresponding source code/);
  assert.match(html, /Pomegr home/);
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
  assert.match(monitor, /requireLoopbackHost\(options\.host \?\? HOST/);
  assert.match(monitor, /await listen\(server, \{ host, port/);
  assert.doesNotMatch(stateRoute, /refreshUsage/);
  assert.match(stateRoute, /monitorParams\.set\("sessionId", sessionId\)/);
});
