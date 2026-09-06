import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCacheReadDrops } from "../monitor/cache-read-drops.mjs";
import {
  SessionObservationCheckpointStore,
  checkpointFilename,
} from "../monitor/session-observation-checkpoints.mjs";
import { SessionObservationStore } from "../monitor/session-observation-store.mjs";
import { parseProviderSessionEvidence } from "../monitor/providers/provider-contract.mjs";
import { buildRequestSnapshots } from "../monitor/request-snapshots.mjs";

test("checkpoint restart preserves only bounded request action evidence and its committed revision", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory });
  const evidence = parseProviderSessionEvidence(JSON.parse(await readFile(
    new URL("./fixtures/providers/claude/expected-session-evidence.json", import.meta.url), "utf8",
  )));
  evidence.usageSnapshots[0].precedingWork = [{ kind: "read", count: 2 }];
  const committed = { ...snapshot("claude", evidence.localId, 7), evidence };
  await checkpoints.write(committed);
  const loaded = await checkpoints.load();
  assert.equal(loaded.ignored, 0);
  assert.equal(loaded.records[0].revision, 7);
  const restored = parseProviderSessionEvidence(loaded.records[0].evidence);
  assert.deepEqual(restored.usageSnapshots, evidence.usageSnapshots);
  const feed = buildRequestSnapshots({ agents: restored.agents, usageSnapshots: restored.usageSnapshots });
  assert.deepEqual(feed.items[0].precedingWork, [{ kind: "read", count: 2 }]);
  assert.equal(feed.items[0].precedingAssociation, "transcript_adjacency");
  assert.equal(feed.items[0].issuedAssociation, "recorded_link");
});

async function temporaryCheckpointDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-observation-checkpoints-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function snapshot(providerId, localSessionId, revision = 1) {
  return {
    providerId,
    localSessionId,
    evidence: { session: { title: "Safe normalized title" }, observations: [{ id: "observation-1" }] },
    readiness: { core: "ready", activityEvidence: "ready" },
    revision,
    observedAt: "2026-08-28T12:00:00.000Z",
    source: { fingerprint: "safe-fingerprint", completeOffset: 42 },
    publicState: { mustNotPersist: "PRIVATE_PATH_MUST_NOT_LEAK" },
    serializedState: '{"mustNotPersist":"PRIVATE_PATH_MUST_NOT_LEAK"}',
  };
}

test("writes atomic privacy-filtered checkpoint payloads and restores them after restart", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory });
  const committed = snapshot("provider-a", "session-1", 4);
  const written = await checkpoints.write(committed);
  assert.match(written.filename, /^checkpoint-[a-f0-9]{64}\.json$/);
  assert.doesNotMatch(written.filename, /provider-a|session-1/);
  const serialized = await readFile(path.join(directory, written.filename), "utf8");
  assert.doesNotMatch(serialized, /PRIVATE_PATH_MUST_NOT_LEAK|mustNotPersist|serializedState/);
  assert.equal((await readdir(directory)).some((file) => file.endsWith(".tmp")), false);

  const loaded = await checkpoints.load({
    projectState(payload) {
      return { restored: payload.evidence.session.title };
    },
  });
  assert.equal(loaded.ignored, 0);
  assert.equal(loaded.records.length, 1);
  const l1 = new SessionObservationStore();
  const restored = l1.restore(loaded.records[0]);
  assert.equal(restored.accepted, true);
  assert.deepEqual(l1.get("provider-a", "session-1").publicState, { restored: "Safe normalized title" });
  assert.equal(l1.get("provider-a", "session-1").source.completeOffset, 42);
});

test("round-trips normalized minimum lifetimes and preserves legacy unavailable values", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory });
  const committed = snapshot("codex", "minimum", 3);
  const beforeAt = "2026-08-28T11:59:00.000Z";
  committed.evidence.usageSnapshots = [
    { dedupeId: "checkpoint-before", actorId: "primary", timestamp: beforeAt, input: 1_000, output: 10, cacheRead: 9_000, cacheWrite: 0, model: "gpt-5.6-sol", comparisonGroup: 0, cacheLifetime: "30m+", cacheReadComparable: true, cacheReadPreviousAt: null },
    { dedupeId: "checkpoint-legacy", actorId: "child", timestamp: "2026-08-28T12:00:00.000Z", input: 1_000, output: 10, cacheRead: 9_000, cacheWrite: 0, model: "gpt-5.6-sol", comparisonGroup: 0, cacheLifetime: null },
    { dedupeId: "checkpoint-after", actorId: "primary", timestamp: "2026-08-28T12:00:00.000Z", input: 10_000, output: 10, cacheRead: 0, cacheWrite: 0, model: "gpt-5.6-sol", comparisonGroup: 0, cacheLifetime: "30m+", cacheReadComparable: true, cacheReadPreviousAt: beforeAt },
  ];
  await checkpoints.write(committed);
  const loaded = await checkpoints.load();
  assert.equal(loaded.ignored, 0);
  assert.equal(loaded.records[0].revision, 3);
  assert.deepEqual(loaded.records[0].evidence.usageSnapshots, committed.evidence.usageSnapshots);
  assert.equal(loaded.records[0].evidence.usageSnapshots[0].cacheReadComparable, true);
  assert.equal(loaded.records[0].evidence.usageSnapshots[2].cacheReadPreviousAt, beforeAt);
  assert.equal(Object.hasOwn(loaded.records[0].evidence.usageSnapshots[1], "cacheReadComparable"), false, "missing provenance stays unknown");
  const roundTripped = loaded.records[0].evidence.usageSnapshots;
  const feed = buildCacheReadDrops({ sessionId: "codex:minimum", agents: [{ id: "primary" }, { id: "child" }], usageSnapshots: roundTripped });
  assert.equal(feed.status, "ready");
  assert.equal(feed.items[0].count, 1);
  const legacy = roundTripped.map((item) => { const copy = { ...item }; delete copy.cacheReadComparable; delete copy.cacheReadPreviousAt; return copy; });
  assert.equal(buildCacheReadDrops({ sessionId: "codex:legacy", agents: [{ id: "primary" }], usageSnapshots: legacy.filter((item) => item.actorId === "primary") }).status, "unavailable");
});

test("startup restore can skip stale checkpoints before public projection", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory });
  const recent = snapshot("provider-a", "recent");
  const stale = { ...snapshot("provider-a", "stale"), observedAt: "2020-01-01T00:00:00.000Z" };
  await checkpoints.write(recent);
  await checkpoints.write(stale);
  const projected = [];
  const loaded = await checkpoints.load({
    includeRecord: (record) => record.observedAt === recent.observedAt,
    projectState(record) {
      projected.push(record.localSessionId);
      return record.evidence;
    },
  });
  assert.deepEqual(loaded.records.map((record) => record.localSessionId), ["recent"]);
  assert.deepEqual(projected, ["recent"]);
  assert.equal(loaded.skipped, 1);
  assert.equal(loaded.ignored, 0);
});

test("ignores corrupted, unknown-version, and validation-rejected checkpoints without blocking valid restart state", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({
    directory,
    validateCandidate(candidate) {
      return candidate.localSessionId !== "reject-me";
    },
  });
  await checkpoints.write(snapshot("provider-a", "good", 2));
  const unknown = checkpointFilename("provider-a", "unknown");
  const rejected = checkpointFilename("provider-a", "reject-me");
  const corrupt = `checkpoint-${"f".repeat(64)}.json`;
  await writeFile(path.join(directory, unknown), JSON.stringify({ version: 999 }), "utf8");
  await writeFile(path.join(directory, rejected), JSON.stringify({
    version: 1,
    providerId: "provider-a",
    localSessionId: "reject-me",
    source: null,
    evidence: {},
    readiness: { core: "ready" },
    revision: 1,
    observedAt: "2026-08-28T12:00:00.000Z",
  }), "utf8");
  await writeFile(path.join(directory, corrupt), "{not-json", "utf8");

  const loaded = await checkpoints.load();
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.records[0].localSessionId, "good");
  assert.equal(loaded.ignored, 3);
});

test("replaces a session atomically and prunes old bounded checkpoint entries", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory, maxEntries: 1, maxBytes: 10_000 });
  await checkpoints.write(snapshot("provider-a", "replace", 1));
  await checkpoints.write(snapshot("provider-a", "replace", 2));
  const replacement = await checkpoints.load();
  assert.equal(replacement.records.length, 1);
  assert.equal(replacement.records[0].revision, 2);

  await checkpoints.write(snapshot("provider-a", "newer", 1));
  const pruned = await checkpoints.load();
  assert.equal(pruned.records.length, 1);
  assert.equal(pruned.records[0].localSessionId, "newer");
});

test("rejects checkpoints containing raw/private fields before they reach disk", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory });
  const unsafe = snapshot("provider-a", "unsafe");
  unsafe.evidence = { rawTranscript: "PROMPT_MUST_NOT_LEAK" };
  await assert.rejects(checkpoints.write(unsafe), /checkpoint/);
  const loaded = await checkpoints.load();
  assert.equal(loaded.records.length, 0);
});

test("uses the validation hook before persisting a candidate", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({
    directory,
    validateCandidate: () => false,
  });
  await assert.rejects(checkpoints.write(snapshot("provider-a", "rejected")), /rejected/);
  assert.equal((await readdir(directory).catch(() => [])).length, 0);
});
