import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeUsageLimitsReader } from "../monitor/providers/claude-usage-limits.mjs";
import { captureClaudeStatuslineUsage } from "../monitor/providers/claude-usage-feed.mjs";
import { createMonitorRuntime, createMonitorServer } from "../monitor/server.mjs";
import { createEmptyProviderCapabilities } from "../shared/monitor-state.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const retainFable of [false, true]) {
test(`usage GETs serve committed sanitized Claude local usage (retained Fable: ${retainFable}) without acquisition`, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-claude-usage-serving-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse("2026-08-10T12:00:00.000Z");
  const localInput = {
    session_id: "PRIVATE_SESSION",
    transcript_path: "C:\\PRIVATE\\transcript.jsonl",
    rate_limits: {
      five_hour: { used_percentage: 23, resets_at: 1786381200, private: "PRIVATE_FIVE" },
      seven_day: { used_percentage: 61, resets_at: 1786899600, private: "PRIVATE_SEVEN" },
    },
  };

  const provider = {
    id: "claude",
    source: "Claude Code",
    capabilities: { ...createEmptyProviderCapabilities(), usageLimits: true },
    homePolicy: { requestModelObservations: true, modelSelection: false, usageLimitActivity: { enabled: false } },
  };
  let remoteRequests = 0;
  const profile = path.join(root, "profile");
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, ".credentials.json"), "PRIVATE_CREDENTIAL");
  const readerOptions = {
    claudeConfigDir: profile,
    homeDir: root,
    usageSnapshotsRoot: root,
    now: () => now,
    usageRequest: async () => {
      remoteRequests += 1;
      assert.equal(remoteRequests, 1);
      if (!retainFable) return new Response("PRIVATE_AUTH_BODY", { status: 401 });
      return new Response(JSON.stringify({ limits: [
        { kind: "weekly_scoped", scope: { model: { display_name: "Fable", private: "PRIVATE_MODEL" } }, percent: 73, resets_at: "2026-08-16T17:00:00.000Z", private: "PRIVATE_LIMIT" },
      ] }));
    },
  };
  let reader = createClaudeUsageLimitsReader(readerOptions);
  if (retainFable) {
    await reader();
    reader = createClaudeUsageLimitsReader(readerOptions);
  }
  now += 60_000;
  captureClaudeStatuslineUsage(localInput, { root, now: new Date(now) });
  let providerReads = 0;
  const registry = {
    providers: [provider],
    defaultProvider: provider,
    providerForSessionId: () => provider,
    async resolveCapabilities() { return provider.capabilities; },
    async readUsageLimits() { providerReads += 1; return reader(); },
    async readServiceStatus() { return null; },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    unavailableMessage: () => "Unavailable",
    async startObservers(publisher) {
      publisher.publishCatalog("claude", []);
      return { async hydrate() { return true; }, async stop() {} };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry,
    checkpointStore: false,
    now: () => now,
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  await runtime.startObservation();
  context.after(async () => runtime.stopObservation());
  for (let attempt = 0; attempt < 50 && runtime.serveUsageLimits().snapshot?.value?.providers?.length !== 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(providerReads, 1);

  const server = createMonitorServer({ runtime });
  const origin = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${origin}/api/usage-limits`)));
  assert.equal(responses.every((response) => response.status === 200), true);
  const revision = responses[0].headers.get("x-pomegr-revision");
  const bodies = await Promise.all(responses.map((response) => response.text()));
  assert.equal(new Set(bodies).size, 1);
  assert.equal(providerReads, 1);
  assert.doesNotMatch(bodies[0], /PRIVATE_|transcript/i);
  const payload = JSON.parse(bodies[0]);
  assert.equal(payload.providers[0].usageLimits.origin, "local_observation");
  assert.equal(payload.providers[0].usageLimits.freshness, "fresh");
  assert.equal(payload.providers[0].usageLimits.limits[0].percent, 23);
  const retained = payload.providers[0].usageLimits.retainedLimits;
  if (retainFable) {
    assert.equal(retained.fetchedAt, "2026-08-10T12:00:00.000Z");
    assert.equal(retained.limits[0].label, "Fable");
    assert.equal(retained.limits[0].percent, 73);
  } else assert.equal(retained, undefined);
  assert.equal(remoteRequests, 1, "background API checks remain shared; GETs never acquire usage");
  assert.equal((await fetch(`${origin}/api/usage-limits?revision=${revision}`)).status, 204);
});
}
