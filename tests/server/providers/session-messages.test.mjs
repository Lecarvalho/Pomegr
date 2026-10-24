import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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
  assert.equal(last.messages[0].text, "last");
  const tool = await f.read({ before: last.older, limit: 1 });
  assert.deepEqual(tool.messages, [{ kind: "tool", at, name: "Read", outcome: "failed" }]);
  assert.equal((await f.read({ before: tool.older, limit: 1 })).messages[0].text, "first");
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
