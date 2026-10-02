import assert from "node:assert/strict";
import test from "node:test";

import { sessionTouchedFiles, touchedFileCount } from "../../../server/repository/session-touched-files.mjs";

const OBSERVED_AT = "2026-09-30T12:00:00.000Z";

function recorded(path, fileId, overrides = {}) {
  return { fileId, path, kind: "edited", changeCount: 1, lastObservedAt: OBSERVED_AT, agents: [], ...overrides };
}
function committed(path, change = null) {
  return { path, source: "committed", change };
}
function history(files, overrides = {}) {
  return { readiness: "ready", files, truncated: false, ...overrides };
}
function gitObserved(files, overrides = {}) {
  return { files, truncated: false, ...overrides };
}

test("recorded and committed inputs become one path-sorted list, and a path in both is one recorded entry", () => {
  const block = sessionTouchedFiles({
    fileHistory: history([recorded("app/b.ts", "f2"), recorded("app/a.ts", "f1", { kind: "created", changeCount: 3 })]),
    gitObserved: gitObserved([committed("app/c.ts", "added"), committed("app/b.ts", "modified"), committed("app/0.ts", null)]),
    agents: [],
  });
  assert.deepEqual(block, {
    readiness: "ready",
    files: [
      { path: "app/0.ts", source: "committed", change: null },
      { path: "app/a.ts", source: "recorded", fileId: "f1", kind: "created", changeCount: 3, lastObservedAt: OBSERVED_AT, agents: [] },
      { path: "app/b.ts", source: "recorded", fileId: "f2", kind: "edited", changeCount: 1, lastObservedAt: OBSERVED_AT, agents: [] },
      { path: "app/c.ts", source: "committed", change: "added" },
    ],
    truncated: false,
  });
  const twice = sessionTouchedFiles({ fileHistory: history([recorded("app/a.ts", "f1"), recorded("app/a.ts", "f2")]), gitObserved: null });
  assert.deepEqual(twice.files.map((file) => file.fileId), ["f1"], "a path recorded under two file IDs is listed once, first entry winning");
});

test("the count equals the list length when ready and is null for loading, unavailable, and rebuilding", () => {
  const inputs = { fileHistory: history([recorded("app/a.ts", "f1"), recorded("app/b.ts", "f2")]), gitObserved: gitObserved([committed("app/b.ts"), committed("app/c.ts")]) };
  const ready = sessionTouchedFiles(inputs);
  assert.equal(ready.files.length, 3);
  assert.equal(touchedFileCount(ready), 3);
  for (const readiness of ["loading", "unavailable", "rebuilding"]) {
    const block = sessionTouchedFiles({ ...inputs, fileHistory: { ...inputs.fileHistory, readiness } });
    assert.equal(block.readiness, readiness);
    assert.equal(touchedFileCount(block), null, readiness);
  }
  assert.equal(touchedFileCount(sessionTouchedFiles({})), null, "no recorded history at all is unavailable, never a zero");
  assert.equal(touchedFileCount(sessionTouchedFiles({ fileHistory: history([]), gitObserved: null })), 0, "a ready history with no files counts zero");
  assert.equal(touchedFileCount(null), null);
});

test("committed entries are listed while the recorded history is not ready", () => {
  const files = [committed("app/new.ts", "added"), committed("app/old.ts", "deleted")];
  for (const readiness of ["loading", "unavailable", "rebuilding"]) {
    const block = sessionTouchedFiles({ fileHistory: history([recorded("app/a.ts", "f1")], { readiness }), gitObserved: gitObserved(files) });
    assert.equal(block.readiness, readiness);
    assert.deepEqual(block.files.map((file) => [file.path, file.source]), [["app/a.ts", "recorded"], ["app/new.ts", "committed"], ["app/old.ts", "committed"]], readiness);
  }
  const missing = sessionTouchedFiles({ fileHistory: null, gitObserved: gitObserved(files) });
  assert.equal(missing.readiness, "unavailable");
  assert.deepEqual(missing.files, [{ path: "app/new.ts", source: "committed", change: "added" }, { path: "app/old.ts", source: "committed", change: "deleted" }]);
  assert.equal(sessionTouchedFiles({ fileHistory: history([], { readiness: "bogus" }) }).readiness, "unavailable", "an unknown readiness degrades to unavailable");
});

test("a malformed Git-observed block contributes no committed entry, and an unknown change becomes null", () => {
  const fileHistory = history([recorded("app/a.ts", "f1")]);
  const none = (block) => sessionTouchedFiles({ fileHistory, gitObserved: block }).files;
  const onlyRecorded = [sessionTouchedFiles({ fileHistory }).files[0]];
  assert.deepEqual(none(gitObserved([committed("app/ok.ts", "added"), committed("../../../escape.ts")])), onlyRecorded, "an unsafe path rejects the whole block");
  assert.deepEqual(none(gitObserved([committed("app/ok.ts", "added"), committed("C:/Users/x/secret.ts")])), onlyRecorded, "a drive path rejects the whole block");
  assert.deepEqual(none(gitObserved([committed("app/ok.ts", "added"), committed(".claude/settings.json")])), onlyRecorded, "a provider configuration path rejects the whole block");
  assert.deepEqual(none(gitObserved([committed("app/ok.ts", "added"), { path: "app/dirty.ts", source: "uncommitted", change: null }])), onlyRecorded, "the retired uncommitted source rejects the whole block");
  assert.deepEqual(none(gitObserved([committed("app/ok.ts", "added"), { path: "app/other.ts", change: "added" }])), onlyRecorded, "a missing source rejects the whole block");
  assert.deepEqual(none(gitObserved(Array.from({ length: 201 }, (_, index) => committed(`app/file-${index}.ts`)))), onlyRecorded, "more than 200 files rejects the whole block");
  assert.deepEqual(none({ files: [committed("app/ok.ts", "added")], truncated: "yes" }), onlyRecorded, "a non-boolean truncated rejects the whole block");
  assert.deepEqual(none({ files: [committed("app/ok.ts", "added")] }), onlyRecorded, "a missing truncated rejects the whole block");
  assert.deepEqual(none({ files: "app/ok.ts", truncated: false }), onlyRecorded, "a non-list rejects the whole block");
  assert.deepEqual(none(null), onlyRecorded);
  assert.equal(sessionTouchedFiles({ fileHistory, gitObserved: gitObserved([committed("app/ok.ts", "added")], { truncated: "yes" }) }).truncated, false, "a rejected block carries no truncation");

  const capped = none(gitObserved(Array.from({ length: 200 }, (_, index) => committed(`app/file-${String(index).padStart(3, "0")}.ts`))));
  assert.equal(capped.length, 201, "exactly 200 committed entries are accepted");

  const odd = sessionTouchedFiles({ gitObserved: gitObserved([committed("app/new.ts", "renamed"), committed("app/other.ts", "added"), committed("app/kept.ts", "deleted")]) });
  assert.deepEqual(odd.files.map((file) => [file.path, file.change]), [["app/kept.ts", "deleted"], ["app/new.ts", null], ["app/other.ts", "added"]], "an unknown change degrades to null rather than leaking");
});

test("a recorded entry with a bad file ID, unsafe path, unknown kind, or bad count or time is dropped", () => {
  const block = sessionTouchedFiles({
    fileHistory: history([
      recorded("app/ok.ts", "f1"),
      recorded("app/zero.ts", "f2", { changeCount: 0 }),
      recorded("app/bad-id-0.ts", "f0"),
      recorded("app/bad-id-letter.ts", "g7"),
      recorded("app/bad-id-long.ts", `f${"1".repeat(17)}`),
      recorded("app/bad-id-number.ts", 7),
      recorded("../escape.ts", "f3"),
      recorded("C:\\Users\\x\\secret.ts", "f4"),
      recorded("app\\win.ts", "f5"),
      recorded(".codex/config.toml", "f6"),
      recorded("app/bad-kind.ts", "f7", { kind: "renamed" }),
      recorded("app/bad-count.ts", "f8", { changeCount: -1 }),
      recorded("app/float-count.ts", "f9", { changeCount: 1.5 }),
      recorded("app/string-count.ts", "f10", { changeCount: "2" }),
      recorded("app/bad-time.ts", "f11", { lastObservedAt: "not a time" }),
      recorded("app/no-time.ts", "f12", { lastObservedAt: undefined }),
      null,
      "app/string.ts",
    ]),
  });
  assert.deepEqual(block.files.map((file) => file.path), ["app/ok.ts", "app/zero.ts"]);

  const over = sessionTouchedFiles({ fileHistory: history(Array.from({ length: 205 }, (_, index) => recorded(`app/file-${String(index).padStart(3, "0")}.ts`, `f${index + 1}`))) });
  assert.equal(over.files.length, 200, "the recorded list is cut at 200 entries");
  assert.equal(sessionTouchedFiles({ fileHistory: { readiness: "ready", files: "app/a.ts", truncated: false } }).files.length, 0, "a non-list degrades to no entries");
});

test("agent identity prefers the visible agent, falls back to the recorded one, drops invalid agents, and caps at 12", () => {
  const entry = recorded("docs/METRICS.md", "f1", { changeCount: 5, agents: [
    { agentId: "primary", changeCount: 2, label: "Old main", assignment: "Ship the fix", model: "claude-sonnet-5-5" },
    { agentId: "agent-gone", changeCount: 1, label: "Explore", assignment: "Map the docs", model: "claude-haiku-4-5" },
    { agentId: "C:\\Users\\x", changeCount: 1, label: "Bad" },
    { agentId: "primary", changeCount: 9 },
    { agentId: "agent-zero", changeCount: 0 },
    { agentId: "agent-float", changeCount: 1.5 },
    { agentId: 7, changeCount: 1 },
    null,
  ] });
  const agents = [{ id: "primary", label: "Main", model: "claude-opus-5-5" }];
  const project = (value, visible = agents) => sessionTouchedFiles({ fileHistory: history([value]), agents: visible }).files[0].agents;
  assert.deepEqual(project(entry), [
    { id: "primary", label: "Main", assignment: "Ship the fix", model: "claude-opus-5-5", changeCount: 2 },
    { id: "agent-gone", label: "Explore", assignment: "Map the docs", model: "claude-haiku-4-5", changeCount: 1 },
  ]);
  assert.deepEqual(project({ ...entry, agents: undefined }), [], "a block without agents projects an empty list");
  assert.deepEqual(project(entry, null).map((agent) => agent.label), ["Old main", "Explore"], "no visible agents falls back to the recorded identity");
  assert.deepEqual(project({ ...entry, agents: [{ agentId: "a", changeCount: 1, label: "two\nlines", model: "C:\\models\\x" }] }, []),
    [{ id: "a", label: null, assignment: null, model: null, changeCount: 1 }], "an unsafe recorded label or model is dropped");

  const many = Array.from({ length: 15 }, (_, index) => ({ agentId: `agent-${index}`, changeCount: 1, label: `Agent ${index}` }));
  assert.deepEqual(project({ ...entry, agents: many }).map((agent) => agent.id), many.slice(0, 12).map((agent) => agent.agentId));
});

test("truncated is true when either source is truncated", () => {
  const files = [committed("app/c.ts", "added")];
  const flags = (recordedTruncated, committedTruncated) => sessionTouchedFiles({
    fileHistory: history([recorded("app/a.ts", "f1")], { truncated: recordedTruncated }),
    gitObserved: gitObserved(files, { truncated: committedTruncated }),
  }).truncated;
  assert.equal(flags(false, false), false);
  assert.equal(flags(true, false), true);
  assert.equal(flags(false, true), true);
  assert.equal(flags(true, true), true);
  assert.equal(sessionTouchedFiles({ fileHistory: history([], { truncated: true }) }).truncated, true);
  assert.equal(sessionTouchedFiles({ gitObserved: gitObserved([], { truncated: true }) }).truncated, true);
});

test("the serialized block contains only the keys of its type", () => {
  const block = sessionTouchedFiles({
    fileHistory: { ...history([
      { ...recorded("app/a.ts", "f1", { agents: [{ agentId: "primary", changeCount: 1, label: "Main", prompt: "PRIVATE_AGENT", transcriptPath: "C:/PRIVATE/agent.jsonl" }] }),
        prompt: "PRIVATE_PROMPT", requestNumber: 9, repositoryId: "repo-private", sessionId: "claude:private", cwd: "C:/PRIVATE" },
    ]), commandOutput: "PRIVATE_OUTPUT" },
    gitObserved: { ...gitObserved([{ ...committed("app/b.ts", "added"), hash: "PRIVATE_HASH", subject: "PRIVATE_SUBJECT", agentId: "primary", changeCount: 4, requestNumber: 2 }]), hashes: ["PRIVATE_HASH"] },
    agents: [{ id: "primary", label: "Main", prompt: "PRIVATE_VISIBLE", transcriptPath: "C:/PRIVATE/visible.jsonl" }],
  });
  assert.deepEqual(Object.keys(block), ["readiness", "files", "truncated"]);
  const [recordedEntry, committedEntry] = block.files;
  assert.deepEqual(Object.keys(recordedEntry), ["path", "source", "fileId", "kind", "changeCount", "lastObservedAt", "agents"]);
  assert.deepEqual(Object.keys(recordedEntry.agents[0]), ["id", "label", "assignment", "model", "changeCount"]);
  assert.deepEqual(Object.keys(committedEntry), ["path", "source", "change"]);
  assert.doesNotMatch(JSON.stringify(block), /PRIVATE/u);
});
