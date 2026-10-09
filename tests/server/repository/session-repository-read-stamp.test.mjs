import assert from "node:assert/strict";
import test from "node:test";
import { snapshotFromLiveCheck } from "../../../server/repository/repository-snapshot.mjs";
import { createSessionRepositoryEnrichment, servedSessionState, serializeServedSessionState } from "../../../server/repository/session-repository-enrichment.mjs";
import { SessionObservationStore } from "../../../server/sessions/checkpoints/session-observation-store.mjs";

const ROOT = "C:\\synthetic\\pomegr";
const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const iso = (milliseconds) => new Date(milliseconds).toISOString();
const withoutReadAt = (block) => Object.fromEntries(Object.entries(block).filter(([key]) => key !== "readAt"));
const binding = { state: "single", repositoryId: REPOSITORY_ID, root: ROOT, fingerprint: `bound:${ROOT}`, recordedBranch: "codex/live" };
const evidence = { session: { cwd: ROOT, recordedGitBranch: "codex/live", startedAt: iso(0) }, pullRequestCreations: [], executionTasks: [] };

function fixture({ startedAt, statusUnknown = false } = {}) {
  const jobs = [];
  const checks = [];
  const clock = { now: 5_000 };
  const enrichment = createSessionRepositoryEnrichment({
    gitReader: async (root) => {
      const acquired = { available: true, branch: "codex/live", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null }, _repositoryRoot: root,
        ...(startedAt === undefined ? {} : { _readStartedAt: startedAt }), ...(statusUnknown ? { _statusUnknown: true } : {}) };
      clock.now = 6_500;
      return acquired;
    },
    pullRequestReader: async () => ({ status: "ready", checkedAt: iso(5_900), readAt: iso(5_100), items: [] }),
    now: () => clock.now,
    cacheMs: 2_500,
    providerFolders: { folders: {} },
    unavailableGitState: () => ({ available: false, branch: "Not a Git repository", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
    unavailablePullRequests: () => ({ status: "unavailable", checkedAt: null, items: [] }),
  });
  enrichment.setOnRepositoryCheck((_sessionId, check) => checks.push(check));
  async function refresh(sessionId = "codex:stamped") {
    enrichment.liveEnrichment(sessionId, evidence, binding, (task) => jobs.push(task)).enqueue?.();
    while (jobs.length) await jobs.shift()();
    return enrichment.liveEnrichment(sessionId, evidence, binding, (task) => jobs.push(task)).value;
  }
  return { refresh, checks, clock };
}

test("a refresh dates its repository block by the start of its Git read, not the moment Git answered", async () => {
  const { refresh } = fixture();
  const value = await refresh();
  assert.equal(value.repository.readAt, iso(5_000), "the clock read 5000 when the call began and 6500 when it answered");
  assert.equal(value.pullRequests.readAt, iso(5_100), "the pull-request block keeps the reader's own oldest read");
  assert.equal(Object.hasOwn(value.repository, "_readStartedAt"), false);
});

test("a Git read that joined an inspection already under way is as old as that inspection, and never newer than its own call", async () => {
  const joined = fixture({ startedAt: 4_200 });
  assert.equal((await joined.refresh()).repository.readAt, iso(4_200));
  const impossible = fixture({ startedAt: 9_900 });
  assert.equal((await impossible.refresh()).repository.readAt, iso(5_000));
  const malformed = fixture({ startedAt: "yesterday" });
  assert.equal((await malformed.refresh()).repository.readAt, iso(5_000));
});

test("a read whose git status failed commits no stamp, so nothing is judged on its empty file list", async () => {
  const value = await fixture({ startedAt: 4_200, statusUnknown: true }).refresh();
  assert.equal(Object.hasOwn(value.repository, "readAt"), false);
  assert.equal(Object.hasOwn(value.repository, "_statusUnknown"), false);
  assert.deepEqual(value.repository.files, []);
});

test("the served form drops both private read times and changes nothing else", async () => {
  const { refresh } = fixture();
  const { repository, pullRequests } = await refresh();
  const state = { connected: true, session: { id: "codex:stamped", repository, pullRequests, title: "kept" } };
  const repositoryWithoutStamp = withoutReadAt(repository);
  const pullRequestsWithoutStamp = withoutReadAt(pullRequests);

  assert.deepEqual(JSON.parse(serializeServedSessionState(state)), { connected: true, session: { id: "codex:stamped", repository: repositoryWithoutStamp, pullRequests: pullRequestsWithoutStamp, title: "kept" } });
  assert.equal(typeof state.session.repository.readAt, "string", "serving leaves the committed state alone");
  assert.equal(typeof state.session.pullRequests.readAt, "string");
  // A state with no stamp, or no session, is served as it is.
  const plain = { session: { repository: repositoryWithoutStamp } };
  assert.equal(servedSessionState(plain), plain);
  for (const value of [{ session: null, other: 1 }, {}, null, undefined, { session: { repository: null, pullRequests: "x" } }]) {
    assert.equal(serializeServedSessionState(value), JSON.stringify(value));
  }
});

test("the default observation store serves the stripped state and keeps the stamped one for the done-when rule", async () => {
  const { refresh } = fixture();
  const { repository, pullRequests } = await refresh();
  const store = new SessionObservationStore();
  const publicState = { session: { id: "codex:stamped", repository, pullRequests } };
  assert.equal(store.publish({ providerId: "codex", localSessionId: "stamped", evidence: {}, readiness: {}, publicState }).accepted, true);

  assert.doesNotMatch(store.getSerialized("codex", "stamped"), /readAt/u);
  const committed = store.get("codex", "stamped").publicState.session;
  assert.equal(committed.repository.readAt, repository.readAt);
  assert.equal(committed.pullRequests.readAt, pullRequests.readAt);
});

test("the recorded repository sidecar is built from named fields and never carries a read time", async () => {
  const { refresh, checks } = fixture();
  await refresh();
  assert.equal(checks.length, 1);
  assert.equal(typeof checks[0].repository.readAt, "string", "the live check handed the stamped block to the recorder");
  assert.equal(typeof checks[0].pullRequests.readAt, "string");

  const snapshot = snapshotFromLiveCheck({ ...checks[0], repositoryId: REPOSITORY_ID });
  assert.ok(snapshot, "the live check records a sidecar");
  assert.doesNotMatch(JSON.stringify(snapshot), /readAt|_readStartedAt/u);
});
