import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeProvider } from "../../../../server/providers/claude/index.mjs";
import { createClaudeSessionWorkStartReader } from "../../../../server/providers/claude/session-work-start.mjs";
import {
  CLAUDE_USER_MESSAGE_TIME_LIMIT,
  claudeUserMessageTimes,
  createClaudeUserMessageTimeState,
  reduceClaudeUserMessageTimes,
} from "../../../../server/providers/claude/user-message-times.mjs";
import { parseProviderSessionEvidence, providerSessionEvidenceSchema } from "../../../../server/providers/provider-contract.mjs";
import { SessionObservationCheckpointStore } from "../../../../server/sessions/checkpoints/session-observation-checkpoints.mjs";
import { projectSessionDomains } from "../../../../server/sessions/domain/session-domain-projection.mjs";
import { createEmptyMonitorState } from "../../../../shared/monitor-state.mjs";

function at(minute, second = 0) {
  return new Date(Date.UTC(2026, 8, 30, 10, minute, second)).toISOString();
}
const userText = (timestamp, content = "PRIVATE_USER_TEXT") => ({ type: "user", uuid: `PRIVATE_UUID_${timestamp}`, timestamp, message: { content } });
const toolUse = (timestamp, id, name = "Read") => ({ type: "assistant", timestamp, message: { model: "claude-test", content: [{ type: "tool_use", id, name, input: { file_path: "PRIVATE_PATH" } }] } });
const toolResult = (timestamp, id) => ({ type: "user", timestamp, message: { content: [{ type: "tool_result", tool_use_id: id, content: "PRIVATE_RESULT" }] } });

async function writeRecords(file, records) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}
async function temporaryRoot(context, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}
async function claudeFixtureEvidence() {
  return parseProviderSessionEvidence(JSON.parse(await readFile(
    new URL("../../../fixtures/providers/claude/expected-session-evidence.json", import.meta.url), "utf8",
  )));
}

test("the reduction keeps only the recorded time of each user-input record", () => {
  const times = claudeUserMessageTimes([
    userText(at(1)),
    toolUse(at(2), "tool-read"),
    toolResult(at(3), "tool-read"), // an ordinary tool result is not user input
    toolUse(at(4), "tool-ask", "AskUserQuestion"),
    toolResult(at(5), "tool-ask"), // the answer to a requested input is
    { ...userText(at(6)), isMeta: true },
    { ...userText(at(7)), isCompactSummary: true },
    { ...userText(at(8)), origin: { kind: "task-notification" }, promptSource: "system" },
    { type: "user", message: { timestamp: "2026-09-30T12:09:00+02:00", content: [{ type: "image", source: { media_type: "image/png" } }] } },
    userText(at(10), "   "),
    { type: "assistant", timestamp: at(11), message: { model: "claude-test", content: [{ type: "text", text: "PRIVATE_REPLY" }] } },
    null, "not a record",
  ]);
  assert.deepEqual(times, [at(1), at(5), at(9)], "canonical UTC, oldest to newest");
});

test("a user-input record without a recorded timestamp is excluded, never given a file time", () => {
  assert.deepEqual(claudeUserMessageTimes([
    { type: "user", message: { content: "PRIVATE_USER_TEXT" } },
    userText("not a time"),
    userText(null),
    userText(1_790_000_000_000),
    userText("+275760-09-13T00:00:00.000Z"),
    userText(at(2)),
  ]), [at(2)]);
});

test("the reduction keeps the newest 256 times in time order and retains no content or identifiers", () => {
  assert.equal(CLAUDE_USER_MESSAGE_TIME_LIMIT, 256);
  const state = createClaudeUserMessageTimeState();
  const stamps = Array.from({ length: 300 }, (_, index) => new Date(Date.UTC(2026, 8, 30, 10, 0, index)).toISOString());
  // Out-of-order arrival still yields the newest 256 by recorded time.
  for (const stamp of [...stamps.slice(150), ...stamps.slice(0, 150)]) reduceClaudeUserMessageTimes(state, userText(stamp));
  for (let index = 0; index < 400; index += 1) reduceClaudeUserMessageTimes(state, toolUse(at(30), `PRIVATE_ASK_${index}`, "AskUserQuestion"));
  assert.deepEqual(state.times.map((time) => new Date(time).toISOString()), stamps.slice(-256));
  assert.equal(state.requestedInputIds.size, 256, "pending input-request IDs are bounded too");
  assert.deepEqual(Object.keys(state).sort(), ["requestedInputIds", "times"]);
  assert.ok(state.times.every((time) => typeof time === "number"));
  assert.doesNotMatch(JSON.stringify(state.times), /PRIVATE/u);
});

test("slash-command echoes, local-command output, interruptions, and sidechain records are not user messages", () => {
  const excluded = {
    "a slash-command echo": userText(at(1), "<command-message>PRIVATE</command-message><command-name>/clear</command-name>"),
    "a slash-command echo in parts": { type: "user", timestamp: at(2), message: { content: "<command-name>/model</command-name><command-args>PRIVATE</command-args>" } },
    "local command stdout": userText(at(3), "<local-command-stdout>PRIVATE_OUTPUT</local-command-stdout>"),
    "local command stderr in a text part": { type: "user", timestamp: at(4), message: { content: [{ type: "text", text: "<local-command-stderr>PRIVATE</local-command-stderr>" }] } },
    "a local command caveat": userText(at(5), "<local-command-caveat>PRIVATE</local-command-caveat>"),
    "an interruption marker": { type: "user", timestamp: at(6), message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } },
    "a tool-use interruption marker": { type: "user", timestamp: at(7), message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } },
    "an interruption marker as a string": userText(at(8), "[Request interrupted by user]"),
    "a sidechain prompt": { ...userText(at(9)), isSidechain: true },
    "a meta turn companion": { ...userText(at(10)), isMeta: true, turnCompanion: true },
    "a compact summary": { ...userText(at(11)), isCompactSummary: true },
    "a system task notification": { ...userText(at(12)), origin: { kind: "task-notification" }, promptSource: "system" },
    "an ordinary tool result": toolResult(at(13), "tool-read"),
  };
  for (const [label, record] of Object.entries(excluded)) assert.deepEqual(claudeUserMessageTimes([toolUse(at(0), "tool-read"), record]), [], label);
  // A real turn that merely mentions an interruption, and an answer to a requested input, still count.
  assert.deepEqual(claudeUserMessageTimes([
    userText(at(20), "why did it say [Request interrupted by user]?"),
    { type: "assistant", isSidechain: true, timestamp: at(21), message: { content: [{ type: "tool_use", id: "side-ask", name: "AskUserQuestion", input: {} }] } },
    toolResult(at(22), "side-ask"), // a sidechain request is not a main-conversation input request
    toolUse(at(23), "main-ask", "AskUserQuestion"),
    toolResult(at(24), "main-ask"),
  ]), [at(20), at(24)]);
});

test("one whole-transcript pass yields the work start and the user-message times beyond the 2 MiB display tail", async (context) => {
  const root = await temporaryRoot(context, "pomegr-claude-user-times-");
  const file = path.join(root, "session.jsonl");
  const filler = (second) => ({ type: "system", subtype: "local_command", timestamp: at(20, second), content: "PRIVATE".repeat(60_000) });
  await writeRecords(file, [userText(at(1)), ...Array.from({ length: 8 }, (_, index) => filler(index)), userText(at(21))]);
  const reader = createClaudeSessionWorkStartReader({ yieldControl: async () => {} });
  assert.deepEqual(await reader.readSessionFacts(file), { startedAt: at(1), userMessageTimes: [at(1), at(21)] }, "the first message is 3 MiB behind the end of the file");
  await appendFile(file, `${JSON.stringify(userText(at(22)))}\n`);
  assert.deepEqual((await reader.readSessionFacts(file)).userMessageTimes, [at(1), at(21), at(22)]);
  // A partially written final record changes nothing, and never hides the complete ones.
  await appendFile(file, '{"type":"user","timestamp":"');
  assert.deepEqual((await reader.readSessionFacts(file)).userMessageTimes, [at(1), at(21), at(22)]);
  const cold = createClaudeSessionWorkStartReader({ yieldControl: async () => {} });
  assert.deepEqual((await cold.readSessionFacts(file)).userMessageTimes, [at(1), at(21), at(22)], "a cold read of a transcript ending mid-record still counts every complete record");
});

test("the transcript is read once for both facts, and a warm read reads no transcript bytes again", async (context) => {
  const root = await temporaryRoot(context, "pomegr-claude-user-times-");
  const file = path.join(root, "session.jsonl");
  await writeRecords(file, [userText(at(1), "PRIVATE".repeat(200)), userText(at(2))]); // larger than a suffix sample
  const size = (await readFile(file)).length;
  let bytes = 0;
  const original = fs.readSync;
  context.mock.method(fs, "readSync", (...args) => { const read = original(...args); if (args[3] > 256) bytes += read; return read; });
  const reader = createClaudeSessionWorkStartReader({ yieldControl: async () => {} });
  assert.deepEqual(await reader.readSessionFacts(file), { startedAt: at(1), userMessageTimes: [at(1), at(2)] });
  assert.equal(bytes, size, "every transcript byte is read exactly once for both facts");
  assert.equal(await reader.read(file), at(1));
  assert.deepEqual((await reader.readSessionFacts(file)).userMessageTimes, [at(1), at(2)]);
  assert.equal(bytes, size, "unchanged transcript: nothing is read or parsed again");
});

test("a transient read failure never leaves a stale list: the next read of the same file recovers", async (context) => {
  const root = await temporaryRoot(context, "pomegr-claude-user-times-");
  const file = path.join(root, "session.jsonl");
  await writeRecords(file, [userText(at(1))]);
  const reader = createClaudeSessionWorkStartReader({ yieldControl: async () => {} });
  assert.deepEqual((await reader.readSessionFacts(file)).userMessageTimes, [at(1)]);
  await appendFile(file, `${JSON.stringify(userText(at(2), "PRIVATE".repeat(200)))}\n`); // larger than a suffix sample
  const original = fs.readSync;
  let failing = true;
  context.mock.method(fs, "readSync", (...args) => {
    if (failing && args[3] > 256) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    return original(...args);
  });
  await assert.rejects(reader.readSessionFacts(file), /EBUSY/u, "a failed read is reported, not answered with the old list");
  failing = false;
  // The file is byte-for-byte what the failed read saw.
  assert.deepEqual((await reader.readSessionFacts(file)).userMessageTimes, [at(1), at(2)]);
});

test("an incomplete replacement keeps the prior complete answer until its replacement is complete", async (context) => {
  const root = await temporaryRoot(context, "pomegr-claude-user-times-");
  const file = path.join(root, "session.jsonl");
  const reader = createClaudeSessionWorkStartReader({ yieldControl: async () => {} });
  await assert.rejects(reader.readSessionFacts(file), /unavailable/u);
  await writeRecords(file, [userText(at(1)), userText(at(2))]);
  assert.deepEqual((await reader.readSessionFacts(file)).userMessageTimes, [at(1), at(2)]);
  await writeFile(file, '{"type":"user"', "utf8");
  assert.deepEqual((await reader.readSessionFacts(file)).userMessageTimes, [at(1), at(2)]);
  await writeRecords(file, [userText(at(5)), userText(at(6)), userText(at(7))]);
  assert.deepEqual((await reader.readSessionFacts(file)).userMessageTimes, [at(5), at(6), at(7)]);
});

test("the Claude adapter records user-message times that survive a tool-heavy session and exclude file-time rows", async (context) => {
  const root = await temporaryRoot(context, "pomegr-claude-user-times-provider-");
  const projectsRoot = path.join(root, "projects");
  const localId = "claude-user-times";
  const file = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  const tools = Array.from({ length: 300 }, (_, index) => {
    const stamp = new Date(Date.UTC(2026, 8, 30, 10, 2, index)).toISOString();
    return [toolUse(stamp, `tool-${index}`), toolResult(stamp, `tool-${index}`)];
  }).flat();
  await writeRecords(file, [
    userText(at(1)),
    { type: "user", uuid: "untimed", message: { content: "PRIVATE_UNTIMED_TEXT" } },
    ...tools,
    userText(at(9)),
  ]);
  const provider = createClaudeProvider({ homeDir: root, projectsRoot, registryRoot: path.join(root, "registry"), tasksRoot: path.join(root, "tasks"), explicitSession: file });
  const evidence = await provider.readSession(localId);
  assert.deepEqual(evidence.userMessageTimes, [at(1), at(9)]);
  // The windowed activity evidence still holds a row for the untimed message, at the file time.
  const userRows = evidence.activity.filter((row) => row.tool === "User input");
  assert.ok(userRows.some((row) => row.id === "untimed"), "the activity row with a synthesized time exists");
  assert.ok(!evidence.userMessageTimes.includes(userRows.find((row) => row.id === "untimed").timestamp), "and its time is not recorded evidence");
  const parsed = parseProviderSessionEvidence(evidence, localId);
  assert.deepEqual(parsed.userMessageTimes, [at(1), at(9)]);
  assert.doesNotMatch(JSON.stringify(parsed.userMessageTimes), /PRIVATE/u);

  // More tool work after the read never removes a recorded time.
  const later = Array.from({ length: 300 }, (_, index) => {
    const stamp = new Date(Date.UTC(2026, 8, 30, 10, 12, index)).toISOString();
    return [toolUse(stamp, `later-${index}`), toolResult(stamp, `later-${index}`)];
  }).flat();
  await appendFile(file, `${later.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const grown = await provider.readSession(localId);
  assert.deepEqual(grown.userMessageTimes, [at(1), at(9)]);
  assert.equal((await provider.readSession(localId, { completeHistory: true })).userMessageTimes.length, 2, "a complete-history read agrees");
});

test("the evidence schema accepts absent or valid user-message times and rejects anything else", async () => {
  const evidence = await claudeFixtureEvidence();
  assert.equal(Object.hasOwn(evidence, "userMessageTimes"), false, "the field is optional");
  const parse = (userMessageTimes) => providerSessionEvidenceSchema.safeParse({ ...evidence, userMessageTimes }).success;
  assert.equal(parse(undefined), true);
  assert.equal(parse([]), true);
  assert.equal(parse([at(1), at(1), at(2)]), true);
  assert.equal(parse(Array.from({ length: 256 }, (_, index) => new Date(Date.UTC(2026, 8, 30, 10, 0, index)).toISOString())), true);
  for (const [label, invalid] of [
    ["over the bound", Array.from({ length: 257 }, (_, index) => new Date(Date.UTC(2026, 8, 30, 10, 0, index)).toISOString())],
    ["newest first", [at(2), at(1)]],
    ["a non-canonical spelling", ["2026-09-30T10:01:00Z"]],
    ["an offset spelling", ["2026-09-30T12:01:00.000+02:00"]],
    ["an impossible date", ["2026-02-31T10:01:00.000Z"]],
    ["message text", ["PRIVATE_USER_TEXT"]],
    ["an activity row", [{ timestamp: at(1), detail: "Text" }]],
    ["a path", ["C:/Users/private/session.jsonl"]],
    ["an epoch number", [1_790_000_000_000]],
    ["null", null],
    ["a string", at(1)],
  ]) {
    assert.equal(parse(invalid), false, label);
  }
});

test("a checkpoint written before the field existed still loads, and one with the field round-trips", async (context) => {
  const directory = await temporaryRoot(context, "pomegr-user-times-checkpoint-");
  const validateCandidate = ({ localSessionId, evidence }) => { parseProviderSessionEvidence(evidence, localSessionId); return true; };
  const store = new SessionObservationCheckpointStore({ directory, validateCandidate });
  const legacy = await claudeFixtureEvidence();
  const snapshot = (evidence, localSessionId) => ({
    providerId: "claude", localSessionId, source: { fingerprint: "a".repeat(64), completeOffset: 10 }, evidence: { ...evidence, localId: localSessionId },
    readiness: { core: "ready" }, revision: 3, observedAt: at(30),
  });
  await store.write(snapshot(legacy, "legacy-session"));
  await store.write(snapshot({ ...legacy, userMessageTimes: [at(1), at(2)] }, "current-session"));
  await assert.rejects(store.write(snapshot({ ...legacy, userMessageTimes: ["PRIVATE_USER_TEXT"] }, "invalid-session")), /Invalid|invalid|canonical|privacy/iu);

  const restarted = new SessionObservationCheckpointStore({ directory, validateCandidate });
  const loaded = await restarted.load();
  assert.equal(loaded.ignored, 0, "no checkpoint is invalidated by the new optional field");
  const byId = new Map(loaded.records.map((record) => [record.localSessionId, record]));
  assert.deepEqual([...byId.keys()].sort(), ["current-session", "legacy-session"]);
  assert.equal(Object.hasOwn(byId.get("legacy-session").evidence, "userMessageTimes"), false);
  assert.equal(byId.get("legacy-session").revision, 3);
  assert.deepEqual(byId.get("current-session").evidence.userMessageTimes, [at(1), at(2)]);
  assert.ok((await restarted.loadOne("claude", "legacy-session")), "the single-session restore accepts it too");

  // A restored legacy checkpoint projects a ready feed with no user-message events.
  const state = { ...createEmptyMonitorState({ connected: true, source: "Claude Code", view: "history" }),
    readiness: { core: "ready", agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready", repository: "ready", resources: "unavailable", usageLimits: "unavailable" } };
  const eventsFor = (record) => projectSessionDomains(`claude:${record.localSessionId}`, { publicState: state, readiness: state.readiness, observedAt: at(30), evidence: record.evidence })
    .domains.get("session-summary").events;
  assert.deepEqual(eventsFor(byId.get("legacy-session")), { readiness: "ready", items: [], total: 0 });
  assert.deepEqual(eventsFor(byId.get("current-session")).items.map((item) => [item.kind, item.at]), [["user_message", at(2)], ["user_message", at(1)]]);
});
