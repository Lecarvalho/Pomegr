// Effort routing with Jev: an option that is off until a key is set. Everything here runs on a fake `fetch`: no request leaves the test.

import assert from "node:assert/strict";
import test from "node:test";

import { createJevRouting, JEV_INSTRUCTIONS, JEV_MODEL, JEV_PREVIOUS_LIMIT, JEV_TIMEOUT_MS, JEV_URL, jevBody, jevState, loweredEffort, previousAnswer } from "../desktop/runtime/agent-chat-jev.mjs";
import { normalizeRoute, normalizeTiming, timingOf } from "../desktop/runtime/agent-chat-timing.mjs";

const SECRET = "jev-secret-key-0123456789";
const keyed = { read: async () => SECRET };
const answer = (choice, extra = {}) => ({ model: "jev-latest", answers: { effort: { type: "choice", choice, confidence: 0.9, probabilities: { low: 0.1, medium: 0.1, high: 0.8 }, ...extra } }, usage: { input_tokens: 90, output_tokens: 2 } });
const respond = (body, init = {}) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init });

function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  return { fetch, calls };
}

const routing = (fetch, options = {}) => createJevRouting({ key: keyed, fetch, timeoutMs: 50, ...options });

test("with no key nothing is asked: the effort is the owner's and no route is recorded", async () => {
  const { fetch, calls } = fakeFetch(respond(answer("low")));
  for (const key of [null, { read: async () => null }, { read: async () => { throw new Error("unreadable"); } }]) {
    assert.deepEqual(await createJevRouting({ key, fetch }).route({ text: "thanks", previous: "", effort: "high" }), { effort: "high", route: null });
  }
  assert.equal(calls.length, 0, "no call without a key");
});

test("the call is one POST with the key as a bearer token, the fixed model, and one choice question", async () => {
  const { fetch, calls } = fakeFetch(respond(answer("low")));
  await routing(fetch).route({ text: "thanks!", previous: "Done.", effort: "high" });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(url, JEV_URL);
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, { authorization: `Bearer ${SECRET}`, "content-type": "application/json" });
  assert.equal(init.redirect, "error");
  assert.equal(init.cache, "no-store");
  assert.ok(init.signal instanceof AbortSignal);
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body), ["state", "model", "questions"]);
  assert.equal(body.model, JEV_MODEL);
  assert.deepEqual(Object.keys(body.questions), ["effort"]);
  assert.deepEqual(body.questions.effort, { type: "choice", instructions: JEV_INSTRUCTIONS, criteria: { low: null, medium: null, high: null } });
  assert.equal(init.body.includes(SECRET), false, "the key is in the header and nowhere else");
  // The instructions say when each level fits.
  for (const word of ["acknowledgment", "thanks", "yes or no", "small talk", "planning", "backlog", "diagnosing", "multi-step"]) assert.match(JEV_INSTRUCTIONS, new RegExp(word, "u"));
});

test("the state is the owner's message and the end of the previous answer, each labeled, and nothing else", async () => {
  const { fetch, calls } = fakeFetch(respond(answer("medium")));
  const previous = `${"x".repeat(5_000)}THE-END`;
  await routing(fetch).route({ text: "OWNER-MESSAGE", previous, effort: "high", images: 0 });
  const { state } = JSON.parse(calls[0].init.body);
  assert.equal(state, `Owner's message:\nOWNER-MESSAGE\n\nEnd of Aril's previous answer (at most 2000 characters):\n${previous.slice(-2_000)}`);
  assert.equal(state.endsWith("THE-END"), true, "the end of the answer is kept");
  assert.equal(JEV_PREVIOUS_LIMIT, 2_000);
  assert.equal(state.length < 2_000 + 200, true);
  // Exactly the last 2,000 characters, whatever the length of the answer.
  assert.equal(jevState({ text: "a", previous: "y".repeat(2_000) }).split("\n").at(-1).length, 2_000);
  assert.equal(jevState({ text: "a", previous: "y".repeat(2_001) }).split("\n").at(-1).length, 2_000);
  assert.equal(jevState({ text: "a", previous: "y".repeat(10) }).split("\n").at(-1).length, 10);
  assert.match(jevState({ text: "a", previous: "" }), /\(none\)$/u, "a thread with no answer yet says so");
  assert.match(jevState({ text: "a", previous: undefined }), /\(none\)$/u);
  assert.equal(JSON.parse(jevBody("S")).state, "S");
});

test("Jev may only lower the owner's effort, on the ordered scale", () => {
  const cases = [
    ["high", "low", "low"], ["high", "medium", "medium"], ["high", "high", "high"], ["medium", "high", "medium"], ["medium", "low", "low"], ["low", "high", "low"], ["low", "medium", "low"],
    ["xhigh", "high", "high"], ["xhigh", "low", "low"], ["xhigh", "medium", "medium"],
    // No effort chosen: the provider's own level is unknown, so only `low`, below which nothing is, can lower it.
    [null, "low", "low"], [null, "medium", null], [null, "high", null],
  ];
  for (const [owner, chosen, used] of cases) assert.equal(loweredEffort(owner, chosen), used, `${owner} with ${chosen}`);
  // Anything that is not one of Jev's three levels leaves the owner's effort alone.
  for (const odd of ["xhigh", "max", "LOW", "", null, undefined, 3, {}]) assert.equal(loweredEffort("high", odd), "high", String(odd));
});

test("a lower answer is used and recorded as Jev's, with its time; an answer that does not lower is the owner's", async () => {
  let now = 0;
  const clock = () => now;
  const slow = (choice) => async () => { now += 420; return new Response(JSON.stringify(answer(choice)), { status: 200 }); };
  assert.deepEqual(await routing(slow("low"), { clock }).route({ text: "thanks", effort: "high" }), { effort: "low", route: { effort: "low", by: "jev", ms: 420 } });
  assert.deepEqual(await routing(slow("medium"), { clock }).route({ text: "thanks", effort: "xhigh" }), { effort: "medium", route: { effort: "medium", by: "jev", ms: 420 } });
  assert.deepEqual(await routing(slow("high"), { clock }).route({ text: "plan it", effort: "high" }), { effort: "high", route: { effort: "high", by: "owner", reason: "kept", ms: 420 } });
  assert.deepEqual(await routing(slow("high"), { clock }).route({ text: "plan it", effort: "low" }), { effort: "low", route: { effort: "low", by: "owner", reason: "kept", ms: 420 } });
  assert.deepEqual(await routing(slow("medium"), { clock }).route({ text: "hm", effort: null }), { effort: null, route: { effort: null, by: "owner", reason: "kept", ms: 420 } });
  assert.deepEqual(await routing(slow("low"), { clock }).route({ text: "thanks", effort: null }), { effort: "low", route: { effort: "low", by: "jev", ms: 420 } });
});

test("no answer in time is the owner's effort, once, and the call is aborted and never retried", async () => {
  // A fetch that ignores the abort signal and never answers must still not hold the turn.
  const hanging = fakeFetch(() => new Promise(() => {}));
  const started = performance.now();
  const result = await routing(hanging.fetch, { timeoutMs: 40 }).route({ text: "thanks", effort: "high" });
  assert.ok(performance.now() - started < 1_000, "the turn does not wait past the timeout");
  assert.deepEqual(result, { effort: "high", route: { effort: "high", by: "owner", reason: "timeout", ms: result.route.ms } });
  assert.ok(result.route.ms >= 35 && result.route.ms < 1_000);
  assert.equal(hanging.calls.length, 1, "no retry");
  assert.equal(hanging.calls[0].init.signal.aborted, true, "the pending call was aborted");
  // One that honors the signal rejects at the abort, and that is the same outcome.
  const honoring = fakeFetch((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
  assert.equal((await routing(honoring.fetch, { timeoutMs: 30 }).route({ text: "x", effort: "medium" })).route.reason, "timeout");
  // The default bound is one and a half seconds.
  assert.equal(JEV_TIMEOUT_MS, 1_500);
});

test("an error, a refusal, or an answer that is not exactly one of three levels is the owner's effort", async () => {
  const bad = [
    ["a failed request", async () => { throw new TypeError("fetch failed"); }, "error"],
    ["a 401", respond(answer("low"), { status: 401 }), "error"],
    ["a 500", respond("oops", { status: 500 }), "error"],
    ["a redirect", async () => { throw new TypeError("redirect"); }, "error"],
    ["text", respond("not json"), "invalid"],
    ["an empty object", respond({}), "invalid"],
    ["no effort answer", respond({ answers: {} }), "invalid"],
    ["a wrong type", respond({ answers: { effort: { type: "text", choice: "low" } } }), "invalid"],
    ["an unknown choice", respond(answer("extreme")), "invalid"],
    ["xhigh", respond(answer("xhigh")), "invalid"],
    ["a capital", respond(answer("Low")), "invalid"],
    ["a number", respond(answer(1)), "invalid"],
    ["null", respond("null"), "invalid"],
    ["an array", respond("[]"), "invalid"],
    ["an enormous body", respond(`{"padding":"${"a".repeat(70 * 1024)}"}`), "invalid"],
  ];
  for (const [name, handler, reason] of bad) {
    const { fetch } = fakeFetch(handler);
    const result = await routing(fetch).route({ text: "thanks", effort: "high" });
    assert.equal(result.effort, "high", name);
    assert.equal(result.route.by, "owner", name);
    assert.equal(result.route.reason, reason, name);
    assert.equal(Number.isInteger(result.route.ms), true, name);
  }
});

test("a message with images is not sent to Jev, and the owner's effort is used", async () => {
  const { fetch, calls } = fakeFetch(respond(answer("low")));
  assert.deepEqual(await routing(fetch).route({ text: "look at this", effort: "high", images: 2 }), { effort: "high", route: { effort: "high", by: "owner", reason: "images" } });
  assert.equal(calls.length, 0);
});

test("neither the key nor any error text reaches the record, and a record is only fixed words and numbers", async () => {
  const failing = fakeFetch(async () => { throw new Error(`boom ${SECRET}`); });
  const records = [
    await routing(failing.fetch).route({ text: "a", effort: "high" }),
    await routing(fakeFetch(respond(answer("low"))).fetch).route({ text: "a", effort: "high" }),
    await routing(fakeFetch(respond(`${SECRET} not json`)).fetch).route({ text: "a", effort: "high" }),
  ];
  for (const record of records) {
    assert.equal(JSON.stringify(record).includes(SECRET), false);
    assert.deepEqual(normalizeRoute(record.route), record.route, "every record is inside the contract");
    assert.ok(Object.keys(record.route).every((name) => ["effort", "by", "reason", "ms"].includes(name)));
  }
});

test("the previous answer is the newest answer of Aril's own run, not a grant's fixed line", () => {
  const user = (text) => ({ role: "user", text });
  const agent = (text, extra = {}) => ({ role: "agent", text, status: "complete", ...extra });
  assert.equal(previousAnswer([user("a"), agent("first"), user("b"), agent("second")]), "second");
  assert.equal(previousAnswer([user("a"), agent("first"), user("b"), agent("", { status: "stopped" })]), "first", "an empty answer says nothing");
  assert.equal(previousAnswer([agent("run"), agent("Started T-1.", { grantFollowUp: true })]), "run");
  assert.equal(previousAnswer([user("a")]), "");
  assert.equal(previousAnswer(undefined), "");
  assert.equal(previousAnswer([]), "");
});

test("a route is whole milliseconds and fixed words; a timing carries it and drops one outside the contract", () => {
  assert.deepEqual(normalizeRoute({ effort: "low", by: "jev", ms: 412 }), { effort: "low", by: "jev", ms: 412 });
  assert.deepEqual(normalizeRoute({ effort: "high", by: "owner", reason: "timeout", ms: 1_500 }), { effort: "high", by: "owner", reason: "timeout", ms: 1_500 });
  assert.deepEqual(normalizeRoute({ effort: null, by: "owner", reason: "images" }), { effort: null, by: "owner", reason: "images" });
  for (const bad of [
    null, [], "low", {}, { effort: "xhigh", by: "jev", ms: 5 }, { effort: "low", by: "jev" }, { effort: "low", by: "jev", ms: -1 }, { effort: "low", by: "jev", ms: 1.5 }, { effort: "low", by: "jev", ms: 5, reason: "kept" },
    { effort: "low", by: "owner" }, { effort: "low", by: "owner", reason: "because the API said no" }, { effort: "max", by: "owner", reason: "kept" }, { effort: "low", by: "owner", reason: "kept", ms: "5" },
    { effort: "low", by: "owner", reason: "kept", ms: 3_600_001 }, { effort: "low", by: "owner", reason: "kept", extra: 1 }, { effort: "low", by: "someone", reason: "kept" },
  ]) assert.equal(normalizeRoute(bad), null, JSON.stringify(bad));
  const base = { eventMs: 1, textMs: 2, doneMs: 3, prompt: { instructions: 1, board: 2, taskLog: 3, conversation: 4, message: 5, other: 6 } };
  const route = { effort: "low", by: "jev", ms: 300 };
  assert.deepEqual(normalizeTiming({ ...base, route }), { ...base, route });
  assert.equal(Object.hasOwn(normalizeTiming(base), "route"), false, "a timing of an older version or of a turn with no key has none");
  assert.deepEqual(normalizeTiming({ ...base, route: { effort: "low", by: "jev", ms: "slow" } }), base, "a bad route is dropped alone");
  assert.deepEqual(timingOf({ eventMs: 1, textMs: 2, doneMs: 3 }, { board: 2, instructions: 1, taskLog: 3, conversation: 4, message: 5, other: 6 }, null, route).route, route);
  assert.equal(Object.hasOwn(timingOf({ eventMs: 1, textMs: 2, doneMs: 3 }, {}, null, null), "route"), false);
});

test("with the key already read, the request goes out before route returns, ahead of the turn's other reads", async () => {
  const { fetch, calls } = fakeFetch(respond(answer("low")));
  const read = { peek: () => SECRET, read: async () => { throw new Error("The read must not be waited for."); } };
  const pending = createJevRouting({ key: read, fetch, timeoutMs: 50 }).route({ text: "thanks", effort: "high" });
  assert.equal(calls.length, 1, "the request was made in the same turn of the event loop as the call");
  assert.equal((await pending).effort, "low");
  // A key that was not read yet is waited for, and a key store without a peek is read.
  const late = fakeFetch(respond(answer("low")));
  const unread = createJevRouting({ key: { peek: () => undefined, read: async () => SECRET }, fetch: late.fetch, timeoutMs: 50 }).route({ text: "thanks", effort: "high" });
  assert.equal(late.calls.length, 0);
  assert.equal((await unread).effort, "low");
  assert.equal(late.calls.length, 1);
  // A key store that peeked "none" asks nothing.
  const none = fakeFetch(respond(answer("low")));
  assert.deepEqual(await createJevRouting({ key: { peek: () => null, read: async () => SECRET }, fetch: none.fetch }).route({ text: "x", effort: "high" }), { effort: "high", route: null });
  assert.equal(none.calls.length, 0);
});

test("a timeout names the phase the call waited in, with a fixed word, and nothing else carries one", async () => {
  for (const phase of ["dns", "connect", "response"]) {
    const waiting = fakeFetch((_url, init) => { init.watch(() => phase); return new Promise(() => {}); });
    const result = await routing(waiting.fetch, { timeoutMs: 30 }).route({ text: "thanks", effort: "high" });
    assert.deepEqual(result, { effort: "high", route: { effort: "high", by: "owner", reason: "timeout", ms: result.route.ms, phase } });
    assert.deepEqual(normalizeRoute(result.route), result.route);
  }
  // A reader that says something else, or throws, or none at all, is a timeout without a phase.
  for (const reader of [() => "tls-version", () => null, () => 5, () => { throw new Error("secret"); }]) {
    const waiting = fakeFetch((_url, init) => { init.watch(reader); return new Promise(() => {}); });
    const result = await routing(waiting.fetch, { timeoutMs: 30 }).route({ text: "thanks", effort: "high" });
    assert.equal(result.route.reason, "timeout");
    assert.equal(Object.hasOwn(result.route, "phase"), false);
  }
  assert.equal(Object.hasOwn((await routing(fakeFetch(() => new Promise(() => {})).fetch, { timeoutMs: 30 }).route({ text: "x", effort: "high" })).route, "phase"), false);
  const refused = await routing(fakeFetch((_url, init) => { init.watch(() => "dns"); return new Response("no", { status: 401 }); }).fetch).route({ text: "x", effort: "high" });
  assert.equal(Object.hasOwn(refused.route, "phase"), false, "only a timeout names a phase");
  for (const bad of [{ phase: "tls" }, { phase: null }, { reason: "error", phase: "dns" }, { reason: "kept", phase: "dns" }]) {
    assert.equal(normalizeRoute({ effort: "high", by: "owner", reason: "timeout", ms: 5, ...bad }), null, JSON.stringify(bad));
  }
  assert.deepEqual(normalizeRoute({ effort: null, by: "owner", reason: "timeout", phase: "connect" }), { effort: null, by: "owner", reason: "timeout", phase: "connect" });
});

test("the default call goes through the transport; the fetch given replaces it, and a pre-connect needs a key and a transport that can", async () => {
  const sent = [];
  const transport = { opened: 0, fetch: async (url, init) => { sent.push([url, init.method]); return new Response(JSON.stringify(answer("low")), { status: 200 }); }, preconnect: async function () { transport.opened += 1; return true; } };
  const keyed_ = createJevRouting({ key: keyed, transport, timeoutMs: 50 });
  assert.equal((await keyed_.route({ text: "thanks", effort: "high" })).effort, "low");
  assert.deepEqual(sent, [[JEV_URL, "POST"]]);
  assert.equal(await keyed_.preconnect(), true);
  assert.equal(transport.opened, 1, "one pre-connect, with no argument and no call of the transport's fetch");
  assert.equal(sent.length, 1);
  // No key, an unreadable key, no key store: nothing opens.
  for (const key of [null, undefined, { read: async () => null }, { read: async () => { throw new Error("unreadable"); } }]) {
    assert.equal(await createJevRouting({ key, transport }).preconnect(), false);
  }
  assert.equal(transport.opened, 1);
  // A transport that cannot pre-connect, or fails to, and a fetch given in its place (as the tests do): false, never a rejection.
  assert.equal(await createJevRouting({ key: keyed, transport: { fetch: transport.fetch } }).preconnect(), false);
  assert.equal(await createJevRouting({ key: keyed, transport: { fetch: transport.fetch, preconnect: async () => { throw new Error("handshake"); } } }).preconnect(), false);
  assert.equal(await createJevRouting({ key: keyed, fetch: fakeFetch(respond(answer("low"))).fetch }).preconnect(), false);
});
