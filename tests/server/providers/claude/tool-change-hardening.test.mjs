import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeProvider } from "../../../../server/providers/claude/index.mjs";
import { parseClaudeContextRecords } from "../../../../server/providers/claude/context.mjs";
import { mergeClaudeRequestFragments } from "../../../../server/providers/claude/activity-correlation.mjs";
import { createClaudeSessionWorkStartReader } from "../../../../server/providers/claude/session-work-start.mjs";
import { createIncrementalJsonlIngestor } from "../../../../server/providers/kernel/incremental-jsonl-ingestor.mjs";

// Synthetic transcripts only. Hardening of the tool-change attribution: no withdrawal, no understated count,
// no attribution across a competing transition.
const clock = (seconds) => new Date(Date.parse("2026-08-10T10:00:00.000Z") + seconds * 1_000).toISOString();
const usage = { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 9_500, cache_creation: { ephemeral_5m_input_tokens: 9_500, ephemeral_1h_input_tokens: 0 } };
const request = (id, seconds, content = [], toolsChanged = false) => ({
  type: "assistant", timestamp: clock(seconds),
  message: { id, model: "claude-test", usage, content, ...(toolsChanged ? { diagnostics: { cache_miss_reason: { type: "tools_changed" } } } : {}) },
});
const search = (id, seconds) => request(id, seconds, [{ type: "tool_use", id: "search", name: "ToolSearch", input: { query: "PRIVATE_QUERY" } }]);
const target = request("target", 20, [], true);
const result = (id = "search") => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "PRIVATE_RESULT" }] } });
const prompt = { type: "user", timestamp: clock(12), message: { content: "PRIVATE_PROMPT" } };
const entries = (...names) => ({ type: "attachment", attachment: { type: "deferred_tools_record", entries: names.map((name) => ({ name })) } });
const unreadable = { type: "attachment", attachment: { type: "deferred_tools_record", entries: [{ nope: 1 }] } };
const delta = { type: "attachment", attachment: { type: "deferred_tools_delta", addedNames: ["PRIVATE_NAME"] } };
const compaction = { type: "system", subtype: "compact_boundary", timestamp: clock(12) };
const sidechain = (record) => ({ ...record, isSidechain: true });
const afterSearch = (...between) => [search("search-request", 10), result(), ...between, target];
const options = { actorId: "primary", sourceKey: "s", completeHistory: true, expectedSessionId: "session" };
const attribution = (records, extra = {}) => {
  const snapshot = parseClaudeContextRecords(records, { ...options, ...extra }).find(({ dedupeId }) => dedupeId.endsWith(":target"));
  return [snapshot.cacheToolChangeCause, snapshot.cacheToolChangeAddedDefinitionCount ?? null];
};
const unavailable = [null, null];
const lines = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
const padding = (seconds, size) => ({ type: "user", timestamp: clock(seconds), message: { content: "x".repeat(size) } });

/**
 * Reads one transcript as it grows past the 2 MiB tail window, after its session has ended (the
 * historical branch), and from a restarted provider with no in-memory state. Each read is
 * [cause, count, historical].
 */
async function causesOverLifetime(context, id, records, { startPastWindow = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-tool-change-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "projects", "fixture", `${id}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  const age = { ms: 0 };
  const open = () => createClaudeProvider({ homeDir: root, projectsRoot: path.join(root, "projects"), now: () => Date.now() + age.ms });
  const read = async (provider) => {
    const evidence = await provider.readSession(id, { historical: false });
    const snapshot = evidence.usageSnapshots.find(({ dedupeId }) => dedupeId.endsWith(":target"));
    return [snapshot.cacheToolChangeCause, snapshot.cacheToolChangeAddedDefinitionCount ?? null, evidence.historical];
  };
  const provider = open();
  await writeFile(file, lines([padding(0, startPastWindow ? 2_300_000 : 1_500_000), ...records]));
  const shown = await read(provider);
  await appendFile(file, lines([padding(30, 900_000)]));
  const pastWindow = await read(provider);
  age.ms = 30 * 86_400_000;
  const ended = await read(provider);
  return { shown, pastWindow, ended, restarted: await read(open()) };
}

const remoteControl = (id) => {
  const bridge = (sequence) => ({ type: "bridge-session", sessionId: id, bridgeSessionId: "bridge", lastSequenceNum: sequence });
  return [request("baseline", 0), bridge(1), request("active", 10), { type: "system", subtype: "bridge_status", content: "/remote-control is active" },
    { type: "last-prompt", sessionId: id }, bridge(2), target];
};

test("a shown tool-change attribution survives growth past the tail window, the end of the session, and a restart", async (context) => {
  const eight = Array.from({ length: 8 }, (_, index) => `tool-${index}`);
  for (const [id, records, expected] of [
    ["live-loaded", afterSearch(entries(...eight)), ["deferred_definitions_loaded", 8]],
    ["live-remote", remoteControl("live-remote"), ["remote_control_connected", null]],
  ]) {
    const reads = await causesOverLifetime(context, id, records);
    assert.deepEqual(reads.shown, [...expected, false], `${id} shown while live`);
    assert.deepEqual(reads.pastWindow, [...expected, false], `${id} past the window`);
    assert.deepEqual(reads.ended, [...expected, true], `${id} after the session ended`);
    assert.deepEqual(reads.restarted, [...expected, true], `${id} from a restarted provider`);
  }
  // Decided from the whole transcript, not created by a bounded window: a transcript first read past the window has it too.
  const cold = await causesOverLifetime(context, "cold-loaded", afterSearch(entries(...eight)), { startPastWindow: true });
  assert.deepEqual([cold.shown, cold.restarted].map(([cause, count]) => [cause, count]), [["deferred_definitions_loaded", 8], ["deferred_definitions_loaded", 8]]);
  // A bounded parse that is handed no whole-transcript decision never creates one.
  assert.deepEqual(attribution(afterSearch(entries("a")), { completeHistory: false }), unavailable);
});

test("the whole-transcript pass decides from every complete record and treats an unreadable one as a gap", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-tool-change-pass-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  const decide = async (text, binding = { expectedSessionId: "session", inlineSidechains: true }) => {
    await writeFile(file, text);
    return [...(await createClaudeSessionWorkStartReader({ yieldControl: async () => {} }).readTranscriptFacts(file, binding)).toolChangeCauses]
      .map(([identity, { cause, added }]) => [identity, cause, added ?? null]);
  };
  const decided = [["target", "deferred_definitions_loaded", 1]];
  assert.deepEqual(await decide(lines(afterSearch(entries("a")))), decided);
  const gap = "{unreadable\n";
  assert.deepEqual(await decide(lines([search("search-request", 10), result()]) + gap + lines([entries("a"), target])), [], "a gap inside the interval");
  assert.deepEqual(await decide(lines(afterSearch(entries("a"))) + gap), decided, "a gap after the decision changes nothing");
  assert.deepEqual(await decide(lines(afterSearch(entries("a")).map(sidechain)), { expectedSessionId: "session", inlineSidechains: true }), [], "inline sidechain records of a primary transcript");
  assert.deepEqual(await decide(lines(afterSearch(entries("a")).map(sidechain)), { expectedSessionId: "session", inlineSidechains: false }), decided, "a subagent's own transcript");
});

test("a fragment merge keeps one retained cause and count pair and never mixes observations", () => {
  const snapshot = (cause, count) => ({ dedupeId: "r", timestamp: clock(1), cacheToolChangeCause: cause, ...(count ? { cacheToolChangeAddedDefinitionCount: count } : {}) });
  const merged = (previous, next) => {
    const result = mergeClaudeRequestFragments(previous, next);
    return [result.cacheToolChangeCause, result.cacheToolChangeAddedDefinitionCount ?? null];
  };
  const [loaded, remote, none] = [snapshot("deferred_definitions_loaded", 8), snapshot("remote_control_connected"), snapshot(null)];
  assert.deepEqual(merged(loaded, none), ["deferred_definitions_loaded", 8]);
  assert.deepEqual(merged(remote, none), ["remote_control_connected", null]);
  assert.deepEqual(merged(loaded, remote), ["deferred_definitions_loaded", 8]);
  assert.deepEqual(merged(remote, snapshot("deferred_definitions_loaded", 5)), ["remote_control_connected", null]);
  assert.deepEqual(merged(none, snapshot("deferred_definitions_loaded", 5)), ["deferred_definitions_loaded", 5]);
  assert.deepEqual(merged(none, none), unavailable);
});

test("an unreadable or pre-result definition record keeps the whole interval unavailable", () => {
  assert.deepEqual(attribution(afterSearch(entries("a", "b", "c"), entries("d"))), ["deferred_definitions_loaded", 4]);
  const cases = {
    "an unreadable record between two readable ones": afterSearch(entries("a", "b", "c"), unreadable, entries("d")),
    "an unreadable record before the result": [search("search-request", 10), unreadable, result(), entries("a"), target],
    "a readable record before the result and another after": [search("search-request", 10), entries("a"), result(), entries("b"), target],
    "an unreadable record after the only readable one": afterSearch(entries("a"), unreadable),
  };
  for (const [name, records] of Object.entries(cases)) assert.deepEqual(attribution(records), unavailable, name);
  // A bookkeeping record or a repeated name before the result adds no definition, so it cannot understate the count.
  assert.deepEqual(attribution([search("search-request", 10), entries(), result(), entries("a"), target]), ["deferred_definitions_loaded", 1]);
  // The ambiguity belongs to its own interval: a later search with a clean interval still attributes.
  const later = [search("first", 5), result(), unreadable, request("quiet", 8), search("second", 10), result(), entries("a"), target];
  assert.deepEqual(attribution(later), ["deferred_definitions_loaded", 1]);
});

test("a competing transition in the interval leaves the deferred-definition cause unavailable", () => {
  const cases = {
    "a deferred tools delta before the record": afterSearch(delta, entries("a")),
    "a deferred tools delta after the record": afterSearch(entries("a"), delta),
    "a compact boundary": afterSearch(entries("a"), compaction),
    "a new user prompt after the record": afterSearch(entries("a"), prompt),
    "a new user prompt before the result": [search("search-request", 10), prompt, result(), entries("a"), target],
    "a user record mixing text with a tool result": afterSearch({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "search", content: "" }, { type: "text", text: "PRIVATE" }] } }, entries("a")),
  };
  for (const [name, records] of Object.entries(cases)) assert.deepEqual(attribution(records), unavailable, name);
  // Another tool result, or a transition that precedes the preceding request, is not a competing transition.
  assert.deepEqual(attribution(afterSearch(result("other"), entries("a"))), ["deferred_definitions_loaded", 1]);
  assert.deepEqual(attribution([request("earlier", 5), delta, compaction, prompt, ...afterSearch(entries("a"))]), ["deferred_definitions_loaded", 1]);
});

test("inline sidechain records are neither the preceding or target request nor a definition source", () => {
  assert.deepEqual(attribution(afterSearch(entries("a"), sidechain(request("side", 15)))), ["deferred_definitions_loaded", 1]);
  assert.deepEqual(attribution(afterSearch(sidechain(entries("b", "c")), entries("a"))), ["deferred_definitions_loaded", 1]);
  const cases = {
    "a sidechain discovery request": [sidechain(search("search-request", 10)), sidechain(result()), entries("a"), target],
    "a sidechain target request": [search("search-request", 10), result(), entries("a"), sidechain(target)],
    "definitions recorded only inside a sidechain": afterSearch(sidechain(entries("a", "b"))),
    "a sidechain discovery result": [search("search-request", 10), sidechain(result()), entries("a"), target],
  };
  for (const [name, records] of Object.entries(cases)) assert.deepEqual(attribution(records), unavailable, name);
});

test("the interval is closed by the successor's first fragment, and a subagent's own transcript stays attributable", () => {
  const loaded = ["deferred_definitions_loaded", 1];
  const firstFragment = request("target", 20);
  for (const [name, after] of Object.entries({ "a deferred tools delta": delta, "a compact boundary": compaction, "a user prompt": prompt, "an unreadable record": unreadable })) {
    const base = [search("search-request", 10), result(), entries("a")];
    assert.deepEqual(attribution([...base, firstFragment, after, target]), loaded, `${name} between fragments, diagnostic on the later one`);
    assert.deepEqual(attribution([...base, target, after, request("target", 21, [], true)]), loaded, `${name} between fragments, diagnostic on both`);
  }
  assert.deepEqual(attribution(afterSearch(entries("a")).map(sidechain), { actorId: "agent-x" }), loaded);
  assert.deepEqual(attribution(afterSearch(entries("a")).map(sidechain)), unavailable, "a primary transcript skips its inline sidechain records");
});

test("the incremental ingestor reports an unreadable or oversized complete record to its reducer as a gap", async () => {
  const content = Buffer.from('{"a":1}\n{broken\n' + `{"b":"${"x".repeat(40)}"}\n` + '{"c":3}\n');
  const ingestor = createIncrementalJsonlIngestor({
    readChunk: (offset, bytes) => content.subarray(offset, offset + bytes),
    parseRecord: (line) => JSON.parse(line.toString("utf8")),
    initialState: () => ({ records: 0, gaps: 0 }),
    reduce: (state) => ({ ...state, records: state.records + 1 }),
    reduceGap: (state) => ({ ...state, gaps: state.gaps + 1 }),
    chunkBytes: 8,
    maximumFragmentBytes: 16,
  });
  await ingestor.observe({ identity: "source", size: content.length }, () => {});
  const { candidate, malformedRecords, oversizedFragments } = ingestor.snapshot();
  assert.deepEqual([malformedRecords > 0, oversizedFragments > 0, candidate.gaps], [true, true, malformedRecords + oversizedFragments]);
  assert.ok(candidate.records >= 1);
});
