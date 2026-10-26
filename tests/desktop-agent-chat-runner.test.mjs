import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  ANSWER_LIMIT,
  CLAUDE_FILE_TOOLS,
  chatArguments,
  createTurnReader,
  POMEGR_READ_TOOLS,
  runChatTurn,
  STDOUT_LINE_LIMIT,
  TURN_TIMEOUT_MS,
} from "../desktop/runtime/agent-chat-runner.mjs";

const server = Object.freeze({
  command: "C:\\Program Files\\Pomegr\\Pomegr.exe",
  args: ["C:\\Program Files\\Pomegr\\resources\\app.asar.unpacked\\desktop\\workers\\agent-chat-mcp.cjs"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
});
const READ_TOOL_ARGUMENT = POMEGR_READ_TOOLS.map((name) => `mcp__pomegr__${name}`);
const ACTIVITIES = ["starting", "thinking", "reading_files", "reading_sessions", "reading_usage", "writing"];

test("the runner's fixed names and bounds", () => {
  assert.equal(TURN_TIMEOUT_MS, 10 * 60_000);
  assert.equal(STDOUT_LINE_LIMIT, 4 * 1024 * 1024);
  assert.equal(ANSWER_LIMIT, 32_000);
  assert.deepEqual([...POMEGR_READ_TOOLS], ["list_sessions", "get_session_report", "list_session_agents", "get_agent_context", "get_recent_failures", "get_usage_limits", "get_provider_health", "get_task", "list_tasks"]);
  assert.deepEqual([...CLAUDE_FILE_TOOLS], ["Read", "Grep", "Glob"]);
  assert.equal(Object.isFrozen(POMEGR_READ_TOOLS), true);
  assert.equal(Object.isFrozen(CLAUDE_FILE_TOOLS), true);
});

test("the Claude arguments are fixed, with the model and the MCP server as the only variable parts", () => {
  const fixed = [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence",
    "--setting-sources", "", "--settings", '{"disableAllHooks":true,"autoMemoryEnabled":false}', "--strict-mcp-config", "--mcp-config",
  ];
  const tail = ["--permission-mode", "dontAsk", "--tools", "Read,Grep,Glob", "--allowedTools", ["Read", "Grep", "Glob", ...READ_TOOL_ARGUMENT].join(",")];
  assert.deepEqual(chatArguments("claude"), [...fixed, '{"mcpServers":{}}', ...tail]);
  assert.deepEqual(chatArguments("claude", "claude-opus-4-1[1m]"), [...fixed, '{"mcpServers":{}}', ...tail, "--model", "claude-opus-4-1[1m]"]);
  assert.deepEqual(chatArguments("claude", null, server), [...fixed, JSON.stringify({ mcpServers: { pomegr: server } }), ...tail]);
  assert.deepEqual(chatArguments("claude", "claude-sonnet-4", server), [...fixed, JSON.stringify({ mcpServers: { pomegr: server } }), ...tail, "--model", "claude-sonnet-4"]);
  assert.deepEqual(JSON.parse(chatArguments("claude", null, server)[fixed.length]), { mcpServers: { pomegr: { command: server.command, args: server.args, env: server.env } } });
});

test("the Codex arguments are fixed, read-only, and end with the stdin marker", () => {
  const fixed = ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--disable", "apps", "-c", 'approval_policy="never"', "-c", "features.prefer_mxc=true", "-c", 'windows.sandbox="elevated"'];
  assert.deepEqual(chatArguments("codex"), [...fixed, "-"]);
  assert.deepEqual(chatArguments("codex", "gpt-6-sol"), [...fixed, "--model", "gpt-6-sol", "-"]);
  const servers = [
    "-c", `mcp_servers.pomegr.command=${JSON.stringify(server.command)}`,
    "-c", `mcp_servers.pomegr.args=[${JSON.stringify(server.args[0])}]`,
    "-c", 'mcp_servers.pomegr.env={ELECTRON_RUN_AS_NODE="1"}',
  ];
  assert.deepEqual(chatArguments("codex", null, server), [...fixed, ...servers, "-"]);
  assert.deepEqual(chatArguments("codex", "gpt-6-sol", server), [...fixed, ...servers, "--model", "gpt-6-sol", "-"]);
  const two = chatArguments("codex", null, { command: "node.exe", args: ["a.js", "b.js"], env: { A_ONE: "1", B_TWO: "x y" } });
  assert.ok(two.includes('mcp_servers.pomegr.args=["a.js", "b.js"]'));
  assert.ok(two.includes('mcp_servers.pomegr.env={A_ONE="1", B_TWO="x y"}'));
  // A path with a backslash or a quote reaches TOML escaped, as one string.
  assert.ok(chatArguments("codex", null, { ...server, command: 'C:\\a "b"\\x.exe' }).includes('mcp_servers.pomegr.command="C:\\\\a \\"b\\"\\\\x.exe"'));
});

test("an unknown provider has no arguments", () => {
  for (const provider of ["gemini", "", undefined, null, "Claude", "CODEX", 5, {}]) assert.equal(chatArguments(provider, "m", server), null, String(provider));
});

test("a model that is not a plain identifier is dropped, and a valid one is kept", () => {
  for (const provider of ["claude", "codex"]) {
    const none = chatArguments(provider);
    for (const bad of ["--help", "a b", "../x", "", "-x", "m;rm", "m\nx", "é", "a".repeat(121), 7, {}, ["m"], null, undefined]) {
      assert.deepEqual(chatArguments(provider, bad), none, `${provider}: ${JSON.stringify(bad)}`);
      assert.deepEqual(chatArguments(provider, bad, server), chatArguments(provider, null, server));
    }
    for (const good of ["a", "claude-opus-4-1[1m]", "gpt-6-sol", "o3:high", "a.b_c-d", "a".repeat(120)]) {
      assert.equal(chatArguments(provider, good).includes(good), true, `${provider}: ${good}`);
    }
  }
});

test("an MCP server that the desktop did not shape exactly is dropped", () => {
  const plainFixed = { ...server, args: [...server.args], env: { ...server.env } };
  for (const provider of ["claude", "codex"]) {
    const none = chatArguments(provider, null);
    for (const bad of [
      null, undefined, "pomegr", 5, [],
      { ...plainFixed, command: 5 }, { ...plainFixed, command: "" }, { ...plainFixed, command: "node.exe\nother" }, { ...plainFixed, command: "node\u0000.exe" }, { ...plainFixed, command: undefined },
      { ...plainFixed, args: "script.cjs" }, { ...plainFixed, args: undefined }, { ...plainFixed, args: [5] }, { ...plainFixed, args: [""] }, { ...plainFixed, args: ["a\nb"] },
      { ...plainFixed, env: null }, { ...plainFixed, env: undefined }, { ...plainFixed, env: "ELECTRON_RUN_AS_NODE=1" },
      { ...plainFixed, env: { electron_run_as_node: "1" } }, { ...plainFixed, env: { "1A": "1" } }, { ...plainFixed, env: { "A-B": "1" } },
      { ...plainFixed, env: { ELECTRON_RUN_AS_NODE: "1\nPATH=x" } }, { ...plainFixed, env: { ELECTRON_RUN_AS_NODE: 1 } }, { ...plainFixed, env: { ELECTRON_RUN_AS_NODE: "" } },
    ]) {
      assert.deepEqual(chatArguments(provider, null, bad), none, `${provider}: ${JSON.stringify(bad)}`);
    }
  }
});

test("the arguments allow only file reading and Pomegr's read tools and never ask for a permission", () => {
  const claude = chatArguments("claude", "claude-opus-4-1", server);
  for (const required of ["--setting-sources", "", "--settings", '{"disableAllHooks":true,"autoMemoryEnabled":false}', "--strict-mcp-config", "--permission-mode", "dontAsk", "--tools", "Read,Grep,Glob", "--no-session-persistence"]) assert.ok(claude.includes(required), required);
  assert.equal(claude[claude.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(claude[claude.indexOf("--tools") + 1], "Read,Grep,Glob");
  assert.equal(claude.some((argument) => /^--dangerously/u.test(argument)), false);
  for (const forbidden of ["bypassPermissions", "acceptEdits", "default", "plan", "--add-dir", "--restricted", "--plugin-dir", "--resume", "--continue", "--agents", "--append-system-prompt"]) {
    assert.equal(claude.includes(forbidden), false, forbidden);
  }
  const allowed = claude[claude.indexOf("--allowedTools") + 1].split(",");
  assert.deepEqual(allowed, ["Read", "Grep", "Glob", ...READ_TOOL_ARGUMENT]);
  for (const writing of ["Bash", "Edit", "Write", "NotebookEdit", "Task", "WebFetch", "add_task", "complete_task"]) assert.equal(allowed.some((name) => name.includes(writing)), false, writing);
  assert.equal(claude.filter((argument) => argument === "--mcp-config").length, 1);

  const codex = chatArguments("codex", "gpt-6-sol", server);
  for (const required of ["--sandbox", "read-only", "--ephemeral", "--ignore-user-config"]) assert.ok(codex.includes(required), required);
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "read-only");
  assert.equal(codex.at(-1), "-");
  for (const forbidden of ["workspace-write", "danger-full-access", "--full-auto", "--yolo", "--dangerously-bypass-approvals-and-sandbox", "--add-dir", "--profile", "--oss"]) assert.equal(codex.includes(forbidden), false, forbidden);
  assert.equal(codex.some((argument) => /dangerously/u.test(argument)), false);
});

// ---- the turn reader -------------------------------------------------------------------------------------------

const event = (inner, extra = {}) => JSON.stringify({ type: "stream_event", event: inner, session_id: "synthetic-session", parent_tool_use_id: null, ...extra });
const delta = (text, index = 0) => event({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
const started = (block, index = 0) => event({ type: "content_block_start", index, content_block: block });
const result = (fields = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Hello world", session_id: "synthetic-session", ...fields });

function claudeStream() {
  return [
    JSON.stringify({ type: "system", subtype: "init", tools: ["Read", "Grep", "Glob"], mcp_servers: [{ name: "pomegr", status: "connected" }] }),
    event({ type: "message_start", message: { id: "msg_1", role: "assistant", content: [] } }),
    started({ type: "thinking", thinking: "" }),
    event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private reasoning" } }),
    started({ type: "tool_use", id: "toolu_1", name: "Read", input: {} }, 1),
    event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"file_path\":\"C:\\\\private\\\\secret.txt\"}" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "private file content" }] } }),
    event({ type: "message_start", message: { id: "msg_2", role: "assistant", content: [] } }),
    started({ type: "text", text: "" }),
    delta("Hel"),
    delta("lo "),
    event({ type: "content_block_stop", index: 0 }),
    delta("world"),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] } }),
    result(),
  ];
}

function readClaude(lines, size = Infinity, provider = "claude") {
  const texts = [];
  const activities = [];
  const reader = createTurnReader(provider, { onText: (text) => texts.push(text), onActivity: (activity) => activities.push(activity) });
  const whole = `${lines.join("\n")}\n`;
  if (size === Infinity) reader.push(whole);
  else for (let at = 0; at < whole.length; at += size) reader.push(whole.slice(at, at + size));
  return { texts, activities, end: reader.end(), reader };
}

test("Claude text deltas accumulate and a new message starts the shown text again", () => {
  const { texts, activities, end } = readClaude(claudeStream());
  assert.deepEqual(texts, ["", "", "Hel", "Hello ", "Hello world"]);
  assert.deepEqual(end, { ok: true, text: "Hello world" });
  assert.deepEqual(activities, ["thinking", "reading_files", "writing"]);
});

test("the same stream read in chunks of any size gives the same texts, activities, and end", () => {
  const whole = readClaude(claudeStream());
  for (const size of [1, 2, 3, 7, 13, 64, 1000]) {
    const chunked = readClaude(claudeStream(), size);
    assert.deepEqual(chunked.texts, whole.texts, `size ${size}`);
    assert.deepEqual(chunked.activities, whole.activities, `size ${size}`);
    assert.deepEqual(chunked.end, whole.end, `size ${size}`);
  }
  // A multi-byte character split inside a chunk boundary of the text is the pipe's job; whole strings pass through.
  assert.deepEqual(readClaude([delta("é ✓"), result({ result: "é ✓" })], 2).end, { ok: true, text: "é ✓" });
});

test("a tool use, a thinking block, and a text block map to the fixed activities", () => {
  const tool = (name) => started({ type: "tool_use", id: "toolu_x", name, input: {} });
  const cases = [
    [started({ type: "thinking", thinking: "" }), "thinking"], [started({ type: "redacted_thinking", data: "x" }), "thinking"], [started({ type: "text", text: "" }), "writing"],
    [tool("Read"), "reading_files"], [tool("Grep"), "reading_files"], [tool("Glob"), "reading_files"],
    [tool("mcp__pomegr__list_sessions"), "reading_sessions"], [tool("mcp__pomegr__get_session_report"), "reading_sessions"],
    [tool("mcp__pomegr__list_session_agents"), "reading_sessions"], [tool("mcp__pomegr__get_agent_context"), "reading_sessions"], [tool("mcp__pomegr__get_recent_failures"), "reading_sessions"],
    [tool("mcp__pomegr__get_usage_limits"), "reading_usage"], [tool("mcp__pomegr__get_provider_health"), "reading_usage"],
    [tool("Bash"), "thinking"], [tool("mcp__pomegr__add_task"), "thinking"], [tool("mcp__other__list_sessions"), "reading_sessions"], [tool("WebFetch"), "thinking"],
  ];
  for (const [line, activity] of cases) assert.deepEqual(readClaude([line]).activities, [activity], line);
});

test("a result decides the turn: success gives the answer, an error or another subtype fails it", () => {
  assert.deepEqual(readClaude([delta("partial"), result({ result: "Final" })]).end, { ok: true, text: "Final" });
  assert.deepEqual(readClaude([delta("partial"), result({ is_error: true, result: "API error: private detail" })]).end, { ok: false, text: "partial" });
  for (const subtype of ["error_max_turns", "error_during_execution", "error_max_budget_usd", "unknown"]) {
    assert.deepEqual(readClaude([delta("partial"), result({ subtype })]).end, { ok: false, text: "partial" }, subtype);
  }
  assert.deepEqual(readClaude([delta("partial"), result({ subtype: undefined })]).end, { ok: false, text: "partial" });
  assert.deepEqual(readClaude([delta("partial"), result({ result: 5 })]).end, { ok: false, text: "partial" });
  assert.deepEqual(readClaude([delta("partial"), result({ result: undefined })]).end, { ok: false, text: "partial" });
  // No result at all: not ok, and the partial text stays.
  assert.deepEqual(readClaude([delta("only "), delta("partial")]).end, { ok: false, text: "only partial" });
  assert.deepEqual(readClaude([]).end, { ok: false, text: "" });
});

test("a last line without a newline is read at the end", () => {
  const reader = createTurnReader("claude");
  reader.push(delta("x"));
  reader.push(`\n${result({ result: "Done" })}`);
  assert.deepEqual(reader.end(), { ok: true, text: "Done" });
  assert.deepEqual(reader.end(), { ok: true, text: "Done" }, "ending twice gives the same outcome");
});

test("events of a sub-agent are ignored", () => {
  const sub = { parent_tool_use_id: "toolu_parent" };
  const { texts, activities, end } = readClaude([
    event({ type: "message_start", message: {} }, sub), started({ type: "tool_use", id: "t", name: "Read", input: {} }, 0).replace('"parent_tool_use_id":null', '"parent_tool_use_id":"toolu_parent"'),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "SUB-AGENT TEXT" } }, sub),
    delta("Main"), result({ result: "Main" }),
  ]);
  assert.deepEqual(texts, ["Main"]);
  assert.deepEqual(activities, []);
  assert.deepEqual(end, { ok: true, text: "Main" });
});

test("lines that are not events, and events that are unknown, are ignored", () => {
  const { texts, activities, end } = readClaude([
    "", "   ", "Warning: something on stdout", "{ not json", "[1,2,3]", "null", "\"text\"", "12", "{}", '{"foo":1}', '{"type":5}',
    JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }),
    JSON.stringify({ type: "stream_event", event: "text" }), JSON.stringify({ type: "stream_event", event: { type: "ping" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 5 } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "x" } }),
    event({ type: "content_block_delta", index: 0, delta: null }), event({ type: "content_block_start", index: 0, content_block: null }),
    delta("Kept"), result({ result: "Kept" }),
  ]);
  assert.deepEqual(texts, ["Kept"]);
  assert.deepEqual(activities, []);
  assert.deepEqual(end, { ok: true, text: "Kept" });
});

test("tool input, tool output, thinking, and error text never reach the text or activity callbacks", () => {
  const { texts, activities } = readClaude([...claudeStream(), result({ is_error: true, result: "private error detail" })]);
  for (const value of [...texts, ...activities]) {
    for (const hidden of ["private", "secret", "file_path", "toolu_", "reasoning"]) assert.equal(String(value).includes(hidden), false, `${hidden} in ${value}`);
  }
  for (const activity of activities) assert.ok(ACTIVITIES.includes(activity), activity);
});

test("a line past the 4 MiB bound fails the turn, whatever else arrives", () => {
  const reader = createTurnReader("claude");
  reader.push(delta("Before"));
  reader.push("\n");
  const megabyte = "a".repeat(1024 * 1024);
  for (let index = 0; index < 4; index += 1) reader.push(megabyte);
  // The four megabytes are exactly the bound; one more character without a newline is past it.
  reader.push("a");
  reader.push(`\n${result({ result: "Late answer" })}\n`);
  assert.deepEqual(reader.end(), { ok: false, text: "Before" });
  const exact = createTurnReader("claude");
  exact.push(`${"a".repeat(STDOUT_LINE_LIMIT)}`);
  exact.push(`\n${result({ result: "Fits" })}\n`);
  assert.equal(exact.end().ok, true, "a line of exactly the bound is not past it");
  const over = createTurnReader("claude");
  over.push(delta("Seen"));
  over.push(`\n${"a".repeat(STDOUT_LINE_LIMIT + 1)}`);
  over.push(`\n${result({ result: "Never read" })}\n`);
  const overEnd = over.end();
  assert.equal(overEnd.ok, false);
  assert.equal(overEnd.text.includes("Never read"), false);
});

test("the answer is cut at 32,000 characters, in the streamed text and in the result", () => {
  const big = "x".repeat(40_000);
  const { texts, end } = readClaude([delta(big), delta("more"), result({ result: big })]);
  assert.equal(Math.max(...texts.map((text) => text.length)), ANSWER_LIMIT);
  assert.equal(texts.at(-1).length, ANSWER_LIMIT);
  assert.deepEqual(end, { ok: true, text: "x".repeat(ANSWER_LIMIT) });
  assert.equal(readClaude([delta(big)]).end.text.length, ANSWER_LIMIT);
  assert.equal(readClaude([result({ result: "y".repeat(ANSWER_LIMIT) })]).end.text.length, ANSWER_LIMIT);
});

test("the callbacks are optional", () => {
  const reader = createTurnReader("claude");
  reader.push(`${delta("a")}\n${started({ type: "text", text: "" })}\n${result({ result: "a" })}\n`);
  assert.deepEqual(reader.end(), { ok: true, text: "a" });
  assert.deepEqual(createTurnReader("codex").end(), { ok: false, text: "" });
});

const codexLine = (value) => JSON.stringify(value);
const item = (type, id, fields = {}, kind = "item.completed") => codexLine({ type: kind, item: { id, type, ...fields } });

test("a Codex agent message is the answer and the last one wins", () => {
  const { texts, activities, end } = readClaude([
    codexLine({ type: "thread.started", thread_id: "synthetic-thread" }), codexLine({ type: "turn.started" }),
    item("agent_message", "item_0", { text: "Draft" }), item("agent_message", "item_1", { text: "Final answer" }),
    codexLine({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
  ], Infinity, "codex");
  assert.deepEqual(texts, ["Draft", "Final answer"]);
  assert.deepEqual(end, { ok: true, text: "Final answer" });
  assert.deepEqual(activities, ["thinking", "writing", "writing"]);
  assert.deepEqual(readClaude([item("agent_message", "i", { text: "Streaming" }, "item.updated")], Infinity, "codex").end, { ok: false, text: "Streaming" });
  assert.deepEqual(readClaude([item("agent_message", "i", { text: "Begun" }, "item.started")], Infinity, "codex").end, { ok: false, text: "Begun" });
});

test("Codex reasoning, commands, and tool calls map to the fixed activities and expose nothing else", () => {
  const { texts, activities, end } = readClaude([
    item("reasoning", "r", { text: "private thoughts" }, "item.started"), item("reasoning", "r", { text: "private thoughts" }),
    item("command_execution", "c", { command: "cat private.txt", aggregated_output: "private output", exit_code: 0 }, "item.started"),
    item("command_execution", "c", { command: "cat private.txt", aggregated_output: "private output", exit_code: 0 }),
    item("mcp_tool_call", "m1", { server: "pomegr", tool: "list_sessions", arguments: { secret: "x" } }, "item.started"),
    item("mcp_tool_call", "m2", { server: "pomegr", tool: "get_usage_limits", arguments: {} }, "item.started"),
    item("mcp_tool_call", "m3", { server: "pomegr", tool: "get_provider_health", arguments: {} }, "item.completed"),
    item("mcp_tool_call", "m4", { server: "pomegr", tool: "get_session_report", arguments: {} }, "item.started"),
    item("mcp_tool_call", "m5", { server: "other", tool: "add_task", arguments: {} }, "item.started"),
    item("web_search", "w", { query: "private query" }), item("file_change", "f", { changes: [] }),
    item("agent_message", "a", { text: "Answer" }),
  ], Infinity, "codex");
  assert.deepEqual(activities, [
    "thinking", "thinking", "reading_files", "reading_files", "reading_sessions", "reading_usage", "reading_usage", "reading_sessions", "thinking", "thinking", "thinking", "writing",
  ]);
  assert.deepEqual(texts, ["Answer"]);
  assert.deepEqual(end, { ok: true, text: "Answer" });
});

test("a Codex turn.failed or error event fails the turn, and no agent message is no answer", () => {
  assert.deepEqual(readClaude([item("agent_message", "a", { text: "Answer" }), codexLine({ type: "turn.failed", error: { message: "private detail" } })], Infinity, "codex").end, { ok: false, text: "Answer" });
  assert.deepEqual(readClaude([item("agent_message", "a", { text: "Answer" }), codexLine({ type: "error", message: "private detail" })], Infinity, "codex").end, { ok: false, text: "Answer" });
  assert.deepEqual(readClaude([codexLine({ type: "turn.started" }), codexLine({ type: "turn.completed" })], Infinity, "codex").end, { ok: false, text: "" });
  assert.deepEqual(readClaude([item("agent_message", "a", { text: 5 })], Infinity, "codex").end, { ok: false, text: "" });
  assert.deepEqual(readClaude([codexLine({ type: "item.completed", item: "agent" }), "not json", codexLine({ type: "thread.started" })], Infinity, "codex").end, { ok: false, text: "" });
  // Claude events mean nothing to a Codex reader, and the reverse.
  assert.deepEqual(readClaude([delta("x"), result()], Infinity, "codex").end, { ok: false, text: "" });
  assert.deepEqual(readClaude([item("agent_message", "a", { text: "Answer" })], Infinity, "claude").end, { ok: false, text: "" });
});

// ---- one turn ------------------------------------------------------------------------------------------------

function fakeChild({ killCloses = false } = {}) {
  const child = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { encoding: null, setEncoding(value) { this.encoding = value; } });
  child.stdin = Object.assign(new EventEmitter(), { writes: [], ended: false, end(data, encoding) { this.writes.push([data, encoding]); this.ended = true; } });
  child.kills = 0;
  child.kill = () => { child.kills += 1; if (killCloses) queueMicrotask(() => child.emit("close", null)); return true; };
  return child;
}

function startTurn(overrides = {}, childOptions = {}) {
  const spawns = [];
  const child = fakeChild(childOptions);
  const texts = [];
  const activities = [];
  const options = {
    spawn: (...args) => { spawns.push(args); return child; },
    executable: "C:\\Users\\tester\\.local\\bin\\claude.exe", provider: "claude", model: "claude-opus-4-1", mcpServer: server,
    cwd: "C:\\Work\\repo", env: { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\tester" }, prompt: "SYNTHETIC-PROMPT unique 4711",
    onText: (text) => texts.push(text), onActivity: (activity) => activities.push(activity),
    ...overrides,
  };
  const turn = runChatTurn(options);
  let settled = 0;
  const done = turn.done.then((outcome) => { settled += 1; return outcome; });
  return { turn, done, child, spawns, texts, activities, options, settledCount: () => settled };
}

const sendStream = (child, lines) => child.stdout.emit("data", Buffer.from(`${lines.join("\n")}\n`));

test("the task capability reaches MCP through inherited environment, never provider arguments or stdin", async () => {
  const capability = { POMEGR_CHAT_TASK_ORIGIN: "http://127.0.0.1:12345", POMEGR_CHAT_TASK_KEY: "synthetic-turn-capability" };
  for (const provider of ["claude", "codex"]) {
    const mcpServer = { ...server, env: { ...server.env, ...capability } };
    const { child, spawns, done, options } = startTurn({ provider, mcpServer });
    const [, args, spawnOptions] = spawns[0];
    for (const [name, value] of Object.entries(capability)) {
      assert.equal(spawnOptions.env[name], value);
      assert.equal(JSON.stringify(args).includes(value), false);
      assert.equal(JSON.stringify(child.stdin.writes).includes(value), false);
      assert.equal(Object.hasOwn(options.env, name), false);
    }
    if (provider === "codex") assert.ok(args.includes('mcp_servers.pomegr.env_vars=["POMEGR_CHAT_TASK_ORIGIN", "POMEGR_CHAT_TASK_KEY"]'));
    else assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.pomegr.env, server.env);
    child.emit("close", 1);
    await done;
  }
});

test("a turn starts the provider with the fixed arguments and options and sends the prompt on stdin only", async () => {
  const { child, spawns, options, done } = startTurn();
  assert.equal(spawns.length, 1);
  const [executable, args, spawnOptions] = spawns[0];
  assert.equal(executable, options.executable);
  assert.deepEqual(args, chatArguments("claude", "claude-opus-4-1", server));
  assert.deepEqual(spawnOptions, { cwd: options.cwd, env: options.env, shell: false, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  assert.equal(spawnOptions.env, options.env);
  assert.deepEqual(child.stdin.writes, [[options.prompt, "utf8"]]);
  assert.equal(child.stdin.ended, true);
  assert.equal(child.stdout.encoding, "utf8");
  for (const argument of args) assert.equal(argument.includes("SYNTHETIC-PROMPT"), false);
  assert.equal(JSON.stringify(spawnOptions).includes("SYNTHETIC-PROMPT"), false);
  child.emit("close", 1);
  await done;
});

test("a Codex turn gets the Codex arguments", async () => {
  const { spawns, child, done } = startTurn({ provider: "codex", model: null, mcpServer: null, executable: "C:\\Users\\tester\\.local\\bin\\codex.exe" });
  assert.deepEqual(spawns[0][1], chatArguments("codex", null, null));
  assert.equal(spawns[0][1].at(-1), "-");
  sendStream(child, [item("agent_message", "a", { text: "From Codex" })]);
  child.emit("close", 0);
  assert.deepEqual(await done, { status: "complete", text: "From Codex" });
});

test("a turn is complete on exit 0 with a result, and reports the text and activity as they stream", async () => {
  const { child, done, texts, activities } = startTurn();
  child.stdout.emit("data", Buffer.from(`${claudeStream().slice(0, 9).join("\n")}\n`));
  assert.deepEqual(activities, ["thinking", "reading_files", "writing"]);
  child.stdout.emit("data", `${claudeStream().slice(9).join("\n")}\n`);
  child.emit("close", 0);
  assert.deepEqual(await done, { status: "complete", text: "Hello world" });
  assert.equal(texts.at(-1), "Hello world");
});

test("a turn is failed on a non-zero exit, on a run without a result, on an error result, and on an error event", async () => {
  const exit = startTurn();
  sendStream(exit.child, [delta("Partial"), result({ result: "Complete answer" })]);
  exit.child.emit("close", 2);
  assert.deepEqual(await exit.done, { status: "failed", text: "Complete answer" });

  const silent = startTurn();
  silent.child.emit("close", 0);
  assert.deepEqual(await silent.done, { status: "failed", text: "" });

  const partial = startTurn();
  sendStream(partial.child, [delta("Half an ans")]);
  partial.child.emit("close", 0);
  assert.deepEqual(await partial.done, { status: "failed", text: "Half an ans" });

  const errored = startTurn();
  sendStream(errored.child, [delta("Half"), result({ is_error: true })]);
  errored.child.emit("close", 0);
  assert.deepEqual(await errored.done, { status: "failed", text: "Half" });

  const crashed = startTurn();
  sendStream(crashed.child, [delta("Before the crash")]);
  crashed.child.emit("error", new Error("spawn EPERM C:\\private"));
  assert.deepEqual(await crashed.done, { status: "failed", text: "Before the crash" });

  const signalled = startTurn();
  signalled.child.emit("close", null);
  assert.equal((await signalled.done).status, "failed");
});

test("a spawn that throws is a failed turn, and nothing is left to stop", async () => {
  const { turn, done } = startTurn({ spawn: () => { throw new Error("EACCES C:\\private\\claude.exe"); } });
  assert.deepEqual(await done, { status: "failed", text: "" });
  assert.doesNotThrow(() => turn.stop());
});

test("a turn without an executable, a prompt, or a known provider fails without starting anything", async () => {
  for (const overrides of [
    { executable: undefined }, { executable: 7 }, { prompt: "" }, { prompt: undefined }, { prompt: 42 },
    { provider: "gemini" }, { provider: undefined }, { provider: "CLAUDE" },
  ]) {
    const { turn, done, spawns } = startTurn(overrides);
    assert.deepEqual(await done, { status: "failed", text: "" }, JSON.stringify(overrides));
    assert.equal(spawns.length, 0);
    assert.doesNotThrow(() => turn.stop());
  }
});

test("stop ends the run once and the turn is stopped, even when the answer was complete", async () => {
  const { turn, child, done } = startTurn({}, { killCloses: true });
  sendStream(child, [delta("Partial text")]);
  turn.stop();
  assert.equal(child.kills, 1);
  assert.deepEqual(await done, { status: "stopped", text: "Partial text" });
  turn.stop();
  assert.equal(child.kills, 1, "a finished turn is not killed again");

  const complete = startTurn({}, { killCloses: true });
  sendStream(complete.child, [delta("x"), result({ result: "Whole answer" })]);
  complete.turn.stop();
  assert.deepEqual(await complete.done, { status: "stopped", text: "Whole answer" });
  assert.equal(complete.child.kills, 1);
});

test("a turn that outlasts its time is killed and ends timed_out with the partial text", async () => {
  const { child, done } = startTurn({ timeoutMs: 5 }, { killCloses: true });
  sendStream(child, [delta("Still writing")]);
  assert.deepEqual(await done, { status: "timed_out", text: "Still writing" });
  assert.equal(child.kills, 1);
});

test("a turn that finishes in time clears its timer and is never killed", async () => {
  const { child, done } = startTurn({ timeoutMs: 20 });
  sendStream(child, [delta("x"), result({ result: "Quick" })]);
  child.emit("close", 0);
  assert.equal((await done).status, "complete");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(child.kills, 0);
});

test("a turn resolves exactly once, whatever the child does afterwards", async () => {
  const { child, turn, done, settledCount } = startTurn();
  sendStream(child, [delta("a"), result({ result: "First" })]);
  child.emit("close", 0);
  child.emit("close", 1);
  child.emit("error", new Error("late"));
  turn.stop();
  assert.deepEqual(await done, { status: "complete", text: "First" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settledCount(), 1);
  assert.equal(child.kills, 0);
  const errorFirst = startTurn();
  errorFirst.child.emit("error", new Error("first"));
  errorFirst.child.emit("close", 0);
  assert.equal((await errorFirst.done).status, "failed");
});

test("a closed stdin pipe is reported by the exit, never thrown", async () => {
  const { child, done } = startTurn();
  assert.doesNotThrow(() => child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
  child.emit("close", 1);
  assert.equal((await done).status, "failed");
});

test("a turn works with a child that has no stdout or stdin", async () => {
  const bare = new EventEmitter();
  bare.kill = () => {};
  const { done } = startTurn({ spawn: () => bare });
  bare.emit("close", 0);
  assert.deepEqual(await done, { status: "failed", text: "" });
});
