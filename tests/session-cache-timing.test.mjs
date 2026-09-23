import assert from "node:assert/strict";
import test from "node:test";

import { projectSessionCacheTiming } from "../monitor/session-cache-timing.mjs";

function request(id, agentId, observedAt, cacheLifetime, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return { id, agentId, observedAt, cacheLifetime, uncachedInputTokens: 10, cacheReadTokens, cacheWriteTokens, outputTokens: 5, totalTokens: 15 + cacheReadTokens + cacheWriteTokens, precedingWork: [], precedingAssociation: null, issuedWork: [], issuedAssociation: null };
}

const agents = [{ id: "primary", status: "active" }, { id: "agent-2", status: "active" }];

test("session cache timing exposes only the primary agent's newest cache touch and allowlisted lifetime", () => {
  const timing = projectSessionCacheTiming(agents, { status: "ready", items: [
    request("old", "primary", "2026-08-08T12:00:00.000Z", "5m", 100),
    request("newest-primary", "primary", "2026-08-08T12:03:00.000Z", "1h", 0, 40),
    request("no-cache", "primary", "2026-08-08T12:04:00.000Z", "1h"),
    request("subagent", "agent-2", "2026-08-08T12:05:00.000Z", "5m", 300),
  ] });
  assert.deepEqual(timing, { lastCacheTouchAt: "2026-08-08T12:03:00.000Z", cacheLifetime: "1h" });
  assert.deepEqual(Object.keys(timing), ["lastCacheTouchAt", "cacheLifetime"]);
});

test("session cache timing nulls an unrecognized lifetime instead of forwarding it", () => {
  const timing = projectSessionCacheTiming(agents, { status: "ready", items: [
    request("touch", "primary", "2026-08-08T12:03:00.000Z", "PRIVATE_LIFETIME_VALUE", 100),
  ] });
  assert.deepEqual(timing, { lastCacheTouchAt: "2026-08-08T12:03:00.000Z", cacheLifetime: null });
});

test("session cache timing keeps recorded evidence for finished primaries so resumed sessions stay described", () => {
  const items = [request("touch", "primary", "2026-08-08T12:03:00.000Z", "5m", 100)];
  assert.deepEqual(projectSessionCacheTiming([{ id: "primary", status: "finished" }], { status: "ready", items }), { lastCacheTouchAt: "2026-08-08T12:03:00.000Z", cacheLifetime: "5m" });
});

test("session cache timing stays unavailable without a primary agent or usable evidence", () => {
  const items = [request("touch", "primary", "2026-08-08T12:03:00.000Z", "5m", 100)];
  assert.equal(projectSessionCacheTiming([{ id: "agent-2", status: "active" }], { status: "ready", items }), null);
  assert.equal(projectSessionCacheTiming(agents, { status: "unavailable", items: [] }), null);
  assert.equal(projectSessionCacheTiming(agents, { status: "ready", items: [request("bad", "primary", "not-a-date", "5m", 100)] }), null);
  assert.equal(projectSessionCacheTiming(agents, undefined), null);
});
