import assert from "node:assert/strict";
import test from "node:test";
import { createRowActivityMemo } from "../../../../server/sessions/catalog/session-catalog-row.mjs";
import { createRowEvidenceView } from "../../../../server/sessions/catalog/session-row-evidence.mjs";

// The view with the real activity memo: what it returns, and how many times a row's evidence is
// walked between a session commit and the catalog commit that follows it.
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const runningAgent = { id: "primary", status: "active", executionTasks: [
  { id: "task-1", kind: "shell", workKind: "test", status: "running", startedAt: "2026-08-30T12:00:00.000Z", finishedAt: null, exitCode: null },
] };
const snapshotOf = (revision) => deepFreeze({ revision, publicState: { agents: [runningAgent] }, evidence: { toolCalls: [] } });
const row = Object.freeze({ id: "codex:one", provider: "codex", isLive: true, needsInput: false, activityStatus: "working", currentActivity: null, activityFallback: null });

function harness({ pending = row, restored = false } = {}) {
  const memo = createRowActivityMemo();
  let snapshot = snapshotOf(1);
  let accepted = pending;
  const view = createRowEvidenceView({
    store: { getByQualifiedId: () => snapshot }, memo, pendingEntry: () => accepted, isRestored: () => restored,
  });
  return { memo, view, snapshot: () => snapshot, commit(revision) { snapshot = snapshotOf(revision); view.mark(row.id); }, accept(entry) { accepted = entry; } };
}

test("a marked session's row carries the activity of its committed evidence", () => {
  const { view, commit } = harness();
  assert.equal(view.row(row), row, "nothing committed since the last catalog commit");
  commit(2);
  const ahead = view.row(row);
  assert.deepEqual(ahead.activityFallback, { label: "Running tests", observedAt: "2026-08-30T12:00:00.000Z", state: "current", source: "execution_task", actor: "primary" });
  assert.deepEqual({ ...ahead, activityFallback: null }, row, "nothing else changes");
  view.clear();
  assert.equal(view.row(row), row);
});

test("the catalog commit reuses the walk the view made", () => {
  const { memo, view, snapshot, commit } = harness();
  commit(2);
  const ahead = view.row(row);
  view.row(row);
  assert.deepEqual(memo.stats(), { walks: 1, reuses: 1, rows: 1 });
  // The catalog commit asks the memo for the same row and snapshot, then ends its pass.
  const committed = memo.activity(row, snapshot(), false);
  memo.settle();
  assert.equal(committed.activityFallback, ahead.activityFallback);
  assert.deepEqual(memo.stats(), { walks: 1, reuses: 2, rows: 1 });
});

test("a restored session's running work stays last observed", () => {
  const { view, commit } = harness({ restored: true });
  commit(2);
  assert.deepEqual([view.row(row).activityFallback.state, view.row(row).activityFallback.label], ["last_observed", "test run"]);
});

for (const [change, pending] of [
  ["activityStatus", { ...row, activityStatus: "idle" }],
  ["isLive", { ...row, isLive: false }],
  ["needsInput", { ...row, needsInput: true }],
  ["the row leaving the catalog", null],
]) {
  test(`a pending change of ${change} returns the committed row unchanged and walks nothing`, () => {
    const { memo, view, commit, accept } = harness();
    commit(2);
    accept(pending);
    assert.equal(view.row(row), row);
    assert.equal(memo.stats().walks, 0);
  });
}

test("a session without a committed snapshot or without a mark is left alone", () => {
  const memo = createRowActivityMemo();
  const view = createRowEvidenceView({ store: { getByQualifiedId: () => null }, memo, pendingEntry: () => row, isRestored: () => false });
  view.mark(row.id);
  assert.equal(view.row(row), row);
  assert.equal(view.row(null), null);
  assert.equal(view.row({ ...row, id: "codex:other" }).id, "codex:other");
  assert.equal(memo.stats().walks, 0);
});
