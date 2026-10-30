// A chat turn with the effort routing: the Jev call runs beside the preparation, may only lower the owner's effort, never delays the turn past
// its timeout, and is recorded on the answer. The provider run, the monitor, and Jev are fakes.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { JEV_PREVIOUS_LIMIT } from "../desktop/runtime/agent-chat-jev.mjs";
import { addImage, agentMessage, chatHarness, finishTurn, repositoryId, root, seedCurrent, send, until, userMessage } from "./helpers/agent-chat-harness.mjs";

const SECRET = "jev-secret-key-0123456789";
const choice = (value) => ({ model: "jev-latest", answers: { effort: { type: "choice", choice: value, confidence: 0.8, probabilities: { low: 0.1, medium: 0.1, high: 0.8 } } }, usage: { input_tokens: 80, output_tokens: 2 } });

// A Jev that answers `body` and records each call as `{ url, init, body }`.
function fakeJev(body = choice("low")) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return typeof body === "function" ? body(init) : new Response(JSON.stringify(body), { status: 200 });
  };
  return { calls, fetch };
}

const withKey = (jev, extra = {}) => ({ jevKey: { read: async () => SECRET }, jevFetch: jev.fetch, ...extra });
const read = (h, conversationId) => h.handle("read", { repositoryId, conversationId });

async function answerOf(h, sent, text = "Fine.") {
  h.runs.at(-1).measured = { eventMs: 100, textMs: 300, doneMs: 900 };
  const conversation = await finishTurn(h, h.runs.at(-1), { status: "complete", text }, sent.conversationId);
  return conversation.messages.at(-1);
}

test("with no key the turn is as it was: nothing is asked and no route is recorded", async (context) => {
  const jev = fakeJev();
  const h = await chatHarness(context, { jevFetch: jev.fetch });
  const sent = await send(h, { text: "thanks", effort: "high" });
  assert.equal(sent.ok, true);
  assert.equal(jev.calls.length, 0);
  assert.equal(h.runs[0].options.effort, "high");
  const answer = await answerOf(h, sent);
  assert.equal(answer.effort, "high");
  assert.equal(Object.hasOwn(answer.timing, "route"), false);
});

test("Jev lowers the effort: the run, the answer, and the tooltip's record say so, and the owner's choice stays the thread's", async (context) => {
  const jev = fakeJev(choice("low"));
  const h = await chatHarness(context, withKey(jev));
  const sent = await send(h, { text: "thanks, that is all", effort: "high" });
  assert.equal(sent.ok, true);
  assert.equal(jev.calls.length, 1);
  assert.equal(h.runs[0].options.effort, "low", "the provider run starts with the lowered effort");
  const running = (await read(h, sent.conversationId)).turn;
  assert.equal(running.effort, "low");
  const answer = await answerOf(h, sent);
  assert.equal(answer.effort, "low");
  assert.equal(answer.timing.route.by, "jev");
  assert.equal(answer.timing.route.effort, "low");
  assert.equal(Number.isInteger(answer.timing.route.ms), true);
  assert.deepEqual(Object.keys(answer.timing.route), ["effort", "by", "ms"]);
  // The composer's effort is the thread's, so the next message and the next warm run start from it.
  const thread = await h.handle("thread", { repositoryId });
  assert.equal(thread.run.effort, "high");
  assert.equal((await read(h, sent.conversationId)).conversation.effort, "high");
});

test("Jev never raises the effort, and an answer that is not lower is recorded as kept", async (context) => {
  const jev = fakeJev(choice("high"));
  const h = await chatHarness(context, withKey(jev));
  const sent = await send(h, { text: "plan the whole backlog", effort: "medium" });
  assert.equal(h.runs[0].options.effort, "medium");
  const answer = await answerOf(h, sent);
  assert.equal(answer.effort, "medium");
  assert.deepEqual({ ...answer.timing.route, ms: 0 }, { effort: "medium", by: "owner", reason: "kept", ms: 0 });
  // With no effort chosen only `low` can lower the provider's own.
  const second = await send(h, { text: "and the rest?" });
  assert.equal(h.runs[1].options.effort, null);
  assert.equal((await answerOf(h, second)).timing.route.reason, "kept");
});

test("a Jev that does not answer in time costs the turn only its timeout, and the owner's effort runs", async (context) => {
  const hanging = fakeJev(() => new Promise(() => {}));
  const h = await chatHarness(context, withKey(hanging, { jevTimeoutMs: 40 }));
  const started = performance.now();
  const sent = await send(h, { text: "thanks", effort: "high" });
  assert.equal(sent.ok, true);
  assert.ok(performance.now() - started < 2_000);
  assert.equal(hanging.calls.length, 1, "no retry");
  assert.equal(h.runs[0].options.effort, "high");
  const answer = await answerOf(h, sent);
  assert.equal(answer.effort, "high");
  assert.equal(answer.timing.route.by, "owner");
  assert.equal(answer.timing.route.reason, "timeout");
});

test("an error, a refusal, or a malformed answer from Jev leaves the owner's effort and records a fixed reason", async (context) => {
  const cases = [
    ["error", () => { throw new TypeError("network down"); }],
    ["error", () => new Response("denied", { status: 401 })],
    ["invalid", () => new Response("{not json", { status: 200 })],
    ["invalid", () => new Response(JSON.stringify(choice("extreme")), { status: 200 })],
  ];
  for (const [reason, handler] of cases) {
    const h = await chatHarness(context, withKey(fakeJev(handler)));
    const sent = await send(h, { text: "thanks", effort: "high" });
    assert.equal(sent.ok, true);
    assert.equal(h.runs[0].options.effort, "high");
    const answer = await answerOf(h, sent);
    assert.equal(answer.effort, "high");
    assert.equal(answer.timing.route.reason, reason);
    assert.equal(JSON.stringify(answer).includes("network down"), false, "no error text is kept");
  }
});

test("Jev is asked while the preparation still runs, not after it", async (context) => {
  const jev = fakeJev(choice("low"));
  const h = await chatHarness(context, withKey(jev));
  let release;
  h.state.gate = new Promise((resolve) => { release = resolve; });
  const sending = send(h, { text: "thanks", effort: "high" });
  await until(() => jev.calls.length === 1);
  assert.equal(h.runs.length, 0, "the board read still holds the turn, and Jev was asked all the same");
  release();
  assert.equal((await sending).ok, true);
  assert.equal(h.runs[0].options.effort, "low");
});

test("what Jev is sent is the owner's message and the end of Aril's previous answer, and nothing else", async (context) => {
  const jev = fakeJev(choice("medium"));
  const h = await chatHarness(context, withKey(jev, { viaDataRoot: true }));
  const long = `Earlier part with the secret repository name private-repo. ${"z".repeat(JEV_PREVIOUS_LIMIT + 500)} FINAL WORDS`;
  await seedCurrent(h, { messages: [userMessage(1, "An old private question T-1"), agentMessage(2, { text: "An old answer about Existing task one" }), userMessage(3, "Second"), agentMessage(4, { text: long })] });
  const sent = await send(h, { text: "OWNER-SAYS-HELLO", effort: "high" });
  assert.equal(sent.ok, true);
  assert.equal(jev.calls.length, 1);
  const { state } = jev.calls[0].body;
  assert.match(state, /OWNER-SAYS-HELLO/u);
  assert.equal(state.endsWith("FINAL WORDS"), true);
  assert.equal(state.includes("private-repo"), false, "the cut drops the start of the answer");
  assert.equal(state.includes("old private question"), false, "no earlier part of the conversation");
  assert.equal(state.includes("Existing task one"), false);
  const sent2 = JSON.stringify(jev.calls[0]);
  for (const forbidden of [root, repositoryId, "Existing task", "T-2", "col-a", "board_snapshot"]) assert.equal(sent2.includes(forbidden), false, forbidden);
  assert.equal(jev.calls[0].init.headers.authorization, `Bearer ${SECRET}`);
  assert.ok(state.length <= "Owner's message:\nOWNER-SAYS-HELLO\n\nEnd of Aril's previous answer (at most 2000 characters):\n".length + JEV_PREVIOUS_LIMIT);
});

test("a message with an image is not asked about, and the owner's effort runs", async (context) => {
  const jev = fakeJev(choice("low"));
  const h = await chatHarness(context, withKey(jev, { viaDataRoot: true }));
  const image = await addImage(h);
  const sent = await send(h, { text: "what is wrong here?", effort: "high", images: [image.id] });
  assert.equal(sent.ok, true);
  assert.equal(jev.calls.length, 0);
  assert.equal(h.runs[0].options.effort, "high");
  assert.equal((await answerOf(h, sent)).timing.route.reason, "images");
});

test("a follow-up after an applied proposal is not asked about, and keeps the conversation's effort", async (context) => {
  const jev = fakeJev(choice("low"));
  const h = await chatHarness(context, withKey(jev));
  const stored = await seedCurrent(h);
  await h.store.save(repositoryId, { ...stored, effort: "high", messages: [userMessage(1), agentMessage(2, { proposal: { id: "p-0123456789ab", summary: "Tidy", state: "pending", operations: [{ op: "queue_task", id: "T-2" }] } })] });
  h.state.actions = () => ({ ok: true });
  assert.deepEqual(await h.handle("dismiss", { repositoryId, conversationId: stored.id, proposalId: "p-0123456789ab" }), { ok: true });
  const run = await h.followUp();
  assert.equal(run.options.effort, "high");
  assert.equal(jev.calls.length, 0);
  await h.finishFollowUp(stored.id);
});

test("the key reaches only the Jev request header: not a run, a prompt, the monitor, a stored file, or anything the renderer reads", async (context) => {
  const jev = fakeJev(choice("low"));
  const h = await chatHarness(context, withKey(jev, { viaDataRoot: true }));
  const sent = await send(h, { text: "thanks", effort: "high" });
  const answer = await answerOf(h, sent);
  const surfaces = {
    runs: JSON.stringify(h.runs.map((run) => run.options)),
    monitor: JSON.stringify(h.calls.map((call) => [call.url, call.init, call.body])),
    declarations: JSON.stringify(h.declarations.map((entry) => entry.call.url)),
    answer: JSON.stringify(answer),
    read: JSON.stringify(await read(h, sent.conversationId)),
    thread: JSON.stringify(await h.handle("thread", { repositoryId })),
    list: JSON.stringify(await h.handle("list", { repositoryId })),
    search: JSON.stringify(await h.handle("search", { repositoryId, query: "thanks" })),
  };
  for (const [name, text] of Object.entries(surfaces)) assert.equal(text.includes(SECRET), false, name);
  // Nor any file under the data root.
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
  for (const file of walk(h.dataRoot)) assert.equal(readFileSync(file).includes(Buffer.from(SECRET)), false, file);
  // The only place it appears is the one request's header.
  assert.equal(JSON.stringify(jev.calls.map((call) => call.init.headers)).includes(SECRET), true);
  assert.equal(JSON.stringify(jev.calls.map((call) => call.body)).includes(SECRET), false);
});

test("no chat operation reaches the key: a paired device and the renderer's chat channel have none, and the controller offers the key store only to desktop main", async (context) => {
  const h = await chatHarness(context, withKey(fakeJev()));
  for (const operation of ["jev", "jevKey", "key", "settings", "status"]) assert.deepEqual(await h.handle(operation, { repositoryId }), { ok: false, error: "invalid" }, operation);
  assert.deepEqual(await h.chat.handle("send", { repositoryId, conversationId: null, text: "x", provider: "claude", model: null, jevKey: SECRET }, { paired: true }), { ok: false, error: "invalid" }, "a send takes no key");
});

// A transport that records what it is asked: its fetch carries the call, its preconnect carries nothing.
function fakeTransport(body = choice("low"), behavior = {}) {
  const log = { fetches: [], preconnects: [] };
  return {
    log,
    fetch: async (url, init) => { log.fetches.push({ url, init, body: JSON.parse(init.body) }); return behavior.fetch ? behavior.fetch(init) : new Response(JSON.stringify(body), { status: 200 }); },
    preconnect: async (...args) => { log.preconnects.push(args); if (behavior.preconnect) return behavior.preconnect(); return true; },
  };
}
const settleTicks = () => new Promise((resolve) => setTimeout(resolve, 30));

test("the warm request opens the connection to Jev ahead of the send, with a key, and sends nothing over it", async (context) => {
  const transport = fakeTransport();
  const h = await chatHarness(context, { jevKey: { read: async () => SECRET }, jevTransport: transport });
  assert.deepEqual(await h.handle("warm", { repositoryId }), { ok: true });
  await until(() => transport.log.preconnects.length === 1);
  assert.deepEqual(transport.log.preconnects[0], [], "no argument: no text, no key, no run");
  assert.deepEqual(await h.handle("warm", { repositoryId, provider: "claude", model: null, effort: "high" }), { ok: true });
  await until(() => transport.log.preconnects.length === 2);
  assert.equal(transport.log.fetches.length, 0, "the pre-connect made no call");
  // A paired device's warm request opens it too: it is the same bounded request, and what it opens carries nothing.
  assert.deepEqual(await h.chat.handle("warm", { repositoryId }, { paired: true }), { ok: true });
  await until(() => transport.log.preconnects.length === 3);
  // A request that is refused opens nothing.
  assert.deepEqual(await h.handle("warm", { repositoryId, extra: 1 }), { ok: false, error: "invalid" });
  assert.deepEqual(await h.handle("warm", { repositoryId, provider: "claude" }), { ok: false, error: "invalid" });
  await settleTicks();
  assert.equal(transport.log.preconnects.length, 3);
  assert.equal(JSON.stringify(transport.log).includes(SECRET), false);
});

test("without a key nothing opens: no key store, a store with no key, or a key that cannot be read", async (context) => {
  for (const jevKey of [undefined, { read: async () => null }, { read: async () => { throw new Error("unreadable"); } }]) {
    const transport = fakeTransport();
    const h = await chatHarness(context, { ...(jevKey ? { jevKey } : {}), jevTransport: transport });
    assert.deepEqual(await h.handle("warm", { repositoryId }), { ok: true });
    await settleTicks();
    assert.equal(transport.log.preconnects.length, 0);
    const sent = await send(h, { text: "thanks", effort: "high" });
    assert.equal(sent.ok, true);
    assert.equal(transport.log.fetches.length, 0);
    assert.equal(h.runs[0].options.effort, "high");
  }
});

test("a pre-connect that fails or never ends changes nothing for the warm request or the send", async (context) => {
  for (const preconnect of [async () => { throw new Error("handshake failed"); }, async () => false, () => new Promise(() => {})]) {
    const transport = fakeTransport(choice("low"), { preconnect });
    const h = await chatHarness(context, { jevKey: { read: async () => SECRET }, jevTransport: transport });
    assert.deepEqual(await h.handle("warm", { repositoryId }), { ok: true });
    await until(() => transport.log.preconnects.length === 1);
    const sent = await send(h, { text: "thanks", effort: "high" });
    assert.equal(sent.ok, true);
    assert.equal(h.runs[0].options.effort, "low", "the send still asked and still lowered the effort");
  }
  // A fetch given in place of the transport (the tests' own) has no pre-connect to open.
  const jev = fakeJev();
  const h = await chatHarness(context, withKey(jev));
  assert.deepEqual(await h.handle("warm", { repositoryId }), { ok: true });
  await settleTicks();
  assert.equal(jev.calls.length, 0);
});

test("the turn's call goes through the transport, keeps its timeout, and records where a call that did not answer was waiting", async (context) => {
  const transport = fakeTransport(choice("low"));
  const h = await chatHarness(context, { jevKey: { read: async () => SECRET }, jevTransport: transport });
  const sent = await send(h, { text: "thanks", effort: "high" });
  assert.equal(sent.ok, true);
  assert.equal(transport.log.fetches.length, 1);
  assert.equal(transport.log.fetches[0].init.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(h.runs[0].options.effort, "low");

  const hanging = fakeTransport(choice("low"), { fetch: (init) => { init.watch(() => "connect"); return new Promise(() => {}); } });
  const slow = await chatHarness(context, { jevKey: { read: async () => SECRET }, jevTransport: hanging, jevTimeoutMs: 40 });
  const started = performance.now();
  const sentSlow = await send(slow, { text: "thanks", effort: "high" });
  assert.equal(sentSlow.ok, true);
  assert.ok(performance.now() - started < 2_000, "the timeout still bounds the wait");
  assert.equal(slow.runs[0].options.effort, "high");
  const answer = await answerOf(slow, sentSlow);
  assert.equal(answer.timing.route.reason, "timeout");
  assert.equal(answer.timing.route.phase, "connect");
  assert.equal(hanging.log.fetches.length, 1, "no retry");
});
