import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexUserMessageTimes } from "../../../../server/providers/codex/user-message-times.mjs";
import { claudeUserMessageTimes } from "../../../../server/providers/claude/user-message-times.mjs";
import { createCodexProvider } from "../../../../server/providers/codex/index.mjs";
import { createCodexIncrementalObserver } from "../../../../server/providers/codex/observation.mjs";
import { parseProviderSessionEvidence } from "../../../../server/providers/provider-contract.mjs";
import { SessionObservationCheckpointStore } from "../../../../server/sessions/checkpoints/session-observation-checkpoints.mjs";
import { sessionEvents } from "../../../../server/sessions/domain/session-events.mjs";

const at = (second) => new Date(Date.UTC(2026, 9, 1, 12, 0, second)).toISOString();
const input = (second, extra = {}) => ({ type: "event_msg", timestamp: at(second), payload: { type: "user_message", message: "PRIVATE_PROMPT", ...extra } });
const jsonl = (...records) => records.map((record) => JSON.stringify(record) + "\n").join("");
const events = (userMessageTimes) => sessionEvents({ readiness: { core: "ready", agentEvidence: "ready", activityEvidence: "ready" }, userMessageTimes });

test("Claude and Codex feed the same timestamp-only interface and event projection", () => {
  const codex = codexUserMessageTimes([input(1), input(2), input(2, { message: "PRIVATE_OTHER" })]);
  const claude = claudeUserMessageTimes([1, 2, 2].map((second) => ({ type: "user", timestamp: at(second), message: { content: "PRIVATE_PROMPT" } })));
  assert.deepEqual(codex, claude);
  assert.deepEqual(events(codex), events(claude));
  assert.equal(events(codex).total, 3);
  assert.doesNotMatch(JSON.stringify(events(codex)), /PRIVATE|message.*content/u);
});

test("Codex times reuse delivery recognition, reject mirrors and synthetic records, and bound deduplication", () => {
  const delivery = { type: "event_msg", timestamp: at(2), payload: { type: "item_completed", item: { type: "UserMessage", id: "PRIVATE_ID", content: [{ type: "image", url: "PRIVATE_URL" }] } } };
  const records = [input(1), delivery, input(3, { synthetic: true }), input(4, { message: "" }),
    { ...input(5), timestamp: undefined }, { ...input(6), timestamp: "invalid" },
    { type: "response_item", timestamp: at(7), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "PRIVATE_CONTEXT" }] } }];
  assert.deepEqual(codexUserMessageTimes([...records, ...records]), [at(1), at(2)]);
  const many = Array.from({ length: 300 }, (_, index) => input(index));
  assert.deepEqual(codexUserMessageTimes([...many.reverse(), ...many]), Array.from({ length: 256 }, (_, index) => at(index + 44)));
});

test("Codex committed message times survive tails, deltas, checkpoints, restart and source replacement", async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-event-times-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions");
  await mkdir(directory);
  const id = "event-times-root", childId = "event-times-child";
  const file = path.join(directory, "rollout-root.jsonl"), childFile = path.join(directory, "rollout-child.jsonl");
  const header = { type: "session_meta", timestamp: at(0), payload: { id, cwd: root, source: "vscode" } };
  const padding = jsonl({ type: "response_item", timestamp: at(3), payload: { type: "function_call_output", output: "PRIVATE_OUTPUT".repeat(50_000) } });
  await writeFile(file, jsonl(header, input(1)) + padding);
  await writeFile(childFile, jsonl({ ...header, payload: { id: childId, cwd: root, source: { subagent: { thread_spawn: { parent_thread_id: id } } } } }, input(2)));
  const provider = createCodexProvider({ codexHome: root, cacheMs: 0, includeArchived: false,
    writerPresence: { async refresh() {}, current() { return null; }, close() {} } });
  let live = true;
  const published = [];
  async function start() {
    const observer = createCodexIncrementalObserver({
      list: async () => [{ localId: id, isLive: live, activityStatus: live ? "working" : "idle" }],
      discoveredMetadata: async () => [{ localId: id, rolloutFile: file }, { localId: childId, parentThreadId: id, rolloutFile: childFile }],
      readEvidence: (sessionId, options) => provider.readSession(sessionId, options),
      transcriptPathsBySessionId: new Map(), intervalMs: 60_000,
      watchTargets: [directory], watchSource() { return { close() {} }; },
    });
    const controller = new AbortController();
    context.after(() => controller.abort());
    await observer.start({ publishCatalog() {}, invalidateSession() {}, publishSession(_id, evidence) { published.push(evidence); } }, controller.signal);
    await observer.hydrate(id);
    return { observer, controller };
  }
  const first = await start();
  const times = () => published.at(-1).userMessageTimes;
  assert.deepEqual(times(), [at(1)], "initial input precedes the live tail; child inputs are excluded");
  const initial = structuredClone(published.at(-1));
  provider.qaStats(true);
  await appendFile(file, padding + jsonl(input(4)));
  await first.observer.hydrate(id);
  assert.deepEqual(times(), [at(1), at(4)]);
  await appendFile(childFile, jsonl(input(5)));
  await first.observer.hydrate(id);
  live = false;
  await first.observer.refresh({ sessionIds: [id] });
  await first.observer.hydrate(id);
  assert.deepEqual(times(), [at(1), at(4)], "child-only and lifecycle-only updates keep the primary facts");
  assert.equal(provider.qaStats().reads, 0, "steady observation does not add a full-source reread");
  assert.deepEqual(initial.userMessageTimes, [at(1)], "published revisions remain immutable");

  const partial = jsonl(input(6));
  await appendFile(file, partial.slice(0, -5));
  await first.observer.hydrate(id);
  assert.deepEqual(times(), [at(1), at(4)]);
  await appendFile(file, partial.slice(-5));
  await first.observer.hydrate(id);
  assert.deepEqual(times(), [at(1), at(4), at(6)]);

  const evidence = parseProviderSessionEvidence(published.at(-1), id);
  const storeOptions = { directory: path.join(root, "checkpoints"), validateCandidate: ({ localSessionId, evidence: value }) => { parseProviderSessionEvidence(value, localSessionId); return true; } };
  const store = new SessionObservationCheckpointStore(storeOptions);
  await store.write({ providerId: "codex", localSessionId: id, evidence,
    source: { fingerprint: "a".repeat(64), completeOffset: 10 }, readiness: { core: "ready" }, revision: 1, observedAt: at(7) });
  const loaded = await new SessionObservationCheckpointStore(storeOptions).load();
  assert.equal(loaded.ignored, 0);
  assert.deepEqual(events(loaded.records[0].evidence.userMessageTimes), events(times()));
  assert.doesNotMatch(JSON.stringify(evidence.userMessageTimes), /PRIVATE|path|id/u);
  assert.deepEqual((await provider.readSession(id, { completeStory: true })).userMessageTimes, times());
  first.controller.abort();
  const restarted = await start();
  assert.deepEqual(times(), [at(1), at(4), at(6)], "cold observation replays the same evidence");
  await writeFile(file, jsonl(header) + jsonl(input(9)).slice(0, -5));
  await restarted.observer.hydrate(id);
  assert.deepEqual(times(), [at(1), at(4), at(6)], "incomplete replacement retains the old committed revision");
  await appendFile(file, jsonl(input(9)).slice(-5));
  await restarted.observer.hydrate(id);
  assert.deepEqual(times(), [at(9)], "complete replacement swaps facts atomically");
  restarted.controller.abort();
});
