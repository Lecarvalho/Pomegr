import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCacheReadDrops } from "../../../../server/analytics/cache-read-drops.mjs";
import {
  SessionObservationCheckpointStore,
  checkpointFilename,
  repositorySnapshotFilename,
} from "../../../../server/sessions/checkpoints/session-observation-checkpoints.mjs";
import { SessionObservationStore } from "../../../../server/sessions/checkpoints/session-observation-store.mjs";
import { parseProviderSessionEvidence } from "../../../../server/providers/provider-contract.mjs";
import { buildRequestSnapshots } from "../../../../server/normalize/request-snapshots.mjs";
import { monitorStateFromProviderEvidence } from "../../../helpers/provider-fixtures.mjs";

test("restored evidence reprojects the bounded custom type without changing its committed revision", async (t) => {
  const checkpoints = new SessionObservationCheckpointStore({ directory: await temporaryCheckpointDirectory(t) });
  const evidence = parseProviderSessionEvidence(JSON.parse(await readFile(
    new URL("../../../fixtures/providers/claude/expected-session-evidence.json", import.meta.url), "utf8",
  )));
  const child = { ...evidence.agents[0], id: "custom-child", parentId: "primary" };
  evidence.agents.push(child);
  child.kind = "local:queue-runner";
  child.workflowId = null;
  await checkpoints.write({ ...snapshot("claude", evidence.localId, 7), evidence });
  const loaded = await checkpoints.load();
  assert.equal(loaded.records[0].revision, 7);
  const restored = parseProviderSessionEvidence(loaded.records[0].evidence);
  assert.equal(Object.hasOwn(restored.agents.find((agent) => agent.id === child.id), "customType"), false);
  const projected = monitorStateFromProviderEvidence("claude", restored).agents.find((agent) => agent.id === child.id);
  assert.equal(projected.role, "unknown");
  assert.equal(projected.customType, "queue-runner");
  assert.equal(Object.hasOwn(projected, "kind"), false);
});

test("checkpoint restart preserves only bounded request action evidence and its committed revision", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory });
  const evidence = parseProviderSessionEvidence(JSON.parse(await readFile(
    new URL("../../../fixtures/providers/claude/expected-session-evidence.json", import.meta.url), "utf8",
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

test("checkpoint round-trips normalized activity duration and opaque request correlation", async (t) => {
  const checkpoints = new SessionObservationCheckpointStore({ directory: await temporaryCheckpointDirectory(t) });
  const evidence = parseProviderSessionEvidence(JSON.parse(await readFile(
    new URL("../../../fixtures/providers/claude/expected-session-evidence.json", import.meta.url), "utf8",
  )));
  evidence.toolCalls[0].durationMs = 2_500;
  evidence.toolCalls[0].requestId = "request-0123456789abcdef";
  await checkpoints.write({ ...snapshot("claude", evidence.localId, 8), evidence });
  const loaded = await checkpoints.load();
  assert.equal(loaded.ignored, 0);
  assert.equal(loaded.records[0].evidence.toolCalls[0].durationMs, 2_500);
  assert.equal(loaded.records[0].evidence.toolCalls[0].requestId, "request-0123456789abcdef");
});

test("checkpoint permits only the contract-approved numeric reasoning output field", async (t) => {
  const checkpoints = new SessionObservationCheckpointStore({ directory: await temporaryCheckpointDirectory(t) });
  const evidence = parseProviderSessionEvidence(JSON.parse(await readFile(
    new URL("../../../fixtures/providers/codex/expected-session-evidence.json", import.meta.url), "utf8",
  )));
  assert.ok(evidence.usageSnapshots.some((entry) => Number.isFinite(entry.reasoningOutput)));
  await checkpoints.write({ ...snapshot("codex", evidence.localId, 9), evidence });
  const loaded = await checkpoints.load();
  assert.equal(loaded.ignored, 0);
  assert.deepEqual(loaded.records[0].evidence.usageSnapshots, evidence.usageSnapshots);
});

test("checkpoint permits the contract-approved diagnostic and transcript flags", async (t) => {
  const checkpoints = new SessionObservationCheckpointStore({ directory: await temporaryCheckpointDirectory(t) });
  const evidence = parseProviderSessionEvidence(JSON.parse(await readFile(
    new URL("../../../fixtures/providers/codex/expected-session-evidence.json", import.meta.url), "utf8",
  )));
  evidence.agents[0].transcriptAvailable = true;
  evidence.usageSnapshots[0].cacheMissDiagnosticState = "inconclusive";

  await checkpoints.write({ ...snapshot("codex", evidence.localId, 10), evidence });
  const loaded = await checkpoints.load();

  assert.equal(loaded.ignored, 0);
  assert.equal(loaded.records[0].evidence.agents[0].transcriptAvailable, true);
  assert.equal(loaded.records[0].evidence.usageSnapshots[0].cacheMissDiagnosticState, "inconclusive");
});

test("checkpoint accepts the provider contract's largest bounded collection", async (t) => {
  const checkpoints = new SessionObservationCheckpointStore({ directory: await temporaryCheckpointDirectory(t) });
  const evidence = { session: { title: "Safe normalized title" }, observations: Array.from({ length: 4_096 }, (_, index) => ({ id: `observation-${index}` })) };
  await checkpoints.write({ ...snapshot("provider-a", "bounded-collection", 10), evidence });
  const loaded = await checkpoints.load();
  assert.equal(loaded.ignored, 0);
  assert.equal(loaded.records[0].evidence.observations.length, 4_096);
});

async function temporaryCheckpointDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-observation-checkpoints-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function settleCheckpointMaintenance(store) {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const result = await store.maintenanceStep({ budget: 64 });
    assert.ok(result.processed <= 64);
    if (!result.scanning && !result.pending) return result;
  }
  throw new Error("checkpoint maintenance did not settle");
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

test("replaces a session atomically and maintenance later prunes old bounded checkpoint entries", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory, maxEntries: 1, maxBytes: 10_000 });
  await checkpoints.write(snapshot("provider-a", "replace", 1));
  await checkpoints.write(snapshot("provider-a", "replace", 2));
  const replacement = await checkpoints.load();
  assert.equal(replacement.records.length, 1);
  assert.equal(replacement.records[0].revision, 2);

  await checkpoints.write(snapshot("provider-a", "newer", 1));
  const newerFile = path.join(directory, checkpointFilename("provider-a", "newer"));
  const newerAt = new Date(Date.now() + 1_000);
  await utimes(newerFile, newerAt, newerAt);
  await settleCheckpointMaintenance(checkpoints);
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

function repositorySnapshot(overrides = {}) {
  return {
    version: 1,
    branch: "feat/sidecar",
    isMain: false,
    files: [{ status: " M", path: "app/file.ts" }],
    comparison: null,
    comparisonCheckedAt: null,
    pullRequests: null,
    commitsInSession: 2,
    checkedAt: "2026-08-28T12:00:00.000Z",
    ...overrides,
  };
}

test("writes an atomic repository-snapshot sidecar sharing its checkpoint's identity hash, and loads it back", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory });
  await checkpoints.write(snapshot("provider-a", "sidecar-session", 1));
  const written = await checkpoints.writeRepositorySnapshot("provider-a", "sidecar-session", repositorySnapshot());
  assert.equal(written.filename, repositorySnapshotFilename("provider-a", "sidecar-session"));
  assert.equal(written.filename.replace(/^repository-/, ""), checkpointFilename("provider-a", "sidecar-session").replace(/^checkpoint-/, ""));
  assert.doesNotMatch(written.filename, /provider-a|sidecar-session/);
  assert.equal((await readdir(directory)).some((file) => file.endsWith(".tmp")), false);

  const records = await checkpoints.loadRepositorySnapshots();
  assert.equal(records.length, 1);
  assert.equal(records[0].providerId, "provider-a");
  assert.equal(records[0].localSessionId, "sidecar-session");
  assert.equal(records[0].snapshot.branch, "feat/sidecar");

  await assert.rejects(checkpoints.writeRepositorySnapshot("provider-a", "sidecar-session", { ...repositorySnapshot(), branch: "" }), /repository snapshot/);
});

test("ignores an invalid or corrupted repository-snapshot sidecar without blocking other valid ones", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory });
  await checkpoints.write(snapshot("provider-a", "good-sidecar", 1));
  await checkpoints.writeRepositorySnapshot("provider-a", "good-sidecar", repositorySnapshot());
  await checkpoints.write(snapshot("provider-a", "corrupt-sidecar", 1));
  await writeFile(path.join(directory, repositorySnapshotFilename("provider-a", "corrupt-sidecar")), "{not-json", "utf8");
  await checkpoints.write(snapshot("provider-a", "invalid-shape-sidecar", 1));
  await writeFile(
    path.join(directory, repositorySnapshotFilename("provider-a", "invalid-shape-sidecar")),
    JSON.stringify({ version: 1, providerId: "provider-a", localSessionId: "invalid-shape-sidecar", snapshot: { branch: "no other fields" } }),
    "utf8",
  );

  const records = await checkpoints.loadRepositorySnapshots();
  assert.deepEqual(records.map((record) => record.localSessionId), ["good-sidecar"]);
});

test("checkpoint schema stays version 1 and unchanged by the repository-snapshot sidecar", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory });
  const written = await checkpoints.write(snapshot("provider-a", "schema-session", 1));
  await checkpoints.writeRepositorySnapshot("provider-a", "schema-session", repositorySnapshot());
  const payload = JSON.parse(await readFile(path.join(directory, written.filename), "utf8"));
  assert.deepEqual(
    Object.keys(payload).sort(),
    ["evidence", "localSessionId", "observedAt", "providerId", "readiness", "revision", "source", "version"],
  );
  assert.equal(payload.version, 1);
});

test("maintenance keeps a sidecar that has no checkpoint, however old", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory, maxEntries: 10, maxBytes: 100_000 });
  await checkpoints.writeRepositorySnapshot("provider-a", "early", repositorySnapshot());
  await checkpoints.writeRepositorySnapshot("provider-a", "old", repositorySnapshot());
  const old = path.join(directory, repositorySnapshotFilename("provider-a", "old"));
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await utimes(old, monthAgo, monthAgo);

  await checkpoints.write(snapshot("provider-a", "other", 1));
  await settleCheckpointMaintenance(checkpoints);
  const afterMaintenance = await readdir(directory);
  assert.ok(afterMaintenance.includes(repositorySnapshotFilename("provider-a", "early")), "a sidecar recorded before its session's first checkpoint is kept");
  assert.ok(afterMaintenance.includes(repositorySnapshotFilename("provider-a", "old")), "age alone never removes recorded repository state");
});

test("an evicted checkpoint keeps its repository-snapshot sidecar, which serves again once the checkpoint is rebuilt", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory, maxEntries: 1, maxBytes: 10_000 });
  await checkpoints.write(snapshot("provider-a", "ended", 1));
  await checkpoints.writeRepositorySnapshot("provider-a", "ended", repositorySnapshot({ branch: "feat/ended" }));
  const endedCheckpoint = path.join(directory, checkpointFilename("provider-a", "ended"));
  const older = new Date(Date.now() - 60_000);
  await utimes(endedCheckpoint, older, older);

  // A second checkpoint exceeds maxEntries: 1 and evicts the first. The checkpoint is a cache
  // rebuilt from its transcript; the recorded repository state is not, so the sidecar stays.
  await checkpoints.write(snapshot("provider-a", "current", 1));
  await checkpoints.writeRepositorySnapshot("provider-a", "current", repositorySnapshot({ branch: "feat/current" }));
  await settleCheckpointMaintenance(checkpoints);
  const afterEviction = await readdir(directory);
  assert.equal(afterEviction.includes(checkpointFilename("provider-a", "ended")), false, "the older checkpoint is evicted");
  assert.ok(afterEviction.includes(repositorySnapshotFilename("provider-a", "ended")), "its sidecar outlives the eviction");

  assert.deepEqual((await checkpoints.loadRepositorySnapshots({ withCheckpoint: true })).map((record) => record.localSessionId), ["current"],
    "the startup load reads only sidecars whose checkpoint is on disk");
  assert.equal((await checkpoints.loadRepositorySnapshot("provider-a", "ended")).branch, "feat/ended", "the evicted session's sidecar is read on demand");
  assert.equal(await checkpoints.loadRepositorySnapshot("provider-a", "never-recorded"), null);

  await checkpoints.write(snapshot("provider-a", "ended", 2));
  assert.equal((await checkpoints.loadRepositorySnapshot("provider-a", "ended")).branch, "feat/ended", "the rebuilt checkpoint still has its recorded repository state");
});

test("a session-event sidecar is written atomically, validated whole, and outlives its evicted checkpoint", async (t) => {
  const { sessionEventRecordFilename } = await import("../../../../server/sessions/checkpoints/session-observation-checkpoints.mjs");
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory, maxEntries: 1, maxBytes: 10_000 });
  const record = (minute) => ({ version: 1, refills: [{ at: new Date(Date.UTC(2026, 9, 2, 10, minute)).toISOString(), agentId: "primary", kind: "possible_full" }],
    compactions: [{ at: new Date(Date.UTC(2026, 9, 2, 11, minute)).toISOString(), agentId: "agent-a", trigger: "automatic" }] });
  await checkpoints.write(snapshot("provider-a", "ended", 1));
  const written = await checkpoints.writeSessionEventRecord("provider-a", "ended", record(1));
  assert.equal(written.filename, sessionEventRecordFilename("provider-a", "ended"));
  assert.equal(written.filename.replace(/^events-/, ""), checkpointFilename("provider-a", "ended").replace(/^checkpoint-/, ""));
  assert.equal((await readdir(directory)).some((file) => file.endsWith(".tmp")), false);
  assert.deepEqual(await checkpoints.loadSessionEventRecord("provider-a", "ended"), record(1));
  assert.equal(await checkpoints.loadSessionEventRecord("provider-a", "never-recorded"), null);

  await assert.rejects(checkpoints.writeSessionEventRecord("provider-a", "ended", { ...record(1), reason: "tools_changed" }), /session event record/);
  await assert.rejects(checkpoints.writeSessionEventRecord("provider-a", "ended", { ...record(1), refills: [{ at: "soon", agentId: "primary", kind: "possible_full" }] }), /session event record/);
  assert.deepEqual(await checkpoints.loadSessionEventRecord("provider-a", "ended"), record(1), "a rejected write leaves the record alone");

  await writeFile(path.join(directory, sessionEventRecordFilename("provider-a", "corrupt")), "{not-json", "utf8");
  await writeFile(path.join(directory, sessionEventRecordFilename("provider-a", "foreign")),
    JSON.stringify({ version: 1, providerId: "provider-a", localSessionId: "someone-else", record: record(2) }), "utf8");
  await writeFile(path.join(directory, sessionEventRecordFilename("provider-a", "newer")),
    JSON.stringify({ version: 1, providerId: "provider-a", localSessionId: "newer", record: { ...record(3), version: 2 } }), "utf8");
  assert.equal(await checkpoints.loadSessionEventRecord("provider-a", "corrupt"), null);
  assert.equal(await checkpoints.loadSessionEventRecord("provider-a", "foreign"), null);
  assert.equal(await checkpoints.loadSessionEventRecord("provider-a", "newer"), null, "an unknown version is never loaded");

  // A second checkpoint evicts the first; its event sidecar stays, because it cannot be rebuilt.
  const older = new Date(Date.now() - 60_000);
  await utimes(path.join(directory, checkpointFilename("provider-a", "ended")), older, older);
  await checkpoints.write(snapshot("provider-a", "current", 1));
  await settleCheckpointMaintenance(checkpoints);
  const afterEviction = await readdir(directory);
  assert.equal(afterEviction.includes(checkpointFilename("provider-a", "ended")), false);
  assert.ok(afterEviction.includes(sessionEventRecordFilename("provider-a", "ended")));

  await checkpoints.prune();
  const afterPrune = await readdir(directory);
  assert.equal(afterPrune.includes(sessionEventRecordFilename("provider-a", "corrupt")), false, "an invalid sidecar is removed");
  assert.ok(afterPrune.includes(sessionEventRecordFilename("provider-a", "newer")), "a newer build's sidecar is kept");
  assert.ok(afterPrune.includes(sessionEventRecordFilename("provider-a", "ended")));
});

test("event sidecars are bounded on their own, oldest first", async (t) => {
  const { sessionEventRecordFilename } = await import("../../../../server/sessions/checkpoints/session-observation-checkpoints.mjs");
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory, maxRepositorySnapshots: 2 });
  const record = { version: 1, refills: [{ at: "2026-10-02T10:00:00.000Z", agentId: "primary", kind: "possible_full" }], compactions: [] };
  for (const [index, name] of ["oldest", "middle", "newest"].entries()) {
    await checkpoints.writeSessionEventRecord("provider-a", name, record);
    const when = new Date(Date.now() - (3 - index) * 60_000);
    await utimes(path.join(directory, sessionEventRecordFilename("provider-a", name)), when, when);
  }
  await checkpoints.writeRepositorySnapshot("provider-a", "oldest", repositorySnapshot());
  await checkpoints.prune();
  const files = await readdir(directory);
  assert.equal(files.includes(sessionEventRecordFilename("provider-a", "oldest")), false);
  assert.ok(files.includes(sessionEventRecordFilename("provider-a", "middle")));
  assert.ok(files.includes(sessionEventRecordFilename("provider-a", "newest")));
  assert.ok(files.includes(repositorySnapshotFilename("provider-a", "oldest")), "the repository sidecars keep their own count");
});

test("the recorder loads only checkpointed sidecars at startup and reads any other on demand, once", async (t) => {
  const { createRepositorySnapshotRecorder } = await import("../../../../server/repository/repository-snapshot.mjs");
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory });
  await checkpoints.write(snapshot("provider-a", "checkpointed", 1));
  await checkpoints.writeRepositorySnapshot("provider-a", "checkpointed", repositorySnapshot({ branch: "feat/checkpointed" }));
  await checkpoints.writeRepositorySnapshot("provider-a", "evicted", repositorySnapshot({ branch: "feat/evicted" }));
  let singleReads = 0;
  const readOne = checkpoints.loadRepositorySnapshot.bind(checkpoints);
  checkpoints.loadRepositorySnapshot = (...args) => { singleReads += 1; return readOne(...args); };

  const recorder = createRepositorySnapshotRecorder({ store: checkpoints });
  await recorder.load();
  assert.equal(recorder.recorded("provider-a:checkpointed").branch, "feat/checkpointed");
  assert.equal(recorder.has("provider-a:evicted"), false, "a sidecar without a checkpoint is not part of the startup load");
  assert.equal(recorder.recorded("provider-a:evicted"), null);

  assert.deepEqual(await Promise.all([recorder.ensure("provider-a:evicted"), recorder.ensure("provider-a:evicted")]), [true, true]);
  assert.equal(recorder.recorded("provider-a:evicted").branch, "feat/evicted");
  assert.equal(await recorder.ensure("provider-a:never-recorded"), false);
  assert.equal(recorder.has("provider-a:never-recorded"), true);
  assert.equal(await recorder.ensure("provider-a:never-recorded"), false);
  assert.equal(await recorder.ensure("provider-a:checkpointed"), true);
  assert.equal(singleReads, 2, "concurrent, repeated, known-absent and already-loaded requests do not reread");
});

test("maintenance bounds repository-snapshot sidecars on their own, oldest first", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory, maxRepositorySnapshots: 2 });
  for (const [index, id] of ["oldest", "middle", "newest"].entries()) {
    await checkpoints.writeRepositorySnapshot("provider-a", id, repositorySnapshot());
    const at = new Date(Date.now() - (3 - index) * 60_000);
    await utimes(path.join(directory, repositorySnapshotFilename("provider-a", id)), at, at);
  }
  // A checkpoint does not shield its sidecar from the sidecar bound, and does not go with it.
  await checkpoints.write(snapshot("provider-a", "oldest", 1));

  await settleCheckpointMaintenance(checkpoints);
  const records = await checkpoints.loadRepositorySnapshots();
  assert.deepEqual(records.map((record) => record.localSessionId).sort(), ["middle", "newest"]);
  assert.ok((await readdir(directory)).includes(checkpointFilename("provider-a", "oldest")));
  assert.throws(() => new SessionObservationCheckpointStore({ directory, maxRepositorySnapshots: 0 }), /repository snapshot limit/);
});

test("checkpoint writes do no cleanup scan and maintenance clears thousands of old owned temps in bounded batches", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory, tempGraceMs: 0 });
  const hash = "a".repeat(64);
  const old = new Date(Date.now() - 60_000);
  await Promise.all(Array.from({ length: 4_055 }, async (_, index) => {
    const filename = `.checkpoint-${hash}.json.${String(index).padStart(8, "0")}-0000-4000-8000-000000000000.tmp`;
    const target = path.join(directory, filename);
    await writeFile(target, "interrupted", "utf8");
    await utimes(target, old, old);
  }));
  await checkpoints.write(snapshot("provider-a", "good-after-temps", 1));
  assert.equal(checkpoints.stats().maintenanceEntries, 0, "write is independent from directory maintenance");
  const first = await checkpoints.maintenanceStep({ budget: 17 });
  assert.equal(first.processed, 17);
  assert.equal(first.deleted, 0);
  await settleCheckpointMaintenance(checkpoints);
  const restored = await checkpoints.load();
  assert.equal(restored.records.length, 1);
  assert.equal((await readdir(directory)).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("maintenance never unlinks a checkpoint rewritten after its eviction was planned", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory, maxEntries: 1 });
  await checkpoints.write(snapshot("provider-a", "old", 1));
  await checkpoints.write(snapshot("provider-a", "new", 1));
  await checkpoints.maintenanceStep({ budget: 16 }); // scan and plan, no delete until a later step
  await checkpoints.write(snapshot("provider-a", "old", 2));
  const oldFile = path.join(directory, checkpointFilename("provider-a", "old"));
  const future = new Date(Date.now() + 2_000);
  await utimes(oldFile, future, future);
  await checkpoints.maintenanceStep({ budget: 1 });
  assert.ok((await readdir(directory)).includes(checkpointFilename("provider-a", "old")));
});

test("a skipped checkpoint eviction preserves its recorded repository sidecar", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory, maxEntries: 1 });
  await checkpoints.write(snapshot("provider-a", "old", 1));
  await checkpoints.writeRepositorySnapshot("provider-a", "old", repositorySnapshot());
  const oldPath = path.join(directory, checkpointFilename("provider-a", "old"));
  const oldDate = new Date(Date.now() - 60_000);
  await utimes(oldPath, oldDate, oldDate);
  await checkpoints.write(snapshot("provider-a", "new", 1));
  await checkpoints.maintenanceStep({ budget: 16 });
  await checkpoints.write(snapshot("provider-a", "old", 2));
  await checkpoints.maintenanceStep({ budget: 1 });
  await checkpoints.maintenanceStep({ budget: 1 });
  assert.equal(JSON.parse(await readFile(oldPath, "utf8")).revision, 2);
  assert.ok((await readdir(directory)).includes(repositorySnapshotFilename("provider-a", "old")));
});

test("failed atomic replacement retains prior revision and cleans only its partial temp", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory });
  await checkpoints.write(snapshot("provider-a", "failure", 1));
  const fsPromises = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fsPromises.rename;
  const target = path.join(directory, checkpointFilename("provider-a", "failure"));
  fsPromises.rename = async (from, to) => {
    if (to === target) throw new Error("synthetic rename interruption");
    return original(from, to);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(checkpoints.write(snapshot("provider-a", "failure", 2)), /synthetic/); }
  finally { fsPromises.rename = original; syncBuiltinESMExports(); }
  assert.equal(JSON.parse(await readFile(target, "utf8")).revision, 1);
  assert.equal((await readdir(directory)).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("publication prepared during an eviction stat keeps its newly committed revision", async (t) => {
  const directory = await temporaryCheckpointDirectory(t);
  const checkpoints = new SessionObservationCheckpointStore({ directory, maxEntries: 1 });
  await checkpoints.write(snapshot("provider-a", "old", 1));
  const target = path.join(directory, checkpointFilename("provider-a", "old"));
  const older = new Date(Date.now() - 60_000);
  await utimes(target, older, older);
  await checkpoints.write(snapshot("provider-a", "new", 1));
  await checkpoints.maintenanceStep({ budget: 16 });
  const fsPromises = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const originalStat = fsPromises.stat; const originalWrite = fsPromises.writeFile;
  let writing; let overlap = false; let markPrepared;
  const prepared = new Promise((resolve) => { markPrepared = resolve; });
  fsPromises.writeFile = async (...args) => {
    const result = await originalWrite(...args);
    if (overlap) markPrepared();
    return result;
  };
  fsPromises.stat = async (location, ...args) => {
    const result = await originalStat(location, ...args);
    if (location === target && !overlap) {
      overlap = true;
      writing = checkpoints.write(snapshot("provider-a", "old", 2));
      // Wait for temporary data, not rename: publication waits for eviction.
      await prepared;
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    await checkpoints.maintenanceStep({ budget: 1 }); await writing;
    assert.equal(overlap, true);
    assert.equal(JSON.parse(await readFile(target, "utf8")).revision, 2);
  } finally {
    fsPromises.stat = originalStat; fsPromises.writeFile = originalWrite; syncBuiltinESMExports();
  }
});

test("restore upgrades only legacy evidence of a provider that declares launch-bound legacy attribution", async (t) => {
  const { withLegacyRepositoryAttribution } = await import("../../../../server/repository/repository-snapshot.mjs");
  const declared = new Map([["claude", "launch"]]);
  const checkpoints = new SessionObservationCheckpointStore({
    directory: await temporaryCheckpointDirectory(t),
    upgradeEvidence: (providerId, evidence) => withLegacyRepositoryAttribution(evidence, declared.get(providerId) ?? null),
  });
  const evidence = parseProviderSessionEvidence(JSON.parse(await readFile(
    new URL("../../../fixtures/providers/claude/expected-session-evidence.json", import.meta.url), "utf8",
  )));
  delete evidence.session.repositoryAttribution;
  await checkpoints.write({ ...snapshot("claude", "legacy-claude", 3), evidence: { ...evidence, localId: "legacy-claude" } });
  await checkpoints.write({ ...snapshot("codex", "legacy-codex", 3), evidence: { ...evidence, localId: "legacy-codex" } });
  const proven = { ...evidence, localId: "proven-claude", session: { ...evidence.session, repositoryAttribution: "single", repositoryId: "repo-0123456789abcdef01234567" } };
  await checkpoints.write({ ...snapshot("claude", "proven-claude", 3), evidence: proven });

  const loaded = await checkpoints.load({ projectState: ({ evidence: restored }) => restored.session.repositoryAttribution ?? null });
  const byId = new Map(loaded.records.map((record) => [record.localSessionId, record]));
  assert.equal(loaded.ignored, 0);
  assert.equal(byId.get("legacy-claude").evidence.session.repositoryAttribution, "launch");
  assert.equal(byId.get("legacy-claude").publicState, "launch", "projection sees the upgraded evidence");
  assert.equal(Object.hasOwn(byId.get("legacy-codex").evidence.session, "repositoryAttribution"), false);
  assert.equal(byId.get("proven-claude").evidence.session.repositoryAttribution, "single");
  parseProviderSessionEvidence(byId.get("legacy-claude").evidence, "legacy-claude");
  const onDisk = JSON.parse(await readFile(path.join(checkpoints.directory, checkpointFilename("claude", "legacy-claude")), "utf8"));
  assert.equal(Object.hasOwn(onDisk.evidence.session, "repositoryAttribution"), false, "restore never rewrites the checkpoint file");
});

// A version-4 sidecar, as an older build wrote it: it still loads, as the current version.
const LEGACY_SIDECAR = {
  version: 4, branch: "feat/example", isMain: false, files: [], comparison: null, comparisonCheckedAt: null,
  pullRequests: { checkedAt: "2026-09-20T12:00:00.000Z", items: [] }, commitsInSession: 1, checkedAt: "2026-09-20T12:00:05.000Z",
  dirtyAtFirstCheck: [], becameDirty: [], committedInWindow: null, committedChanges: null, gitObservedTruncated: false,
  repositoryId: "repo-0123456789abcdef01234567",
};

test("legacy launch-bound evidence keeps its pre-rule sidecar trust and recorded branch; other legacy evidence stays unbound", async () => {
  const { normalizeRepositorySnapshot, resolveCheckpointRepository, sessionRepositorySnapshot, withLegacyRepositoryAttribution } = await import("../../../../server/repository/repository-snapshot.mjs");
  const legacy = { session: { project: "Clapline", recordedGitBranch: "feat/clapline", updatedAt: "2026-09-20T12:00:00.000Z" } };
  assert.equal(withLegacyRepositoryAttribution(legacy, null), legacy, "an undeclared provider's legacy evidence is untouched");
  const proven = { session: { ...legacy.session, repositoryAttribution: "unknown" } };
  assert.equal(withLegacyRepositoryAttribution(proven, "launch"), proven, "a recorded attribution is never overridden");
  const upgraded = withLegacyRepositoryAttribution(legacy, "launch");
  assert.equal(upgraded.session.repositoryAttribution, "launch");
  assert.equal(Object.hasOwn(legacy.session, "repositoryAttribution"), false, "the upgrade does not mutate its input");

  const sidecar = normalizeRepositorySnapshot(LEGACY_SIDECAR);
  assert.ok(sidecar, "fixture sidecar is valid");
  assert.equal(sessionRepositorySnapshot(upgraded, sidecar), sidecar);
  assert.equal(sessionRepositorySnapshot(legacy, sidecar), null);
  const options = (evidence) => ({ historical: true, evidence, snapshot: null,
    recordedGitState: (branch) => ({ available: Boolean(branch), branch }), unavailablePullRequests: () => ({ items: [] }) });
  assert.equal(resolveCheckpointRepository(options(upgraded)).repository.branch, "feat/clapline");
  assert.equal(resolveCheckpointRepository(options(legacy)).repository.available, false);
});

test("a launch-declaring provider's proven session adopts its unbound pre-rule sidecar; no other provider does", async () => {
  const { normalizeRepositorySnapshot, resolveCheckpointRepository, sessionRepositorySnapshot, snapshotFromLiveCheck } = await import("../../../../server/repository/repository-snapshot.mjs");
  const unbound = normalizeRepositorySnapshot({ ...LEGACY_SIDECAR, repositoryId: null, commitsInSession: 7 });
  assert.ok(unbound, "fixture sidecar is valid");
  const proven = { session: { repositoryAttribution: "single", repositoryId: "repo-0123456789abcdef01234567", recordedGitBranch: "feat/example", updatedAt: "2026-09-20T12:00:00.000Z" } };
  assert.equal(sessionRepositorySnapshot(proven, unbound, { adoptsUnboundSidecar: true }), unbound);
  assert.equal(sessionRepositorySnapshot(proven, unbound), null);
  const options = { historical: true, evidence: proven, snapshot: unbound, recordedGitState: (branch) => ({ available: Boolean(branch), branch, fallback: true }), unavailablePullRequests: () => ({ items: [] }) };
  assert.equal(resolveCheckpointRepository({ ...options, adoptsUnboundSidecar: true }).repository.fallback, undefined, "the recorded sidecar wins over the branch fallback");
  const live = { repository: { available: true, historical: false, branch: "feat/example", files: [], remote: { status: "unavailable" } }, checkedAt: "2026-09-28T12:00:00.000Z", repositoryId: proven.session.repositoryId };
  assert.equal(snapshotFromLiveCheck({ ...live, previous: unbound, adoptsUnboundSidecar: true }).commitsInSession, 7, "the live timeline continues");
  assert.equal(snapshotFromLiveCheck({ ...live, previous: unbound }).commitsInSession, null, "without adoption a new identity starts a new timeline");
});
