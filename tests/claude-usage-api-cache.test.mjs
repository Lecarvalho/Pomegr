import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeUsageApiCache } from "../monitor/providers/claude-usage-api-cache.mjs";

const NOW = Date.parse("2026-08-10T12:00:00.000Z");
const ATTEMPT = "2026-08-10T11:59:00.000Z";
const FETCHED = "2026-08-10T11:58:00.000Z";
const RESET = "2026-08-10T17:00:00.000Z";

function temporaryRoot(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-claude-api-cache-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(context) {
  const root = temporaryRoot(context);
  const configDir = path.join(root, "profile");
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "PRIVATE_TOKEN" } }));
  const cache = createClaudeUsageApiCache({ root, configDir, now: () => NOW });
  return { root, configDir, cache, fingerprint: cache.fingerprint() };
}

function limit(id, percent, resetsAt = RESET, active = false) {
  return { id, label: "PRIVATE_LABEL", window: "PRIVATE_WINDOW", percent, resetsAt, severity: "critical", active };
}

function value(overrides = {}) {
  return {
    available: true,
    fetchedAt: FETCHED,
    attemptedAt: FETCHED,
    failureKind: null,
    retryAt: null,
    error: "PRIVATE_ERROR",
    limits: [limit("current-session", 23), limit("all-models", 61), limit("model-fable", 73)],
    origin: "provider_api",
    freshness: "fresh",
    ...overrides,
  };
}

test("round trips complete API usage, retaining Fable and reconstructing safe fields", (context) => {
  const { cache, fingerprint } = fixture(context);
  assert.ok(fingerprint);
  assert.equal(cache.write(value(), NOW + 5 * 60_000, fingerprint), true);

  const restored = cache.read(fingerprint);
  assert.equal(restored?.nextAttemptAt, NOW + 5 * 60_000);
  assert.deepEqual(restored?.value, {
    available: true,
    fetchedAt: FETCHED,
    attemptedAt: FETCHED,
    failureKind: null,
    retryAt: null,
    error: "",
    limits: [
      { id: "current-session", label: "Current session", window: "5 hours", percent: 23, resetsAt: RESET, severity: "normal", active: false },
      { id: "all-models", label: "All models", window: "7 days", percent: 61, resetsAt: RESET, severity: "normal", active: false },
      { id: "model-fable", label: "Fable", window: "7 days", percent: 73, resetsAt: RESET, severity: "normal", active: false },
    ],
    origin: "provider_api",
    freshness: "stale",
  });
});

test("a failed refresh preserves limits and exposes only fixed retry/error values", (context) => {
  const { cache, fingerprint } = fixture(context);
  const failed = value({
    attemptedAt: "2026-08-10T12:00:00.000Z",
    failureKind: "rate_limited",
    limits: [limit("model-fable", 73)],
  });
  assert.equal(cache.write(failed, NOW + 10 * 60_000, fingerprint), true);
  const restored = cache.read(fingerprint);
  assert.equal(restored?.value.failureKind, "rate_limited");
  assert.equal(restored?.value.retryAt, "2026-08-10T12:10:00.000Z");
  assert.equal(restored?.value.error, "Anthropic usage endpoint returned 429");
  assert.deepEqual(restored?.value.limits.map(({ id, label, window }) => ({ id, label, window })), [
    { id: "model-fable", label: "Fable", window: "7 days" },
  ]);
});

test("a successful empty result clears a previously retained Fable value", (context) => {
  const { cache, fingerprint } = fixture(context);
  assert.equal(cache.write(value(), NOW + 5 * 60_000, fingerprint), true);
  assert.equal(cache.write(value({
    fetchedAt: "2026-08-10T12:00:00.000Z",
    attemptedAt: "2026-08-10T12:00:00.000Z",
    limits: [],
  }), NOW + 10 * 60_000, fingerprint), true);
  const restored = cache.read(fingerprint);
  assert.equal(restored?.value.available, false);
  assert.deepEqual(restored?.value.limits, []);
  assert.equal(restored?.value.retryAt, null);
});

test("canonicalizes valid provider reset timestamp variants on write", (context) => {
  const { cache, fingerprint } = fixture(context);
  assert.equal(cache.write(value({ limits: [limit("model-fable", 73, "2026-08-10T17:00:00+00:00")] }), NOW + 5 * 60_000, fingerprint), true);
  assert.equal(cache.read(fingerprint)?.value.limits[0].resetsAt, RESET);
  assert.equal(cache.write(value({ limits: [limit("model-fable", 73, "not-a-timestamp")] }), NOW + 5 * 60_000, fingerprint), false);
});

test("credential profile and metadata changes invalidate reads and writes", (context) => {
  const { root, configDir, cache, fingerprint } = fixture(context);
  assert.equal(cache.write(value(), NOW + 5 * 60_000, fingerprint), true);
  const replacement = path.join(configDir, ".credentials-replacement.json");
  fs.writeFileSync(replacement, JSON.stringify({ claudeAiOauth: { accessToken: "PRIVATE_NEW_TOKEN" } }));
  fs.renameSync(replacement, path.join(configDir, ".credentials.json"));
  const changedFingerprint = cache.fingerprint();
  assert.ok(changedFingerprint);
  assert.notEqual(changedFingerprint, fingerprint);
  assert.equal(cache.read(fingerprint), null);
  assert.equal(cache.write(value(), NOW + 5 * 60_000, fingerprint), false);

  const otherProfile = path.join(root, "other-profile");
  fs.mkdirSync(otherProfile);
  fs.writeFileSync(path.join(otherProfile, ".credentials.json"), "{}", "utf8");
  const otherCache = createClaudeUsageApiCache({ root, configDir: otherProfile, now: () => NOW });
  assert.notEqual(otherCache.fingerprint(), changedFingerprint);
  assert.equal(otherCache.read(changedFingerprint), null);
});

test("rejects malformed, oversized, future, and untrusted stored data", (context) => {
  const { root, cache, fingerprint } = fixture(context);
  const file = path.join(root, "claude-api.json");
  const writeRaw = (raw) => { fs.writeFileSync(file, raw, "utf8"); assert.equal(cache.read(fingerprint), null); };
  writeRaw("{ malformed");
  writeRaw("x".repeat(8_193));
  writeRaw(JSON.stringify({
    version: 1, sourceFingerprint: fingerprint, fetchedAt: "2026-08-10T12:02:00.000Z",
    attemptedAt: ATTEMPT, failureKind: null, nextAttemptAt: "2026-08-10T12:05:00.000Z", limits: [],
  }));
  writeRaw(JSON.stringify({
    version: 1, sourceFingerprint: fingerprint, fetchedAt: FETCHED, attemptedAt: ATTEMPT,
    failureKind: null, nextAttemptAt: "2026-08-10T12:05:00.000Z", limits: [], hostile: "PRIVATE_FIELD",
  }));
  writeRaw(JSON.stringify({
    version: 1, sourceFingerprint: fingerprint, fetchedAt: FETCHED, attemptedAt: ATTEMPT,
    failureKind: null, nextAttemptAt: "2026-08-10T12:05:00.000Z", limits: [{ id: "model-fable", percent: 101, resetsAt: null, active: false }],
  }));
});

test("rejects invalid writes without partially accepting limits or shortening cooldown", (context) => {
  const { cache, fingerprint } = fixture(context);
  assert.equal(cache.write(value({ limits: [limit("current-session", 20), limit("current-session", 30)] }), NOW + 5 * 60_000, fingerprint), false);
  assert.equal(cache.write(value({ attemptedAt: "2026-08-10T12:00:00.000Z" }), NOW - 1, fingerprint), false);
  assert.equal(cache.write(value({ failureKind: "rate_limited", attemptedAt: "2026-08-10T12:00:00.000Z" }), NOW + 30_000, fingerprint), true);
  assert.equal(cache.read(fingerprint)?.nextAttemptAt, NOW + 30_000);
  assert.equal(cache.write(value({ attemptedAt: "2026-08-10T12:00:00.000Z" }), NOW + 5 * 60_000, "0".repeat(64)), false);
});

test("fails closed when the observation clock is invalid", (context) => {
  const { root, configDir, fingerprint } = fixture(context);
  const cache = createClaudeUsageApiCache({ root, configDir, now: () => Number.NaN });
  assert.equal(cache.write(value(), NOW + 5 * 60_000, fingerprint), false);
  assert.equal(cache.read(fingerprint), null);
});

test("keeps hostile provider fields out of the serialized cache and read value", (context) => {
  const { root, cache, fingerprint } = fixture(context);
  assert.equal(cache.write(value({
    error: "PRIVATE_RESPONSE_BODY",
    accountId: "PRIVATE_ACCOUNT_ID",
    limits: [limit("model-fable", 17)],
  }), NOW + 5 * 60_000, fingerprint), true);
  const serialized = fs.readFileSync(path.join(root, "claude-api.json"), "utf8");
  assert.doesNotMatch(serialized, /PRIVATE_|credentials\.json|profile/);
  assert.doesNotMatch(JSON.stringify(cache.read(fingerprint)), /PRIVATE_|credentials\.json|profile/);
});

test("returns safe failures for I/O errors", (context) => {
  const root = temporaryRoot(context);
  const configDir = path.join(root, "profile");
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, ".credentials.json"), "{}", "utf8");
  const blockedRoot = path.join(root, "blocked-root");
  fs.writeFileSync(blockedRoot, "file", "utf8");
  const cache = createClaudeUsageApiCache({ root: blockedRoot, configDir, now: () => NOW });
  const fingerprint = cache.fingerprint();
  assert.ok(fingerprint);
  assert.equal(cache.write(value(), NOW + 5 * 60_000, fingerprint), false);
  assert.equal(cache.read(fingerprint), null);
});
