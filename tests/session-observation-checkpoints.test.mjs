import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SessionObservationCheckpointStore,
  checkpointFilename,
} from "../monitor/session-observation-checkpoints.mjs";
import { SessionObservationStore } from "../monitor/session-observation-store.mjs";

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
