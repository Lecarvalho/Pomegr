// With Aril Off, everything under the switch is read only: desktop main refuses the owner's memory edit, a repository's memory edit (from the
// desktop window and from a paired device), the flush limit, and the owner's flush, and answers `conflict`. Reads still answer. The automatic
// flush is desktop housekeeping, not an action of Aril, and keeps running. Aril's own memory update is refused while Aril is Off too.

import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLanGateway } from "../desktop/runtime/lan-gateway.mjs";
import { createArilControl } from "../desktop/runtime/agent-chat-aril.mjs";
import { createAgentChatImages } from "../desktop/runtime/agent-chat-images.mjs";
import { AGENT_CHAT_DIRECTORY, createAgentChatStore } from "../desktop/runtime/agent-chat-store.mjs";
import { createArilSwitch } from "../desktop/runtime/aril-switch.mjs";
import { createOwnerMemory, OWNER_MEMORY_FILE } from "../desktop/runtime/aril-owner-memory.mjs";
import { createThreadLimit } from "../desktop/runtime/aril-thread-limit.mjs";
import { createThreadSpace } from "../desktop/runtime/agent-chat-space.mjs";
import { createTaskAction, installTaskActionIpc } from "../desktop/runtime/task-action.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const desktop = { event: {} };
const conflict = { ok: false, error: "conflict" };
const AUTHORIZATION = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const loopbackTestNetwork = Object.freeze({
  isBindHostAllowed: (host, mask) => host === "127.0.0.1" && mask === "255.255.255.0",
  isClientAddressAllowed: (address) => address === "127.0.0.1",
});
const at = (n) => new Date(Date.parse("2026-10-01T10:00:00.000Z") + n * 60_000).toISOString();

async function fixture(context, { on, limit = 5 }) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-off-writes-"));
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const directory = path.join(dataRoot, AGENT_CHAT_DIRECTORY);
  const store = createAgentChatStore({ directory });
  const images = createAgentChatImages({ directory });
  const arilSwitch = createArilSwitch({ initial: { on } });
  const ownerMemory = createOwnerMemory({ file: path.join(dataRoot, "aril-v1", OWNER_MEMORY_FILE) });
  const threadLimit = createThreadLimit({});
  await threadLimit.set(limit);
  const space = createThreadSpace({ directory, store, images, busy: () => false, limit: () => threadLimit.bytes() });
  const control = createArilControl({ arilSwitch, ownerMemory, threadLimit, space });
  return { dataRoot, directory, store, images, arilSwitch, ownerMemory, threadLimit, space, control, handlers: control.handlers };
}

async function thread(h, count, size = 400) {
  const created = await h.store.create(repositoryId, { provider: "claude", model: null, title: "Seeded" });
  const messages = Array.from({ length: count }, (_, index) => (index % 2 === 0
    ? { id: `m-${index + 1}`, role: "user", text: `Question ${index} `.padEnd(size, "x"), at: at(index) }
    : { id: `m-${index + 1}`, role: "agent", text: `Answer ${index} `.padEnd(size, "x"), at: at(index), provider: "claude", model: null, status: "complete" }));
  assert.ok(await h.store.save(repositoryId, { ...created, messages, updatedAt: at(count) }));
  return messages;
}

test("with Aril Off the owner's memory, the limit, and the owner's flush are refused with conflict, and the reads still answer", async (context) => {
  const h = await fixture(context, { on: false });
  await thread(h, 10);
  assert.deepEqual(await h.handlers.owner_memory_set({ text: "- Reply briefly." }, desktop), conflict);
  assert.deepEqual(await h.handlers.thread_limit_set({ megabytes: 10 }, desktop), conflict);
  assert.deepEqual(await h.handlers.thread_flush({ repositoryId }, desktop), conflict);
  assert.equal((await h.ownerMemory.read()).text, "", "nothing was written");
  assert.equal(h.threadLimit.megabytes(), 5, "the limit is as it was");
  assert.equal((await h.store.read(repositoryId, (await h.store.index(repositoryId))[0].id)).messages.length, 10, "nothing was flushed");
  // Reads are not writes: they answer as they did.
  assert.equal((await h.handlers.owner_memory({}, { paired: true })).ok, true);
  assert.equal((await h.handlers.thread_space({}, desktop)).limit, 5);
  assert.deepEqual(await h.handlers.aril_switch({}, desktop), { ok: true, on: false, pairedOn: false });
  // Other refusals keep their words: the Off check follows the payload and the origin checks.
  assert.deepEqual(await h.handlers.owner_memory_set({ text: "x", extra: 1 }, desktop), { ok: false, error: "invalid" });
  assert.deepEqual(await h.handlers.owner_memory_set({ text: "x" }, { paired: true }), { ok: false, error: "desktop_only" });
  assert.deepEqual(await h.handlers.thread_limit_set({ megabytes: 3 }, desktop), conflict, "a value that is no choice is judged after the switch");
  assert.deepEqual(await h.handlers.thread_flush({ repositoryId }, undefined), { ok: false, error: "desktop_only" });
});

test("turning Aril On lets the same writes through, and turning it Off refuses them again at once", async (context) => {
  const h = await fixture(context, { on: false });
  await thread(h, 10);
  assert.deepEqual(await h.handlers.aril_switch_set({ on: true }, desktop), { ok: true, on: true });
  assert.equal((await h.handlers.owner_memory_set({ text: "- Reply briefly." }, desktop)).ok, true);
  assert.deepEqual(await h.handlers.thread_limit_set({ megabytes: 10 }, desktop), { ok: true, limit: 10 });
  assert.equal((await h.handlers.thread_flush({ repositoryId }, desktop)).ok, true);
  assert.deepEqual(await h.handlers.aril_switch_set({ on: false }, desktop), { ok: true, on: false });
  assert.deepEqual(await h.handlers.owner_memory_set({ text: "- Changed." }, desktop), conflict);
  assert.deepEqual(await h.handlers.thread_limit_set({ megabytes: 2 }, desktop), conflict);
  assert.equal((await h.ownerMemory.read()).text, "- Reply briefly.");
  assert.equal(h.threadLimit.megabytes(), 10);
});

test("a write at start waits for the switch to be read, so an On is never refused as the unread state", async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-off-start-"));
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await fs.mkdir(path.join(dataRoot, "aril-v1"), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "aril-v1", "switch.json"), JSON.stringify({ version: 1, on: true, pairedOn: false }));
  const control = createArilControl({ dataRoot });
  assert.equal((await control.handlers.owner_memory_set({ text: "- Saved at start." }, desktop)).ok, true);
});

test("the automatic flush keeps running while Aril is Off: it is housekeeping and not an action of Aril", async (context) => {
  const h = await fixture(context, { on: false, limit: 2 });
  // A thread that passes 2 MB, made of the longest answers a message may hold.
  const created = await h.store.create(repositoryId, { provider: "claude", model: null, title: "Big" });
  const messages = Array.from({ length: 100 }, (_, index) => (index % 2 === 0
    ? { id: `m-${index + 1}`, role: "user", text: `Question ${index}`, at: at(index) }
    : { id: `m-${index + 1}`, role: "agent", text: `Answer ${index} `.padEnd(32_000, "y"), at: at(index), provider: "claude", model: null, status: "complete" }));
  const second = await h.store.create(repositoryId, { provider: "claude", model: null, title: "Bigger" });
  assert.ok(await h.store.save(repositoryId, { ...created, messages, updatedAt: at(100) }));
  assert.ok(await h.store.save(repositoryId, { ...second, messages: messages.map((message, index) => ({ ...message, id: `m-${index + 1}`, at: at(1000 + index) })), updatedAt: at(1100) }));
  assert.equal(h.arilSwitch.isOn(), false);
  const result = await h.control.autoFlush(repositoryId);
  assert.equal(result.ok, true);
  assert.equal(result.flushed, true, "Aril is Off and the thread was still flushed");
  assert.deepEqual(await h.handlers.thread_flush({ repositoryId }, desktop), conflict, "while the owner's own flush is refused");
});

test("the renderer's task actions refuse a repository's memory edit while Aril is Off, and send every other action as before", async () => {
  const sent = [];
  let on = false;
  const action = createTaskAction({
    isTrustedEvent: (event) => event?.trusted === true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "secret", arilOn: () => on,
    fetch: async (url) => { sent.push(String(url)); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }); },
  });
  const trusted = { trusted: true };
  assert.deepEqual(await action.run(trusted, repositoryId, "aril_memory_set", { text: "- x" }), conflict);
  assert.deepEqual(sent, [], "no request reached the monitor");
  assert.deepEqual(await action.run(trusted, repositoryId, "aril_settings_set", { settings: {} }), { ok: true });
  assert.deepEqual(await action.run(trusted, repositoryId, "grant_stop", {}), { ok: true }, "a grant can always be stopped");
  on = true;
  assert.deepEqual(await action.run(trusted, repositoryId, "aril_memory_set", { text: "- x" }), { ok: true });
  assert.deepEqual(sent.map((url) => url.split("/").at(-1)), ["aril_settings_set", "grant_stop", "aril_memory_set"]);
  // A bridge made without the switch behaves as it did.
  const plain = createTaskAction({ isTrustedEvent: () => true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "secret",
    fetch: async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }) });
  assert.deepEqual(await plain.run({}, repositoryId, "aril_memory_set", { text: "- x" }), { ok: true });
});

test("the task action IPC takes the switch from desktop main", () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) };
  const remove = installTaskActionIpc({ ipcMain, isTrustedEvent: () => true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "secret", arilOn: () => false,
    fetch: async () => { throw new Error("no request while Aril is Off"); } });
  assert.equal(handlers.size, 1);
  return handlers.values().next().value({}, repositoryId, "aril_memory_set", { text: "- x" }).then((answer) => { assert.deepEqual(answer, conflict); remove(); });
});

test("the paired device's route refuses a repository's memory edit while Aril is Off, before the web host, and forwards the rest", async (context) => {
  let on = false;
  const observed = [];
  const upstream = http.createServer((request, response) => { observed.push(`${request.method} ${request.url}`); response.end("{}"); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true, networkPolicy: loopbackTestNetwork, arilOn: () => on,
  });
  context.after(async () => { await gateway.close?.(); upstream.close(); });
  const secret = new URL(gateway.createPairing().url).hash.slice(1);
  const paired = await fetch(`${gateway.origin}/__pomegr/pair`, { method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret }) });
  const headers = { Cookie: paired.headers.get("set-cookie").split(";")[0], Origin: gateway.origin, "Content-Type": "application/json" };
  const post = (body) => fetch(`${gateway.origin}/api/tasks/action`, { method: "POST", headers, body: JSON.stringify(body) });
  const memory = { repositoryId, action: "aril_memory_set", payload: { text: "- x" } };
  const refused = await post(memory);
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), conflict);
  assert.deepEqual(observed, [], "the web host was never asked");
  // Everything else goes on: a settings change, a grant stop, and a board action.
  assert.equal((await post({ repositoryId, action: "aril_settings_set", payload: { settings: {} } })).status, 200);
  assert.equal((await post({ repositoryId, action: "grant_stop", payload: {} })).status, 200);
  assert.equal(observed.length, 2);
  on = true;
  assert.equal((await post(memory)).status, 200);
  assert.equal(observed.length, 3);
});
