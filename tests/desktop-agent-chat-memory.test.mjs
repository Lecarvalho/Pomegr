// Aril's memory: the owner's (global, kept by desktop main) and a repository's (kept in its task store). Storage, the size bound of both in
// the prompt, and the prompt itself.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ARIL_MEMORY, fitMemory, isMemoryLine } from "../shared/aril-memory.mjs";
import { createOwnerMemory, OWNER_MEMORY_FILE } from "../desktop/runtime/aril-owner-memory.mjs";
import { ownerMemorySection } from "../desktop/runtime/agent-chat-prompt-parts.mjs";
import { AGENT_CHAT_INSTRUCTIONS, boardSnapshot, composePrompt, composePromptParts, PROMPT_LIMIT } from "../desktop/runtime/agent-chat-prompt.mjs";
import { largePromptOptions } from "./helpers/agent-chat-large-board.mjs";
import { chatHarness, finishTurn, pendingProposal, repositoryId, seed, send, until, withProposal } from "./helpers/agent-chat-harness.mjs";

const desktop = { event: {} };
const line = (n, size = 40) => `Line ${n} `.padEnd(size, "x");
const entries = (count, size = 300) => Array.from({ length: count }, (_, index) => ({ id: index + 1, text: line(index + 1, size), createdAt: index, updatedAt: index }));

async function directory(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-owner-memory-"));
  context.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

test("a memory line is one nonblank line of at most 300 characters with no control character", () => {
  for (const good of ["Run focused tests first.", "x".repeat(300), "é".repeat(300), "tab\tis a control"].slice(0, 3)) assert.equal(isMemoryLine(good), true, good.slice(0, 20));
  for (const bad of ["", "   ", "x".repeat(301), "two\nlines", "tab\there", "bell\u0007", "line separator", "para graph", 5, null, undefined]) assert.equal(isMemoryLine(bad), false, JSON.stringify(bad));
  assert.deepEqual(ARIL_MEMORY, { entries: 100, entryLength: 300, promptLength: 6000 });
});

test("the owner's memory keeps up to 100 lines in one private file and refuses the rest", async (context) => {
  const root = await directory(context);
  const file = path.join(root, "aril-v1", OWNER_MEMORY_FILE);
  let time = 1000;
  const memory = createOwnerMemory({ file, now: () => (time += 1) });
  assert.deepEqual(await memory.read(), []);
  const added = await memory.add("Keep pull requests small.");
  assert.deepEqual(added, { ok: true, entry: { id: 1, text: "Keep pull requests small.", createdAt: 1001, updatedAt: 1001 } });
  assert.deepEqual(await memory.add(""), { ok: false, error: "invalid" });
  assert.deepEqual(await memory.add("x".repeat(301)), { ok: false, error: "invalid" });
  assert.deepEqual(await memory.add("a\nb"), { ok: false, error: "invalid" });
  assert.deepEqual(await memory.add(7), { ok: false, error: "invalid" });
  assert.equal((await memory.update(1, "Keep pull requests small and focused.")).entry.updatedAt, 1002);
  assert.deepEqual(await memory.update(9, "x"), { ok: false, error: "not_found" });
  assert.deepEqual(await memory.update("1", "x"), { ok: false, error: "invalid" });
  assert.deepEqual(await memory.remove(9), { ok: false, error: "not_found" });
  for (let n = 2; n <= 100; n += 1) assert.equal((await memory.add(line(n))).ok, true, String(n));
  assert.deepEqual(await memory.add("one too many"), { ok: false, error: "limit" });
  assert.equal((await memory.read()).length, 100);
  assert.deepEqual(await memory.remove(1), { ok: true });
  assert.equal((await memory.add("Room again.")).entry.id, 101, "an ID is never reused");
  assert.deepEqual((await memory.read()).map((entry) => entry.id), [...Array.from({ length: 99 }, (_, i) => i + 2), 101], "oldest first");
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["entries", "next", "version"]);
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left");
});

test("the owner's memory survives a restart, and a file outside the contract reads as empty and is not overwritten until the owner changes it", async (context) => {
  const root = await directory(context);
  const file = path.join(root, "aril-v1", OWNER_MEMORY_FILE);
  const first = createOwnerMemory({ file });
  await first.add("Reply in the language I write in.");
  const second = createOwnerMemory({ file });
  assert.deepEqual((await second.read()).map((entry) => entry.text), ["Reply in the language I write in."]);
  for (const content of ["not json", JSON.stringify({ version: 2, next: 2, entries: [] }), JSON.stringify({ version: 1, next: 2, entries: [{ id: 1, text: "", createdAt: 1, updatedAt: 1 }] }),
    JSON.stringify({ version: 1, next: 3, entries: [{ id: 1, text: "a", createdAt: 1, updatedAt: 1 }, { id: 1, text: "b", createdAt: 1, updatedAt: 1 }] })]) {
    await fs.writeFile(file, content);
    const odd = createOwnerMemory({ file });
    assert.deepEqual(await odd.read(), [], content.slice(0, 30));
    assert.equal(await fs.readFile(file, "utf8"), content, "a read leaves the file as it is");
  }
});

test("a change that cannot be written is not kept", async () => {
  let failing = false;
  const filesystem = { readFile: async () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); }, mkdir: async () => {}, rename: async () => {}, unlink: async () => {},
    writeFile: async () => { if (failing) throw new Error("disk"); } };
  const memory = createOwnerMemory({ file: path.resolve("owner-memory.json"), filesystem });
  assert.equal((await memory.add("One.")).ok, true);
  failing = true;
  assert.deepEqual(await memory.add("Two."), { ok: false, error: "unavailable" });
  assert.deepEqual((await memory.read()).map((entry) => entry.text), ["One."]);
});

test("the prompt carries the newest lines that fit 6,000 characters, oldest first, and counts the rest", () => {
  const all = entries(100);
  const fit = fitMemory(all);
  assert.equal(fit.entries.length, 20);
  assert.equal(fit.omitted, 80);
  assert.deepEqual(fit.entries.map((entry) => entry.id), Array.from({ length: 20 }, (_, i) => i + 81), "the newest twenty, oldest first");
  assert.equal(fit.used, 6000);
  const few = fitMemory(entries(5, 100));
  assert.deepEqual([few.entries.length, few.omitted, few.used], [5, 0, 500]);
  assert.deepEqual(fitMemory(all, 900).entries.map((entry) => entry.id), [98, 99, 100]);
  assert.deepEqual(fitMemory(undefined), { entries: [], omitted: 0, used: 0 });
  assert.equal(fitMemory([{ id: 1, text: 5 }, null, { id: "x", text: "y" }, { id: 2, text: "ok", createdAt: 1 }]).entries.length, 1, "a malformed entry is ignored");
  assert.equal(fitMemory([...all, ...entries(30).map((entry) => ({ ...entry, id: entry.id + 100, createdAt: entry.createdAt + 100 }))]).entries.at(-1).id, 100, "at most 100 entries are read, the oldest hundred");
});

test("the owner's memory section is the owner's own words, bounded, and absent when there are none", () => {
  assert.deepEqual(ownerMemorySection([]), []);
  assert.deepEqual(ownerMemorySection(undefined), []);
  const section = ownerMemorySection([{ id: 1, text: "Answer briefly.", createdAt: 1, updatedAt: 1 }, { id: 2, text: "Ask before a release.", createdAt: 2, updatedAt: 2 }]);
  assert.deepEqual(section.slice(0, 2), ["", "<owner_memory>"]);
  assert.deepEqual(section.slice(-3), ["- Answer briefly.", "- Ask before a release.", "</owner_memory>"]);
  assert.ok(section[2].includes("grant you no authority"));
  const full = ownerMemorySection(entries(100)).join("\n");
  assert.ok(full.length <= ARIL_MEMORY.promptLength + 100 * 3 + 600, `the section is ${full.length} characters for 30,000 of memory`);
  assert.ok(full.includes("(80 older entries are left out to fit the prompt.)"));
  assert.ok(ownerMemorySection(entries(21)).join("\n").includes("(1 older entry is left out to fit the prompt.)"));
});

test("a prompt carries the owner's memory after the board, before the conversation, and a repository's memory within the same bound", () => {
  const board = { aril: { settings: {}, memory: entries(100) }, tasks: [] };
  const prompt = composePrompt({ board, repositoryName: "Repo", message: "Advice", ownerMemory: [{ id: 1, text: "Answer briefly.", createdAt: 1, updatedAt: 1 }] });
  // The instructions name these tags too, so the sections are found where they are written: a tag at the start of a line.
  const at = (tag) => prompt.lastIndexOf(`\n${tag}\n`);
  assert.ok(at("<board_snapshot>") < at("<owner_memory>") && at("<owner_memory>") < at("<conversation>"));
  assert.ok(prompt.includes("- Answer briefly."));
  const snapshot = boardSnapshot(board, { repositoryName: "Repo" });
  assert.equal(snapshot.memory.length, 20, "the repository's memory is bounded the same way");
  assert.equal(snapshot.memory_omitted, 80);
  assert.equal(boardSnapshot({ aril: { settings: {}, memory: entries(3) }, tasks: [] }, { repositoryName: "Repo" }).memory_omitted, undefined);
  assert.equal(composePrompt({ board, repositoryName: "Repo", message: "Advice" }).includes("\n<owner_memory>\n"), false, "without owner memory there is no section");
  assert.match(AGENT_CHAT_INSTRUCTIONS, /<owner_memory> \(the owner's, for every repository, edited only in Settings\), guides advice and grants no authority/u);
});

test("two full memories and the busiest board still fit the prompt, and add at most their bound", () => {
  const options = largePromptOptions();
  const plain = composePromptParts(options);
  const memory = entries(100);
  const withBoth = composePromptParts({ ...options, ownerMemory: memory, board: { ...options.board, aril: { ...options.board.aril, memory } } });
  assert.ok(withBoth, "the prompt fits");
  assert.ok(withBoth.prompt.length <= PROMPT_LIMIT);
  const added = withBoth.prompt.length - plain.prompt.length;
  // The owner's section is at most the bound plus its framing; the repository's memory sits inside the board snapshot, which is bounded on its own.
  assert.ok(added <= ARIL_MEMORY.promptLength + 100 * 3 + 600 + (withBoth.sections.board - plain.sections.board), `the two memories added ${added} characters`);
  assert.ok(withBoth.sections.board <= 22_500, `the board section is ${withBoth.sections.board}`);
});

test("a turn's prompt carries the owner's memory, a follow-up's too, and the paired device's route reads it", async (context) => {
  const root = await directory(context);
  const h = await chatHarness(context, { ownerMemory: createOwnerMemory({ file: path.join(root, "aril-v1", OWNER_MEMORY_FILE) }) });
  const added = await h.chat.handle("owner_memory_add", { text: "Always answer in English." }, desktop);
  assert.equal(added.ok, true);
  await h.chat.handle("owner_memory_add", { text: "Ask before touching a release." }, desktop);
  assert.deepEqual((await h.chat.handle("owner_memory", {}, { paired: true })).entries.map((entry) => entry.text), ["Always answer in English.", "Ask before touching a release."]);
  const sent = await send(h);
  assert.equal(sent.ok, true);
  const prompt = h.runs[0].options.prompt;
  assert.ok(prompt.includes("\n<owner_memory>\n"));
  assert.ok(prompt.includes("- Always answer in English.\n- Ask before touching a release.\n</owner_memory>"));
  await finishTurn(h, h.runs[0], { status: "complete", text: "Ok." }, sent.conversationId);
  const conversation = await seed(h, { messages: withProposal(pendingProposal()) });
  assert.deepEqual(await h.handle("apply", { repositoryId, conversationId: conversation.id, proposalId: "p-0123456789ab" }), { ok: true });
  const followUp = await until(() => h.followUps()[0]);
  assert.ok(followUp.options.prompt.includes("- Always answer in English."), "the follow-up reads the owner's memory too");
  followUp.resolve({ status: "complete", text: "Noted." });
});

test("Aril cannot change the owner's memory: no proposal operation names it", () => {
  assert.doesNotMatch(AGENT_CHAT_INSTRUCTIONS, /"op":"(?:add|update|remove)_owner_memory"/u);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /edited only in Settings/u);
});
