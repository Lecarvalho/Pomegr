// The space a thread takes on disk and the flush: fixtures in a temporary directory, with the real store, images, and summaries.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentChatImages } from "../desktop/runtime/agent-chat-images.mjs";
import { createArilControl } from "../desktop/runtime/agent-chat-aril.mjs";
import { createArilSwitch } from "../desktop/runtime/aril-switch.mjs";
import { AGENT_CHAT_DIRECTORY, createAgentChatStore, nextMessageId } from "../desktop/runtime/agent-chat-store.mjs";
import { createAgentChatSummaries } from "../desktop/runtime/agent-chat-summary.mjs";
import { createThreadSpace } from "../desktop/runtime/agent-chat-space.mjs";
import { threadSince } from "../desktop/runtime/agent-chat-compaction.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const otherRepositoryId = "repo-fedcba9876543210fedcba98";
const minute = 60_000;
const t0 = Date.parse("2026-10-01T10:00:00.000Z");
const at = (n) => new Date(t0 + n * minute).toISOString();
// A small PNG: the signature and some padding, which is all the store checks.
const PNG = (size) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(size).fill(7)]);

async function fixture(context) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-agent-chat-space-"));
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const directory = path.join(dataRoot, AGENT_CHAT_DIRECTORY);
  const store = createAgentChatStore({ directory });
  const images = createAgentChatImages({ directory });
  const summaries = createAgentChatSummaries({ directory });
  let busy = false;
  const space = createThreadSpace({ directory, store, images, busy: () => busy });
  return { dataRoot, directory, store, images, summaries, space, setBusy: (value) => { busy = value; } };
}

// A conversation of alternating owner and Aril messages, one minute apart from `start`; `withImage` lists the owner messages (by position) that carry an image.
async function conversation(h, { repository = repositoryId, start, count, withImage = [], title = "Seeded" }) {
  const created = await h.store.create(repository, { provider: "claude", model: null, title });
  // The conversation is created at the moment of this call: the thread orders by the time of its messages first.
  const messages = [];
  for (let index = 0; index < count; index += 1) {
    const id = `m-${index + 1}`;
    if (index % 2 === 0) {
      const message = { id, role: "user", text: `Question ${start + index}`, at: at(start + index) };
      if (withImage.includes(index)) {
        const staged = await h.images.stage(repository, PNG(2000));
        const claimed = await h.images.claim(repository, created.id, [staged.id]);
        message.images = claimed;
      }
      messages.push(message);
    } else messages.push({ id, role: "agent", text: `Answer ${start + index}`, at: at(start + index), provider: "claude", model: null, status: "complete" });
  }
  const saved = { ...created, messages, updatedAt: at(start + count) };
  assert.ok(await h.store.save(repository, saved));
  return saved;
}

const textsOf = (saved) => saved.messages.map((message) => message.text);
const listing = async (folder) => (existsSync(folder) ? (await fs.readdir(folder, { recursive: true })).map((entry) => String(entry).split(path.sep).join("/")).sort() : []);

test("a thread's size is the bytes of its conversations, its summary, and its images, and nothing else", async (context) => {
  const h = await fixture(context);
  const first = await conversation(h, { start: 0, count: 6, withImage: [0, 2] });
  await conversation(h, { start: 10, count: 4 });
  await h.summaries.write(repositoryId, { text: "The owner prefers small pull requests.", through: { conversationId: first.id, messageId: "m-4", at: at(3) }, at: at(20), provider: "claude", model: null });
  await conversation(h, { repository: otherRepositoryId, start: 0, count: 2, title: "Other" });
  let expected = 0;
  for (const name of await fs.readdir(path.join(h.directory, repositoryId), { recursive: true })) {
    const stat = await fs.stat(path.join(h.directory, repositoryId, name));
    if (stat.isFile()) expected += stat.size;
  }
  const sizes = await h.space.sizes();
  assert.deepEqual(sizes.map((entry) => entry.repositoryId).sort(), [repositoryId, otherRepositoryId].sort());
  const mine = sizes.find((entry) => entry.repositoryId === repositoryId);
  assert.equal(mine.bytes, expected);
  assert.equal(mine.messages, 10);
  assert.ok(mine.bytes > 4000, "the two images and the conversations count");
  assert.equal(sizes.find((entry) => entry.repositoryId === otherRepositoryId).messages, 2);
});

test("a repository with no folder is not listed, and a folder that is no repository is ignored", async (context) => {
  const h = await fixture(context);
  assert.deepEqual(await h.space.sizes(), []);
  await fs.mkdir(path.join(h.directory, "not-a-repository"), { recursive: true });
  await fs.writeFile(path.join(h.directory, "not-a-repository", "x.json"), "{}");
  assert.deepEqual(await h.space.sizes(), []);
});

test("a flush removes the oldest half of the messages across conversations, whole conversations first, and their images", async (context) => {
  const h = await fixture(context);
  // 6 + 4 + 4 = 14 messages: the oldest 7 are all of the first conversation and the first message of the second.
  const first = await conversation(h, { start: 0, count: 6, withImage: [0, 2] });
  const second = await conversation(h, { start: 10, count: 4, withImage: [0] });
  const third = await conversation(h, { start: 20, count: 4, withImage: [0] });
  const before = (await h.space.sizes())[0];
  assert.equal(before.messages, 14);
  const imagesBefore = await listing(path.join(h.directory, repositoryId, "images"));
  assert.equal(imagesBefore.filter((name) => /\.png$/u.test(name)).length, 4);

  const answer = await h.space.flush(repositoryId);
  assert.equal(answer.ok, true);
  assert.equal(answer.messages, 7);
  assert.equal(answer.conversations, 1, "the first conversation went whole");
  assert.equal(answer.images, 3, "two images of the first conversation and the one on the second's first message");
  assert.ok(answer.freed > 0);

  assert.equal(await h.store.read(repositoryId, first.id), null, "the oldest conversation is gone");
  assert.equal(existsSync(path.join(h.directory, repositoryId, `${first.id}.json`)), false);
  assert.equal(existsSync(path.join(h.directory, repositoryId, "images", first.id)), false, "with its image folder");
  const trimmed = await h.store.read(repositoryId, second.id);
  assert.deepEqual(textsOf(trimmed), ["Answer 11", "Question 12", "Answer 13"], "the cut runs through the second conversation");
  assert.deepEqual(trimmed.messages.map((message) => message.id), ["m-2", "m-3", "m-4"], "a message keeps its ID");
  const untouched = await h.store.read(repositoryId, third.id);
  assert.deepEqual(untouched, third, "the newest half is untouched");
  const imagesAfter = await listing(path.join(h.directory, repositoryId, "images"));
  assert.deepEqual(imagesAfter.filter((name) => /\.png$/u.test(name)).length, 1, "only the newest conversation's image is left");
  assert.ok(imagesAfter.some((name) => name.startsWith(third.id)));
  const after = (await h.space.sizes())[0];
  assert.equal(after.messages, 7);
  assert.equal(before.bytes - after.bytes, answer.freed);
  // What is stored reads back through a new process: the trimmed conversation is inside the stored contract.
  const reloaded = createAgentChatStore({ directory: h.directory });
  assert.deepEqual((await reloaded.index(repositoryId)).map((meta) => meta.messages).sort(), [3, 4]);
  assert.equal((await reloaded.read(repositoryId, second.id)).messages.length, 3);
});

test("a flush keeps the summary of a compacted thread, byte for byte, and the thread still divides at the same place", async (context) => {
  const h = await fixture(context);
  const first = await conversation(h, { start: 0, count: 6 });
  const second = await conversation(h, { start: 10, count: 6 });
  await conversation(h, { start: 20, count: 4 });
  // The summary covers the first conversation and the first two messages of the second.
  await h.summaries.write(repositoryId, { text: "Decisions: squash merges, small pull requests. T-4 is blocked on a review.", through: { conversationId: second.id, messageId: "m-2", at: at(11) }, at: at(30), provider: "claude", model: null, effort: "low" });
  const summaryFile = path.join(h.directory, repositoryId, "summary.json");
  const summaryBefore = await fs.readFile(summaryFile);
  const readAfterSummary = async (store, summaries) => (await threadSince({ store, summaries, repositoryId })).messages.map((message) => message.text);
  const readBefore = await readAfterSummary(h.store, h.summaries);
  assert.equal(readBefore.length, 8, "the second conversation's last four messages and the third conversation");

  const answer = await h.space.flush(repositoryId);
  assert.equal(answer.ok, true);
  assert.equal(answer.messages, 8, "half of sixteen");
  assert.equal(await h.store.read(repositoryId, first.id), null);
  assert.deepEqual(await fs.readFile(summaryFile), summaryBefore, "the summary file is untouched");
  const reread = createAgentChatSummaries({ directory: h.directory });
  const summary = await reread.read(repositoryId);
  assert.equal(summary.text, "Decisions: squash merges, small pull requests. T-4 is blocked on a review.");
  assert.deepEqual(summary.through, { conversationId: second.id, messageId: "m-2", at: at(11) });

  // The summary still stands for the part that is gone, and the messages after it are the ones that remain after its position.
  const reloaded = createAgentChatStore({ directory: h.directory });
  const since = await threadSince({ store: reloaded, summaries: reread, repositoryId });
  assert.equal(since.summary.text, summary.text);
  assert.deepEqual(await readAfterSummary(reloaded, reread), readBefore, "the same messages follow the summary before and after the flush: it removed only what the summary covers");
  assert.ok(since.messages.every((message) => Date.parse(message.at) > Date.parse(at(11))), "nothing at or before where the summary ends");
});

test("a flush that reaches past where the summary ends still leaves the summary and the newest half", async (context) => {
  const h = await fixture(context);
  const first = await conversation(h, { start: 0, count: 4 });
  await conversation(h, { start: 10, count: 4 });
  await h.summaries.write(repositoryId, { text: "Early notes.", through: { conversationId: first.id, messageId: "m-2", at: at(1) }, at: at(30), provider: "claude", model: null });
  const answer = await h.space.flush(repositoryId);
  assert.equal(answer.messages, 4);
  assert.equal((await h.summaries.read(repositoryId)).text, "Early notes.");
  const since = await threadSince({ store: createAgentChatStore({ directory: h.directory }), summaries: createAgentChatSummaries({ directory: h.directory }), repositoryId });
  assert.deepEqual(since.messages.map((message) => message.text), ["Question 10", "Answer 11", "Question 12", "Answer 13"], "the summary's position still divides the thread by time, though its conversation is gone");
});

test("a message written after a flush gets an ID no message holds", async (context) => {
  const h = await fixture(context);
  await conversation(h, { start: 0, count: 6 });
  const second = await conversation(h, { start: 10, count: 6 });
  await conversation(h, { start: 20, count: 2 });
  assert.equal((await h.space.flush(repositoryId)).messages, 7);
  const trimmed = await h.store.read(repositoryId, second.id);
  assert.deepEqual(trimmed.messages.map((message) => message.id), ["m-2", "m-3", "m-4", "m-5", "m-6"], "the IDs that are left");
  const next = nextMessageId(trimmed.messages);
  assert.equal(next, "m-7", "not m-6, which a count of the messages would give");
  assert.equal(nextMessageId([]), "m-1");
  assert.equal(nextMessageId([{ id: "m-4" }, { id: "m-9" }, { id: "m-2" }]), "m-10");
  const saved = { ...trimmed, messages: [...trimmed.messages, { id: next, role: "user", text: "After the flush", at: at(100) }] };
  assert.ok(await h.store.save(repositoryId, saved), "the store accepts it: no ID repeats");
});

test("nothing is flushed while a turn runs, from a thread with fewer than two messages, or for another repository", async (context) => {
  const h = await fixture(context);
  const lone = await conversation(h, { start: 0, count: 1 });
  assert.deepEqual(await h.space.flush(repositoryId), { ok: false, error: "not_found" });
  assert.deepEqual(await h.store.read(repositoryId, lone.id), lone);
  await conversation(h, { start: 10, count: 4 });
  const other = await conversation(h, { repository: otherRepositoryId, start: 0, count: 6, title: "Other" });
  h.setBusy(true);
  assert.deepEqual(await h.space.flush(repositoryId), { ok: false, error: "busy" });
  assert.equal((await h.space.sizes()).find((entry) => entry.repositoryId === repositoryId).messages, 5, "nothing was removed");
  h.setBusy(false);
  assert.equal((await h.space.flush(repositoryId)).ok, true);
  assert.deepEqual(await h.store.read(otherRepositoryId, other.id), other, "another repository's thread is not touched");
  assert.deepEqual(await h.space.flush("repo-short"), { ok: false, error: "invalid" });
});

test("two flushes at once run one, and an odd count rounds down", async (context) => {
  const h = await fixture(context);
  await conversation(h, { start: 0, count: 5 });
  const [first, second] = await Promise.all([h.space.flush(repositoryId), h.space.flush(repositoryId)]);
  assert.deepEqual([first, second].map((answer) => answer.ok).sort(), [false, true]);
  assert.equal([first, second].find((answer) => answer.ok).messages, 2, "half of five, rounded down");
  assert.equal([first, second].find((answer) => !answer.ok).error, "busy");
});

test("the controls serve the sizes and the flush to the desktop window only", async (context) => {
  const h = await fixture(context);
  await conversation(h, { start: 0, count: 6 });
  const control = createArilControl({ dataRoot: h.dataRoot, store: h.store, images: h.images, arilSwitch: createArilSwitch({ initial: { on: true } }) });
  const desktop = { event: {} };
  assert.deepEqual(await control.handlers.thread_space({}, { paired: true }), { ok: false, error: "desktop_only" });
  assert.deepEqual(await control.handlers.thread_flush({ repositoryId }, { paired: true }), { ok: false, error: "desktop_only" });
  assert.deepEqual(await control.handlers.thread_flush({ repositoryId }, undefined), { ok: false, error: "desktop_only" });
  assert.deepEqual(await control.handlers.thread_flush({ repositoryId: "x" }, desktop), { ok: false, error: "invalid" });
  assert.deepEqual(await control.handlers.thread_flush({ repositoryId, extra: 1 }, desktop), { ok: false, error: "invalid" });
  const listed = await control.handlers.thread_space({}, desktop);
  assert.equal(listed.ok, true);
  assert.deepEqual(Object.keys(listed.repositories[0]).sort(), ["bytes", "messages", "repositoryId"], "sizes and counts, never a path or a text");
  const flushed = await control.handlers.thread_flush({ repositoryId }, desktop);
  assert.equal(flushed.ok, true);
  assert.deepEqual(Object.keys(flushed).sort(), ["conversations", "freed", "images", "messages", "ok"]);
});
