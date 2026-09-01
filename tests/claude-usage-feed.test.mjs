import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureClaudeStatuslineUsage,
  claudeUsageLimitsFromSnapshot,
  readClaudeUsageSnapshot,
} from "../monitor/providers/claude-usage-feed.mjs";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { createClaudeUsageLimitsReader } from "../monitor/providers/claude-usage-limits.mjs";

function statusline(fiveHour = 23, sevenDay = 61) {
  return {
    session_id: "PRIVATE_SESSION_ID",
    transcript_path: "C:\\PRIVATE\\session.jsonl",
    rate_limits: {
      five_hour: { used_percentage: fiveHour, resets_at: 1786381200, opaque: "PRIVATE_FIVE_HOUR" },
      seven_day: { used_percentage: sevenDay, resets_at: 1786899600, opaque: "PRIVATE_SEVEN_DAY" },
    },
  };
}

function temporaryRoot(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-claude-usage-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("fallback credentials stay in the selected profile and requests reject redirects", async (context) => {
  const root = temporaryRoot(context);
  const profile = path.join(root, "selected-profile");
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "PRIVATE_TEST_TOKEN" } }));
  let requests = 0;
  const reader = createClaudeUsageLimitsReader({
    homeDir: root,
    usageSnapshotsRoot: root,
    env: { CLAUDE_CONFIG_DIR: profile },
    fetch: async (url, options) => {
      requests += 1;
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer PRIVATE_TEST_TOKEN");
      return new Response("PRIVATE_TEST_RESPONSE", { status: 401 });
    },
  });
  const result = await reader();
  assert.equal(requests, 1);
  assert.equal(result.failureKind, "authentication_required");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEST|selected-profile|credentials\.json/);
});

test("captures only a complete sanitized local Claude usage pair", (context) => {
  const root = temporaryRoot(context);
  const now = new Date("2026-08-10T12:00:00.000Z");
  const captured = captureClaudeStatuslineUsage(statusline(), { root, now });

  assert.deepEqual(captured, {
    version: 1,
    observedAt: now.toISOString(),
    limits: {
      fiveHour: { usedPercentage: 23, resetsAt: "2026-08-10T17:00:00.000Z" },
      sevenDay: { usedPercentage: 61, resetsAt: "2026-08-16T17:00:00.000Z" },
    },
  });
  const stored = fs.readFileSync(path.join(root, "claude.json"), "utf8");
  assert.doesNotMatch(stored, /PRIVATE|session_id|transcript_path|opaque/i);
  assert.deepEqual(claudeUsageLimitsFromSnapshot(readClaudeUsageSnapshot({ root })), {
    available: true,
    fetchedAt: now.toISOString(),
    attemptedAt: now.toISOString(),
    failureKind: null,
    retryAt: null,
    error: "",
    limits: [
      { id: "current-session", label: "Current session", window: "5 hours", percent: 23, resetsAt: "2026-08-10T17:00:00.000Z", severity: "normal", active: false },
      { id: "all-models", label: "All models", window: "7 days", percent: 61, resetsAt: "2026-08-16T17:00:00.000Z", severity: "normal", active: false },
    ],
    origin: "local_observation",
    freshness: "fresh",
  });
});

test("rejects incomplete data and retains the last complete atomic snapshot", (context) => {
  const root = temporaryRoot(context);
  const first = captureClaudeStatuslineUsage(statusline(), { root, now: new Date("2026-08-10T12:00:00.000Z") });
  assert.equal(captureClaudeStatuslineUsage({ rate_limits: { five_hour: statusline().rate_limits.five_hour } }, { root }), null);
  assert.deepEqual(readClaudeUsageSnapshot({ root }), first);

  fs.writeFileSync(path.join(root, "claude.json"), "{ malformed", "utf8");
  assert.equal(readClaudeUsageSnapshot({ root }), null);
  const replacement = captureClaudeStatuslineUsage(statusline(24, 62), { root, now: new Date("2026-08-10T12:01:00.000Z") });
  assert.equal(replacement?.limits.fiveHour.usedPercentage, 24);
  assert.deepEqual(readClaudeUsageSnapshot({ root }), replacement);
});

test("does not advance observation time for repeated statusline usage", (context) => {
  const root = temporaryRoot(context);
  const first = captureClaudeStatuslineUsage(statusline(), { root, now: new Date("2026-08-10T12:00:00.000Z") });
  const repeated = captureClaudeStatuslineUsage(statusline(), { root, now: new Date("2026-08-10T12:30:00.000Z") });
  assert.deepEqual(repeated, first);
});

test("accepts only finite epoch-second statusline resets and rejects future stored observations", (context) => {
  const root = temporaryRoot(context);
  const invalid = statusline();
  invalid.rate_limits.five_hour.resets_at = "2026-08-10T17:00:00.000Z";
  assert.equal(captureClaudeStatuslineUsage(invalid, { root }), null);
  invalid.rate_limits.five_hour.resets_at = Number.POSITIVE_INFINITY;
  assert.equal(captureClaudeStatuslineUsage(invalid, { root }), null);

  const future = {
    version: 1,
    observedAt: "2026-08-10T12:02:00.000Z",
    limits: {
      fiveHour: { usedPercentage: 23, resetsAt: "2026-08-10T17:00:00.000Z" },
      sevenDay: { usedPercentage: 61, resetsAt: "2026-08-16T17:00:00.000Z" },
    },
  };
  fs.writeFileSync(path.join(root, "claude.json"), JSON.stringify(future), "utf8");
  assert.equal(readClaudeUsageSnapshot({ root, now: new Date("2026-08-10T12:00:00.000Z") }), null);
});

test("serves fresh local usage immediately while a shared API check is pending", async (context) => {
  const root = temporaryRoot(context);
  let currentTime = Date.parse("2026-08-10T12:00:00.000Z");
  captureClaudeStatuslineUsage(statusline(), { root, now: new Date(currentTime) });
  let requests = 0;
  const provider = createClaudeProvider({
    homeDir: root,
    usageSnapshotsRoot: root,
    now: () => currentTime,
    usageRequest: async () => { requests += 1; return new Promise(() => {}); },
  });
  const limits = await provider.readUsageLimits();
  assert.equal(requests, 1);
  assert.equal(limits.origin, "local_observation");
  assert.equal(limits.freshness, "fresh");
  assert.equal(limits.fetchedAt, "2026-08-10T12:00:00.000Z");
  assert.equal(limits.attemptedAt, null, "a pending API check has no completed attempt timestamp");
  assert.equal(limits.retainedLimits, undefined, "no model value is invented before an API observation");
  await provider.readUsageLimits();
  assert.equal(requests, 1, "overlapping reads share the pending request");
});

for (const [status, failureKind] of [[401, "authentication_required"], [429, "rate_limited"], [503, "unavailable"]]) {
  test(`exposes the completed ${status} API failure while local usage remains fresh`, async (context) => {
    const root = temporaryRoot(context);
    const currentTime = Date.parse("2026-08-10T12:00:00.000Z");
    captureClaudeStatuslineUsage(statusline(), { root, now: new Date(currentTime) });
    let requests = 0;
    const reader = createClaudeUsageLimitsReader({
      homeDir: root, usageSnapshotsRoot: root, now: () => currentTime,
      usageRequest: async () => { requests += 1; return new Response("PRIVATE_API_BODY", { status }); },
    });
    await reader();
    await new Promise((resolve) => setImmediate(resolve));
    const value = await reader();
    assert.equal(value.origin, "local_observation");
    assert.equal(value.available, true);
    assert.equal(value.freshness, "fresh");
    assert.equal(value.failureKind, failureKind);
    assert.equal(value.attemptedAt, "2026-08-10T12:00:00.000Z");
    assert.equal(value.retryAt, "2026-08-10T12:05:00.000Z");
    assert.equal(requests, 1);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_API_BODY/);
  });
}

test("retains Fable separately when newer local windows replace an API observation", async (context) => {
  const root = temporaryRoot(context);
  let currentTime = Date.parse("2026-08-10T12:00:00.000Z");
  let requests = 0;
  const reader = createClaudeUsageLimitsReader({
    homeDir: root,
    usageSnapshotsRoot: root,
    now: () => currentTime,
    usageRequest: async () => {
      requests += 1;
      return requests === 1 ? new Response(JSON.stringify({ limits: [
        { kind: "session", percent: 20, resets_at: "2026-08-10T17:00:00.000Z" },
        { kind: "weekly_all", percent: 50, resets_at: "2026-08-16T17:00:00.000Z" },
        { kind: "weekly_scoped", scope: { model: { display_name: "Fable", private: "PRIVATE_MODEL" } }, percent: 73, resets_at: "2026-08-16T17:00:00.000Z", private: "PRIVATE_LIMIT" },
      ] }), { status: 200 }) : new Response("PRIVATE_AUTH_BODY", { status: 401 });
    },
  });
  const original = await reader();
  assert.equal(original.limits.length, 3);
  currentTime += 60_000;
  captureClaudeStatuslineUsage(statusline(23, 61), { root, now: new Date(currentTime) });
  const local = await reader();
  assert.equal(local.origin, "local_observation");
  assert.equal(local.fetchedAt, "2026-08-10T12:01:00.000Z");
  assert.deepEqual(local.limits.map((limit) => limit.id), ["current-session", "all-models"]);
  assert.deepEqual(local.retainedLimits, { fetchedAt: original.fetchedAt, limits: [original.limits[2]] });
  assert.equal(requests, 1, "Fable retention must not add requests while the local feed is fresh");
  currentTime += 6 * 60_000;
  await reader();
  await new Promise((resolve) => setImmediate(resolve));
  const stale = await reader();
  assert.equal(requests, 2);
  assert.equal(stale.failureKind, "authentication_required");
  assert.deepEqual(stale.retainedLimits, local.retainedLimits);
  assert.doesNotMatch(JSON.stringify(stale), /PRIVATE_/);
});

test("continues refreshing Fable on the API cooldown while local usage stays fresh", async (context) => {
  const root = temporaryRoot(context);
  let currentTime = Date.parse("2026-08-10T12:00:00.000Z");
  let requests = 0;
  const reader = createClaudeUsageLimitsReader({
    homeDir: root,
    usageSnapshotsRoot: root,
    now: () => currentTime,
    usageRequest: async () => {
      requests += 1;
      return new Response(JSON.stringify({ limits: [
        { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: requests * 10, resets_at: "2026-08-16T17:00:00.000Z" },
      ] }));
    },
  });
  captureClaudeStatuslineUsage(statusline(23, 61), { root, now: new Date(currentTime) });
  const first = await reader();
  assert.equal(first.origin, "local_observation");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await reader()).retainedLimits.limits[0].percent, 10);
  currentTime += 4 * 60_000;
  captureClaudeStatuslineUsage(statusline(24, 62), { root, now: new Date(currentTime) });
  await reader();
  assert.equal(requests, 1);
  currentTime += 60_000;
  captureClaudeStatuslineUsage(statusline(25, 63), { root, now: new Date(currentTime) });
  await reader();
  await new Promise((resolve) => setImmediate(resolve));
  await reader();
  const refreshed = await reader();
  assert.equal(requests, 2);
  assert.equal(refreshed.retainedLimits.limits[0].percent, 20);
  assert.equal(refreshed.retainedLimits.fetchedAt, "2026-08-10T12:05:00.000Z");
  assert.deepEqual(refreshed.limits.map((limit) => limit.percent), [25, 63]);
});

test("uses the newest complete remote observation after a stale local feed and retains stale local values on failure", async (context) => {
  const root = temporaryRoot(context);
  let currentTime = Date.parse("2026-08-10T12:06:00.000Z");
  captureClaudeStatuslineUsage(statusline(23, 61), { root, now: new Date("2026-08-10T12:00:00.000Z") });
  const remoteProvider = createClaudeProvider({
    homeDir: root,
    usageSnapshotsRoot: root,
    now: () => currentTime,
    usageRequest: async () => new Response(JSON.stringify({ limits: [
      { kind: "session", percent: 25, resets_at: "2026-08-10T17:00:00.000Z", is_active: false },
      { kind: "weekly_all", percent: 63, resets_at: "2026-08-16T17:00:00.000Z", is_active: false },
    ] }), { status: 200 }),
  });
  const remote = await remoteProvider.readUsageLimits();
  assert.equal(remote.origin, "provider_api");
  assert.equal(remote.freshness, "fresh");
  assert.deepEqual(remote.limits.map((limit) => limit.percent), [25, 63]);

  currentTime += 6 * 60_000;
  const fallbackProvider = createClaudeProvider({
    homeDir: root,
    usageSnapshotsRoot: root,
    now: () => currentTime,
    usageRequest: async () => new Response("PRIVATE_PROVIDER_BODY", { status: 503 }),
  });
  const stale = await fallbackProvider.readUsageLimits();
  assert.equal(stale.origin, "local_observation");
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.fetchedAt, "2026-08-10T12:00:00.000Z");
  assert.equal(stale.failureKind, "unavailable");
  assert.doesNotMatch(JSON.stringify(stale), /PRIVATE_PROVIDER_BODY/);
});

test("never regresses a newer remote pair when an older local snapshot is restored", async (context) => {
  const root = temporaryRoot(context);
  const currentTime = Date.parse("2026-08-10T12:06:00.000Z");
  captureClaudeStatuslineUsage(statusline(20, 50), { root, now: new Date("2026-08-10T12:00:00.000Z") });
  const provider = createClaudeProvider({
    homeDir: root,
    usageSnapshotsRoot: root,
    now: () => currentTime,
    usageRequest: async () => new Response(JSON.stringify({ limits: [
      { kind: "session", percent: 25, resets_at: "2026-08-10T17:00:00.000Z", is_active: false },
      { kind: "weekly_all", percent: 63, resets_at: "2026-08-16T17:00:00.000Z", is_active: false },
    ] }), { status: 200 }),
  });
  assert.equal((await provider.readUsageLimits()).origin, "provider_api");
  captureClaudeStatuslineUsage(statusline(19, 49), { root, now: new Date("2026-08-10T12:01:00.000Z") });
  const selected = await provider.readUsageLimits();
  assert.equal(selected.origin, "provider_api");
  assert.deepEqual(selected.limits.map((limit) => limit.percent), [25, 63]);
});

test("keeps a retained remote pair while surfacing its later authentication failure", async (context) => {
  const root = temporaryRoot(context);
  let currentTime = Date.parse("2026-08-10T12:00:00.000Z");
  let calls = 0;
  const reader = createClaudeUsageLimitsReader({
    homeDir: root,
    usageSnapshotsRoot: root,
    now: () => currentTime,
    usageRequest: async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ limits: [{ kind: "session", percent: 25, resets_at: "2026-08-10T17:00:00.000Z", is_active: false }] }), { status: 200 })
        : new Response("PRIVATE_AUTH_BODY", { status: 401 });
    },
  });
  assert.equal((await reader()).failureKind, null);
  currentTime += 5 * 60_000;
  await reader();
  await new Promise((resolve) => setImmediate(resolve));
  const retained = await reader();
  assert.equal(retained.available, true);
  assert.equal(retained.failureKind, "authentication_required");
  assert.equal(retained.retryAt, "2026-08-10T12:10:00.000Z");
  assert.doesNotMatch(JSON.stringify(retained), /PRIVATE_AUTH_BODY/);
});

test("treats expired local windows as stale and retains its in-memory last good pair across a malformed replacement", async (context) => {
  const root = temporaryRoot(context);
  let currentTime = Date.parse("2026-08-10T12:00:00.000Z");
  captureClaudeStatuslineUsage(statusline(), { root, now: new Date(currentTime) });
  let requests = 0;
  const provider = createClaudeProvider({
    homeDir: root,
    usageSnapshotsRoot: root,
    now: () => currentTime,
    usageRequest: async () => { requests += 1; return new Response("", { status: 503 }); },
  });
  assert.equal((await provider.readUsageLimits()).freshness, "fresh");
  fs.writeFileSync(path.join(root, "claude.json"), "{ malformed", "utf8");
  currentTime += 1_000;
  const retained = await provider.readUsageLimits();
  assert.equal(retained.origin, "local_observation");
  assert.equal(retained.fetchedAt, "2026-08-10T12:00:00.000Z");

  captureClaudeStatuslineUsage(statusline(), { root, now: new Date(currentTime) });
  const expired = statusline();
  expired.rate_limits.five_hour.resets_at = (currentTime - 1_000) / 1_000;
  captureClaudeStatuslineUsage(expired, { root, now: new Date(currentTime) });
  const stale = await provider.readUsageLimits();
  assert.equal(stale.freshness, "stale");
  assert.equal(requests, 1);
});

test("the statusline bridge captures usage while preserving argv delegation", (context) => {
  const root = temporaryRoot(context);
  const bridge = path.resolve("scripts/claude-statusline-bridge.mjs");
  const input = JSON.stringify(statusline());
  const result = spawnSync(process.execPath, [bridge, "--", process.execPath, "-e", "process.stdin.on('data', value => process.stdout.write(value))"], {
    input,
    encoding: "utf8",
    env: { ...process.env, POMEGR_USAGE_SNAPSHOTS_DIR: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, input);
  assert.equal(readClaudeUsageSnapshot({ root })?.limits.sevenDay.usedPercentage, 61);
});

test("the bridge captures usage when cost capture cannot write", (context) => {
  const root = temporaryRoot(context);
  const blockedCostRoot = path.join(root, "cost-root-file");
  fs.writeFileSync(blockedCostRoot, "not a directory", "utf8");
  const bridge = path.resolve("scripts/claude-statusline-bridge.mjs");
  const result = spawnSync(process.execPath, [bridge], {
    input: JSON.stringify(statusline()),
    encoding: "utf8",
    env: { ...process.env, POMEGR_COST_SNAPSHOTS_DIR: blockedCostRoot, POMEGR_USAGE_SNAPSHOTS_DIR: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readClaudeUsageSnapshot({ root })?.limits.fiveHour.usedPercentage, 23);
});

test("the bridge discards oversized input before capture or delegation buffering", (context) => {
  const root = temporaryRoot(context);
  const bridge = path.resolve("scripts/claude-statusline-bridge.mjs");
  const result = spawnSync(process.execPath, [bridge, "--", process.execPath, "-e", "process.stdin.on('data', value => process.stdout.write(value))"], {
    input: "x".repeat(1_000_001),
    encoding: "utf8",
    env: { ...process.env, POMEGR_USAGE_SNAPSHOTS_DIR: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(readClaudeUsageSnapshot({ root }), null);
});
