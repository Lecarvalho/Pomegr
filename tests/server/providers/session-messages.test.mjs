import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import crypto from "node:crypto";
import { readSessionMessages } from "../../../server/providers/kernel/session-messages.mjs";
import { claudeSessionMessages } from "../../../server/providers/claude/activity-events.mjs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeProvider } from "../../../server/providers/claude/index.mjs";
import { createCodexProvider } from "../../../server/providers/codex/index.mjs";

const timestamp = "2026-10-24T12:00:00.000Z";
const at = Date.parse(timestamp);
const line = (record) => `${JSON.stringify({ timestamp, ...record })}\n`;
const formats = {
  claude: {
    owner: (text) => ({ type: "user", message: { content: text } }),
    agent: (text) => ({ type: "assistant", message: { id: "reply", content: [{ type: "text", text }] } }),
    call: { type: "assistant", message: { content: [{ type: "tool_use", id: "call", name: "Read", input: { secret: "ARGUMENT_PRIVATE" } }] } },
    result: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call", is_error: true, content: "RESULT_PRIVATE" }] } },
    hidden: [
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "THINKING_PRIVATE" }] } },
      { type: "user", isMeta: true, message: { content: "META_PRIVATE" } },
      { type: "user", isCompactSummary: true, message: { content: "COMPACT_PRIVATE" } },
      { type: "user", message: { content: "<local-command-stdout>COMMAND_PRIVATE</local-command-stdout>" } },
      { type: "user", message: { content: "<command-name>/hook</command-name>HOOK_PRIVATE" } },
      { type: "system", subtype: "away_summary", content: "SUMMARY_PRIVATE" },
      { type: "user", isSidechain: true, message: { content: "SIDECHAIN_PRIVATE" } },
      { type: "user", origin: { kind: "task-notification" }, promptSource: "system", message: { content: "NOTIFICATION_PRIVATE" } },
      { type: "user", promptSource: "system", message: { content: "HOOK_PRIVATE" } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "other", content: "RESULT_PRIVATE" }, { type: "text", text: "COMMAND_PRIVATE" }] } },
    ],
  },
  codex: {
    owner: (text) => ({ type: "event_msg", payload: { type: "user_message", message: text } }),
    agent: (text) => ({ type: "event_msg", payload: { type: "agent_message", message: text } }),
    call: { type: "response_item", payload: { type: "function_call", call_id: "call", name: "Read", arguments: "ARGUMENT_PRIVATE" } },
    result: { type: "response_item", payload: { type: "function_call_output", call_id: "call", is_error: true, output: "RESULT_PRIVATE" } },
    hidden: [
      { type: "response_item", payload: { type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "THINKING_PRIVATE" }] } },
      { type: "event_msg", synthetic: true, payload: { type: "user_message", message: "META_PRIVATE" } },
      { type: "compacted", payload: { message: "COMPACT_PRIVATE" } },
      { type: "event_msg", payload: { type: "exec_command_end", output: "COMMAND_PRIVATE" } },
      { type: "response_item", payload: { type: "message", role: "system", content: "HOOK_PRIVATE" } },
      { type: "event_msg", payload: { type: "agent_reasoning", text: "SUMMARY_PRIVATE" } },
      { type: "event_msg", isMeta: true, payload: { type: "user_message", message: "META_PRIVATE" } },
    ],
  },
};

function countReads(t) {
  const calls = [];
  const read = fs.readSync;
  t.mock.method(fs, "readSync", (...args) => {
    const bytes = read(...args);
    calls.push({ offset: args[4], bytes });
    return bytes;
  });
  return calls;
}

test("byte cursor reads only the append plus fixed-size fingerprint samples", async (t) => {
  const f = await fixture(t, "claude", Array.from({ length: 2000 }, () => formats.claude.owner("x".repeat(1000))));
  const page = await readSessionMessages(f.file, { limit: 2 }, claudeSessionMessages);
  const end = fs.statSync(f.file).size;
  assert.equal(page.cursor.offset, end);
  const appended = line(formats.claude.owner("appended"));
  await appendFile(f.file, appended);
  const calls = countReads(t);
  const next = await readSessionMessages(f.file, { cursor: page.cursor, limit: 2 }, claudeSessionMessages);
  assert.deepEqual(next.messages.map((message) => message.text), ["appended"]);
  assert.ok(calls.every((call) => call.offset >= end || call.bytes <= 256));
  assert.ok(calls.reduce((total, call) => total + call.bytes, 0) <= Buffer.byteLength(appended) + 6 * 256);
});

test("newest and older pages scan bounded windows rather than a large transcript", async (t) => {
  const f = await fixture(t, "claude", Array.from({ length: 3000 }, (_, i) => formats.claude.owner(`${i}:` + "x".repeat(1000))));
  const calls = countReads(t);
  const newest = await readSessionMessages(f.file, { limit: 2 }, claudeSessionMessages);
  assert.deepEqual(newest.messages.map((message) => message.text.split(":")[0]), ["2998", "2999"]);
  assert.ok(calls.reduce((total, call) => total + call.bytes, 0) < fs.statSync(f.file).size);
  assert.ok(calls.every((call) => call.bytes <= 256 * 1024));
  calls.length = 0;
  const older = await readSessionMessages(f.file, { before: newest.older, limit: 2 }, claudeSessionMessages);
  assert.deepEqual(older.messages.map((message) => message.text.split(":")[0]), ["2996", "2997"]);
  assert.ok(calls.reduce((total, call) => total + call.bytes, 0) < 512 * 1024);
});

test("a signed mid-record cursor resets instead of splitting a record", async (t) => {
  const f = await fixture(t, "claude", [formats.claude.owner("one"), { type: "assistant", message: { content: [
    { type: "text", text: "two" }, { type: "text", text: "three" },
  ] } }]);
  const stat = fs.statSync(f.file);
  const offset = stat.size - 10;
  const bytes = fs.readFileSync(f.file).subarray(Math.max(0, offset - 256), offset);
  const identity = `${stat.dev}:${stat.ino}`;
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const fingerprint = crypto.createHash("sha256").update(`${identity}\0${offset}\0${digest}`).digest("hex");
  const page = await readSessionMessages(f.file, { cursor: { fingerprint, offset }, limit: 1 }, claudeSessionMessages);
  assert.equal(page.reset, true);
  assert.deepEqual(page.messages.map((message) => message.text), ["two", "three"]);
  assert.equal(page.cursor.offset, stat.size);
});

test("same-file reads serialize and append pages stop at complete record boundaries", async (t) => {
  const f = await fixture(t, "claude", [formats.claude.owner("one")]);
  const page = await readSessionMessages(f.file, { limit: 1 }, claudeSessionMessages);
  const appended = Array.from({ length: 2000 }, (_, i) => line(formats.claude.owner(`${i}` + "x".repeat(1000)))).join("");
  await appendFile(f.file, appended);
  const calls = countReads(t);
  let active = 0, maximum = 0;
  const open = fs.openSync, close = fs.closeSync;
  t.mock.method(fs, "openSync", (...args) => { const fd = open(...args); maximum = Math.max(maximum, ++active); return fd; });
  t.mock.method(fs, "closeSync", (...args) => { active -= 1; return close(...args); });
  const pages = await Promise.all(Array.from({ length: 3 }, () => readSessionMessages(f.file, { cursor: page.cursor, limit: 1 }, claudeSessionMessages)));
  assert.equal(maximum, 1);
  assert.ok(calls.reduce((total, call) => total + call.bytes, 0) < 3 * (64 * 1024 + 6 * 256));
  assert.equal(pages[0].cursor.offset, page.cursor.offset + Buffer.byteLength(line(formats.claude.owner("0" + "x".repeat(1000)))));
  assert.deepEqual(pages[0], pages[1]);
});

test("backward windows stitch a split record and retain its later tool outcome", async (t) => {
  const f = await fixture(t, "claude", [formats.claude.owner("old"), formats.claude.call,
    ...Array.from({ length: 500 }, () => ({ type: "system", content: "PRIVATE".repeat(100) })), formats.claude.result]);
  const page = await readSessionMessages(f.file, { limit: 1 }, claudeSessionMessages);
  assert.deepEqual(page.messages, [{ kind: "tool", at, name: "Read", outcome: "failed" }]);
  const older = await readSessionMessages(f.file, { before: page.older, limit: 1 }, claudeSessionMessages);
  assert.deepEqual(older.messages, [{ kind: "owner", at, text: "old" }]);
  assert.equal(older.older, null);
});

test("append stops on a multi-block record and resumes an incomplete tail", async (t) => {
  const f = await fixture(t, "claude", [formats.claude.owner("one")]);
  const page = await readSessionMessages(f.file, { limit: 1 }, claudeSessionMessages);
  const record = line({ type: "assistant", message: { content: [{ type: "text", text: "two" }, { type: "text", text: "three" }] } });
  const incomplete = line(formats.claude.owner("four"));
  await appendFile(f.file, record + incomplete.slice(0, -4));
  const next = await readSessionMessages(f.file, { cursor: page.cursor, limit: 1 }, claudeSessionMessages);
  assert.deepEqual(next.messages.map((message) => message.text), ["two", "three"]);
  assert.equal(next.cursor.offset, page.cursor.offset + Buffer.byteLength(record));
  const empty = await readSessionMessages(f.file, { cursor: next.cursor, limit: 1 }, claudeSessionMessages);
  assert.equal(empty.cursor.offset, next.cursor.offset);
  await appendFile(f.file, incomplete.slice(-4));
  assert.deepEqual((await readSessionMessages(f.file, { cursor: empty.cursor, limit: 1 }, claudeSessionMessages)).messages.map((message) => message.text), ["four"]);
});

test("the cursor suffix hash detects same-size rewrites and smaller files", async (t) => {
  const f = await fixture(t, "claude", [formats.claude.owner("first")]);
  const page = await readSessionMessages(f.file, { limit: 1 }, claudeSessionMessages);
  await f.write([formats.claude.owner("other")]);
  const changed = await readSessionMessages(f.file, { cursor: page.cursor, limit: 1 }, claudeSessionMessages);
  assert.equal(changed.reset, true);
  assert.equal(changed.messages[0].text, "other");
  await f.write([formats.claude.owner("x")]);
  const shortened = await readSessionMessages(f.file, { before: changed.cursor, limit: 1 }, claudeSessionMessages);
  assert.equal(shortened.reset, true);
  assert.equal(shortened.messages[0].text, "x");
});

async function fixture(t, id, records) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-messages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localId = "11111111-1111-4111-8111-111111111111";
  const file = path.join(root, id === "claude" ? "projects/project" : "sessions", `${id === "codex" ? "rollout-" : ""}${localId}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  const header = id === "codex" ? line({ type: "session_meta", payload: { id: localId, cwd: root, source: "cli" } }) : "";
  const write = (rows) => writeFile(file, header + rows.map(line).join(""));
  await write(records);
  const provider = id === "claude"
    ? createClaudeProvider({ homeDir: root, projectsRoot: path.join(root, "projects"), registryRoot: path.join(root, "registry"), tasksRoot: path.join(root, "tasks"), explicitSession: file })
    : createCodexProvider({ codexHome: root, includeArchived: false, appServer: false });
  return { file, write, read: (request = { limit: 100 }) => provider.readSessionMessages(localId, request) };
}

test("Claude paginates multiple blocks in one record without losing tool outcomes", async (t) => {
  const f = await fixture(t, "claude", [{ type: "assistant", message: { content: [
    { type: "text", text: "first" }, { type: "tool_use", id: "call", name: "Read", input: { value: "PRIVATE" } }, { type: "text", text: "last" },
  ] } }, formats.claude.result]);
  const last = await f.read({ limit: 1 });
  assert.deepEqual(last.messages.map((message) => message.kind), ["agent", "tool", "agent"]);
  assert.equal(last.messages[1].outcome, "failed");
  assert.equal(last.older, null);
  assert.equal(last.cursor.offset, fs.statSync(f.file).size);
  assert.deepEqual((await f.read({ cursor: last.cursor, limit: 1 })).messages, []);
});

test("Codex reply mirrors do not duplicate messages or alter append offsets", async (t) => {
  const f = await fixture(t, "codex", [formats.codex.owner("one"), formats.codex.agent("two")]);
  const page = await f.read();
  await appendFile(f.file, line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "two" }] } }) + line(formats.codex.owner("three")));
  assert.deepEqual((await f.read({ cursor: page.cursor, limit: 1 })).messages, [{ kind: "owner", at, text: "three" }]);
});

test("Codex tool event calls and completion outcomes expose no execution content", async (t) => {
  const f = await fixture(t, "codex", [
    { type: "event_msg", payload: { type: "mcp_tool_call_begin", call_id: "mcp", invocation: { tool: "lookup", arguments: "ARGUMENT_PRIVATE" } } },
    { type: "event_msg", payload: { type: "mcp_tool_call_end", call_id: "mcp", result: { Ok: { isError: true, content: "RESULT_PRIVATE" } } } },
    formats.codex.call,
    { type: "event_msg", payload: { type: "exec_command_end", call_id: "call", exit_code: 1, output: "COMMAND_PRIVATE" } },
  ]);
  const page = await f.read();
  assert.deepEqual(page.messages, [
    { kind: "tool", at, name: "lookup", outcome: "failed" },
    { kind: "tool", at, name: "Read", outcome: "failed" },
  ]);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE/);
});

for (const [id, format] of Object.entries(formats)) {
  test(`${id} messages expose only owner/reply text and tool outcome, in order`, async (t) => {
    const { read } = await fixture(t, id, [format.owner("hello"), format.agent("reply"), format.call, ...format.hidden, format.result]);
    const page = await read();
    assert.deepEqual(page.messages, [
      { kind: "owner", at, text: "hello" }, { kind: "agent", at, text: "reply" },
      { kind: "tool", at, name: "Read", outcome: "failed" },
    ]);
    assert.equal(page.status, "ok");
    assert.equal(page.reset, false);
    assert.equal(page.older, null);
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE|call_id|tool_use_id|arguments|input/);
  });

  test(`${id} messages page backward, follow appends, and reset replacement or rewrite`, async (t) => {
    const rows = [format.owner("one"), format.agent("two"), format.owner("three"), format.agent("four")];
    const f = await fixture(t, id, rows);
    const newest = await f.read({ limit: 2 });
    assert.deepEqual(newest.messages.map((m) => m.text), ["three", "four"]);
    assert.ok(newest.older);
    const older = await f.read({ before: newest.older, limit: 2 });
    assert.deepEqual(older.messages.map((m) => m.text), ["one", "two"]);
    assert.equal(older.older, null);
    assert.deepEqual((await f.read({ cursor: newest.cursor, limit: 2 })).messages, []);
    await appendFile(f.file, line(format.owner("five")) + line(format.agent("six")) + line(format.owner("seven")));
    const next = await f.read({ cursor: newest.cursor, limit: 2 });
    assert.equal(next.reset, false);
    assert.deepEqual(next.messages.map((m) => m.text), ["five", "six"]);
    assert.deepEqual((await f.read({ cursor: next.cursor, limit: 2 })).messages.map((m) => m.text), ["seven"]);
    await rename(f.file, `${f.file}.old`);
    await f.write([format.owner("replacement")]);
    const replacement = await f.read({ cursor: next.cursor, limit: 2 });
    assert.equal(replacement.reset, true);
    assert.equal(replacement.messages[0].text, "replacement");
    await f.write([format.owner("rewritten content is longer")]);
    const rewritten = await f.read({ cursor: replacement.cursor, limit: 2 });
    assert.equal(rewritten.reset, true);
    assert.equal(rewritten.messages[0].text, "rewritten content is longer");
    await rm(f.file);
    assert.deepEqual(await f.read(), { messages: [], cursor: null, older: null, reset: false, status: "missing" });
  });

  test(`${id} truncates text, keeps UTF-8 and omits incomplete records`, async (t) => {
    const f = await fixture(t, id, [format.owner("😀".repeat(40_000)), format.call]);
    const page = await f.read();
    assert.equal(page.messages[0].text.length, 32000);
    assert.ok(page.messages[0].text.endsWith("\n[truncated]"));
    assert.equal(page.messages[1].outcome, "pending");
    await appendFile(f.file, '{"type":');
    assert.deepEqual((await f.read({ cursor: page.cursor, limit: 100 })).messages, []);
  });
}
