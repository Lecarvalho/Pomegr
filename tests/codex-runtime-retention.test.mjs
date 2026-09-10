import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexIncrementalObserver } from "../monitor/providers/codex-observation.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { assertNoPrivateFixtureSentinels } from "./helpers/provider-fixtures.mjs";

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for observer state");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("Codex runtime evidence survives continuous deltas and resets only on recorded changes or complete replacement", async (context) => {
  // Windows runners can expose TEMP through an 8.3 alias while realpath-based
  // rollout discovery returns the expanded path. Keep observer fixture keys in
  // the same canonical form used by the provider.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pomegr-runtime-retention-")));
  const directory = path.join(root, "sessions");
  await mkdir(directory);
  const rootId = "runtime-retention-root";
  const childId = "runtime-retention-child";
  const rootFile = path.join(directory, "rollout-root.jsonl");
  const childFile = path.join(directory, "rollout-child.jsonl");
  const timestamp = "2026-09-02T12:00:00.000Z";
  const record = (type, payload) => JSON.stringify({ type, timestamp, payload }) + "\n";
  const rootHeader = record("session_meta", { id: rootId, cwd: root, source: "vscode" });
  const childHeader = record("session_meta", { id: childId, parent_thread_id: rootId, cwd: root, source: { subagent: { thread_spawn: { parent_thread_id: rootId } } } });
  const padding = record("event_msg", { type: "agent_message", message: "RESPONSE_MUST_NOT_LEAK" }).repeat(30);
  await writeFile(rootFile, rootHeader + record("turn_context", { model: "gpt-root", effort: "high" }) + padding);
  await writeFile(childFile, childHeader + record("turn_context", { model: "gpt-child", effort: "low" }) + padding);
  const provider = createCodexProvider({
    codexHome: root, cacheMs: 0, includeArchived: false,
    writerPresence: { async refresh() {}, current() { return null; }, close() {} },
  });
  let isLive = true;
  const published = [];
  const reads = [];
  const observer = createCodexIncrementalObserver({
    list: async () => [{ localId: rootId, isLive, activityStatus: isLive ? "working" : "idle" }],
    discoveredMetadata: async () => [
      { localId: rootId, sessionId: rootId, rolloutFile: rootFile },
      { localId: childId, parentThreadId: rootId, rolloutFile: childFile },
    ],
    readEvidence: async (id, options) => {
      reads.push(options);
      return provider.readSession(id, options);
    },
    transcriptPathsBySessionId: new Map(), intervalMs: 60_000,
    watchTargets: [directory], watchSource() { return { close() {} }; },
  });
  const controller = new AbortController();
  context.after(async () => { controller.abort(); await rm(root, { recursive: true, force: true }); });
  await observer.start({
    publishCatalog() {}, publishSession(_id, candidate) { published.push(candidate); }, invalidateSession() {},
  }, controller.signal);
  await waitFor(() => published.length > 0);
  const runtime = () => published.at(-1).agents.map(({ id, model, effort }) => ({ id, model, effort }));
  const initial = [
    { id: "primary", model: "gpt-root", effort: "high" },
    { id: "agent-" + childId, model: "gpt-child", effort: "low" },
  ];
  assert.deepEqual(runtime(), initial);
  const firstRevision = structuredClone(published[0]);
  provider.qaStats(true);

  await appendFile(rootFile, padding);
  await observer.hydrate(rootId);
  assert.deepEqual(runtime(), initial, "a live append beyond runtime lookbehind retains both agents");
  isLive = false;
  await observer.refresh({ sessionIds: [rootId] });
  await observer.hydrate(rootId);
  assert.equal(reads.at(-1).historical, true);
  assert.equal(reads.at(-1).incrementalRecordsByFile.size, 0);
  assert.deepEqual(runtime(), initial, "an empty live-to-history delta retains runtime evidence");
  assert.equal(provider.qaStats().reads, 0, "continuous runtime normalization must not rescan rollouts");
  const revisionCount = published.length;
  await observer.hydrate(rootId);
  assert.equal(published.length, revisionCount, "unchanged evidence does not publish another revision");

  await appendFile(childFile, record("thread_settings_updated", { settings: { model: "gpt-child-new" } }));
  await observer.hydrate(rootId);
  assert.deepEqual(runtime(), [initial[0], { ...initial[1], model: "gpt-child-new" }]);
  await appendFile(rootFile, record("thread_settings", { reasoning_effort: "low" }));
  await observer.hydrate(rootId);
  assert.deepEqual(runtime(), [{ ...initial[0], effort: "low" }, { ...initial[1], model: "gpt-child-new" }]);

  isLive = true;
  await observer.refresh({ sessionIds: [rootId] });
  await observer.hydrate(rootId);
  await appendFile(rootFile, record("turn_context", { model: null, effort: null }) + padding);
  await appendFile(childFile, record("turn_context", { model: null, effort: null }) + padding);
  await observer.hydrate(rootId);
  const unavailable = initial.map((agent) => ({ ...agent, model: "unknown", effort: "unspecified" }));
  assert.deepEqual(runtime(), unavailable, "explicit unavailability is not revived by the live cache");
  isLive = false;
  await observer.refresh({ sessionIds: [rootId] });
  await observer.hydrate(rootId);
  assert.deepEqual(runtime(), unavailable, "unavailability survives empty updates");

  await appendFile(childFile, record("turn_context", { model: "gpt-restored", effort: "medium" }) + padding);
  await observer.hydrate(rootId);
  const beforeReplacement = structuredClone(runtime());
  assert.equal(beforeReplacement[1].model, "gpt-restored");
  const beforeReplacementCount = published.length;
  await writeFile(childFile, childHeader + '{"type":"event_msg"');
  await observer.hydrate(rootId);
  assert.equal(published.length, beforeReplacementCount);
  assert.deepEqual(runtime(), beforeReplacement, "incomplete replacement keeps the committed evidence");
  await appendFile(childFile, ',"payload":{"type":"task_complete"}}\n');
  await observer.hydrate(rootId);
  assert.equal(reads.at(-1).completeStory, true);
  assert.equal(reads.at(-1).previousAgentRuntimeByThreadId, null);
  assert.deepEqual(runtime(), unavailable, "a complete replacement never inherits the prior source model");
  assert.deepEqual(published[0], firstRevision, "prior revisions remain immutable");
  assertNoPrivateFixtureSentinels(published.at(-1), "retained Codex runtime evidence");
});
