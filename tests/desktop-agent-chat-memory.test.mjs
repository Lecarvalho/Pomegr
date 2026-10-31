// Aril's memory: free text for the owner (kept by desktop main) and one for each repository (kept in its task store), both limited to 6,000
// characters. The shared rules, the owner's file and its migration from the first version, the prompt, and Aril's own update of both.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyMemoryUpdate, ARIL_MEMORY, isMemoryLine, isMemoryText, legacyMemory, normalizeMemoryText } from "../shared/aril-memory.mjs";
import { createOwnerMemory, OWNER_MEMORY_FILE } from "../desktop/runtime/aril-owner-memory.mjs";
import { createArilSwitch } from "../desktop/runtime/aril-switch.mjs";
import { extractMemory, hideMemory, MEMORY_FENCE, normalizeMemoryUpdates, recordMemory } from "../desktop/runtime/agent-chat-memory.mjs";
import { ownerMemorySection } from "../desktop/runtime/agent-chat-prompt-parts.mjs";
import { AGENT_CHAT_INSTRUCTIONS, boardSnapshot, composePrompt, composePromptParts, PROMPT_LIMIT } from "../desktop/runtime/agent-chat-prompt.mjs";
import { largePromptOptions } from "./helpers/agent-chat-large-board.mjs";
import { chatHarness, finishTurn, pendingProposal, repositoryId, seed, send, until, withProposal } from "./helpers/agent-chat-harness.mjs";

const desktop = { event: {} };
const none = { text: "", previous: null, updatedAt: null, updatedBy: null };
const block = (updates) => `\`\`\`${MEMORY_FENCE}\n${typeof updates === "string" ? updates : JSON.stringify({ updates })}\n\`\`\``;
const update = (scope, add = [], remove = []) => ({ scope, add, remove });
const lines = (count, size = 40) => Array.from({ length: count }, (_, index) => `- Line ${index + 1} `.padEnd(size, "x")).join("\n");

async function directory(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-owner-memory-"));
  context.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

test("a memory text is at most 6,000 characters with no control character but a line break and a tab", () => {
  assert.deepEqual(ARIL_MEMORY, { textLength: 6000, lineLength: 300, updateLines: 10 });
  for (const good of ["", "- one\n- two", "x".repeat(6000), "tab\tis fine", "é".repeat(6000), "- a\n\n- b"]) assert.equal(isMemoryText(good), true, good.slice(0, 20));
  for (const bad of ["x".repeat(6001), "bell\u0007", "nul\u0000", "line\u2028separator", "para\u2029graph", "c1\u0085", 5, null, undefined]) assert.equal(isMemoryText(bad), false, JSON.stringify(bad));
  assert.equal(normalizeMemoryText("a\r\nb\rc"), "a\nb\nc");
});

test("a line to add or remove is one nonblank line of at most 300 characters", () => {
  for (const good of ["Run focused tests first.", "x".repeat(300), "é".repeat(300)]) assert.equal(isMemoryLine(good), true, good.slice(0, 20));
  for (const bad of ["", "   ", "x".repeat(301), "two\nlines", "tab\there", "bell\u0007", "line\u2028separator", 5, null, undefined]) assert.equal(isMemoryLine(bad), false, JSON.stringify(bad));
});

test("an update adds lines last, removes the lines it names, leaves a duplicate out, and refuses what it cannot do", () => {
  const text = "- Reply briefly.\n- Merge myself.\nFree words the owner wrote.";
  assert.deepEqual(applyMemoryUpdate(text, { add: ["Ask before a release."], remove: [] }), { ok: true, text: `${text}\n- Ask before a release.`, added: 1, removed: 0 });
  assert.deepEqual(applyMemoryUpdate("", { add: ["First."], remove: [] }), { ok: true, text: "- First.", added: 1, removed: 0 }, "an empty text starts without a blank line");
  assert.deepEqual(applyMemoryUpdate(text, { add: ["- Merge myself."], remove: [] }), { ok: true, text, added: 0, removed: 0 }, "a line that is there is not added again");
  assert.deepEqual(applyMemoryUpdate(text, { add: [], remove: ["Reply briefly."] }), { ok: true, text: "- Merge myself.\nFree words the owner wrote.", added: 0, removed: 1 }, "a line is compared without its marker");
  assert.deepEqual(applyMemoryUpdate(text, { add: ["Reply at length."], remove: ["- Reply briefly."] }), { ok: true, text: "- Merge myself.\nFree words the owner wrote.\n- Reply at length.", added: 1, removed: 1 });
  assert.deepEqual(applyMemoryUpdate(text, { add: [], remove: ["A line that is not there."] }), { ok: false, error: "not_found" });
  assert.deepEqual(applyMemoryUpdate(text, { add: ["x".repeat(301)], remove: [] }), { ok: false, error: "invalid" });
  assert.deepEqual(applyMemoryUpdate(text, { add: [], remove: [] }), { ok: false, error: "invalid" });
  assert.deepEqual(applyMemoryUpdate(text, { add: Array(11).fill("x"), remove: [] }), { ok: false, error: "invalid" });
  assert.deepEqual(applyMemoryUpdate(text, { add: "x", remove: [] }), { ok: false, error: "invalid" });
  assert.deepEqual(applyMemoryUpdate("x".repeat(6001), { add: ["a"], remove: [] }), { ok: false, error: "invalid" });
  // The result must fit the limit: a full text takes no line, until a stale one is removed.
  const full = `${lines(20, 299)}`;
  assert.equal(full.length <= ARIL_MEMORY.textLength, true);
  assert.deepEqual(applyMemoryUpdate(full, { add: ["x".repeat(300)], remove: [] }), { ok: false, error: "too_long" });
  assert.equal(applyMemoryUpdate(full, { add: ["x".repeat(290)], remove: [full.split("\n")[0]] }).ok, true);
});

test("the older entries become one text, oldest first, and a text over the limit keeps the whole of it as the previous text", () => {
  const entries = [{ id: 2, text: "Second.", createdAt: 20, updatedAt: 90 }, { id: 1, text: "First.", createdAt: 10, updatedAt: 40 }, { id: 3, text: "Third.", createdAt: 20, updatedAt: 70 }, { id: "x", text: "Malformed." }];
  assert.deepEqual(legacyMemory(entries), { text: "- First.\n- Second.\n- Third.", previous: null, updatedAt: 90 });
  assert.deepEqual(legacyMemory([]), { text: "", previous: null, updatedAt: null });
  const big = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, text: "x".repeat(300), createdAt: index, updatedAt: index }));
  const migrated = legacyMemory(big);
  assert.equal(migrated.previous.split("\n").length, 100, "nothing is lost");
  assert.equal(migrated.text.split("\n").length, 19, "the newest lines that fit 6,000 characters stay as the text");
  assert.ok(migrated.text.length <= ARIL_MEMORY.textLength);
  assert.equal(migrated.text.split("\n").at(-1), migrated.previous.split("\n").at(-1), "the newest line is kept");
});

test("the owner's memory is free text in one private file: it keeps the text before the last change and who and when", async (context) => {
  const root = await directory(context);
  const file = path.join(root, "aril-v1", OWNER_MEMORY_FILE);
  let time = 1000;
  const memory = createOwnerMemory({ file, now: () => (time += 1) });
  assert.deepEqual(await memory.read(), none);
  assert.deepEqual(await memory.set("- Keep pull requests small."), { ok: true, memory: { text: "- Keep pull requests small.", previous: "", updatedAt: 1001, updatedBy: "owner" } });
  assert.deepEqual((await memory.set("- Keep pull requests small and focused.\r\nAnswer briefly.")).memory, { text: "- Keep pull requests small and focused.\nAnswer briefly.", previous: "- Keep pull requests small.", updatedAt: 1002, updatedBy: "owner" }, "line breaks are normalized");
  assert.equal((await memory.set("- Keep pull requests small and focused.\nAnswer briefly.")).memory.updatedAt, 1002, "the same text is not a change");
  assert.deepEqual(await memory.set("x".repeat(6001)), { ok: false, error: "limit" });
  assert.deepEqual(await memory.set("bell\u0007"), { ok: false, error: "invalid" });
  assert.deepEqual(await memory.set(7), { ok: false, error: "invalid" });
  assert.equal((await memory.set("x".repeat(6000))).ok, true, "6,000 characters fit");
  assert.deepEqual(await memory.set(""), { ok: true, memory: { text: "", previous: "x".repeat(6000), updatedAt: 1004, updatedBy: "owner" } }, "the owner may empty it");
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["previous", "text", "updatedAt", "updatedBy", "version"]);
  assert.equal(stored.version, 2);
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left");
  assert.deepEqual(await createOwnerMemory({ file }).read(), { text: "", previous: "x".repeat(6000), updatedAt: 1004, updatedBy: "owner" }, "a restart reads what was kept");
});

test("Aril's update of the owner's memory is applied to the text as it is, written as Aril's, and bounded like the owner's", async (context) => {
  const root = await directory(context);
  const memory = createOwnerMemory({ file: path.join(root, "aril-v1", OWNER_MEMORY_FILE), now: () => 5000 });
  await memory.set("- Reply briefly.\n- Merge myself.");
  assert.deepEqual(await memory.apply({ add: ["Ask before a release."], remove: ["Merge myself."] }), { ok: true, added: 1, removed: 1 });
  assert.deepEqual(await memory.read(), { text: "- Reply briefly.\n- Ask before a release.", previous: "- Reply briefly.\n- Merge myself.", updatedAt: 5000, updatedBy: "aril" });
  assert.deepEqual(await memory.apply({ add: ["Ask before a release."], remove: [] }), { ok: true, added: 0, removed: 0 }, "nothing changes, so nothing is written");
  assert.equal((await memory.read()).previous, "- Reply briefly.\n- Merge myself.");
  assert.deepEqual(await memory.apply({ add: [], remove: ["A line that is not there."] }), { ok: false, error: "not_found" });
  assert.deepEqual(await memory.apply({ add: ["x".repeat(301)], remove: [] }), { ok: false, error: "invalid" });
  await memory.set(lines(20, 299));
  assert.deepEqual(await memory.apply({ add: ["x".repeat(300)], remove: [] }), { ok: false, error: "limit" }, "an update that would pass 6,000 characters changes nothing");
  assert.equal((await memory.read()).text, lines(20, 299));
  assert.equal((await memory.read()).updatedBy, "owner");
});

test("a change that cannot be written is not kept", async () => {
  let failing = false;
  const filesystem = { readFile: async () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); }, mkdir: async () => {}, rename: async () => {}, unlink: async () => {},
    writeFile: async () => { if (failing) throw new Error("disk"); } };
  const memory = createOwnerMemory({ file: path.resolve("owner-memory.json"), filesystem });
  assert.equal((await memory.set("One.")).ok, true);
  failing = true;
  assert.deepEqual(await memory.set("Two."), { ok: false, error: "unavailable" });
  assert.deepEqual(await memory.apply({ add: ["Three."], remove: [] }), { ok: false, error: "unavailable" });
  assert.equal((await memory.read()).text, "One.");
});

test("the first version's file becomes text once: one line for each entry, oldest first, and the old file stays readable until the new one is written", async (context) => {
  const root = await directory(context);
  const file = path.join(root, "aril-v1", OWNER_MEMORY_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const entries = [{ id: 2, text: "Ask before a release.", createdAt: 20, updatedAt: 90 }, { id: 1, text: "Reply briefly.", createdAt: 10, updatedAt: 40 }];
  await fs.writeFile(file, JSON.stringify({ version: 1, next: 3, entries }));
  const memory = createOwnerMemory({ file });
  assert.deepEqual(await memory.read(), { text: "- Reply briefly.\n- Ask before a release.", previous: null, updatedAt: 90, updatedBy: "owner" });
  const migrated = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(migrated, { version: 2, text: "- Reply briefly.\n- Ask before a release.", previous: null, updatedAt: 90, updatedBy: "owner" }, "the file was replaced whole");
  assert.deepEqual(await createOwnerMemory({ file }).read(), await memory.read(), "a second start reads the new file and changes nothing");
  // A write that fails leaves the first version's file exactly as it was, and the text is served from memory until a change is written.
  const legacy = JSON.stringify({ version: 1, next: 3, entries });
  await fs.writeFile(file, legacy);
  let failing = true;
  const filesystem = { ...fs, writeFile: (...args) => (failing ? Promise.reject(new Error("disk")) : fs.writeFile(...args)) };
  const blocked = createOwnerMemory({ file, filesystem });
  assert.equal((await blocked.read()).text, "- Reply briefly.\n- Ask before a release.");
  assert.equal(await fs.readFile(file, "utf8"), legacy, "the old data is still there");
  failing = false;
  assert.equal((await blocked.set("- Reply briefly.")).ok, true);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).version, 2);
  // Too long for one text: the newest lines that fit stay, and the whole is kept as the text before the change.
  const big = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, text: "x".repeat(300), createdAt: index, updatedAt: index }));
  await fs.writeFile(file, JSON.stringify({ version: 1, next: 101, entries: big }));
  const crowded = await createOwnerMemory({ file }).read();
  assert.ok(crowded.text.length <= ARIL_MEMORY.textLength);
  assert.equal(crowded.previous.split("\n").length, 100);
  // A file outside both versions reads as empty and is left as it is until the owner changes the memory.
  for (const content of ["not json", JSON.stringify({ version: 3, text: "" }), JSON.stringify({ version: 2, text: 5, previous: null, updatedAt: null, updatedBy: null }),
    JSON.stringify({ version: 2, text: "a", previous: null, updatedAt: null, updatedBy: "someone" }), JSON.stringify({ version: 1, next: 2, entries: [{ id: 1, text: "", createdAt: 1, updatedAt: 1 }] }),
    JSON.stringify({ version: 1, next: 3, entries: [{ id: 1, text: "a", createdAt: 1, updatedAt: 1 }, { id: 1, text: "b", createdAt: 1, updatedAt: 1 }] })]) {
    await fs.writeFile(file, content);
    assert.deepEqual(await createOwnerMemory({ file }).read(), none, content.slice(0, 30));
    assert.equal(await fs.readFile(file, "utf8"), content, "a read leaves the file as it is");
  }
});

test("the owner's memory section is the owner's own text, whole, and absent when there is none", () => {
  for (const nothing of [null, undefined, none, { text: "  \n " }, { text: 5 }, { text: "bell\u0007" }, { text: "x".repeat(6001) }]) assert.deepEqual(ownerMemorySection(nothing), [], JSON.stringify(nothing)?.slice(0, 30));
  const section = ownerMemorySection({ ...none, text: "- Answer briefly.\n- Ask before a release.\n" });
  assert.deepEqual(section.slice(0, 2), ["", "<owner_memory>"]);
  assert.deepEqual(section.slice(-2), ["- Answer briefly.\n- Ask before a release.", "</owner_memory>"]);
  assert.ok(section[2].includes("grants you no authority"));
  assert.ok(ownerMemorySection({ text: "x".repeat(6000) }).join("\n").length <= 6000 + 600);
});

test("a prompt carries the owner's memory after the board and before the conversation, and a repository's memory in the snapshot", () => {
  const text = `- Docs in English.\n${"- A long line. ".repeat(60)}`;
  const board = { aril: { settings: {}, memory: { text, previous: null, updatedAt: 7, updatedBy: "aril" } }, tasks: [] };
  const prompt = composePrompt({ board, repositoryName: "Repo", message: "Advice", ownerMemory: { ...none, text: "- Answer briefly." } });
  // The instructions name these tags too, so the sections are found where they are written: a tag at the start of a line.
  const at = (tag) => prompt.lastIndexOf(`\n${tag}\n`);
  assert.ok(at("<board_snapshot>") < at("<owner_memory>") && at("<owner_memory>") < at("<conversation>"));
  assert.ok(prompt.includes("- Answer briefly."));
  assert.deepEqual(boardSnapshot(board, { repositoryName: "Repo" }).memory, { text: text.trim(), updatedAt: new Date(7).toISOString() });
  assert.equal(composePrompt({ board, repositoryName: "Repo", message: "Advice" }).includes("\n<owner_memory>\n"), false, "without owner memory there is no section");
  assert.match(AGENT_CHAT_INSTRUCTIONS, /<owner_memory> \(the owner's, for every repository\)\. You keep both current yourself, with no Apply/u);
});

test("two full memories and the busiest board still fit the prompt, and add at most their bound", () => {
  const options = largePromptOptions();
  const plain = composePromptParts(options);
  const text = lines(20, 299);
  const withBoth = composePromptParts({ ...options, ownerMemory: { ...none, text }, board: { ...options.board, aril: { ...options.board.aril, memory: { text, previous: null, updatedAt: 1, updatedBy: "owner" } } } });
  assert.ok(withBoth, "the prompt fits");
  assert.ok(withBoth.prompt.length <= PROMPT_LIMIT);
  const added = withBoth.prompt.length - plain.prompt.length;
  // The owner's section is at most the bound plus its framing; the repository's memory sits inside the board snapshot, which is bounded on its own.
  assert.ok(added <= ARIL_MEMORY.textLength + 600 + (withBoth.sections.board - plain.sections.board), `the two memories added ${added} characters`);
  assert.ok(withBoth.sections.board <= 22_500, `the board section is ${withBoth.sections.board}`);
});

test("the memory block is read strictly: one or two updates with distinct scopes, bounded lines, and nothing else", () => {
  const good = [update("owner", ["Reply briefly."]), update("repository", [], ["Old line."])];
  assert.deepEqual(normalizeMemoryUpdates({ updates: good }), good);
  assert.deepEqual(normalizeMemoryUpdates({ updates: [update("owner", [" Reply briefly. "])] }), [update("owner", ["Reply briefly."])], "a line is trimmed");
  for (const bad of [null, [], {}, { updates: [] }, { updates: [update("owner", ["a"]), update("owner", ["b"])] }, { updates: [...good, update("owner", ["c"])] },
    { updates: [update("everywhere", ["a"])] }, { updates: [update("Pomegr", ["a"])] }, { updates: [update("repo-0123456789abcdef01234567", ["a"])] }, { updates: [update("OWNER", ["a"])] },
    { updates: [update("owner")] }, { updates: [update("owner", Array(11).fill("a"))] }, { updates: [update("owner", ["x".repeat(301)])] }, { updates: [update("owner", ["two\nlines"])] },
    { updates: [{ scope: "owner", add: ["a"] }] }, { updates: [{ ...update("owner", ["a"]), extra: 1 }] }, { updates: [update("owner", "a")] }, { updates: good, extra: true }, { replace: "a" }]) {
    assert.equal(normalizeMemoryUpdates(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
  const extracted = extractMemory(`Saved.\n\n${block([update("repository", ["Docs in English."])])}`);
  assert.deepEqual(extracted, { text: "Saved.", updates: [update("repository", ["Docs in English."])], unreadable: false });
  assert.deepEqual(extractMemory("No block."), { text: "No block.", updates: null, unreadable: false });
  for (const answer of [`A\n${block("{not json")}`, `A\n${block([update("owner", ["a"])])}\n${block([update("owner", ["b"])])}`, `A\n\`\`\`${MEMORY_FENCE}\n{"updates": []`,
    `A\n${block([update("anywhere", ["a"])])}`, `A\n${block(`{"updates":[${JSON.stringify(update("owner", ["x".repeat(9000)]))}]}`)}`]) {
    const read = extractMemory(answer);
    assert.equal(read.updates, null);
    assert.equal(read.unreadable, true, answer.slice(0, 40));
    assert.equal(read.text, "A", "the block is never shown");
  }
  assert.equal(hideMemory(`Half\n\`\`\`${MEMORY_FENCE}\n{"upd`), "Half");
  assert.equal(hideMemory(`A\n${block([update("owner", ["a"])])}\nB`), "A\n\nB");
});

test("recording an update puts one fixed line for each scope after the answer, and nothing a function says reaches it", async () => {
  const read = { text: "Saved.", proposal: null, unreadable: false };
  const found = { text: "Saved.", updates: [update("owner", ["a"]), update("repository", ["b"], ["c"])], unreadable: false };
  const apply = { owner: async () => ({ ok: true, added: 1, removed: 0 }), repository: async () => ({ ok: true, added: 1, removed: 1, secret: "private" }) };
  assert.equal((await recordMemory(read, found, { on: () => true, apply }, 32_000)).text, "Saved.\n\nMemory updated: you · 1 added\nMemory updated: this repository · 1 added · 1 removed");
  assert.equal((await recordMemory(read, found, { on: () => true, apply: { owner: async () => ({ ok: true, added: 0, removed: 0 }), repository: async () => ({ ok: false, error: "limit" }) } }, 32_000)).text,
    "Saved.\n\nMemory already up to date: you\nMemory not updated: this repository · too long");
  assert.equal((await recordMemory(read, found, { on: () => true, apply: { owner: async () => { throw new Error("private text"); }, repository: async () => ({ ok: false, error: "private details" }) } }, 32_000)).text,
    "Saved.\n\nMemory not updated: you · could not be saved\nMemory not updated: this repository · could not be saved");
  assert.equal((await recordMemory(read, found, { on: () => false, apply: { owner: () => assert.fail("off"), repository: () => assert.fail("off") } }, 32_000)).text,
    "Saved.\n\nMemory not updated: you · Aril is off\nMemory not updated: this repository · Aril is off");
  assert.equal((await recordMemory(read, { text: "Saved.", updates: null, unreadable: true }, { on: () => true, apply }, 32_000)).text, "Saved.\n\nMemory not updated: the update could not be read");
  assert.equal(await recordMemory(read, { text: "Saved.", updates: null, unreadable: false }, { on: () => true, apply }, 32_000), read);
  assert.ok((await recordMemory({ text: "x".repeat(40_000) }, found, { on: () => true, apply }, 32_000)).text.length <= 32_000, "the answer stays within its bound");
});

test("a turn's prompt carries the owner's memory, a follow-up's too, and a paired device reads it but cannot change it", async (context) => {
  const root = await directory(context);
  const h = await chatHarness(context, { ownerMemory: createOwnerMemory({ file: path.join(root, "aril-v1", OWNER_MEMORY_FILE) }) });
  const saved = await h.chat.handle("owner_memory_set", { text: "- Always answer in English.\n- Ask before touching a release." }, desktop);
  assert.equal(saved.ok, true);
  assert.equal(saved.memory.updatedBy, "owner");
  assert.deepEqual((await h.chat.handle("owner_memory", {}, { paired: true })).memory.text, "- Always answer in English.\n- Ask before touching a release.");
  assert.deepEqual(await h.chat.handle("owner_memory_set", { text: "x" }, { paired: true }), { ok: false, error: "desktop_only" });
  assert.deepEqual(await h.chat.handle("owner_memory_set", { text: "x", extra: 1 }, desktop), { ok: false, error: "invalid" });
  assert.deepEqual(await h.chat.handle("owner_memory_set", { text: "x".repeat(6001) }, desktop), { ok: false, error: "limit" });
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

// An owner's message answered with a memory block: the owner's text changes in desktop main, and the repository's through the monitor.
async function answered(context, text, { status = "complete", off = false, actions } = {}) {
  const root = await directory(context);
  const ownerMemory = createOwnerMemory({ file: path.join(root, "aril-v1", OWNER_MEMORY_FILE), now: () => 9000 });
  await ownerMemory.set("- Reply briefly.");
  const arilSwitch = createArilSwitch({ initial: { on: true } });
  const h = await chatHarness(context, { ownerMemory, arilSwitch });
  h.state.actions = actions ?? ((action, payload, body) => (action === "aril-memory-update" ? { ok: true, added: body.add.length, removed: body.remove.length } : { ok: true }));
  const sent = await send(h);
  // Off stops the turn in flight, but a run that completes in the same moment still finds the switch Off: its memory block is not applied.
  if (off) await arilSwitch.set(false);
  const conversation = await finishTurn(h, h.runs[0], { status, text }, sent.conversationId);
  return { h, ownerMemory, answer: conversation.messages.at(-1) };
}
const memoryCalls = (h) => h.calls.filter((call) => call.pathname === "/internal/tasks/aril-memory-update");

test("Aril keeps both memories current by itself: each update goes to its own memory, with no Apply, and the owner sees one line for each", async (context) => {
  const { h, ownerMemory, answer } = await answered(context, `Noted both.\n\n${block([update("owner", ["Ask before a release."], ["Reply briefly."]), update("repository", ["Docs in English."])])}`);
  assert.equal(answer.text, "Noted both.\n\nMemory updated: you · 1 added · 1 removed\nMemory updated: this repository · 1 added");
  assert.equal(answer.proposal, undefined, "no proposal and no Apply");
  assert.deepEqual(await ownerMemory.read(), { text: "- Ask before a release.", previous: "- Reply briefly.", updatedAt: 9000, updatedBy: "aril" });
  assert.equal(memoryCalls(h).length, 1);
  assert.deepEqual(memoryCalls(h)[0].body, { repositoryId, add: ["Docs in English."], remove: [] }, "the repository is the thread's own, and nothing else rides along");
  assert.equal(memoryCalls(h)[0].init.headers["content-type"], "application/json");
});

test("an update that is too long, names a line that is not there, or names another scope applies nothing and says why", async (context) => {
  const tooLong = await answered(context, `A\n${block([update("owner", ["x".repeat(300)])])}`, { actions: () => ({ ok: true }) });
  await tooLong.ownerMemory.set(lines(20, 299));
  const again = await send(tooLong.h);
  assert.equal(again.ok, true);
  const conversation = await finishTurn(tooLong.h, tooLong.h.runs[1], { status: "complete", text: `B\n${block([update("owner", ["x".repeat(300)])])}` }, again.conversationId);
  assert.equal(conversation.messages.at(-1).text, "B\n\nMemory not updated: you · too long");
  assert.equal((await tooLong.ownerMemory.read()).text, lines(20, 299));

  const repository = await answered(context, `A\n${block([update("repository", ["y"])])}`, { actions: (action) => (action === "aril-memory-update" ? { ok: false, error: "limit" } : { ok: true }) });
  assert.equal(repository.answer.text, "A\n\nMemory not updated: this repository · too long");
  const missing = await answered(context, `A\n${block([update("owner", [], ["A line that is not there."])])}`);
  assert.equal(missing.answer.text, "A\n\nMemory not updated: you · a line to remove is not there");
  assert.equal((await missing.ownerMemory.read()).text, "- Reply briefly.");

  for (const wrong of [update("everywhere", ["a"]), update("Pomegr", ["a"]), update("repo-0123456789abcdef01234567", ["a"])]) {
    const other = await answered(context, `A\n${block([wrong])}`);
    assert.equal(other.answer.text, "A\n\nMemory not updated: the update could not be read", wrong.scope);
    assert.equal((await other.ownerMemory.read()).text, "- Reply briefly.");
    assert.equal(memoryCalls(other.h).length, 0);
  }
});

test("a memory block applies only in a complete answer to an owner's message while Aril is On, and is never shown or stored", async (context) => {
  const text = `Noted.\n${block([update("owner", ["Ask before a release."]), update("repository", ["Docs in English."])])}`;
  const off = await answered(context, text, { off: true });
  assert.equal(off.answer.text, "Noted.\n\nMemory not updated: you · Aril is off\nMemory not updated: this repository · Aril is off");
  assert.equal((await off.ownerMemory.read()).text, "- Reply briefly.");
  assert.equal(memoryCalls(off.h).length, 0);
  for (const status of ["stopped", "failed", "timed_out"]) {
    const unfinished = await answered(context, text, { status });
    assert.equal(unfinished.answer.text.includes(MEMORY_FENCE), false, status);
    assert.equal((await unfinished.ownerMemory.read()).text, "- Reply briefly.", status);
    assert.equal(memoryCalls(unfinished.h).length, 0, status);
  }
  // A follow-up after an Apply never updates a memory, and its block is not shown.
  const root = await directory(context);
  const ownerMemory = createOwnerMemory({ file: path.join(root, "aril-v1", OWNER_MEMORY_FILE) });
  const h = await chatHarness(context, { ownerMemory });
  const conversation = await seed(h, { messages: withProposal(pendingProposal()) });
  assert.deepEqual(await h.handle("apply", { repositoryId, conversationId: conversation.id, proposalId: "p-0123456789ab" }), { ok: true });
  const after = await h.finishFollowUp(conversation.id, { status: "complete", text: `Done.\n${block([update("owner", ["x"])])}` });
  assert.equal(after.messages.at(-1).text, "Done.");
  assert.equal((await ownerMemory.read()).text, "");
  assert.equal(memoryCalls(h).length, 0);
});
