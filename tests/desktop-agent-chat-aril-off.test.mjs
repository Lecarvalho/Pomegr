// Aril Off means no Aril at all. Desktop main refuses a message, a warm run, a follow-up, an answer to a proposal (Apply and Dismiss), a deletion,
// an image, a compaction, and Aril's memory update with the same `conflict` the other Off writes use, for the desktop window and for a paired
// device; stops what runs the moment the switch turns Off (as the owner's Stop does); and closes the warm runs and the Jev pre-connect. Reading a
// saved thread still answers, and the stored threads are never touched. Everything runs on fakes: no provider starts and nothing leaves the test.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createCompaction } from "../desktop/runtime/agent-chat-compaction.mjs";
import { createArilSwitch } from "../desktop/runtime/aril-switch.mjs";
import {
  agentMessage, chatHarness, fakeRuns, finishTurn, pendingProposal, pngBytes, repositoryId, root, seed, send, until, userMessage, withProposal,
} from "./helpers/agent-chat-harness.mjs";

const desktop = { event: {} };
const paired = { paired: true };
const CONFLICT = { ok: false, error: "conflict" };
const proposalId = "p-0123456789ab";
const SECRET = "jev-secret-key-0123456789";
const quiet = () => new Promise((resolve) => setTimeout(resolve, 60));
const setOn = (h, on, origin = desktop) => h.chat.handle("aril_switch_set", { on }, origin);
const offHarness = (context, overrides = {}) => chatHarness(context, { arilSwitch: createArilSwitch(), ...overrides });

const SIZE = 1_500;
const at = (minute) => new Date(Date.UTC(2026, 8, 1, 12, minute)).toISOString();
// A thread long enough that a completed turn is followed by a compaction (the compaction tests' own LONG thread).
const longThread = (h) => seed(h, { messages: Array.from({ length: 24 }, (_, index) => {
  const text = `m${index + 1} ${"x".repeat(SIZE - 5)}`;
  return index % 2 === 0 ? { ...userMessage(index + 1, text), at: at(index) } : agentMessage(index + 1, { text, at: at(index) });
}) });
const compactions = (h) => h.runs.filter((run) => run.options.tools === "none");

test("with Aril Off the chat refuses a message, a warm run, Apply, Dismiss, a deletion, and an image, for the desktop window and for a paired device", async (context) => {
  const h = await offHarness(context);
  const conversation = await seed(h, { messages: withProposal(pendingProposal()) });
  const located = { repositoryId, conversationId: conversation.id };
  const refused = [
    ["send", { repositoryId, conversationId: null, text: "Hello", provider: "claude", model: null }],
    ["send", { ...located, text: "Hello", provider: "claude", model: null, effort: "low" }],
    ["warm", { repositoryId }],
    ["warm", { repositoryId, provider: "claude", model: null, effort: "high" }],
    ["apply", { ...located, proposalId }],
    ["dismiss", { ...located, proposalId }],
    ["delete", located],
  ];
  for (const origin of [desktop, paired]) {
    for (const [operation, payload] of refused) assert.deepEqual(await h.chat.handle(operation, payload, origin), CONFLICT, `${operation} from ${Object.keys(origin)[0]}`);
  }
  assert.deepEqual(await h.image("add", { repositoryId, bytes: pngBytes() }), CONFLICT, "an image is staged for a message that cannot be sent");
  // Nothing started, nothing was asked of the monitor, and the stored thread is exactly as it was.
  assert.equal(h.runs.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.declarations.length, 0);
  const stored = await h.reload().read(repositoryId, conversation.id);
  assert.equal(stored.messages.length, 2);
  assert.equal(stored.messages[1].proposal.state, "pending");
  assert.equal((await h.reload().index(repositoryId)).length, 1);
  assert.deepEqual(await h.handle("nope", { repositoryId }), { ok: false, error: "invalid" }, "an operation Off does not own is judged as it always is");
});

test("with Aril Off reading a saved thread still answers, Stop is not refused, and the switch card and the Settings controls keep their own rules", async (context) => {
  const h = await offHarness(context);
  const conversation = await seed(h, { messages: withProposal(pendingProposal(), { text: "Plan zebra." }) });
  const located = { repositoryId, conversationId: conversation.id };
  assert.equal((await h.handle("list", { repositoryId })).ok, true);
  assert.equal((await h.handle("read", located)).ok, true);
  assert.equal((await h.handle("thread", { repositoryId })).ok, true);
  assert.equal((await h.handle("search", { repositoryId, query: "zebra" })).ok, true);
  assert.deepEqual(await h.handle("stop", located), { ok: false, error: "not_found" }, "there is nothing to stop, which is not a refusal for Off");
  assert.deepEqual(await h.chat.handle("aril_switch", {}, paired), { ok: true, on: false, pairedOn: false });
  assert.deepEqual(await h.chat.handle("owner_memory_set", { text: "x" }, desktop), CONFLICT, "the other Off writes answer the same way");
  assert.deepEqual(await h.chat.handle("thread_flush", { repositoryId }, desktop), CONFLICT);
});

test("everything is back when Aril is turned On again, and the saved threads are shown again", async (context) => {
  const h = await offHarness(context);
  const conversation = await seed(h, { messages: withProposal(pendingProposal(), { text: "Plan zebra." }) });
  const located = { repositoryId, conversationId: conversation.id };
  assert.deepEqual(await h.handle("send", { repositoryId, conversationId: null, text: "Hello", provider: "claude", model: null }), CONFLICT);
  assert.deepEqual(await setOn(h, true), { ok: true, on: true });
  assert.deepEqual(await h.handle("warm", { repositoryId }), { ok: true });
  const image = await h.image("add", { repositoryId, bytes: pngBytes() });
  assert.equal(image.ok, true);
  assert.deepEqual(await h.handle("apply", { ...located, proposalId }), { ok: true });
  await until(() => h.followUps()[0]);
  await h.finishFollowUp(conversation.id);
  const sent = await send(h, { conversationId: conversation.id });
  assert.equal(sent.ok, true);
  const answered = await finishTurn(h, h.runs.find((run) => !run.options.prompt.includes("</proposal_outcome>")), { status: "complete", text: "Back." }, conversation.id);
  assert.equal(answered.messages.at(-1).text, "Back.");
  assert.equal(answered.messages.find((message) => message.proposal)?.proposal.state, "applied", "the thread was kept while Aril was Off");
  const other = await seed(h, { messages: [userMessage(1), agentMessage(2)] });
  assert.deepEqual(await h.handle("delete", { repositoryId, conversationId: other.id }), { ok: true });
});

test("turning Aril Off stops the turn in flight, and the turn is stored as stopped exactly as the owner's Stop stores it", async (context) => {
  const h = await offHarness(context, { arilSwitch: createArilSwitch({ initial: { on: true } }) });
  const sent = await send(h);
  assert.equal(sent.ok, true);
  assert.equal(h.runs[0].stops, 0);
  assert.deepEqual(await setOn(h, false, paired), { ok: true, on: false }, "a paired device turns it Off, and that stops the run too");
  assert.equal(h.runs[0].stops, 1, "Pomegr stops its own read-only run");
  await finishTurn(h, h.runs[0], { status: "stopped", text: "" }, sent.conversationId);
  const byOff = (await h.reload().read(repositoryId, sent.conversationId)).messages;
  assert.deepEqual(byOff.map((message) => [message.role, message.status ?? null]), [["user", null], ["agent", "stopped"]], "the owner's message stays and the turn reads as stopped");
  assert.equal(byOff.at(-1).text, "");
  // The owner's Stop of a turn of the same kind stores the same.
  assert.deepEqual(await setOn(h, true), { ok: true, on: true });
  const again = await send(h, { conversationId: sent.conversationId, text: "Once more" });
  assert.equal(again.ok, true);
  assert.deepEqual(await h.handle("stop", { repositoryId, conversationId: sent.conversationId }), { ok: true });
  assert.equal(h.runs[1].stops, 1);
  await finishTurn(h, h.runs[1], { status: "stopped", text: "" }, sent.conversationId);
  const byOwner = (await h.reload().read(repositoryId, sent.conversationId)).messages.at(-1);
  const strip = (message) => Object.fromEntries(Object.entries(message).filter(([key]) => key !== "id" && key !== "at"));
  assert.deepEqual(strip(byOwner), strip(byOff.at(-1)));
});

test("turning Aril Off kills the provider process of a turn that runs, with the real runner on a fake process", async (context) => {
  const children = [];
  const spawn = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stdin = Object.assign(new EventEmitter(), { writes: [], ended: false, write(data) { this.writes.push(data); return true; }, end() { this.ended = true; } });
    child.kills = 0;
    child.kill = () => { child.kills += 1; queueMicrotask(() => child.emit("close", null)); return true; };
    children.push({ executable, args, options, child });
    return child;
  };
  const h = await chatHarness(context, { viaDataRoot: true, runTurn: undefined, spawn, arilSwitch: createArilSwitch({ initial: { on: true } }) });
  const sent = await send(h);
  assert.equal(sent.ok, true);
  await until(() => children.length === 1);
  await setOn(h, false);
  assert.equal(children[0].child.kills, 1, "the process is killed");
  await until(async () => (await h.handle("read", { repositoryId, conversationId: sent.conversationId })).turn === null);
  const stored = (await h.reload().read(repositoryId, sent.conversationId)).messages;
  assert.equal(stored.at(-1).status, "stopped");
  assert.equal(children.length, 1, "and no warm run is started after the answer");
});

test("turning Aril Off stops a follow-up that runs, and the outcome of the proposal stays as it was", async (context) => {
  const h = await offHarness(context, { arilSwitch: createArilSwitch({ initial: { on: true } }) });
  const conversation = await seed(h, { messages: withProposal(pendingProposal()) });
  assert.deepEqual(await h.handle("apply", { repositoryId, conversationId: conversation.id, proposalId }), { ok: true });
  const run = await h.followUp();
  assert.equal(run.stops, 0);
  await setOn(h, false);
  assert.equal(run.stops, 1);
  run.answered = true;
  await finishTurn(h, run, { status: "stopped", text: "" }, conversation.id);
  const stored = (await h.reload().read(repositoryId, conversation.id)).messages;
  assert.equal(stored[1].proposal.state, "applied");
  assert.equal(stored.at(-1).status, "stopped");
  assert.equal(stored.at(-1).followUp, proposalId);
});

test("a message whose reads are still running when Aril turns Off stores nothing and starts nothing", async (context) => {
  const h = await offHarness(context, { arilSwitch: createArilSwitch({ initial: { on: true } }) });
  let release;
  h.state.gate = new Promise((resolve) => { release = resolve; });
  const pending = send(h);
  await until(() => h.calls.some((call) => call.pathname === "/api/tasks" && !call.search.includes("view=home")));
  await setOn(h, false);
  release();
  assert.deepEqual(await pending, CONFLICT);
  assert.equal(h.runs.length, 0);
  assert.deepEqual(await h.reload().index(repositoryId), [], "the conversation made for the message is not kept");
  // Aril is Off, so a later On is the owner's: the chat is free for a message again.
  await setOn(h, true);
  h.state.gate = null;
  assert.equal((await send(h)).ok, true);
});

test("a compaction is not started while Aril is Off, and one that runs is stopped when it turns Off", async (context) => {
  const idle = await chatHarness(context);
  await longThread(idle);
  const fakes = fakeRuns();
  const off = createCompaction({
    store: idle.store, summaries: idle.summaries, now: idle.now, runTurn: fakes.runTurn, spawn: idle.spawn, env: { PATH: "C:\\Tools" }, executable: (provider) => `C:\\bin\\${provider}.exe`,
    repositoryRoot: async () => root, declare: async () => null, withdraw: () => {}, busy: () => false, on: () => false,
  });
  await off.afterTurn(repositoryId);
  assert.equal(fakes.runs.length, 0, "Off: no compaction");

  const h = await chatHarness(context, { arilSwitch: createArilSwitch({ initial: { on: true } }) });
  await longThread(h);
  const first = await send(h);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, first.conversationId);
  const run = await until(() => compactions(h)[0] ?? null);
  await setOn(h, false);
  assert.equal(run.stops, 1, "the compaction run is stopped");
  run.resolve({ status: "complete", text: "Too late." });
  await quiet();
  assert.equal(await h.summaries.read(repositoryId), null, "and it stores nothing");
  assert.equal(compactions(h).length, 1);
});

test("a turn that completes in the moment Aril turns Off starts no compaction", async (context) => {
  const h = await chatHarness(context, { arilSwitch: createArilSwitch({ initial: { on: true } }) });
  await longThread(h);
  const first = await send(h);
  await setOn(h, false);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, first.conversationId);
  await quiet();
  assert.equal(compactions(h).length, 0, "Off: the stored answer does not start a compaction");
});

// ---- The warm run and the Jev pre-connect ----

function fakeProvider() {
  const spawns = [];
  const spawn = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stdin = Object.assign(new EventEmitter(), { writes: [], ended: false, write(data) { this.writes.push(data); return true; }, end() { this.ended = true; } });
    child.kills = 0;
    child.kill = () => { child.kills += 1; queueMicrotask(() => child.emit("close", null)); return true; };
    spawns.push({ executable, args, options, child });
    return child;
  };
  return { spawns, spawn };
}

test("turning Aril Off closes the warm runs that wait, and no warm run starts while it is Off", async (context) => {
  const provider = fakeProvider();
  let ids = 0;
  const h = await chatHarness(context, { viaDataRoot: true, runTurn: undefined, spawn: provider.spawn, arilSwitch: createArilSwitch({ initial: { on: true } }),
    newSessionId: () => `0b7c2a4e-1f3d-4c5b-9a8e-${String((ids += 1)).padStart(12, "0")}` });
  const warm = () => h.handle("warm", { repositoryId, provider: "claude", model: null, effort: null });
  assert.deepEqual(await warm(), { ok: true });
  assert.equal(provider.spawns.length, 1, "a run waits");
  const waiting = provider.spawns[0].child;
  assert.equal(waiting.kills, 0);
  await setOn(h, false);
  assert.equal(waiting.kills, 1, "Off closes it");
  await until(() => h.declarations.some(({ action }) => action === "withdraw"));
  assert.deepEqual(await warm(), CONFLICT);
  assert.equal(provider.spawns.length, 1, "and no other starts");
  await setOn(h, true);
  assert.deepEqual(await warm(), { ok: true });
  assert.equal(provider.spawns.length, 2, "On again: a run waits again");
});

function fakeTransport(behavior = {}) {
  const log = { fetches: 0, preconnects: 0, stops: 0 };
  return {
    log,
    fetch: async () => { log.fetches += 1; return new Response("{}", { status: 200 }); },
    preconnect: async () => { log.preconnects += 1; return behavior.preconnect ? behavior.preconnect() : true; },
    stopPreconnect: () => { log.stops += 1; },
  };
}

test("the Jev pre-connect is not opened while Aril is Off, and turning Aril Off gives up one that is being opened", async (context) => {
  const off = fakeTransport();
  const closed = await chatHarness(context, { arilSwitch: createArilSwitch(), jevKey: { read: async () => SECRET }, jevTransport: off });
  assert.deepEqual(await closed.handle("warm", { repositoryId }), CONFLICT);
  await quiet();
  assert.equal(off.log.preconnects, 0, "Off: nothing opens");

  const transport = fakeTransport({ preconnect: () => new Promise(() => {}) });
  const h = await chatHarness(context, { arilSwitch: createArilSwitch({ initial: { on: true } }), jevKey: { read: async () => SECRET }, jevTransport: transport });
  assert.deepEqual(await h.handle("warm", { repositoryId }), { ok: true });
  await until(() => transport.log.preconnects === 1);
  assert.equal(transport.log.stops, 0);
  await setOn(h, false);
  assert.equal(transport.log.stops, 1, "Off gives up the connection that was being opened");
  assert.equal(transport.log.fetches, 0, "and nothing was sent");
  assert.deepEqual(await h.handle("warm", { repositoryId }), CONFLICT);
  assert.equal(transport.log.preconnects, 1);
});
