// "Flush oldest at": the limit setting (default 5 MB), and the flush that a thread over it gets by itself: when it runs, how far it goes, what it
// keeps, and that it waits while the repository is busy. Fixtures in a temporary directory, with the real store, images, and summaries.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentChatImages } from "../desktop/runtime/agent-chat-images.mjs";
import { createArilControl } from "../desktop/runtime/agent-chat-aril.mjs";
import { createArilSwitch } from "../desktop/runtime/aril-switch.mjs";
import { AGENT_CHAT_DIRECTORY, createAgentChatStore } from "../desktop/runtime/agent-chat-store.mjs";
import { createAgentChatSummaries } from "../desktop/runtime/agent-chat-summary.mjs";
import { AUTO_FLUSH_TARGET, createThreadSpace } from "../desktop/runtime/agent-chat-space.mjs";
import { createThreadLimit, DEFAULT_THREAD_LIMIT, THREAD_LIMIT_FILE, THREAD_LIMITS } from "../desktop/runtime/aril-thread-limit.mjs";
import { chatHarness, finishTurn, repositoryId, send, stamp, until } from "./helpers/agent-chat-harness.mjs";

const otherRepositoryId = "repo-fedcba9876543210fedcba98";
const minute = 60_000;
const t0 = Date.parse("2026-10-01T10:00:00.000Z");
const at = (n) => new Date(t0 + n * minute).toISOString();
const MEGABYTE = 1024 * 1024;
// A small PNG: the signature and some padding, which is all the store checks.
const PNG = (size) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(size).fill(7)]);

async function folderBytes(folder) {
  let total = 0;
  for (const name of await fs.readdir(folder, { recursive: true })) {
    const stat = await fs.stat(path.join(folder, name));
    if (stat.isFile()) total += stat.size;
  }
  return total;
}

async function fixture(context, limit = 10_000) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-auto-flush-"));
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const directory = path.join(dataRoot, AGENT_CHAT_DIRECTORY);
  const store = createAgentChatStore({ directory });
  const images = createAgentChatImages({ directory });
  const summaries = createAgentChatSummaries({ directory });
  const state = { busy: false, limit };
  const space = createThreadSpace({ directory, store, images, busy: () => state.busy, limit: () => state.limit });
  return { dataRoot, directory, store, images, summaries, space, state };
}

// A conversation of alternating owner and Aril messages, one minute apart from `start`, each of about `size` characters of text; `withImage` lists
// the owner messages (by position) that carry an image of 2,000 bytes.
async function conversation(h, { repository = repositoryId, start, count, size = 300, withImage = [], title = "Seeded" }) {
  const created = await h.store.create(repository, { provider: "claude", model: null, title });
  const messages = [];
  for (let index = 0; index < count; index += 1) {
    const id = `m-${index + 1}`;
    const text = `${index % 2 === 0 ? "Question" : "Answer"} ${start + index} `.padEnd(size, "x");
    if (index % 2 === 0) {
      const message = { id, role: "user", text, at: at(start + index) };
      if (withImage.includes(index)) {
        const staged = await h.images.stage(repository, PNG(2000));
        message.images = await h.images.claim(repository, created.id, [staged.id]);
      }
      messages.push(message);
    } else messages.push({ id, role: "agent", text, at: at(start + index), provider: "claude", model: null, status: "complete" });
  }
  const saved = { ...created, messages, updatedAt: at(start + count) };
  assert.ok(await h.store.save(repository, saved));
  return saved;
}

const thread = async (h, repository = repositoryId) => {
  const found = [];
  for (const meta of await h.store.index(repository)) found.push(...(await h.store.read(repository, meta.id)).messages.map((message) => ({ conversation: meta.id, ...message })));
  return found.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
};

test("the limit is 2, 5, 10, or 25 MB, or Never; it is 5 MB until the owner changes it, and it survives a restart", async (context) => {
  assert.deepEqual([...THREAD_LIMITS], [2, 5, 10, 25, 0]);
  assert.equal(DEFAULT_THREAD_LIMIT, 5);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-thread-limit-"));
  context.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const file = path.join(root, "aril-v1", THREAD_LIMIT_FILE);
  const changes = [];
  const limit = createThreadLimit({ file, onChange: (value) => changes.push(value) });
  await limit.ready;
  assert.equal(limit.megabytes(), 5);
  assert.equal(limit.bytes(), 5 * MEGABYTE);
  for (const value of [1, 3, 50, -1, "5", null, undefined, 2.5, true]) assert.equal(await limit.set(value), "invalid", String(value));
  assert.equal(limit.megabytes(), 5);
  assert.equal(await limit.set(5), "ok", "the same value is not a change");
  assert.deepEqual(changes, []);
  for (const value of [2, 10, 25, 0, 5]) {
    assert.equal(await limit.set(value), "ok");
    assert.equal(limit.megabytes(), value);
    assert.equal(limit.bytes(), value * MEGABYTE);
  }
  assert.deepEqual(changes, [2, 10, 25, 0, 5]);
  assert.equal(await limit.set(0), "ok");
  assert.equal(limit.bytes(), 0, "Never is no size at all");
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 1, megabytes: 0 });
  const restarted = createThreadLimit({ file });
  await restarted.ready;
  assert.equal(restarted.megabytes(), 0, "a restart keeps the owner's choice");
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")), []);
  // No file, and a file outside the contract, are the default.
  for (const content of [null, "not json", JSON.stringify({ version: 2, megabytes: 10 }), JSON.stringify({ version: 1, megabytes: 7 }), JSON.stringify({ version: 1, megabytes: "10" })]) {
    if (content === null) await fs.rm(file); else await fs.writeFile(file, content);
    const odd = createThreadLimit({ file });
    await odd.ready;
    assert.equal(odd.megabytes(), 5, String(content).slice(0, 30));
  }
  assert.equal(createThreadLimit({}).megabytes(), 5, "a setting held in memory starts at the default too");
});

test("a limit that cannot be written is not kept", async () => {
  let failing = false;
  const filesystem = { readFile: async () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); }, mkdir: async () => {}, rename: async () => {}, unlink: async () => {},
    writeFile: async () => { if (failing) throw new Error("disk"); } };
  const changes = [];
  const limit = createThreadLimit({ file: path.resolve("thread-limit.json"), filesystem, onChange: (value) => changes.push(value) });
  assert.equal(await limit.set(10), "ok");
  failing = true;
  assert.equal(await limit.set(25), "unavailable");
  assert.equal(limit.megabytes(), 10);
  assert.deepEqual(changes, [10]);
});

test("a thread over the limit is flushed down to 75% of it: the oldest messages go, with their images, and the newest message and the summary stay", async (context) => {
  const h = await fixture(context, 20_000);
  const first = await conversation(h, { start: 0, count: 30, withImage: [0, 2, 4], size: 400 });
  await conversation(h, { start: 40, count: 30, size: 400 });
  await h.summaries.write(repositoryId, { text: "The owner prefers small pull requests.", through: { conversationId: first.id, messageId: "m-4", at: at(3) }, at: at(80), provider: "claude", model: null });
  const summary = await fs.readFile(path.join(h.directory, repositoryId, "summary.json"), "utf8");
  const before = await folderBytes(path.join(h.directory, repositoryId));
  const messages = await thread(h);
  assert.ok(before > 20_000, `the thread takes ${before} bytes`);
  const result = await h.space.autoFlush(repositoryId);
  assert.equal(result.ok, true);
  assert.equal(result.flushed, true);
  const after = await folderBytes(path.join(h.directory, repositoryId));
  const target = Math.floor(20_000 * AUTO_FLUSH_TARGET);
  assert.equal(AUTO_FLUSH_TARGET, 0.75);
  assert.ok(after <= target, `${after} bytes are at or below ${target}`);
  assert.ok(after > target * 0.8, `${after} bytes: it stops at the target and does not empty the thread`);
  assert.equal(result.freed, before - after);
  const left = await thread(h);
  assert.equal(left.length, messages.length - result.messages);
  assert.deepEqual(left.map((message) => message.text), messages.slice(messages.length - left.length).map((message) => message.text), "it removed the oldest, in order, and nothing from the middle");
  assert.equal(left.at(-1).text, messages.at(-1).text, "the newest message stays");
  assert.equal(await fs.readFile(path.join(h.directory, repositoryId, "summary.json"), "utf8"), summary, "the summary file is untouched");
  assert.equal(result.images, 3);
  const images = path.join(h.directory, repositoryId, "images");
  assert.deepEqual(existsSync(images) ? (await fs.readdir(images, { recursive: true })).filter((name) => String(name).endsWith(".png") || /\.\w+$/u.test(String(name))) : [], [], "the images of the removed messages are gone");
  // Asked again, it has nothing to do.
  assert.deepEqual(await h.space.autoFlush(repositoryId), { ok: true, flushed: false, reason: "under" });
});

test("a thread at or below the limit is left alone, and so is every other repository's", async (context) => {
  const h = await fixture(context, 20_000);
  await conversation(h, { start: 0, count: 20, size: 400 });
  await conversation(h, { repository: otherRepositoryId, start: 0, count: 200, size: 400, title: "Other" });
  const mine = (await folderBytes(path.join(h.directory, repositoryId)));
  assert.ok(mine < 20_000);
  assert.deepEqual(await h.space.autoFlush(repositoryId), { ok: true, flushed: false, reason: "under" });
  assert.equal((await thread(h)).length, 20);
  h.state.limit = mine;
  assert.deepEqual(await h.space.autoFlush(repositoryId), { ok: true, flushed: false, reason: "under" }, "a thread exactly at the limit is not over it");
  h.state.limit = mine - 1;
  assert.equal((await h.space.autoFlush(repositoryId)).flushed, true, "one byte over is over");
  assert.equal((await thread(h, otherRepositoryId)).length, 200, "another repository is untouched");
});

test("the newest message always stays, even when it is the whole thread's weight", async (context) => {
  const h = await fixture(context, 5000);
  const created = await h.store.create(repositoryId, { provider: "claude", model: null, title: "Heavy" });
  const heavy = [{ id: "m-1", role: "user", text: "Short question", at: at(0) }, { id: "m-2", role: "agent", text: "Short answer", at: at(1), provider: "claude", model: null, status: "complete" },
    { id: "m-3", role: "agent", text: "Newest ".padEnd(20_000, "x"), at: at(2), provider: "claude", model: null, status: "complete" }];
  assert.ok(await h.store.save(repositoryId, { ...created, messages: heavy, updatedAt: at(3) }));
  const result = await h.space.autoFlush(repositoryId);
  assert.equal(result.flushed, true);
  assert.equal(result.messages, 2);
  assert.deepEqual((await thread(h)).map((message) => message.id), ["m-3"]);
  // One message left: there is nothing more to remove, and it is not an error.
  assert.deepEqual(await h.space.autoFlush(repositoryId), { ok: true, flushed: false, reason: "under" });
  assert.equal((await thread(h)).length, 1);
});

test("the summary alone can keep a thread over the limit: the messages go, the summary stays", async (context) => {
  const h = await fixture(context, 4000);
  const first = await conversation(h, { start: 0, count: 10, size: 300 });
  await h.summaries.write(repositoryId, { text: "x".repeat(6000), through: { conversationId: first.id, messageId: "m-10", at: at(9) }, at: at(20), provider: "claude", model: null });
  const result = await h.space.autoFlush(repositoryId);
  assert.equal(result.flushed, true);
  assert.equal((await thread(h)).length, 1, "only the newest message is left");
  assert.ok(existsSync(path.join(h.directory, repositoryId, "summary.json")));
  assert.deepEqual(await h.space.autoFlush(repositoryId), { ok: true, flushed: false, reason: "under" });
});

test("Never turns the automatic flush off, whatever the size", async (context) => {
  const h = await fixture(context, 0);
  await conversation(h, { start: 0, count: 100, size: 400 });
  assert.deepEqual(await h.space.autoFlush(repositoryId), { ok: true, flushed: false, reason: "never" });
  assert.deepEqual(await h.space.sweep(), [{ repositoryId, ok: true, flushed: false, reason: "never" }]);
  assert.equal((await thread(h)).length, 100);
  // The owner's own flush is not the automatic one: it still removes the oldest half.
  assert.equal((await h.space.flush(repositoryId)).messages, 50);
});

test("it never flushes while a turn, a follow-up, a compaction, or another flush of the repository runs, and runs when it is idle", async (context) => {
  const h = await fixture(context, 10_000);
  await conversation(h, { start: 0, count: 60, size: 400 });
  h.state.busy = true;
  assert.deepEqual(await h.space.autoFlush(repositoryId), { ok: true, flushed: false, reason: "busy" });
  assert.equal((await thread(h)).length, 60, "nothing was removed");
  h.state.busy = false;
  assert.equal((await h.space.autoFlush(repositoryId)).flushed, true);
  assert.ok((await thread(h)).length < 60);
  // Two at once: one flushes, the other finds it flushing and does nothing.
  const second = await fixture(context, 10_000);
  await conversation(second, { start: 0, count: 60, size: 400 });
  const both = await Promise.all([second.space.autoFlush(repositoryId), second.space.autoFlush(repositoryId)]);
  assert.deepEqual(both.map((answer) => answer.flushed).sort(), [false, true]);
  assert.equal(both.find((answer) => !answer.flushed).reason, "busy");
  assert.equal(second.space.flushing(repositoryId), false, "the lock is released");
});

test("a message keeps its ID through an automatic flush, and a new one is one past the highest", async (context) => {
  const h = await fixture(context, 6000);
  await conversation(h, { start: 0, count: 40, size: 300 });
  const ids = (await thread(h)).map((message) => Number(message.id.slice(2)));
  assert.equal((await h.space.autoFlush(repositoryId)).flushed, true);
  const left = (await thread(h)).map((message) => Number(message.id.slice(2)));
  assert.deepEqual(left, ids.slice(ids.length - left.length));
});

test("the controller's operations: the limit is read with the space and set by the desktop window only, with an exact payload", async (context) => {
  const h = await fixture(context, 0);
  await conversation(h, { start: 0, count: 6, size: 300 });
  const limit = createThreadLimit({});
  const control = createArilControl({ arilSwitch: createArilSwitch({ initial: { on: true } }), threadLimit: limit, space: h.space });
  const { thread_space: space, thread_limit_set: set } = control.handlers;
  const desktop = { event: {} };
  assert.deepEqual(await space({}, { paired: true }), { ok: false, error: "desktop_only" });
  const read = await space({}, desktop);
  assert.equal(read.ok, true);
  assert.equal(read.limit, 5, "the default is 5 MB");
  assert.equal(read.repositories[0].messages, 6);
  assert.deepEqual(await set({ megabytes: 10 }, { paired: true }), { ok: false, error: "desktop_only" });
  assert.deepEqual(await set({ megabytes: 10 }, undefined), { ok: false, error: "desktop_only" });
  for (const payload of [{}, { megabytes: 10, extra: 1 }, { megabyte: 10 }, { megabytes: 3 }, { megabytes: "10" }, { megabytes: null }]) assert.deepEqual(await set(payload, desktop), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.deepEqual(await set({ megabytes: 25 }, desktop), { ok: true, limit: 25 });
  assert.equal((await space({}, desktop)).limit, 25);
  assert.deepEqual(await set({ megabytes: 0 }, desktop), { ok: true, limit: 0 });
  assert.equal(limit.bytes(), 0);
});

test("a new limit is judged at once for every thread that is idle", async (context) => {
  const h = await fixture(context, 0);
  await conversation(h, { start: 0, count: 60, size: 400 });
  // 2 MB is the smallest limit, so a thread of 60 small messages is far under it; the sweep leaves it alone.
  const control = createArilControl({ arilSwitch: createArilSwitch({ initial: { on: true } }), space: createThreadSpace({ directory: h.directory, store: h.store, images: h.images, busy: () => false, limit: () => 10_000 }) });
  const sweep = await control.sweep();
  assert.deepEqual(sweep.map((entry) => [entry.repositoryId, entry.flushed]), [[repositoryId, true]]);
  assert.ok((await folderBytes(path.join(h.directory, repositoryId))) <= 7500);
});

// A thread this long is summarized after a turn, a chunk at a time: the compaction runs, which the flush waits for, are answered here until
// none is left.
const compact = async (h, { first = null } = {}) => {
  const answered = new Set();
  let idle = 0;
  while (idle < 10) {
    const run = h.runs.find((candidate) => candidate.options.tools === "none" && !answered.has(candidate));
    if (run) { idle = 0; answered.add(run); await first?.(run); run.resolve({ status: "complete", text: "The owner asked small questions." }); } else { idle += 1; await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  return answered.size;
};

// The same through the whole chat: a thread past 2 MB is flushed after the turn that ends, never during one.
async function bigThread(context, megabytes) {
  const limit = createThreadLimit({});
  const h = await chatHarness(context, { viaDataRoot: true, threadLimit: limit });
  assert.equal(await limit.set(megabytes), "ok");
  // Two conversations of 100 messages: half of them Aril's answers of 32,000 characters, about 3.2 MB in all.
  for (const [start, title] of [[0, "First"], [1000, "Second"]]) {
    const created = await h.store.create(repositoryId, { provider: "claude", model: null, title });
    const messages = Array.from({ length: 100 }, (_, index) => (index % 2 === 0
      ? { id: `m-${index + 1}`, role: "user", text: `Question ${start + index}`, at: new Date(Date.parse(stamp) - (3000 - start - index) * 1000).toISOString() }
      : { id: `m-${index + 1}`, role: "agent", text: `Answer ${start + index} `.padEnd(32_000, "y"), at: new Date(Date.parse(stamp) - (3000 - start - index) * 1000).toISOString(), provider: "claude", model: null, status: "complete" }));
    assert.ok(await h.store.save(repositoryId, { ...created, messages, updatedAt: messages.at(-1).at }));
  }
  return { h, limit };
}

test("through the chat: the flush runs when the turn that was running ends, never during it, and stops at 75% of the limit", async (context) => {
  const { h, limit } = await bigThread(context, 2);
  const folder = path.join(h.dataRoot, AGENT_CHAT_DIRECTORY, repositoryId);
  const before = await folderBytes(folder);
  assert.ok(before > 2 * MEGABYTE, `the thread takes ${before} bytes`);
  const sent = await send(h);
  assert.equal(sent.ok, true);
  // A turn is running: a new limit judges the thread at once, and finds it busy.
  assert.equal((await h.handle("thread_limit_set", { megabytes: 5 })).ok, false, "only the desktop window sets the limit");
  assert.equal(await limit.set(5), "ok");
  assert.equal(await limit.set(2), "ok");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok((await folderBytes(folder)) >= before, "nothing is removed while the turn runs");
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, sent.conversationId);
  // The turn has ended, but the thread is summarized first: a compaction runs, and the flush waits for it.
  const summarized = await compact(h, { first: async () => { assert.ok((await folderBytes(folder)) >= before, "nothing is removed while a compaction runs"); } });
  assert.ok(summarized >= 1, "the thread was summarized before it was flushed");
  const target = Math.floor(2 * MEGABYTE * AUTO_FLUSH_TARGET);
  await until(async () => (await folderBytes(folder)) <= target);
  const after = await folderBytes(folder);
  assert.ok(after <= target && after > target * 0.8, `${after} bytes after the turn`);
  const left = await h.reload().index(repositoryId);
  const messages = left.reduce((sum, meta) => sum + meta.messages, 0);
  assert.ok(messages < 202 && messages > 1);
  const newest = (await h.reload().read(repositoryId, sent.conversationId)).messages.at(-1);
  assert.equal(newest.text, "Done.", "the newest message, the answer just stored, stays");
});

test("through the chat: with Never, a thread of any size is not flushed", async (context) => {
  const { h } = await bigThread(context, 0);
  const folder = path.join(h.dataRoot, AGENT_CHAT_DIRECTORY, repositoryId);
  const before = await folderBytes(folder);
  const sent = await send(h);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, sent.conversationId);
  await compact(h);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok((await folderBytes(folder)) >= before, "nothing was removed");
});

test("through the chat: with the default 5 MB a 3 MB thread is not flushed, and a message waits while its thread flushes", async (context) => {
  const h = await chatHarness(context, { viaDataRoot: true });
  const space = await h.handle("thread_space", {});
  assert.equal(space.ok, false, "a call with no window is refused");
  const read = await h.chat.handle("thread_space", {}, { event: {} });
  assert.equal(read.limit, 5);
  const created = await h.store.create(repositoryId, { provider: "claude", model: null, title: "Three" });
  const messages = Array.from({ length: 100 }, (_, index) => ({ id: `m-${index + 1}`, role: index % 2 === 0 ? "user" : "agent", text: `Text ${index} `.padEnd(index % 2 === 0 ? 100 : 32_000, "y"), at: new Date(Date.parse(stamp) - (200 - index) * 1000).toISOString(), ...(index % 2 === 0 ? {} : { provider: "claude", model: null, status: "complete" }) }));
  assert.ok(await h.store.save(repositoryId, { ...created, messages, updatedAt: messages.at(-1).at }));
  const sent = await send(h);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, sent.conversationId);
  await compact(h);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const left = (await h.reload().read(repositoryId, created.id)).messages.length;
  assert.equal(left, 102, "3 MB is under 5 MB: the 100 messages and the exchange just stored are all there");
});
