import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  AGENT_CHAT_CHANNEL,
  AGENT_CHAT_ERRORS,
  AGENT_CHAT_OPERATIONS,
  AGENT_CHAT_REQUEST_MAX_BYTES,
  createAgentChat,
} from "../desktop/runtime/agent-chat.mjs";
import { DESKTOP_AUTH_HEADER } from "../shared/local-auth.mjs";
import {
  agentMessage, chatHarness, claudeExecutable, codexExecutable, desktopExecutable, finishTurn, mcpScript, origin, otherRepositoryId,
  readyBoard, repositoryId, root, seed, send, sourceEnvironment, token, until, userMessage,
} from "./helpers/agent-chat-harness.mjs";

const invalid = { ok: false, error: "invalid" };
const unavailable = { ok: false, error: "unavailable" };
const conversationId = "chat-0123456789ab";
const proposalId = "p-0123456789ab";
const CHAT_ID = /^chat-[0-9a-f]{12}$/u;

const logEntry = (id, extra = {}) => ({ id, task: `T-${id}`, kind: "started", at: id * 1000, pullRequest: null, ...extra });
const logAnswer = (entries, cursor = 0, more = false) => ({ ok: true, log: { entries, cursors: { aril: cursor }, more, latestId: 100 } });
const logCalls = (h, action) => h.calls.filter((call) => call.pathname === `/internal/tasks/log-${action}`);

test("owner turns show only valid unseen log entries and acknowledge the highest shown ID", async (context) => {
  const h = await chatHarness(context);
  const malformed = [null, {}, logEntry(6, { id: 6.5 }), logEntry(6, { task: "T-6\ninjected" }), logEntry(6, { kind: "injected" }),
    logEntry(6, { at: "1000" }), logEntry(6, { at: Number.MAX_SAFE_INTEGER }), logEntry(6, { pullRequest: "42" }), logEntry(6, { pullRequest: undefined })];
  h.state.actions = (action) => action === "log-read" ? logAnswer([logEntry(1), logEntry(2), logEntry(5, { kind: "merged", pullRequest: 42 }), ...malformed, logEntry(3)], 2) : { ok: true };
  const sent = await send(h);
  assert.equal(sent.ok, true);
  const prompt = h.runs[0].options.prompt;
  assert.match(prompt, /<task_log_since_last_turn>\n1970-01-01T00:00:03.000Z T-3 started\n1970-01-01T00:00:05.000Z T-5 merged PR #42\n<\/task_log_since_last_turn>/u);
  assert.doesNotMatch(prompt, /injected/u);
  assert.equal(logCalls(h, "ack").length, 0);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, sent.conversationId);
  assert.deepEqual(logCalls(h, "ack").map((call) => call.body), [{ repositoryId, payload: { consumer: "aril", through: 5 } }]);
});

test("log omission requires both older entries and a gap beyond the cursor", async (context) => {
  for (const [cursor, more, omitted] of [[0, true, true], [3, true, false], [0, false, false], [5, true, false]]) {
    const h = await chatHarness(context);
    h.state.actions = () => logAnswer([logEntry(4), logEntry(5)], cursor, more);
    assert.equal((await send(h)).ok, true);
    assert.equal(h.runs[0].options.prompt.includes("(Older entries are left out.)"), omitted);
  }
});

test("failed, refused, and malformed log reads leave the turn available", async (context) => {
  const answers = [null, { ok: false }, { ok: true }, { ...logAnswer([]), ok: "true" },
    { ok: true, log: { entries: null, cursors: { aril: 0 }, more: false } },
    ...[-1, 0.5, "0"].map((cursor) => logAnswer([], cursor)),
    { ok: true, log: { entries: [], cursors: {}, more: false } }, logAnswer([], 0, "false"), new Error("read failed")];
  for (const answer of answers) {
    const h = await chatHarness(context);
    h.state.actions = () => { if (answer instanceof Error) throw answer; return answer; };
    const sent = await send(h);
    assert.equal(sent.ok, true);
    assert.match(h.runs[0].options.prompt, /\(The task log is unavailable\.\)/u);
    await finishTurn(h, h.runs[0], { status: "complete", text: "Answer." }, sent.conversationId);
    assert.equal(logCalls(h, "ack").length, 0);
  }
});

test("failed, stopped, and timed-out turns never acknowledge the log", async (context) => {
  for (const status of ["failed", "stopped", "timed_out"]) {
    const h = await chatHarness(context);
    h.state.actions = () => logAnswer([logEntry(1)]);
    const sent = await send(h);
    await finishTurn(h, h.runs[0], { status, text: "Partial." }, sent.conversationId);
    assert.equal(logCalls(h, "ack").length, 0, status);
  }
});

test("log reads start beside the existing reads and use their timeout", async (context) => {
  const h = await chatHarness(context, { timeoutMs: 25 });
  let releaseBoard;
  h.state.gate = new Promise((resolve) => { releaseBoard = resolve; });
  h.state.actions = async (_action, _payload, _body, call) => new Promise((_resolve, reject) => {
    call.init.signal.addEventListener("abort", () => reject(call.init.signal.reason), { once: true });
  });
  const sending = send(h);
  await until(() => logCalls(h, "read").length === 1);
  assert.equal(h.calls.length, 4, "all reads start while the board is pending");
  releaseBoard();
  assert.equal((await sending).ok, true);
  assert.match(h.runs[0].options.prompt, /\(The task log is unavailable\.\)/u);
});

test("an acknowledgement failure or pending request cannot delay saving the answer", async (context) => {
  for (const ack of [() => { throw new Error("ack failed"); }, () => ({ ok: false }), () => new Promise(() => {})]) {
    const h = await chatHarness(context);
    h.state.actions = (action) => action === "log-read" ? logAnswer([logEntry(1)]) : ack();
    const sent = await send(h);
    const saved = await finishTurn(h, h.runs[0], { status: "complete", text: "Answer." }, sent.conversationId);
    assert.equal(saved.messages.at(-1).status, "complete");
    assert.equal(logCalls(h, "ack").length, 1);
  }
});

test("a follow-up neither reads nor acknowledges the log", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: [userMessage(1), agentMessage(2, { proposal: {
    id: proposalId, summary: "Change", state: "pending", operations: [{ op: "update_task", id: "T-1", text: "Updated" }],
  } })] });
  assert.deepEqual(await h.handle("dismiss", { repositoryId, conversationId: conversation.id, proposalId }), { ok: true });
  const run = await h.followUp();
  assert.doesNotMatch(run.options.prompt, /<task_log_since_last_turn>/u);
  await h.finishFollowUp(conversation.id);
  assert.equal(logCalls(h, "read").length, 0);
  assert.equal(logCalls(h, "ack").length, 0);
});

test("the channel, operations, errors, and request bound are fixed", () => {
  assert.equal(AGENT_CHAT_CHANNEL, "pomegr:agent-chat");
  assert.deepEqual([...AGENT_CHAT_OPERATIONS], ["list", "read", "send", "stop", "apply", "dismiss", "delete"]);
  assert.deepEqual([...AGENT_CHAT_ERRORS], ["invalid", "not_found", "busy", "limit", "cli_missing", "conflict", "unavailable", "desktop_only"]);
  assert.equal(AGENT_CHAT_REQUEST_MAX_BYTES, 17 * 1024);
});

const goodPayloads = {
  list: { repositoryId },
  read: { repositoryId, conversationId },
  stop: { repositoryId, conversationId },
  delete: { repositoryId, conversationId },
  apply: { repositoryId, conversationId, proposalId },
  dismiss: { repositoryId, conversationId, proposalId },
  send: { repositoryId, conversationId: null, text: "Hello", provider: "claude", model: null },
};

const badValues = {
  repositoryId: ["repo-short", "repo-0123456789ABCDEF01234567", "../x", `${repositoryId}/..`, "C:\\Work", 7, null, undefined, ""],
  conversationId: ["chat-short", "chat-0123456789AB", "../x", "..\\x", 7, undefined, ""],
  proposalId: ["p-short", "p-0123456789AB", "../x", 7, null, undefined, ""],
  text: ["", "   \n\t ", "x".repeat(4001), "a\u0000b", "a\u001bb", "a\u0085b", "a\u007fb", 5, null, undefined, ["a"]],
  provider: ["gemini", "Claude", "", null, undefined, 5],
  model: ["../x", "a b", "-x", "--help", "", 7, undefined, "m".repeat(121)],
};

test("a request outside its operation's shape is refused as invalid before anything is sent", async (context) => {
  const h = await chatHarness(context);
  for (const [operation, good] of Object.entries(goodPayloads)) {
    const refuse = async (payload, rule) => assert.deepEqual(await h.handle(operation, payload), invalid, `${operation}: ${rule}`);
    await refuse({ ...good, extra: 1 }, "an extra key");
    await refuse({ ...good, path: "C:\\private" }, "a path key");
    for (const key of Object.keys(good)) {
      const { [key]: _removed, ...rest } = good;
      await refuse(rest, `${key} missing`);
      for (const bad of badValues[key]) await refuse({ ...good, [key]: bad }, `${key} = ${JSON.stringify(bad)}`);
    }
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.runs.length, 0);
});

test("an unknown operation or a payload that is not a plain object is invalid", async (context) => {
  const h = await chatHarness(context);
  for (const operation of ["erase", "", " list", "LIST", "constructor", "__proto__", "toString", "hasOwnProperty", "handle", undefined, null, 5, ["list"], {}]) {
    assert.deepEqual(await h.handle(operation, goodPayloads.list), invalid, String(operation));
  }
  const cyclic = { repositoryId };
  cyclic.self = cyclic;
  class Holder { repositoryId = repositoryId; }
  for (const payload of [undefined, null, "list", 5, true, [], [goodPayloads.list], new Map(), new Holder(), () => {}, cyclic, { repositoryId, big: 1n }]) {
    assert.deepEqual(await h.handle("list", payload), invalid, String(payload));
  }
  assert.equal(h.calls.length, 0);
});

test("a payload over 17 KiB of JSON is refused, even before its shape is read", async (context) => {
  const h = await chatHarness(context);
  const padded = (size) => ({ ...goodPayloads.send, text: "x".repeat(size) });
  assert.deepEqual(await h.handle("send", padded(17 * 1024)), invalid);
  assert.deepEqual(await h.handle("list", { repositoryId, pad: "x".repeat(17 * 1024) }), invalid);
  assert.equal(h.calls.length, 0);
  // 4,000 three-byte characters are 12,000 bytes: within both the message bound and the byte bound.
  assert.equal((await h.handle("send", { ...goodPayloads.send, text: "€".repeat(4000) })).ok, true);
});

test("a request that is valid in shape is unavailable without a monitor origin, a token, or a place to keep conversations, and after dispose", async (context) => {
  const cases = [
    ["no origin", { monitorOrigin: undefined }], ["no token", { authorizationToken: undefined }], ["an empty token", { authorizationToken: "" }],
    ["no store", { store: undefined }], ["a relative data root", { store: undefined, dataRoot: "relative\\data" }],
    ["an https origin", { monitorOrigin: "https://example.test" }], ["a LAN origin", { monitorOrigin: "http://192.168.1.5:4317" }],
    ["a named host", { monitorOrigin: "http://localhost:4317" }], ["an origin with a path", { monitorOrigin: "http://127.0.0.1:4317/internal" }],
    ["an origin with credentials", { monitorOrigin: "http://user:secret@127.0.0.1:4317" }], ["an origin with a query", { monitorOrigin: "http://127.0.0.1:4317/?x=1" }],
    ["an origin with a fragment", { monitorOrigin: "http://127.0.0.1:4317/#x" }], ["another scheme", { monitorOrigin: "ftp://127.0.0.1:4317" }],
    ["text for an origin", { monitorOrigin: "not a url" }], ["a number for an origin", { monitorOrigin: 4317 }],
  ];
  for (const [rule, overrides] of cases) {
    const h = await chatHarness(context, overrides);
    for (const [operation, payload] of Object.entries(goodPayloads)) assert.deepEqual(await h.handle(operation, payload), unavailable, `${rule}: ${operation}`);
    assert.equal(h.calls.length, 0, rule);
    assert.equal(h.runs.length, 0, rule);
  }
  const h = await chatHarness(context);
  h.chat.dispose();
  for (const [operation, payload] of Object.entries(goodPayloads)) assert.deepEqual(await h.handle(operation, payload), unavailable, `disposed: ${operation}`);
  assert.deepEqual(await h.handle("erase", {}), invalid, "a bad request is still invalid after dispose");
  assert.equal(h.calls.length, 0);
});

test("send reads the board, the root, and the observed runs with the desktop header, stores the owner's message, and starts the turn", async (context) => {
  const h = await chatHarness(context, { turnTimeoutMs: 4321 });
  h.state.agents = { runs: [{ source: "Claude Code", model: "claude-opus-5-5", prompt: "private run text" }, { source: "Codex", model: "gpt-9" }] };
  const answer = await send(h, { text: "  Plan the next sprint\nsecond line  ", model: "claude-opus-4-1" });
  assert.equal(answer.ok, true);
  assert.deepEqual(Object.keys(answer), ["ok", "conversationId"]);
  assert.match(answer.conversationId, CHAT_ID);

  assert.equal(h.calls.length, 4);
  const [board, rootCall, agents] = h.calls;
  assert.equal(agents.url, `${origin}/api/agents?project=all&days=90&scope=all`);
  assert.equal(agents.init.method, "GET");
  assert.equal(board.url, `${origin}/api/tasks?repositoryId=${repositoryId}`);
  assert.equal(board.init.method, "GET");
  assert.equal(rootCall.url, `${origin}/internal/tasks/worktree-root`);
  assert.equal(rootCall.init.method, "POST");
  assert.deepEqual(rootCall.body, { repositoryId, payload: {} });
  assert.equal(rootCall.init.headers["content-type"], "application/json");
  assert.deepEqual(h.calls[3].body, { repositoryId, payload: { limit: 100 } });
  assert.equal(h.calls[3].pathname, "/internal/tasks/log-read");
  for (const call of h.calls) {
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.cache, "no-store");
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(call.init.headers[DESKTOP_AUTH_HEADER], token);
  }

  assert.equal(h.runs.length, 1);
  const [run] = h.runs;
  const stored = Object.entries(run.diskAtStart);
  assert.equal(stored.length, 1, "the conversation file exists when the turn starts");
  assert.deepEqual(stored[0][1].conversation.messages.map((message) => [message.id, message.role, message.text]), [["m-1", "user", "Plan the next sprint\nsecond line"]]);
  assert.equal(stored[0][0], `${repositoryId}/${answer.conversationId}.json`);
  assert.equal(stored[0][1].conversation.title, "Plan the next sprint");
  assert.equal(stored[0][1].conversation.model, "claude-opus-4-1");

  const { options } = run;
  assert.equal(options.executable, claudeExecutable);
  assert.equal(options.provider, "claude");
  assert.equal(options.model, "claude-opus-4-1");
  assert.deepEqual({ ...options.mcpServer, env: { ELECTRON_RUN_AS_NODE: options.mcpServer.env.ELECTRON_RUN_AS_NODE } }, { command: desktopExecutable, args: [mcpScript], env: { ELECTRON_RUN_AS_NODE: "1" } });
  assert.match(options.mcpServer.env.POMEGR_CHAT_TASK_ORIGIN, /^http:\/\/127\.0\.0\.1:[0-9]+$/u);
  assert.match(options.mcpServer.env.POMEGR_CHAT_TASK_KEY, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(options.cwd, root);
  assert.equal(options.timeoutMs, 4321);
  assert.equal(options.spawn, h.spawn);
  assert.equal(typeof options.onText, "function");
  assert.equal(typeof options.onActivity, "function");
  assert.match(options.prompt, /<owner_message>\nPlan the next sprint\nsecond line\n<\/owner_message>$/u);
  assert.match(options.prompt, /<conversation>\n\(This is the first message\.\)\n<\/conversation>/u);
  assert.ok(options.prompt.includes("Existing task one"), "the board is in the prompt");
  assert.ok(options.prompt.includes('"repository":"private-repo"'));
  assert.ok(options.prompt.includes('"claude":["claude-opus-5-5"'), "the form's Claude models are in the snapshot");
  assert.equal(options.prompt.includes("private run text"), false, "only the model of a run reaches the prompt");
});

test("the turn gets the owner's session environment without the app's own tokens and runtime variables", async (context) => {
  const h = await chatHarness(context);
  await send(h);
  const { env, prompt, mcpServer } = h.runs[0].options;
  assert.deepEqual(env, {
    USERPROFILE: sourceEnvironment.USERPROFILE, PATH: sourceEnvironment.PATH, HTTPS_PROXY: sourceEnvironment.HTTPS_PROXY,
    POMEGR_CLAUDE_EXECUTABLE: claudeExecutable, POMEGR_CODEX_EXECUTABLE: codexExecutable,
  });
  assert.notEqual(env, sourceEnvironment);
  for (const name of Object.keys(env)) assert.doesNotMatch(name, /^(?:ELECTRON_|POMEGR_SMOKE_|POMEGR_START_)|TOKEN|POMEGR_MONITOR_ORIGIN/u, name);
  const sensitive = [token, sourceEnvironment.POMEGR_MONITOR_TOKEN, sourceEnvironment.POMEGR_TASK_TOKEN, root, root.replaceAll("\\", "\\\\")];
  for (const value of sensitive) {
    assert.equal(prompt.includes(value), false, `the prompt holds ${value}`);
    assert.equal(JSON.stringify(env).includes(value), false, `the environment holds ${value}`);
    assert.equal(JSON.stringify(mcpServer).includes(value), false, `the MCP server holds ${value}`);
  }
});

test("a Codex message runs the Codex executable, and the executable is found like the rest of the app finds it", async (context) => {
  const codex = await chatHarness(context);
  assert.equal((await send(codex, { provider: "codex", model: "gpt-6-sol" })).ok, true);
  assert.equal(codex.runs[0].options.executable, codexExecutable);
  assert.equal(codex.runs[0].options.provider, "codex");
  assert.equal(codex.runs[0].options.model, "gpt-6-sol");

  const home = "C:\\Users\\tester";
  const found = [path.join(home, ".local", "bin", "claude.exe"), path.join(home, ".local", "bin", "codex.exe")];
  const discovered = await chatHarness(context, { environment: { USERPROFILE: home, PATH: "C:\\Windows" }, files: found });
  assert.equal((await send(discovered)).ok, true);
  assert.equal(discovered.runs[0].options.executable, found[0]);
  assert.equal((await send(discovered, { provider: "codex" })).error, "busy");

  const mcpMissing = await chatHarness(context, { files: [claudeExecutable] });
  assert.equal((await send(mcpMissing)).ok, true);
  assert.equal(mcpMissing.runs[0].options.mcpServer, null, "without the bundled server the turn runs with no MCP server");
});

test("a provider whose executable is missing or not safe answers cli_missing and stores and requests nothing", async (context) => {
  const cases = [
    ["Claude is not installed", { files: [codexExecutable, mcpScript] }, "claude"],
    ["Codex is not installed", { files: [claudeExecutable, mcpScript] }, "codex"],
    ["a configured Claude path with another name", { environment: { ...sourceEnvironment, POMEGR_CLAUDE_EXECUTABLE: "C:\\Tools\\evil.exe" }, files: ["C:\\Tools\\evil.exe"] }, "claude"],
    ["a relative configured Claude path", { environment: { ...sourceEnvironment, POMEGR_CLAUDE_EXECUTABLE: "claude.exe" }, files: ["claude.exe"] }, "claude"],
    ["a configured Codex path in WindowsApps", { environment: { ...sourceEnvironment, POMEGR_CODEX_EXECUTABLE: "C:\\Program Files\\WindowsApps\\OpenAI\\codex.exe" }, files: ["C:\\Program Files\\WindowsApps\\OpenAI\\codex.exe"] }, "codex"],
    ["no profile and no path", { environment: {}, files: [claudeExecutable] }, "claude"],
  ];
  for (const [rule, overrides, provider] of cases) {
    const h = await chatHarness(context, overrides);
    assert.deepEqual(await send(h, { provider }), { ok: false, error: "cli_missing" }, rule);
    assert.equal(h.calls.length, 0, rule);
    assert.equal(h.runs.length, 0, rule);
    assert.deepEqual(await h.reload().list(repositoryId), [], rule);
    // The refusal frees the app for the next message.
    const other = provider === "claude" ? "codex" : "claude";
    if (overrides.files.includes(other === "claude" ? claudeExecutable : codexExecutable)) assert.equal((await send(h, { provider: other })).ok, true, `${rule}: the next send is not busy`);
  }
});

test("a board that is not ready, or a root that is missing, is unavailable, stores nothing, and frees the app for the next message", async (context) => {
  const cases = [
    ["a board that is loading", (state) => { state.board = { ...readyBoard(), readiness: "loading" }; }],
    ["a board without readiness", (state) => { const { readiness: _readiness, ...rest } = readyBoard(); state.board = rest; }],
    ["a board of another repository", (state) => { state.board = { ...readyBoard(), repositoryId: otherRepositoryId }; }],
    ["a board that is a string", (state) => { state.board = "ready"; }],
    ["a board that is a list", (state) => { state.board = [readyBoard()]; }],
    ["a root that is refused", (state) => { state.rootAnswer = { ok: false, error: "not_found" }; }],
    ["a root answer without ok", (state) => { state.rootAnswer = { root }; }],
    ["a relative root", (state) => { state.rootAnswer = { ok: true, root: "relative\\dir" }; }],
    ["a root with a quote", (state) => { state.rootAnswer = { ok: true, root: 'C:\\Work\\"quoted"' }; }],
    ["a root with a newline", (state) => { state.rootAnswer = { ok: true, root: "C:\\Work\nx" }; }],
    ["a root that is a number", (state) => { state.rootAnswer = { ok: true, root: 5 }; }],
    ["a monitor that is down", (state) => { state.fetchError = new TypeError("fetch failed: C:\\private"); }],
  ];
  for (const [rule, change] of cases) {
    const h = await chatHarness(context);
    change(h.state);
    assert.deepEqual(await send(h), unavailable, rule);
    assert.equal(h.runs.length, 0, rule);
    assert.deepEqual(await h.reload().list(repositoryId), [], rule);
    assert.deepEqual(await h.store.list(repositoryId), [], `${rule}: no conversation is kept in memory either`);
    Object.assign(h.state, { board: readyBoard(), rootAnswer: { ok: true, root }, fetchError: null });
    assert.equal((await send(h)).ok, true, `${rule}: the next send is not busy`);
  }
});

test("a prompt past its limit is refused as invalid and stores nothing", async (context) => {
  const h = await chatHarness(context);
  h.state.board.tasks = Array.from({ length: 1500 }, (_, index) => ({ id: `T-${index + 1}`, text: "t", columnId: "col-a", state: "queued" }));
  assert.deepEqual(await send(h), invalid);
  assert.equal(h.runs.length, 0);
  assert.deepEqual(await h.reload().list(repositoryId), []);
});

test("a second send is busy while a turn runs, in any conversation or repository, and also while the first is still preparing", async (context) => {
  const h = await chatHarness(context);
  let release;
  h.state.gate = new Promise((resolve) => { release = resolve; });
  const first = send(h);
  assert.deepEqual(await send(h, { text: "While preparing" }), { ok: false, error: "busy" });
  assert.deepEqual(await send(h, { repositoryId: otherRepositoryId }), { ok: false, error: "busy" });
  release();
  const { conversationId: running } = await first;
  assert.match(running, CHAT_ID);
  assert.deepEqual(await send(h, { text: "While running" }), { ok: false, error: "busy" });
  assert.deepEqual(await send(h, { conversationId: running }), { ok: false, error: "busy" });
  assert.deepEqual(await send(h, { repositoryId: otherRepositoryId, provider: "codex" }), { ok: false, error: "busy" });
  assert.equal(h.runs.length, 1);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, running);
  assert.equal((await send(h, { conversationId: running })).ok, true, "the app is free again once the answer is stored");
});

test("a conversation that does not exist is not_found before any request, and a failed send leaves the app free", async (context) => {
  const h = await chatHarness(context);
  assert.deepEqual(await send(h, { conversationId }), { ok: false, error: "not_found" });
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await send(h, { conversationId: "chat-ffffffffffff", repositoryId: otherRepositoryId }), { ok: false, error: "not_found" });
  assert.equal((await send(h)).ok, true);
});

test("fifty conversations and two hundred messages are the limits", async (context) => {
  const crowded = await chatHarness(context);
  for (let index = 0; index < 50; index += 1) assert.ok(await crowded.store.create(repositoryId, { provider: "claude", model: null, title: `Chat ${index}` }));
  assert.deepEqual(await send(crowded), { ok: false, error: "limit" });
  assert.equal(crowded.runs.length, 0);
  crowded.state.board = { ...readyBoard(), repositoryId: otherRepositoryId };
  assert.equal((await send(crowded, { repositoryId: otherRepositoryId })).ok, true, "another repository has its own fifty");

  const messages = (count) => Array.from({ length: count }, (_, index) => (index % 2 === 0 ? userMessage(index + 1) : agentMessage(index + 1)));
  const full = await chatHarness(context);
  const long = await seed(full, { messages: messages(199) });
  assert.deepEqual(await send(full, { conversationId: long.id }), { ok: false, error: "limit" });
  assert.equal(full.calls.length, 0, "the limit is read before the monitor is asked");
  const last = await seed(full, { messages: messages(198) });
  assert.equal((await send(full, { conversationId: last.id })).ok, true);
  const conversation = await finishTurn(full, full.runs[0], { status: "complete", text: "Two hundredth." }, last.id);
  assert.equal(conversation.messages.length, 200);
  assert.deepEqual(await send(full, { conversationId: last.id }), { ok: false, error: "limit" });
});

test("a later message joins its conversation, keeps its title, takes the new provider and model, and sends the earlier messages", async (context) => {
  const h = await chatHarness(context);
  const seeded = await seed(h, { title: "Earlier title", messages: [userMessage(1, "First question"), agentMessage(2, { text: "First answer" })] });
  const answer = await send(h, { conversationId: seeded.id, text: "Second question", provider: "codex", model: "gpt-6-sol" });
  assert.deepEqual(answer, { ok: true, conversationId: seeded.id });
  const { options } = h.runs[0];
  assert.equal(options.provider, "codex");
  assert.equal(options.executable, codexExecutable);
  assert.match(options.prompt, /<conversation>\nOwner: First question\nAril: First answer\n<\/conversation>/u);
  assert.match(options.prompt, /<owner_message>\nSecond question\n<\/owner_message>$/u);
  const stored = await h.reload().read(repositoryId, seeded.id);
  assert.equal(stored.title, "Earlier title");
  assert.equal(stored.provider, "codex");
  assert.equal(stored.model, "gpt-6-sol");
  assert.deepEqual(stored.messages.map((message) => [message.id, message.role]), [["m-1", "user"], ["m-2", "agent"], ["m-3", "user"]]);
  assert.equal(stored.messages[2].text, "Second question");
});

test("a message is titled from its first non-empty line, cut to 80 characters", async (context) => {
  const h = await chatHarness(context);
  const { conversationId: first } = await send(h, { text: `\n\n  ${"w".repeat(120)}\nsecond line` });
  assert.equal((await h.store.read(repositoryId, first)).title, `${"w".repeat(79)}…`);
});

test("the conversation file is kept under the data root when the controller is given one", async (context) => {
  const h = await chatHarness(context, { viaDataRoot: true });
  const { conversationId: id } = await send(h);
  const file = path.join(h.dataRoot, "agent-chat-v1", repositoryId, `${id}.json`);
  assert.equal(JSON.parse(await readFile(file, "utf8")).conversation.id, id);
  assert.deepEqual(Object.keys(h.runs[0].diskAtStart), [`${repositoryId}/${id}.json`]);
});

test("read answers the running turn's fixed activity and the visible text, with a begun proposal block hidden", async (context) => {
  const h = await chatHarness(context);
  const { conversationId: id } = await send(h);
  const [run] = h.runs;
  const first = await h.handle("read", { repositoryId, conversationId: id });
  assert.equal(first.ok, true);
  assert.deepEqual(Object.keys(first.turn).sort(), ["activity", "conversationId", "model", "provider", "startedAt", "text"]);
  assert.deepEqual({ ...first.turn, startedAt: "" }, { conversationId: id, startedAt: "", provider: "claude", model: null, activity: "starting", text: "" });
  assert.ok(Number.isFinite(Date.parse(first.turn.startedAt)));
  assert.deepEqual(first.conversation.messages.map((message) => message.role), ["user"], "no interrupted answer is made up while the turn runs");

  run.options.onActivity("reading_files");
  run.options.onText("Looking at it.\n\n```pomegr-board\n{\"summary\":\"x\",\"oper");
  const second = await h.handle("read", { repositoryId, conversationId: id });
  assert.equal(second.turn.activity, "reading_files");
  assert.equal(second.turn.text, "Looking at it.");
  run.options.onActivity("writing");
  run.options.onText("Plain streamed text");
  assert.deepEqual((await h.handle("read", { repositoryId, conversationId: id })).turn.text, "Plain streamed text");
  assert.equal((await h.handle("read", { repositoryId: otherRepositoryId, conversationId: id })).error, "not_found");
});

test("a complete turn stores the answer with its proposal pending and the block stripped from the text", async (context) => {
  const h = await chatHarness(context);
  const { conversationId: id } = await send(h);
  const block = { summary: "Queue the second task", operations: [{ op: "queue_task", id: "T-2" }] };
  const text = `I suggest queuing T-2.\n\n\`\`\`pomegr-board\n${JSON.stringify(block)}\n\`\`\``;
  const conversation = await finishTurn(h, h.runs[0], { status: "complete", text }, id);
  assert.equal(conversation.messages.length, 2);
  const { proposal, ...message } = conversation.messages[1];
  assert.deepEqual({ ...message, at: "" }, { id: "m-2", role: "agent", text: "I suggest queuing T-2.", at: "", provider: "claude", model: null, status: "complete" });
  assert.match(proposal.id, /^p-[0-9a-f]{12}$/u);
  assert.deepEqual({ ...proposal, id: "" }, { id: "", summary: "Queue the second task", operations: [{ op: "queue_task", id: "T-2" }], state: "pending" });
  assert.equal(Object.hasOwn(message, "proposalUnreadable"), false);
  assert.deepEqual((await h.reload().read(repositoryId, id)).messages[1].proposal, proposal);
  const read = await h.handle("read", { repositoryId, conversationId: id });
  assert.equal(read.turn, null);
  assert.equal(h.actionCalls().length, 0, "nothing is changed on the board by an answer");
});

test("a stopped, failed, or timed-out turn stores its partial text and never a proposal", async (context) => {
  const block = `\`\`\`pomegr-board\n${JSON.stringify({ summary: "Delete it", operations: [{ op: "delete_task", id: "T-1" }] })}\n\`\`\``;
  for (const status of ["stopped", "failed", "timed_out"]) {
    const h = await chatHarness(context);
    const { conversationId: id } = await send(h);
    const conversation = await finishTurn(h, h.runs[0], { status, text: `Partial answer\n\n${block}` }, id);
    const message = conversation.messages[1];
    assert.equal(message.status, status);
    assert.equal(message.text, "Partial answer");
    assert.equal(Object.hasOwn(message, "proposal"), false, status);
    assert.equal(Object.hasOwn(message, "proposalUnreadable"), false, status);
  }
});

test("an outcome that is unknown, missing, or rejected is stored as a failed turn", async (context) => {
  for (const settle of [
    (run) => run.resolve({ status: "weird", text: "Some text" }), (run) => run.resolve(undefined), (run) => run.resolve(null), (run) => run.reject(new Error("C:\\private\\boom")),
  ]) {
    const h = await chatHarness(context);
    const { conversationId: id } = await send(h);
    settle(h.runs[0]);
    await until(async () => (await h.handle("read", { repositoryId, conversationId: id })).turn === null);
    const message = (await h.reload().read(repositoryId, id)).messages[1];
    assert.equal(message.status, "failed");
    assert.equal(message.role, "agent");
    assert.equal(message.text.includes("private"), false);
  }
  const h = await chatHarness(context);
  const { conversationId: id } = await send(h);
  const conversation = await finishTurn(h, h.runs[0], { status: "complete", text: 42 }, id);
  assert.deepEqual([conversation.messages[1].status, conversation.messages[1].text], ["complete", ""]);
});

test("a proposal block that cannot be read sets proposalUnreadable, and its text is not shown", async (context) => {
  const cases = [
    "Plan.\n\n```pomegr-board\n{not json\n```", "Plan.\n\n```pomegr-board\n{\"summary\":\"x\",\"operations\":[]}\n```",
    "Plan.\n\n```pomegr-board\n{\"summary\":\"x\",\"operations\":[{\"op\":\"delete_task\",\"id\":\"T-1\"}]", `Plan.\n\n\`\`\`pomegr-board\n{}\n\`\`\`\n\n\`\`\`pomegr-board\n{}\n\`\`\``,
  ];
  for (const text of cases) {
    const h = await chatHarness(context);
    const { conversationId: id } = await send(h);
    const message = (await finishTurn(h, h.runs[0], { status: "complete", text }, id)).messages[1];
    assert.equal(message.proposalUnreadable, true, text);
    assert.equal(Object.hasOwn(message, "proposal"), false);
    assert.equal(message.text, "Plan.");
    assert.equal(message.status, "complete");
  }
});

test("a conversation that ends on the owner's message with no turn behind it is repaired once with an interrupted answer", async (context) => {
  const h = await chatHarness(context);
  const lost = await seed(h, { provider: "codex", model: "gpt-6-sol", messages: [userMessage(1, "Question whose answer was lost")] });
  const first = await h.handle("read", { repositoryId, conversationId: lost.id });
  assert.equal(first.turn, null);
  assert.equal(first.conversation.messages.length, 2);
  const { at, ...agent } = first.conversation.messages[1];
  assert.deepEqual(agent, { id: "m-2", role: "agent", text: "", provider: "codex", model: "gpt-6-sol", status: "interrupted" });
  assert.ok(Number.isFinite(Date.parse(at)));
  assert.notEqual(first.conversation.updatedAt, lost.updatedAt);
  const second = await h.handle("read", { repositoryId, conversationId: lost.id });
  assert.equal(second.conversation.messages.length, 2, "repaired once");
  assert.deepEqual((await h.reload().read(repositoryId, lost.id)).messages.map((message) => message.status ?? "user"), ["user", "interrupted"]);

  // A fresh controller on the same directory, as after the app was closed mid-turn, repairs the same way.
  const prior = await chatHarness(context, { viaDataRoot: true });
  const started = await send(prior);
  const relaunched = createAgentChat({ fetch: async () => { throw new Error("unused"); }, monitorOrigin: origin, authorizationToken: token, dataRoot: prior.dataRoot });
  const view = await relaunched.handle("read", { repositoryId, conversationId: started.conversationId });
  assert.deepEqual(view.conversation.messages.map((message) => message.role), ["user", "agent"]);
  assert.equal(view.conversation.messages[1].status, "interrupted");
  assert.equal(view.turn, null);
  relaunched.dispose();
});

test("an answer ending in an agent message is left as it is", async (context) => {
  const h = await chatHarness(context);
  const done = await seed(h, { messages: [userMessage(1), agentMessage(2, { status: "failed", text: "" })] });
  const view = await h.handle("read", { repositoryId, conversationId: done.id });
  assert.equal(view.conversation.messages.length, 2);
  assert.deepEqual(await h.handle("read", { repositoryId, conversationId: "chat-ffffffffffff" }), { ok: false, error: "not_found" });
});

test("stop calls the running turn's stop, and answers not_found when nothing runs there", async (context) => {
  const h = await chatHarness(context);
  const idle = await seed(h, { messages: [userMessage(1), agentMessage(2)] });
  assert.deepEqual(await h.handle("stop", { repositoryId, conversationId: idle.id }), { ok: false, error: "not_found" });
  let release;
  h.state.gate = new Promise((resolve) => { release = resolve; });
  const preparing = send(h, { conversationId: idle.id });
  assert.deepEqual(await h.handle("stop", { repositoryId, conversationId: idle.id }), { ok: false, error: "not_found" }, "a turn that has not started has nothing to stop");
  release();
  await preparing;
  const [run] = h.runs;
  assert.deepEqual(await h.handle("stop", { repositoryId: otherRepositoryId, conversationId: idle.id }), { ok: false, error: "not_found" });
  assert.deepEqual(await h.handle("stop", { repositoryId, conversationId: "chat-ffffffffffff" }), { ok: false, error: "not_found" });
  assert.equal(run.stops, 0);
  assert.deepEqual(await h.handle("stop", { repositoryId, conversationId: idle.id }), { ok: true });
  assert.equal(run.stops, 1);
  await finishTurn(h, run, { status: "stopped", text: "Cut short" }, idle.id);
  assert.deepEqual(await h.handle("stop", { repositoryId, conversationId: idle.id }), { ok: false, error: "not_found" });
  assert.equal(run.stops, 1);
});

test("delete is busy while that conversation runs, and removes it otherwise", async (context) => {
  const h = await chatHarness(context);
  const running = await seed(h, { title: "Running", messages: [userMessage(1), agentMessage(2)] });
  const other = await seed(h, { title: "Other", messages: [userMessage(1), agentMessage(2)] });
  await send(h, { conversationId: running.id });
  assert.deepEqual(await h.handle("delete", { repositoryId, conversationId: running.id }), { ok: false, error: "busy" });
  assert.deepEqual(await h.handle("delete", { repositoryId, conversationId: other.id }), { ok: true });
  assert.equal(await h.reload().read(repositoryId, other.id), null);
  assert.deepEqual(await h.handle("delete", { repositoryId, conversationId: other.id }), { ok: false, error: "not_found" });
  assert.deepEqual(await h.handle("read", { repositoryId, conversationId: other.id }), { ok: false, error: "not_found" });
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done" }, running.id);
  assert.deepEqual(await h.handle("delete", { repositoryId, conversationId: running.id }), { ok: true });
  assert.deepEqual((await h.handle("list", { repositoryId })).conversations, []);
});

test("list answers the summaries newest first and the conversation that is running", async (context) => {
  const h = await chatHarness(context);
  assert.deepEqual(await h.handle("list", { repositoryId }), { ok: true, conversations: [], running: null });
  const older = await seed(h, { title: "Older", messages: [userMessage(1), agentMessage(2)] });
  const newer = await seed(h, { title: "Newer", messages: [userMessage(1), agentMessage(2), userMessage(3), agentMessage(4)] });
  const listed = await h.handle("list", { repositoryId });
  assert.equal(listed.running, null);
  assert.deepEqual(listed.conversations.map((summary) => [summary.id, summary.title, summary.messages]), [[newer.id, "Newer", 4], [older.id, "Older", 2]]);
  assert.deepEqual(Object.keys(listed.conversations[0]), ["id", "title", "updatedAt", "messages"]);
  await send(h, { conversationId: older.id });
  const running = await h.handle("list", { repositoryId });
  assert.equal(running.running, older.id);
  assert.equal(running.conversations[0].id, older.id, "the conversation that just got a message is the newest");
  assert.equal((await h.handle("list", { repositoryId: otherRepositoryId })).running, null);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done" }, older.id);
  assert.equal((await h.handle("list", { repositoryId })).running, null);
});
