import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openMonitorStore } from "../../../server/persistence/monitor-store.mjs";
import { fileChangeAgentIdentity, readFileChangeAgents } from "../../../server/repository/file-change-agents.mjs";
import { createFileChangeIndexContributor } from "../../../server/repository/file-change-index.mjs";
import { projectSessionDomains } from "../../../server/sessions/domain/session-domain-projection.mjs";
import { createEmptyMonitorState } from "../../../shared/monitor-state.mjs";

const REPOSITORY_ID = `repo-${"a".repeat(24)}`;

async function openStore(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-file-change-agents-"));
  const store = await openMonitorStore({ directory });
  t.after(async () => {
    try { store.close(); } catch { /* already closed */ }
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

function snapshot({ localSessionId = "s1", toolCalls, agents }) {
  return {
    providerId: "claude",
    localSessionId,
    evidence: { session: { cwd: "C:/repo", repositoryAttribution: "single", repositoryId: REPOSITORY_ID }, toolCalls },
    publicState: { agents },
  };
}

function change(actorId, timestamp, filePath = "docs/METRICS.md") {
  return { timestamp, actor: { id: actorId }, fileChanges: [{ path: filePath, kind: "edited", repositoryId: REPOSITORY_ID }] };
}

function contributor(checkpointStore = null) {
  return createFileChangeIndexContributor({ resolveRepository: async () => ({ repositoryId: REPOSITORY_ID, root: "C:/repo" }), checkpointStore });
}

test("fileChangeAgentIdentity keeps only bounded one-line label, assignment, and a safe model", () => {
  assert.deepEqual(fileChangeAgentIdentity({ label: " Explore ", assignment: "Map the docs", model: "claude-sonnet-5-5", prompt: "secret" }),
    { label: "Explore", assignment: "Map the docs", model: "claude-sonnet-5-5" });
  assert.deepEqual(fileChangeAgentIdentity({ label: "two\nlines", assignment: "x".repeat(513), model: "C:\\models\\x" }),
    { label: null, assignment: null, model: null });
  assert.deepEqual(fileChangeAgentIdentity({ label: "Main", model: "unknown" }), { label: "Main", assignment: null, model: null });
  assert.deepEqual(fileChangeAgentIdentity(undefined), { label: null, assignment: null, model: null });
});

test("the index records the identity of agents that changed files, and keeps the last known values", async (t) => {
  const store = await openStore(t);
  const index = contributor();
  await index.onCheckpoint(store, { now: 1, snapshots: [snapshot({
    toolCalls: [change("primary", "2026-09-30T10:00:00.000Z"), change("agent-2", "2026-09-30T10:01:00.000Z")],
    agents: [
      { id: "primary", label: "Main", assignment: null, model: "claude-opus-5-5" },
      { id: "agent-2", label: "Explore", assignment: "Map the metrics docs", model: "claude-sonnet-5-5" },
      { id: "agent-3", label: "Idle reader", assignment: "Never wrote", model: "claude-haiku-4-5" },
    ],
  })] });

  const recorded = readFileChangeAgents(store, "claude:s1", new Set(["primary", "agent-2", "agent-3"]));
  assert.deepEqual(Object.fromEntries(recorded), {
    primary: { label: "Main", assignment: null, model: "claude-opus-5-5" },
    "agent-2": { label: "Explore", assignment: "Map the metrics docs", model: "claude-sonnet-5-5" },
  }, "an agent without a recorded file change is never stored");

  // A later snapshot drops agent-2 from its list and reports no model for the primary agent.
  await index.onCheckpoint(store, { now: 2, snapshots: [snapshot({
    toolCalls: [change("primary", "2026-09-30T10:02:00.000Z"), change("agent-2", "2026-09-30T10:01:00.000Z")],
    agents: [{ id: "primary", label: "Main", assignment: "Ship the fix", model: null }],
  })] });
  const updated = readFileChangeAgents(store, "claude:s1", new Set(["primary", "agent-2"]));
  assert.deepEqual(updated.get("primary"), { label: "Main", assignment: "Ship the fix", model: "claude-opus-5-5" });
  assert.deepEqual(updated.get("agent-2"), { label: "Explore", assignment: "Map the metrics docs", model: "claude-sonnet-5-5" });
});

test("an index without agent identities backfills them once from retained checkpoints", async (t) => {
  const store = await openStore(t);
  const retained = snapshot({
    toolCalls: [change("agent-2", "2026-09-30T09:00:00.000Z")],
    agents: [{ id: "agent-2", label: "Explore", assignment: "Map the metrics docs", model: "claude-sonnet-5-5" }],
  });
  // An index at the current file-index version whose agent identities were never recorded.
  await contributor().onCheckpoint(store, { now: 1, snapshots: [{ ...retained, publicState: { agents: [] } }] });
  store.transaction(() => store.database.prepare("DELETE FROM meta WHERE key = 'file_agents_version'").run());
  assert.equal(readFileChangeAgents(store, "claude:s1", new Set(["agent-2"])).size, 0);

  let loads = 0;
  const index = contributor({ load: async () => { loads += 1; return { records: [retained] }; } });
  await index.onCheckpoint(store, { now: 2, snapshots: [] });
  await index.onCheckpoint(store, { now: 3, snapshots: [] });
  assert.equal(loads, 1);
  assert.deepEqual(readFileChangeAgents(store, "claude:s1", new Set(["agent-2"])).get("agent-2"),
    { label: "Explore", assignment: "Map the metrics docs", model: "claude-sonnet-5-5" });
  const changes = store.database.prepare("SELECT COUNT(*) AS count FROM file_changes").get().count;
  assert.equal(changes, 1, "the backfill replay never duplicates recorded changes");
});

test("the repository domain's touchedFiles prefers the visible agent's fields, falls back to the recorded identity, and drops invalid agents", () => {
  const base = createEmptyMonitorState({ connected: true, source: "Claude Code", view: "history" });
  const state = { ...base, session: { id: "claude:s1" }, agents: [{ id: "primary", label: "Main", model: "claude-opus-5-5" }] };
  const fileHistory = { readiness: "ready", truncated: false, files: [{
    fileId: "f1", path: "docs/METRICS.md", kind: "edited", changeCount: 5, lastObservedAt: "2026-09-30T12:00:00.000Z",
    agents: [
      { agentId: "primary", changeCount: 2, label: "Old main", assignment: "Ship the fix", model: "claude-sonnet-5-5" },
      { agentId: "agent-gone", changeCount: 1, label: "Explore", assignment: "Map the docs", model: "claude-haiku-4-5" },
      { agentId: "C:\\Users\\x", changeCount: 1, label: "Bad" },
      { agentId: "primary", changeCount: 9 },
      { agentId: "agent-zero", changeCount: 0 },
    ],
  }] };
  const project = (history) => projectSessionDomains("claude:s1", { publicState: state, readiness: {}, observedAt: null }, { fileHistory: history })
    .domains.get("repository").touchedFiles.files[0].agents;
  assert.deepEqual(project(fileHistory), [
    { id: "primary", label: "Main", assignment: "Ship the fix", model: "claude-opus-5-5", changeCount: 2 },
    { id: "agent-gone", label: "Explore", assignment: "Map the docs", model: "claude-haiku-4-5", changeCount: 1 },
  ]);
  assert.deepEqual(project({ ...fileHistory, files: [{ ...fileHistory.files[0], agents: undefined }] }), [], "a block without agents projects an empty list");
});
