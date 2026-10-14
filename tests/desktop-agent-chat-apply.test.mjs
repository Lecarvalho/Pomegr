import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { DESKTOP_AUTH_HEADER } from "../shared/local-auth.mjs";
import {
  agentChatMcpServer, createAgentChat, installAgentChatIpc, AGENT_CHAT_CHANNEL,
} from "../desktop/runtime/agent-chat.mjs";
import {
  agentMessage, chatHarness, desktopExecutable, finishTurn, mcpScript, origin, otherRepositoryId, pendingProposal, readyBoard, repositoryId, root,
  seed, send, sourceEnvironment, token, unpackedRoot, until, userMessage, withProposal,
} from "./helpers/agent-chat-harness.mjs";

const invalid = { ok: false, error: "invalid" };
const unavailable = { ok: false, error: "unavailable" };
const conversationId = "chat-0123456789ab";

const SET_OF_ACTIONS = ["create", "update", "delete", "move", "feature_create", "queue_add", "queue_remove", "queue_reorder"];

const everyKind = [
  { op: "create_feature", name: "Billing" },
  { op: "create_task", text: "Invoice export", feature: "Billing", step: 1, queue: true, run: { provider: "claude", effort: "high" }, completeWhen: { checks: ["pr_open"] } },
  { op: "update_task", id: "T-1", text: "Reworded" },
  { op: "move_task", id: "T-1", column: "Ready" },
  { op: "set_step", id: "T-2", step: 2 },
  { op: "queue_task", id: "T-3" },
  { op: "unqueue_task", id: "T-3" },
  { op: "delete_task", id: "T-3" },
];

function withBilling() {
  const board = readyBoard();
  board.features = [...board.features, { id: "feat-2", name: "Billing", done: false }];
  return board;
}

/** The fake monitor accepts every action; a new feature appears on the board and a new task gets T-9. */
function acceptAll(h) {
  h.state.actions = (action) => {
    if (action === "feature_create") return { ok: true, board: withBilling() };
    if (action === "create") return { ok: true, taskId: "T-9", board: withBilling() };
    return { ok: true };
  };
}

const apply = (h, id, proposalId = "p-0123456789ab", repository = repositoryId) => h.handle("apply", { repositoryId: repository, conversationId: id, proposalId });
const dismiss = (h, id, proposalId = "p-0123456789ab", repository = repositoryId) => h.handle("dismiss", { repositoryId: repository, conversationId: id, proposalId });
const storedProposal = async (h, id) => (await h.reload().read(repositoryId, id)).messages.find((message) => message.proposal)?.proposal;

test("apply runs every kind of operation through the fixed task actions, in order, and stores the proposal as applied with its results", async (context) => {
  const h = await chatHarness(context);
  acceptAll(h);
  const conversation = await seed(h, { messages: withProposal(pendingProposal({ operations: everyKind })) });
  assert.deepEqual(await apply(h, conversation.id), { ok: true });
  assert.equal(h.calls[0].pathname, "/api/tasks", "the board is read first");
  assert.equal(h.calls[0].init.method, "GET");
  const requests = h.actionCalls();
  assert.deepEqual(requests.map((call) => call.pathname.replace("/internal/tasks/", "")), [
    "feature_create", "create", "queue_add", "update", "move", "queue_reorder", "queue_add", "queue_remove", "delete",
  ]);
  assert.deepEqual(requests.map((call) => call.body), [
    { repositoryId, payload: { name: "Billing" } },
    { repositoryId, payload: { text: "Invoice export", run: { provider: "claude", model: null, effort: "high" }, completeWhen: { checks: ["pr_open"], own: null }, featureId: "feat-2", step: 1 } },
    { repositoryId, payload: { id: "T-9" } },
    { repositoryId, payload: { id: "T-1", text: "Reworded" } },
    { repositoryId, payload: { id: "T-1", columnId: "col-b", position: 100_000 } },
    { repositoryId, payload: { id: "T-2", step: 2 } },
    { repositoryId, payload: { id: "T-3" } },
    { repositoryId, payload: { id: "T-3" } },
    { repositoryId, payload: { id: "T-3" } },
  ]);
  for (const call of requests) {
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.cache, "no-store");
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(call.init.headers[DESKTOP_AUTH_HEADER], token);
    assert.equal(call.init.headers["content-type"], "application/json");
    assert.ok(SET_OF_ACTIONS.includes(call.pathname.replace("/internal/tasks/", "")), call.pathname);
  }
  const proposal = await storedProposal(h, conversation.id);
  assert.equal(proposal.state, "applied");
  assert.deepEqual(proposal.results, [{ ok: true }, { ok: true, taskId: "T-9" }, ...Array(6).fill({ ok: true })]);
  assert.deepEqual(proposal.operations, everyKind);
  assert.deepEqual(await h.handle("read", { repositoryId, conversationId: conversation.id }).then((view) => view.conversation.messages[1].proposal.state), "applied");
});

test("an operation that fails stops the rest and the proposal is stored as partial", async (context) => {
  const h = await chatHarness(context);
  h.state.actions = (action) => (action === "update" ? { ok: false, error: "conflict", detail: `${root} ${token}` } : { ok: true });
  const operations = [{ op: "delete_task", id: "T-3" }, { op: "update_task", id: "T-1", text: "Blocked" }, { op: "queue_task", id: "T-2" }];
  const conversation = await seed(h, { messages: withProposal(pendingProposal({ operations })) });
  assert.deepEqual(await apply(h, conversation.id), { ok: true });
  assert.deepEqual(h.actionCalls().map((call) => call.pathname.replace("/internal/tasks/", "")), ["delete", "update"]);
  const proposal = await storedProposal(h, conversation.id);
  assert.equal(proposal.state, "partial");
  assert.deepEqual(proposal.results, [{ ok: true }, { ok: false, error: "conflict" }, { ok: false, error: "skipped" }]);
  assert.equal(JSON.stringify(proposal).includes(token), false);
  assert.equal(JSON.stringify(proposal).includes("detail"), false);
  assert.deepEqual(await apply(h, conversation.id), { ok: false, error: "conflict" }, "a proposal takes one answer");
});

test("a monitor error outside the fixed set, a failing request, and a task that is not on the board are results, not leaks", async (context) => {
  const teapot = await chatHarness(context);
  teapot.state.actions = () => ({ ok: false, error: "teapot", message: `${root}` });
  const first = await seed(teapot, { messages: withProposal(pendingProposal({ operations: [{ op: "delete_task", id: "T-3" }, { op: "delete_task", id: "T-1" }] })) });
  assert.deepEqual(await apply(teapot, first.id), { ok: true });
  assert.deepEqual((await storedProposal(teapot, first.id)).results, [{ ok: false, error: "unavailable" }, { ok: false, error: "skipped" }]);

  const broken = await chatHarness(context);
  broken.state.actions = () => { throw new TypeError(`fetch failed ${root}`); };
  const second = await seed(broken, { messages: withProposal(pendingProposal({ operations: [{ op: "queue_task", id: "T-1" }] })) });
  assert.deepEqual(await apply(broken, second.id), { ok: true });
  const stored = await storedProposal(broken, second.id);
  assert.equal(stored.state, "partial");
  assert.deepEqual(stored.results, [{ ok: false, error: "unavailable" }]);

  const missing = await chatHarness(context);
  const third = await seed(missing, { messages: withProposal(pendingProposal({ operations: [{ op: "delete_task", id: "T-77" }, { op: "queue_task", id: "T-1" }] })) });
  assert.deepEqual(await apply(missing, third.id), { ok: true });
  assert.deepEqual((await storedProposal(missing, third.id)).results, [{ ok: false, error: "not_found" }, { ok: false, error: "skipped" }]);
  assert.equal(missing.actionCalls().length, 0, "a task that is not on the board is never sent");
});

test("only a pending proposal is applied or dismissed", async (context) => {
  for (const state of ["applied", "partial", "dismissed"]) {
    const h = await chatHarness(context);
    const results = state === "applied" ? [{ ok: true }, { ok: true }] : [{ ok: true }, { ok: false, error: "conflict" }];
    const proposal = pendingProposal({ state, ...(state === "dismissed" ? {} : { results }) });
    const conversation = await seed(h, { messages: withProposal(proposal) });
    assert.deepEqual(await apply(h, conversation.id), { ok: false, error: "conflict" }, state);
    assert.deepEqual(await dismiss(h, conversation.id), { ok: false, error: "conflict" }, state);
    assert.equal(h.calls.length, 0, state);
    assert.equal((await storedProposal(h, conversation.id)).state, state);
  }
});

test("an unknown proposal or conversation is not_found, and a bad identifier is invalid", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: withProposal() });
  const other = await seed(h, { messages: [userMessage(1), agentMessage(2)] });
  for (const operation of ["apply", "dismiss"]) {
    assert.deepEqual(await h.handle(operation, { repositoryId, conversationId: conversation.id, proposalId: "p-ffffffffffff" }), { ok: false, error: "not_found" }, operation);
    assert.deepEqual(await h.handle(operation, { repositoryId, conversationId: other.id, proposalId: "p-0123456789ab" }), { ok: false, error: "not_found" }, "a proposal of another conversation");
    assert.deepEqual(await h.handle(operation, { repositoryId, conversationId: "chat-ffffffffffff", proposalId: "p-0123456789ab" }), { ok: false, error: "not_found" });
    assert.deepEqual(await h.handle(operation, { repositoryId: otherRepositoryId, conversationId: conversation.id, proposalId: "p-0123456789ab" }), { ok: false, error: "not_found" });
    assert.deepEqual(await h.handle(operation, { repositoryId, conversationId: conversation.id, proposalId: "p-short" }), invalid);
    assert.deepEqual(await h.handle(operation, { repositoryId, conversationId: conversation.id }), invalid);
  }
  assert.equal(h.calls.length, 0);
  assert.equal((await storedProposal(h, conversation.id)).state, "pending");
});

test("dismiss stores dismissed and posts nothing, not even a board read", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: withProposal() });
  assert.deepEqual(await dismiss(h, conversation.id), { ok: true });
  assert.equal(h.calls.length, 0);
  const proposal = await storedProposal(h, conversation.id);
  assert.deepEqual(proposal, { ...pendingProposal(), state: "dismissed" });
  assert.equal(Object.hasOwn(proposal, "results"), false);
  const stored = await h.reload().read(repositoryId, conversation.id);
  assert.notEqual(stored.updatedAt, conversation.updatedAt);
  assert.deepEqual(await apply(h, conversation.id), { ok: false, error: "conflict" });
});

test("a second answer to the same proposal while one is applying is busy", async (context) => {
  const h = await chatHarness(context);
  acceptAll(h);
  const conversation = await seed(h, { messages: withProposal() });
  let release;
  h.state.gate = new Promise((resolve) => { release = resolve; });
  const first = apply(h, conversation.id);
  await until(() => h.calls.length > 0);
  assert.deepEqual(await apply(h, conversation.id), { ok: false, error: "busy" });
  assert.deepEqual(await dismiss(h, conversation.id), { ok: false, error: "busy" });
  release();
  assert.deepEqual(await first, { ok: true });
  assert.equal(h.actionCalls().length, 2, "the operations ran once");
  assert.equal((await storedProposal(h, conversation.id)).state, "applied");
});

test("proposals of two conversations can apply at the same time", async (context) => {
  const h = await chatHarness(context);
  acceptAll(h);
  const one = await seed(h, { messages: withProposal(pendingProposal({ id: "p-111111111111", operations: [{ op: "queue_task", id: "T-1" }] })) });
  const two = await seed(h, { messages: withProposal(pendingProposal({ id: "p-222222222222", operations: [{ op: "queue_task", id: "T-2" }] })) });
  let release;
  h.state.gate = new Promise((resolve) => { release = resolve; });
  const first = apply(h, one.id, "p-111111111111");
  await until(() => h.calls.length > 0);
  const second = apply(h, two.id, "p-222222222222");
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
});

test("a board that is not ready makes apply unavailable and the proposal stays pending", async (context) => {
  const h = await chatHarness(context);
  acceptAll(h);
  const conversation = await seed(h, { messages: withProposal() });
  for (const change of [
    () => { h.state.board = { ...readyBoard(), readiness: "loading" }; },
    () => { h.state.board = { ...readyBoard(), repositoryId: otherRepositoryId }; },
    () => { h.state.fetchError = new TypeError("fetch failed"); },
  ]) {
    change();
    assert.deepEqual(await apply(h, conversation.id), unavailable);
    assert.equal(h.actionCalls().length, 0);
    assert.equal((await storedProposal(h, conversation.id)).state, "pending");
    Object.assign(h.state, { board: readyBoard(), fetchError: null });
  }
  assert.deepEqual(await apply(h, conversation.id), { ok: true }, "the same proposal applies once the board is back");
});

test("the outcome is stored on the newest conversation, so a message added while applying is kept, and a deleted conversation is not_found", async (context) => {
  const h = await chatHarness(context);
  acceptAll(h);
  const conversation = await seed(h, { messages: withProposal() });
  let release;
  h.state.gate = new Promise((resolve) => { release = resolve; });
  const applying = apply(h, conversation.id);
  await until(() => h.calls.length > 0);
  const current = await h.store.read(repositoryId, conversation.id);
  await h.store.save(repositoryId, { ...current, messages: [...current.messages, userMessage(3, "Another question")] });
  release();
  assert.deepEqual(await applying, { ok: true });
  const stored = await h.reload().read(repositoryId, conversation.id);
  assert.deepEqual(stored.messages.map((message) => message.id), ["m-1", "m-2", "m-3"]);
  assert.equal(stored.messages[1].proposal.state, "applied");

  const gone = await chatHarness(context);
  acceptAll(gone);
  const doomed = await seed(gone, { messages: withProposal() });
  gone.state.gate = new Promise((resolve) => { release = resolve; });
  const pending = apply(gone, doomed.id);
  await until(() => gone.calls.length > 0);
  await gone.store.remove(repositoryId, doomed.id);
  release();
  assert.deepEqual(await pending, { ok: false, error: "not_found" });
});

test("a proposal from a real turn can be applied end to end", async (context) => {
  const h = await chatHarness(context);
  acceptAll(h);
  const { conversationId: id } = await send(h);
  const block = { summary: "Queue the second task", operations: [{ op: "queue_task", id: "T-2" }] };
  const conversation = await finishTurn(h, h.runs[0], { status: "complete", text: `Queue it.\n\n\`\`\`pomegr-board\n${JSON.stringify(block)}\n\`\`\`` }, id);
  const { proposal } = conversation.messages[1];
  assert.equal(h.actionCalls().length, 0);
  assert.deepEqual(await h.handle("apply", { repositoryId, conversationId: id, proposalId: proposal.id }), { ok: true });
  assert.deepEqual(h.actionCalls().map((call) => [call.pathname, call.body.payload]), [["/internal/tasks/queue_add", { id: "T-2" }]]);
  assert.equal((await storedProposal(h, id)).state, "applied");
});

test("no answer of any operation holds the desktop token or the repository root", async (context) => {
  const h = await chatHarness(context);
  h.state.actions = (action) => (action === "delete" ? { ok: false, error: "limit", detail: `${root} ${token}` } : { ok: true, board: readyBoard() });
  h.state.board = { ...readyBoard(), repositoryRoot: root, secretToken: token };
  const answers = [];
  const record = async (operation, payload) => { const answer = await h.handle(operation, payload); answers.push(answer); return answer; };
  const seeded = await seed(h, { messages: withProposal(pendingProposal({ operations: [{ op: "delete_task", id: "T-3" }] })) });
  const dismissable = await seed(h, { messages: withProposal(pendingProposal({ id: "p-aaaaaaaaaaaa" })) });
  await record("list", { repositoryId });
  await record("read", { repositoryId, conversationId: seeded.id });
  await record("apply", { repositoryId, conversationId: seeded.id, proposalId: "p-0123456789ab" });
  await record("dismiss", { repositoryId, conversationId: dismissable.id, proposalId: "p-aaaaaaaaaaaa" });
  const started = await record("send", { repositoryId, conversationId: null, text: "Question", provider: "claude", model: null });
  await record("read", { repositoryId, conversationId: started.conversationId });
  h.runs[0].options.onText(`Looking at ${"files"}.`);
  await record("read", { repositoryId, conversationId: started.conversationId });
  await record("stop", { repositoryId, conversationId: started.conversationId });
  await finishTurn(h, h.runs[0], { status: "stopped", text: "Cut" }, started.conversationId);
  await record("read", { repositoryId, conversationId: started.conversationId });
  await record("delete", { repositoryId, conversationId: started.conversationId });
  await record("list", { repositoryId });
  await record("apply", { repositoryId, conversationId: "chat-ffffffffffff", proposalId: "p-0123456789ab" });
  await record("erase", {});
  const serialized = JSON.stringify(answers);
  for (const value of [token, root, root.replaceAll("\\", "\\\\"), "private-repo", sourceEnvironment.POMEGR_MONITOR_TOKEN, "detail", "secretToken"]) {
    assert.equal(serialized.includes(value), false, `an answer holds ${value}`);
  }
  assert.equal(answers.length, 13);
});

test("dispose stops a running turn once, and a send that is still preparing never starts one", async (context) => {
  const running = await chatHarness(context);
  await send(running);
  assert.equal(running.runs[0].stops, 0);
  running.chat.dispose();
  assert.equal(running.runs[0].stops, 1);
  assert.doesNotThrow(() => running.chat.dispose());
  assert.deepEqual(await running.handle("list", { repositoryId }), unavailable);

  const preparing = await chatHarness(context);
  let release;
  preparing.state.gate = new Promise((resolve) => { release = resolve; });
  const pending = send(preparing);
  preparing.chat.dispose();
  release();
  assert.deepEqual(await pending, unavailable);
  assert.equal(preparing.runs.length, 0);
  assert.deepEqual(await preparing.reload().list(repositoryId), []);

  const idle = await chatHarness(context);
  assert.doesNotThrow(() => idle.chat.dispose());
});

test("an explicit MCP server option, or none, is passed to the turn as given", async (context) => {
  const none = await chatHarness(context, { mcpServer: null });
  await send(none);
  assert.equal(none.runs[0].options.mcpServer, null);
  const given = { command: desktopExecutable, args: [mcpScript], env: { ELECTRON_RUN_AS_NODE: "1" } };
  const custom = await chatHarness(context, { mcpServer: given });
  await send(custom);
  assert.equal(custom.runs[0].options.mcpServer, given);
});

test("the MCP server is the desktop executable running the bundled read-only server as Node, and null when it is not built", () => {
  const present = (file) => file === mcpScript;
  const server = agentChatMcpServer({ executable: desktopExecutable, unpackedRoot, fileExists: present });
  assert.deepEqual(server, { command: desktopExecutable, args: [path.join(unpackedRoot, "desktop", "workers", "agent-chat-mcp.cjs")], env: { ELECTRON_RUN_AS_NODE: "1" } });
  assert.equal(Object.isFrozen(server) && Object.isFrozen(server.args) && Object.isFrozen(server.env), true);
  const asked = [];
  agentChatMcpServer({ executable: desktopExecutable, unpackedRoot, fileExists: (file) => { asked.push(file); return true; } });
  assert.deepEqual(asked, [mcpScript]);
  const options = { executable: desktopExecutable, unpackedRoot, fileExists: present };
  for (const [rule, change] of [
    ["the bundle is missing", { fileExists: () => false }], ["the file check throws", { fileExists: () => { throw new Error("EPERM"); } }],
    ["the file check answers something else than true", { fileExists: () => "yes" }], ["a relative executable", { executable: "Pomegr.exe" }],
    ["a relative root", { unpackedRoot: "resources\\app.asar.unpacked" }], ["no executable", { executable: undefined }], ["no root", { unpackedRoot: undefined }],
    ["an executable that is not text", { executable: 5 }], ["a root that is not text", { unpackedRoot: {} }],
  ]) assert.equal(agentChatMcpServer({ ...options, ...change }), null, rule);
  assert.equal(agentChatMcpServer(), null);
  assert.equal(agentChatMcpServer({}), null);
});

function fakeIpc() {
  const handlers = new Map();
  const order = [];
  return {
    handlers, order,
    ipcMain: {
      handle: (channel, handler) => { order.push(["handle", channel]); handlers.set(channel, handler); },
      removeHandler: (channel) => { order.push(["remove", channel]); handlers.delete(channel); },
    },
  };
}

test("the IPC bridge registers the chat and image channels, refuses an untrusted frame, and removes itself", async () => {
  const { handlers, order, ipcMain } = fakeIpc();
  const trusted = { trusted: true };
  const calls = [];
  let disposed = 0;
  const chat = { handle: async (...args) => { calls.push(args); return { ok: true, conversations: [], running: null }; }, dispose() { disposed += 1; } };
  const remove = installAgentChatIpc({ ipcMain, isTrustedEvent: (event) => event?.trusted === true, chat });
  assert.equal(AGENT_CHAT_CHANNEL, "pomegr:agent-chat");
  assert.deepEqual([...handlers.keys()], ["pomegr:agent-chat", "pomegr:agent-chat-image"]);
  assert.deepEqual(order, [["remove", "pomegr:agent-chat"], ["handle", "pomegr:agent-chat"], ["remove", "pomegr:agent-chat-image"], ["handle", "pomegr:agent-chat-image"]]);
  const call = handlers.get("pomegr:agent-chat");
  for (const event of [{}, undefined, null, { trusted: false }, "trusted"]) assert.deepEqual(await call(event, "list", { repositoryId }), invalid);
  assert.equal(calls.length, 0, "an untrusted frame never reaches the chat");
  assert.deepEqual(await call(trusted, "list", { repositoryId }), { ok: true, conversations: [], running: null });
  assert.deepEqual(calls, [["list", { repositoryId }, { event: trusted }]]);
  remove();
  assert.equal(handlers.size, 0);
  assert.equal(disposed, 1);
  assert.deepEqual(order.slice(-2), [["remove", "pomegr:agent-chat"], ["remove", "pomegr:agent-chat-image"]]);
});

test("every frame is untrusted unless the bridge is told how to trust one", async () => {
  const { handlers, ipcMain } = fakeIpc();
  const calls = [];
  installAgentChatIpc({ ipcMain, chat: { handle: async (...args) => { calls.push(args); return { ok: true }; } } });
  assert.deepEqual(await handlers.get("pomegr:agent-chat")({ trusted: true }, "list", { repositoryId }), invalid);
  assert.equal(calls.length, 0);
});

test("a chat that throws answers unavailable at the bridge, and the bridge needs an ipcMain", async () => {
  for (const handle of [async () => { throw new Error("C:\\private\\boom"); }, () => { throw new Error("sync boom"); }]) {
    const { handlers, ipcMain } = fakeIpc();
    installAgentChatIpc({ ipcMain, isTrustedEvent: () => true, chat: { handle } });
    assert.deepEqual(await handlers.get("pomegr:agent-chat")({}, "list", { repositoryId }), unavailable);
  }
  assert.throws(() => installAgentChatIpc({}), TypeError);
  assert.throws(() => installAgentChatIpc(), TypeError);
  assert.throws(() => installAgentChatIpc({ ipcMain: { handle() {} } }), TypeError);
  assert.throws(() => installAgentChatIpc({ ipcMain: { removeHandler() {} } }), TypeError);
});

test("the bridge builds its own chat from the task bridge options when none is given", async (context) => {
  const h = await chatHarness(context, { viaDataRoot: true });
  const { handlers, ipcMain } = fakeIpc();
  const remove = installAgentChatIpc({ ipcMain, isTrustedEvent: () => true, monitorOrigin: origin, authorizationToken: token, dataRoot: h.dataRoot, fetch: async () => { throw new Error("unused"); } });
  assert.deepEqual(await handlers.get("pomegr:agent-chat")({}, "list", { repositoryId }), { ok: true, conversations: [], running: null });
  assert.deepEqual(await handlers.get("pomegr:agent-chat")({}, "list", { repositoryId: "x" }), invalid);
  remove();
  assert.deepEqual(await createAgentChat({ monitorOrigin: origin, authorizationToken: token, dataRoot: h.dataRoot }).handle("list", { repositoryId }), { ok: true, conversations: [], running: null });
});

async function loadPreload() {
  const invokes = [];
  let exposed;
  const Module = (await import("node:module")).default;
  const require = Module.createRequire(import.meta.url);
  const original = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "electron") {
      return {
        contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
        ipcRenderer: { invoke: (...args) => { invokes.push(args); return Promise.resolve({ ok: true, from: "main" }); } },
      };
    }
    return original.call(this, request, ...rest);
  };
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {} };
  try {
    const file = require.resolve("../desktop/runtime/preload.cjs");
    delete require.cache[file];
    require(file);
  } finally {
    Module._load = original;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
  return { exposed, invokes };
}

test("the preload bridge invokes the chat channel only for the seven operations with a plain payload that holds a valid repository", async () => {
  const { exposed, invokes } = await loadPreload();
  assert.equal(typeof exposed.agentChat, "function");
  class Holder { repositoryId = repositoryId; }
  const good = { repositoryId };
  for (const operation of ["erase", "", " list", "LIST", "send ", "constructor", undefined, null, 5, ["list"]]) assert.deepEqual(await exposed.agentChat(operation, good), invalid, String(operation));
  for (const payload of [null, undefined, "list", 5, true, [], [good], new Map(), new Holder(), () => {}, {}, { text: "no repository" }]) assert.deepEqual(await exposed.agentChat("list", payload), invalid, String(payload));
  for (const bad of ["repo-short", "repo-0123456789ABCDEF01234567", "repo-0123456789abcdef012345678", "../x", `${repositoryId}\n`, 7, null, undefined, ["repo-0123456789abcdef01234567"]]) {
    assert.deepEqual(await exposed.agentChat("list", { repositoryId: bad }), invalid, String(bad));
  }
  assert.equal(invokes.length, 0, "nothing reached the main process");

  for (const operation of ["list", "read", "send", "stop", "apply", "dismiss", "delete"]) {
    const payload = { repositoryId, conversationId, extra: "validated by the main process" };
    assert.deepEqual(await exposed.agentChat(operation, payload), { ok: true, from: "main" });
    assert.deepEqual(invokes.at(-1), ["pomegr:agent-chat", operation, payload]);
  }
  assert.equal(invokes.length, 7);
  const bare = Object.assign(Object.create(null), { repositoryId });
  await exposed.agentChat("list", bare);
  assert.deepEqual(invokes.at(-1), ["pomegr:agent-chat", "list", bare]);
});

const RUNTIME_FILES = ["agent-chat.mjs", "agent-chat-images.mjs", "agent-chat-prompt.mjs", "agent-chat-proposal.mjs", "agent-chat-runner.mjs", "agent-chat-store.mjs"];
const sourceOf = (file) => readFile(new URL(`../desktop/runtime/${file}`, import.meta.url), "utf8");

function callText(source, start) {
  let depth = 0;
  for (let index = source.indexOf("(", start); index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")" && (depth -= 1) === 0) return source.slice(start, index + 1);
  }
  return source.slice(start);
}

test("the chat's runtime files are a closed surface: no console, no shell, no external open, no server import", async () => {
  const sources = new Map(await Promise.all(RUNTIME_FILES.map(async (file) => [file, await sourceOf(file)])));
  for (const [file, source] of sources) {
    assert.doesNotMatch(source, /console\./u, `${file} logs`);
    assert.doesNotMatch(source, /shell\s*:\s*true/u, `${file} uses a shell`);
    assert.doesNotMatch(source, /openExternal|shell\.open|Menu\.|dialog\./u, `${file} opens something outside the app`);
    assert.doesNotMatch(source, /\bexec(?:Sync|File|FileSync)?\(|\beval\(|new Function\(|spawnSync|fork\(/u, `${file} runs code by another route`);
    assert.doesNotMatch(source, /server\//u, `${file} reaches into the monitor`);
    assert.doesNotMatch(source, /\bprocess\.(?:exit|kill)|child\.kill\(\)\s*;\s*process/u, `${file} ends processes`);
    for (const specifier of [...source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu)].map((match) => match[1])) {
      const allowed = specifier.startsWith("node:") || RUNTIME_FILES.some((name) => specifier === `./${name}`)
        || ["./claude-auth.mjs", "./environment-policy.mjs", "./plugin-cli.mjs", "../../shared/local-auth.mjs"].includes(specifier);
      assert.ok(allowed, `${file} imports ${specifier}`);
    }
  }
  assert.deepEqual([...sources.get("agent-chat-store.mjs").matchAll(/from\s+"(node:[^"]+)"/gu)].map((match) => match[1]).sort(), ["node:crypto", "node:fs/promises", "node:path"]);
  for (const pure of ["agent-chat-prompt.mjs", "agent-chat-proposal.mjs", "agent-chat-runner.mjs"]) assert.doesNotMatch(sources.get(pure), /from\s+"node:/u, `${pure} touches no node module`);
  assert.deepEqual([...sources.get("agent-chat-images.mjs").matchAll(/from\s+"(node:[^"]+|\.\/[^"]+)"/gu)].map((match) => match[1]).sort(), ["./agent-chat-proposal.mjs", "node:crypto", "node:fs/promises", "node:path"]);
  assert.doesNotMatch(sources.get("agent-chat-runner.mjs"), /\bimport\b/u);
  assert.doesNotMatch(sources.get("agent-chat-proposal.mjs"), /\bimport\b/u);
});

test("every process the chat starts is started without a shell, from an argument array", async () => {
  const runner = await sourceOf("agent-chat-runner.mjs");
  const spawns = [...runner.matchAll(/\bspawn\(/gu)];
  assert.equal(spawns.length, 1, "one place starts a provider");
  for (const match of spawns) assert.match(callText(runner, match.index), /\(executable, args, \{[^}]*shell: false[^}]*stdio: \["pipe", "pipe", "ignore"\][^}]*windowsHide: true/u);
  const controller = await sourceOf("agent-chat.mjs");
  assert.doesNotMatch(controller, /\bspawn(?:Child)?\(/u, "the controller only hands spawn to the runner");
  assert.match(controller, /spawn,\s*executable: command/u);
  for (const file of RUNTIME_FILES.filter((name) => name !== "agent-chat-runner.mjs")) assert.doesNotMatch(await sourceOf(file), /\bspawn\w*\(/u, `${file} starts a process`);
});

test("every request the controller makes refuses redirects, is bounded in time, and carries the desktop header", async () => {
  const controller = await sourceOf("agent-chat.mjs");
  assert.equal([...controller.matchAll(/fetchImpl\(/gu)].length, 1, "one function makes every request");
  assert.match(controller, /cache: "no-store", redirect: "error", signal: AbortSignal\.timeout\(/u);
  assert.match(controller, /\[DESKTOP_AUTH_HEADER\]: authorizationToken/u);
  assert.match(controller, /const TASK_ACTIONS = new Set\(\["create", "update", "delete", "move", "feature_create", "queue_add", "queue_remove", "queue_reorder"\]\);/u);
  for (const forbidden of ["queue_settings", "resolve_done", "resolve_requeue", "start", "image"]) assert.equal(new RegExp(`TASK_ACTIONS[^;]*"${forbidden}"`, "u").test(controller), false, forbidden);
  assert.match(controller, /if \(!TASK_ACTIONS\.has\(action\)\) return refused\("invalid"\);/u);
});

test("the chat is wired once into the shell, the LAN gateway, and the preload", async () => {
  const [main, preload, sharing] = await Promise.all(["shell-main.mjs", "preload.cjs", "lan-sharing.mjs"].map(sourceOf));
  assert.match(main, /installAgentChatIpc\(\{ \.\.\.taskBridge, chat: agentChat \}\)/u);
  // A paired device's call carries no origin, so it can never start a session from the chat.
  assert.match(main, /agentChat: \(operation, payload\) => agentChat\.handle\(operation, payload\), agentChatImage: \(operation, payload\) => agentChat\.image\(operation, payload\), taskStart:/u);
  assert.match(main, /createAgentChat\(\{\s+monitorOrigin: privateMonitorOrigin, authorizationToken,/u);
  assert.match(main, /startTask: \(event, repositoryId, taskId\) => taskStarter\.startApproved\(event, repositoryId, taskId\) \}\);/u);
  assert.equal([...main.matchAll(/createAgentChat\(/gu)].length, 1);
  assert.match(preload, /ipcRenderer\.invoke\("pomegr:agent-chat", operation, payload\)/u);
  assert.match(preload, /new Set\(\["list", "read", "send", "stop", "apply", "dismiss", "delete"\]\)/u);
  assert.match(preload, /ipcRenderer\.invoke\("pomegr:agent-chat-image", operation, payload\)/u);
  assert.match(sharing, /agentChat: options\.agentChat/u);
});
