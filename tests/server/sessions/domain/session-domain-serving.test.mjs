import assert from "node:assert/strict";
import test from "node:test";
import { createSessionDomainServing } from "../../../../server/sessions/domain/session-domain-serving.mjs";

// Which catalog row a session-domain commit hands to the domain store.
function harness({ rows = [], identity = null, rowWithCommittedEvidence, committed = null } = {}) {
  const commits = [];
  const asked = [];
  const catalog = { snapshot: { value: { sessions: rows } } };
  const serving = createSessionDomainServing({
    registry: { providers: [{ id: "codex" }], providerForSessionId: () => ({ source: "Codex", capabilities: {} }) },
    sessionDomains: {
      commit(sessionId, snapshot, catalogEntry) { commits.push({ sessionId, snapshot, catalogEntry }); return []; },
      commitUnavailable() { throw new Error("no placeholder is committed for a session with evidence"); },
    },
    observationStore: { getByQualifiedId: () => committed },
    coordinator: {
      catalog: () => catalog,
      catalogIdentity: () => identity,
      ...(rowWithCommittedEvidence ? { rowWithCommittedEvidence(row) { asked.push(row); return rowWithCommittedEvidence(row); } } : {}),
    },
    scheduleObservation() {},
    isServingActive: () => true,
  });
  return { serving, commits, asked };
}

const snapshot = Object.freeze({ revision: 2 });
const row = Object.freeze({ id: "codex:one", isLive: true, activityStatus: "working", currentActivity: null, activityFallback: null });

test("every commit of a session reads the row through the coordinator's evidence view", () => {
  const ahead = { ...row, currentActivity: { label: "Step 2" } };
  const { serving, commits, asked } = harness({ rows: [row], rowWithCommittedEvidence: () => ahead });
  // The session event's commit, then one from another source before the catalog commit.
  serving.commit("codex:one", snapshot);
  serving.commit("codex:one", snapshot);
  assert.deepEqual(asked, [row, row]);
  assert.deepEqual(commits.map((commit) => commit.catalogEntry), [ahead, ahead], "a later commit cannot bring the previous activity back");
});

test("a commit that names no snapshot reads the same view for the committed one", () => {
  // Commits from other sources (a recorded repository snapshot, retained resources, file
  // history, the catalog event) pass only the session ID.
  const ahead = { ...row, currentActivity: { label: "Step 2" } };
  const { serving, commits, asked } = harness({ rows: [row], committed: snapshot, rowWithCommittedEvidence: () => ahead });
  serving.commit("codex:one");
  assert.deepEqual(asked, [row]);
  assert.deepEqual(commits, [{ sessionId: "codex:one", snapshot, catalogEntry: ahead }]);
});

test("a row the catalog already built is passed on unchanged", () => {
  const { serving, commits } = harness({ rows: [row], rowWithCommittedEvidence: (value) => value });
  serving.commit("codex:one", snapshot);
  assert.equal(commits[0].catalogEntry, row);
});

test("a session without a committed row keeps its inventory identity and is not asked about", () => {
  const identity = { id: "codex:outside", title: "Outside" };
  const { serving, commits, asked } = harness({ rows: [row], identity, rowWithCommittedEvidence: () => { throw new Error("only committed rows are asked about"); } });
  serving.commit("codex:outside", snapshot);
  assert.deepEqual(asked, []);
  assert.deepEqual(commits[0].catalogEntry, { ...identity, summaryReadiness: "loading" });
});

test("a coordinator without the evidence view serves the committed row", () => {
  const { serving, commits } = harness({ rows: [row] });
  serving.commit("codex:one", snapshot);
  assert.equal(commits[0].catalogEntry, row);
});
