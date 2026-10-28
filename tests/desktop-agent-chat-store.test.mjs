import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as storeModule from "../desktop/runtime/agent-chat-store.mjs";
import {
  AGENT_CHAT_DIRECTORY,
  ANSWER_LENGTH,
  conversationTitle,
  createAgentChatStore,
  MESSAGE_LENGTH,
  MESSAGE_LIMIT,
  newConversationId,
  newProposalId,
  normalizeConversation,
  TITLE_LENGTH,
} from "../desktop/runtime/agent-chat-store.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const otherRepositoryId = "repo-fedcba9876543210fedcba98";
const stamp = "2026-10-01T12:00:00.000Z";

async function workspace(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-agent-chat-store-"));
  context.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const directory = path.join(root, "store");
  let tick = 0;
  const now = () => new Date(Date.parse(stamp) + (tick += 1000));
  return { root, directory, store: createAgentChatStore({ directory, now }), now };
}

const userMessage = (index, text = "Hello") => ({ id: `m-${index}`, role: "user", text, at: stamp });
const agentMessage = (index, extra = {}) => ({ id: `m-${index}`, role: "agent", text: "Hi there", at: stamp, provider: "claude", model: null, status: "complete", ...extra });

const everyOperation = [
  { op: "create_feature", name: "Auth" },
  { op: "create_task", text: "Write it", feature: "Auth", queue: true, run: { provider: "claude", model: "claude-opus-4-1", effort: "high" }, completeWhen: { checks: ["pr_open", "tree_clean"], own: "Changelog" } },
  { op: "create_task", text: "Bare" },
  { op: "update_task", id: "T-1", text: "Rewrite", feature: null, run: { effort: "low" }, completeWhen: { own: null } },
  { op: "update_task", id: "T-2", feature: "Auth", run: { provider: "codex", model: null }, completeWhen: { checks: [] } },
  { op: "delete_task", id: "T-3" },
  { op: "move_task", id: "T-4", column: "Ready", position: 2 },
  { op: "move_task", id: "T-4", column: "In progress" },
  { op: "queue_task", id: "T-5" },
  { op: "unqueue_task", id: "T-5" },
  { op: "group_tasks", ids: ["T-6", "T-7", "T-8"] },
  { op: "ungroup_tasks", ids: ["T-6"] },
];

function proposalWith(overrides = {}) {
  return {
    id: "p-0123456789ab", summary: "Cut the work", state: "partial", operations: everyOperation,
    results: everyOperation.map((_, index) => (index === 1 ? { ok: true, taskId: "T-9" } : index === 4 ? { ok: false, error: "conflict", taskId: "T-9" } : index > 4 ? { ok: false, error: "skipped" } : { ok: true })),
    ...overrides,
  };
}

function conversationOf(id, messages = [userMessage(1), agentMessage(2)], overrides = {}) {
  return { id, title: "A title", provider: "claude", model: "claude-opus-4-1", createdAt: stamp, updatedAt: stamp, messages, ...overrides };
}

const fileOf = (directory, id, repository = repositoryId) => path.join(directory, repository, `${id}.json`);

test("the store limits, directory name, and identifier formats are fixed", () => {
  assert.equal(AGENT_CHAT_DIRECTORY, "agent-chat-v1");
  assert.equal("CONVERSATION_LIMIT" in storeModule, false, "a repository holds any number of conversations");
  assert.equal(MESSAGE_LIMIT, 200);
  assert.equal(MESSAGE_LENGTH, 4000);
  assert.equal(ANSWER_LENGTH, 32_000);
  assert.equal(TITLE_LENGTH, 80);
  assert.match(newConversationId(), /^chat-[0-9a-f]{12}$/u);
  assert.match(newProposalId(), /^p-[0-9a-f]{12}$/u);
  assert.notEqual(newConversationId(), newConversationId());
  for (const directory of [undefined, null, "", "relative\\store", "./store", 5]) assert.throws(() => createAgentChatStore({ directory }), TypeError, String(directory));
  assert.throws(() => createAgentChatStore(), TypeError);
});

test("the title is the first non-empty line, trimmed and cut to 80 characters", () => {
  assert.equal(conversationTitle("Plan the release"), "Plan the release");
  assert.equal(conversationTitle("\r\n  \n   Second line wins  \r\nthird"), "Second line wins");
  assert.equal(conversationTitle(""), "New conversation");
  assert.equal(conversationTitle("  \n\t\n"), "New conversation");
  assert.equal(conversationTitle("a".repeat(80)), "a".repeat(80));
  const cut = conversationTitle("b".repeat(200));
  assert.equal(cut.length, 80);
  assert.equal(cut, `${"b".repeat(79)}…`);
  assert.equal(conversationTitle(12345), "12345");
});

test("a conversation is created, saved, read, listed, and removed", async (context) => {
  const { store, directory } = await workspace(context);
  assert.deepEqual(await store.index(repositoryId), []);
  const created = await store.create(repositoryId, { provider: "claude", model: "claude-opus-4-1", title: "Plan" });
  assert.match(created.id, /^chat-[0-9a-f]{12}$/u);
  assert.deepEqual({ ...created, id: "x" }, { id: "x", title: "Plan", provider: "claude", model: "claude-opus-4-1", createdAt: created.createdAt, updatedAt: created.createdAt, messages: [] });
  await assert.rejects(fs.stat(path.join(directory, repositoryId)), "nothing is on disk before the first save");
  const next = { ...created, updatedAt: "2026-10-01T13:00:00.000Z", messages: [userMessage(1), agentMessage(2)] };
  assert.equal(await store.save(repositoryId, next), true);
  assert.deepEqual(await store.read(repositoryId, created.id), next);
  assert.deepEqual((await store.index(repositoryId)).map((conversation) => conversation.id), [created.id]);
  assert.deepEqual(JSON.parse(await fs.readFile(fileOf(directory, created.id), "utf8")), { version: 1, repositoryId, conversation: next });
  assert.deepEqual(await fs.readdir(path.join(directory, repositoryId)), [`${created.id}.json`], "no temporary file is left");
  assert.equal(await store.remove(repositoryId, created.id), true);
  assert.equal(await store.read(repositoryId, created.id), null);
  assert.deepEqual(await store.index(repositoryId), []);
  await assert.rejects(fs.stat(fileOf(directory, created.id)));
  assert.equal(await store.remove(repositoryId, created.id), false, "a second remove finds nothing");
});

test("each conversation is one file under its repository, and a new store reads them again, newest first", async (context) => {
  const { store, directory } = await workspace(context);
  const ids = [];
  for (const [index, updatedAt] of ["2026-10-01T10:00:00.000Z", "2026-10-03T10:00:00.000Z", "2026-10-02T10:00:00.000Z"].entries()) {
    const created = await store.create(repositoryId, { provider: index === 1 ? "codex" : "claude", model: null, title: `Chat ${index}` });
    assert.equal(await store.save(repositoryId, { ...created, updatedAt, messages: [userMessage(1, `Question ${index}`)] }), true);
    ids.push(created.id);
  }
  const other = await store.create(otherRepositoryId, { provider: "claude", model: null, title: "Elsewhere" });
  assert.equal(await store.save(otherRepositoryId, { ...other, messages: [userMessage(1)] }), true);
  assert.deepEqual((await store.index(repositoryId)).map((conversation) => conversation.id), [ids[1], ids[2], ids[0]]);
  assert.deepEqual((await fs.readdir(path.join(directory, repositoryId))).sort(), ids.map((id) => `${id}.json`).sort());
  assert.deepEqual(await fs.readdir(path.join(directory, otherRepositoryId)), [`${other.id}.json`]);
  assert.equal(await store.read(repositoryId, other.id), null, "a conversation belongs to its own repository");

  const again = createAgentChatStore({ directory });
  assert.deepEqual((await again.index(repositoryId)).map((conversation) => conversation.id), [ids[1], ids[2], ids[0]]);
  assert.deepEqual(await again.read(repositoryId, ids[1]), await store.read(repositoryId, ids[1]));
  assert.equal((await again.read(repositoryId, ids[1])).provider, "codex");
  assert.deepEqual((await again.index(otherRepositoryId)).map((conversation) => conversation.title), ["Elsewhere"]);
});

test("a file that is malformed, of another repository, of another version, or too large is skipped and left untouched", async (context) => {
  const { store, directory } = await workspace(context);
  const good = await store.create(repositoryId, { provider: "claude", model: null, title: "Good" });
  await store.save(repositoryId, { ...good, messages: [userMessage(1)] });
  const folder = path.join(directory, repositoryId);
  const valid = conversationOf("chat-aaaaaaaaaaaa");
  const wrapper = (id, overrides = {}, conversation = conversationOf(id)) => JSON.stringify({ version: 1, repositoryId, conversation, ...overrides });
  const planted = {
    "chat-111111111111.json": "{ this is not json",
    "chat-222222222222.json": wrapper("chat-222222222222", { repositoryId: otherRepositoryId }),
    "chat-333333333333.json": wrapper("chat-333333333333", { version: 2 }),
    "chat-444444444444.json": "x".repeat(12 * 1024 * 1024 + 1),
    "chat-555555555555.json": wrapper("chat-555555555555", {}, conversationOf("chat-666666666666")),
    "chat-777777777777.json": wrapper("chat-777777777777", {}, { ...conversationOf("chat-777777777777"), messages: [{ id: "m-1", role: "user", text: "", at: stamp }] }),
    "chat-888888888888.json": JSON.stringify([1, 2, 3]),
    "chat-999999999999.json": "null",
    "notes.json": wrapper("notes"),
    "chat-ABCDEFABCDEF.json": wrapper("chat-ABCDEFABCDEF"),
    "chat-bbbbbbbbbbbb.json.bak": wrapper("chat-bbbbbbbbbbbb"),
  };
  for (const [name, content] of Object.entries(planted)) await fs.writeFile(path.join(folder, name), content);
  await fs.writeFile(path.join(folder, "chat-aaaaaaaaaaaa.json"), wrapper("chat-aaaaaaaaaaaa", {}, valid));
  const before = new Map(await Promise.all(Object.keys(planted).map(async (name) => [name, await fs.readFile(path.join(folder, name), "utf8")])));

  const fresh = createAgentChatStore({ directory });
  assert.deepEqual((await fresh.index(repositoryId)).map((conversation) => conversation.id).sort(), [good.id, "chat-aaaaaaaaaaaa"].sort());
  for (const id of ["chat-111111111111", "chat-222222222222", "chat-333333333333", "chat-444444444444", "chat-555555555555", "chat-666666666666", "chat-777777777777"]) {
    assert.equal(await fresh.read(repositoryId, id), null, id);
  }
  // A skipped file is never overwritten or removed, even by a save or remove that names it.
  assert.equal(await fresh.save(repositoryId, conversationOf("chat-111111111111")), false);
  assert.equal(await fresh.save(repositoryId, conversationOf("chat-222222222222")), false);
  assert.equal(await fresh.remove(repositoryId, "chat-333333333333"), false);
  const goodNow = await fresh.read(repositoryId, good.id);
  assert.equal(await fresh.save(repositoryId, { ...goodNow, title: "Renamed" }), true);
  assert.equal(await fresh.remove(repositoryId, "chat-aaaaaaaaaaaa"), true);
  for (const [name, content] of before) assert.equal(await fs.readFile(path.join(folder, name), "utf8"), content, `${name} is untouched`);
});

test("a repository holds any number of conversations, and each repository keeps its own", async (context) => {
  const { store } = await workspace(context);
  for (let index = 0; index < 60; index += 1) assert.ok(await store.create(repositoryId, { provider: "claude", model: null, title: `Chat ${index}` }));
  assert.equal((await store.index(repositoryId)).length, 60);
  assert.ok(await store.create(otherRepositoryId, { provider: "codex", model: null, title: "Other repository" }));
  const [first] = await store.index(repositoryId);
  assert.equal(await store.remove(repositoryId, first.id), true);
  assert.equal((await store.index(repositoryId)).length, 59);
  assert.equal((await store.index(otherRepositoryId)).length, 1);
});

test("the index holds an entry for each conversation without its messages, and follows every save", async (context) => {
  const { store, directory } = await workspace(context);
  const created = await store.create(repositoryId, { provider: "codex", model: "gpt-6-luna", effort: "high", title: "Plan" });
  const followUps = await store.create(repositoryId, { provider: "claude", model: null, title: "Grant follow-ups", grantFollowUps: { grant: null, through: null, ended: null, messageId: null } });
  const picture = { id: "img-0123456789ab", type: "png", bytes: 5 };
  const messages = [
    { ...userMessage(1), at: "2026-10-01T12:00:00.000Z", images: [picture, { ...picture, id: "img-0123456789ac" }] },
    { ...agentMessage(2), at: "2026-10-01T12:05:00.000Z" },
    { ...agentMessage(3, { status: "failed" }), at: "2026-10-01T12:09:00.000Z" },
    { ...userMessage(4), at: "2026-10-01T12:07:00.000Z" },
  ];
  assert.equal(await store.save(repositoryId, { ...created, updatedAt: "2026-10-01T12:10:00.000Z", messages }), true);
  const entry = (await store.index(repositoryId)).find(({ id }) => id === created.id);
  assert.deepEqual(entry, {
    id: created.id, title: "Plan", provider: "codex", model: "gpt-6-luna", effort: "high", createdAt: created.createdAt, updatedAt: "2026-10-01T12:10:00.000Z",
    messages: 4, images: 2, lastRole: "user", answeredAt: Date.parse("2026-10-01T12:05:00.000Z"),
    from: Date.parse("2026-10-01T12:00:00.000Z"), to: Date.parse("2026-10-01T12:09:00.000Z"),
  });
  assert.equal("messages" in entry && Array.isArray(entry.messages), false, "no message is in the index");
  assert.deepEqual(JSON.parse(JSON.stringify((await store.index(repositoryId)).find(({ id }) => id === followUps.id).grantFollowUps)), { grant: null, through: null, ended: null, messageId: null });
  assert.deepEqual(entry, (await createAgentChatStore({ directory }).index(repositoryId)).find(({ id }) => id === created.id), "a new store builds the same entry from the file");
  assert.equal(Object.isFrozen(entry), true);
  assert.deepEqual((await store.index(repositoryId)).find(({ id }) => id === followUps.id), { ...(await store.index(repositoryId)).find(({ id }) => id === followUps.id), messages: 0, from: null, to: null, lastRole: null, answeredAt: null });
});

test("only the conversations read lately keep their messages in memory, and every one is still read in full from its file", async (context) => {
  const { store, directory } = await workspace(context);
  const ids = [];
  for (let index = 0; index < 40; index += 1) {
    const created = await store.create(repositoryId, { provider: "claude", model: null, title: `Chat ${index}` });
    assert.equal(await store.save(repositoryId, { ...created, messages: [userMessage(1, `Question ${index}`)] }), true);
    ids.push(created.id);
  }
  const reads = [];
  const counting = createAgentChatStore({ directory, filesystem: { ...fs, readFile: (target, ...rest) => { reads.push(path.basename(String(target))); return fs.readFile(target, ...rest); } } });
  assert.equal((await counting.index(repositoryId)).length, 40);
  assert.equal(reads.length, 40, "the index reads each file once");
  reads.length = 0;
  for (const id of ids) assert.equal((await counting.read(repositoryId, id)).messages[0].text, `Question ${ids.indexOf(id)}`);
  assert.equal(reads.length, 40, "a conversation that is not in memory is read from its file");
  reads.length = 0;
  for (const id of ids.slice(-16)) await counting.read(repositoryId, id);
  assert.equal(reads.length, 0, "the sixteen read last are in memory");
  await counting.read(repositoryId, ids[0]);
  assert.equal(reads.length, 1, "an older one is not");
  assert.deepEqual(await counting.read(repositoryId, ids[0]), await store.read(repositoryId, ids[0]));
});

test("a conversation saved and then pushed out of memory is read with its last save, even while the file is being written", async (context) => {
  const { store, directory } = await workspace(context);
  const created = await store.create(repositoryId, { provider: "claude", model: null, title: "Plan" });
  const saving = store.save(repositoryId, { ...created, messages: [userMessage(1, "Latest")] });
  for (let index = 0; index < 20; index += 1) {
    const other = await store.create(repositoryId, { provider: "claude", model: null, title: `Other ${index}` });
    await store.save(repositoryId, { ...other, messages: [userMessage(1)] });
    await store.read(repositoryId, other.id);
  }
  assert.equal((await store.read(repositoryId, created.id)).messages[0].text, "Latest");
  await saving;
  assert.equal(JSON.parse(await fs.readFile(fileOf(directory, created.id), "utf8")).conversation.messages[0].text, "Latest");
});

test("a write that fails leaves the index and the messages as they were, and a conversation never written stays", async (context) => {
  const { store, directory } = await workspace(context);
  const created = await store.create(repositoryId, { provider: "claude", model: null, title: "Plan" });
  assert.equal(await store.save(repositoryId, { ...created, messages: [userMessage(1, "Kept")] }), true);
  let failing = true;
  const flaky = createAgentChatStore({ directory, filesystem: { ...fs, rename: (...args) => (failing ? Promise.reject(new Error("disk")) : fs.rename(...args)) } });
  const [before] = await flaky.index(repositoryId);
  assert.equal(await flaky.save(repositoryId, { ...created, updatedAt: "2026-10-02T10:00:00.000Z", messages: [userMessage(1, "Lost"), agentMessage(2)] }), false);
  assert.deepEqual((await flaky.index(repositoryId))[0], before);
  assert.equal((await flaky.read(repositoryId, created.id)).messages[0].text, "Kept");
  const fresh = await flaky.create(repositoryId, { provider: "claude", model: null, title: "New" });
  assert.equal(await flaky.save(repositoryId, { ...fresh, messages: [userMessage(1, "Unsaved")] }), false);
  assert.equal((await flaky.read(repositoryId, fresh.id)).messages.length, 0, "the conversation made and not written is still there, empty");
  failing = false;
  assert.equal(await flaky.save(repositoryId, { ...fresh, messages: [userMessage(1, "Saved")] }), true);
  assert.equal((await flaky.read(repositoryId, fresh.id)).messages[0].text, "Saved");
});

test("create refuses a title, provider, or model outside the contract", async (context) => {
  const { store } = await workspace(context);
  for (const options of [
    { provider: "claude", model: null, title: "" }, { provider: "claude", model: null, title: "t".repeat(81) }, { provider: "claude", model: null, title: 7 },
    { provider: "gemini", model: null, title: "t" }, { provider: "claude", model: "../x", title: "t" }, { provider: "claude", model: "--help", title: "t" },
  ]) assert.equal(await store.create(repositoryId, options), null, JSON.stringify(options));
  assert.deepEqual(await store.index(repositoryId), []);
});

test("save refuses an unknown conversation, too many messages, a message or answer over its length, and a bad proposal, and changes nothing", async (context) => {
  const { store, directory } = await workspace(context);
  const created = await store.create(repositoryId, { provider: "claude", model: null, title: "Plan" });
  const baseline = { ...created, messages: [userMessage(1), agentMessage(2)] };
  assert.equal(await store.save(repositoryId, baseline), true);
  const onDisk = await fs.readFile(fileOf(directory, created.id), "utf8");
  const refuse = async (conversation, rule) => {
    assert.equal(await store.save(repositoryId, conversation), false, rule);
    assert.deepEqual(await store.read(repositoryId, created.id), baseline, `${rule}: memory is unchanged`);
    assert.equal(await fs.readFile(fileOf(directory, created.id), "utf8"), onDisk, `${rule}: the file is unchanged`);
  };
  const proposalMessage = (proposal) => agentMessage(2, { proposal });
  const turn = (index) => (index % 2 === 0 ? agentMessage(index + 1) : userMessage(index + 1));
  await refuse({ ...baseline, messages: Array.from({ length: MESSAGE_LIMIT + 1 }, (_, index) => turn(index)) }, "201 messages");
  await refuse({ ...baseline, messages: [userMessage(1, "u".repeat(MESSAGE_LENGTH + 1))] }, "user text over 4000");
  await refuse({ ...baseline, messages: [userMessage(1, "")] }, "empty user text");
  await refuse({ ...baseline, messages: [userMessage(1), agentMessage(2, { text: "a".repeat(ANSWER_LENGTH + 1) })] }, "answer over 32000");
  await refuse({ ...baseline, messages: [userMessage(1), agentMessage(2, { status: "weird" })] }, "unknown turn status");
  await refuse({ ...baseline, messages: [userMessage(1), agentMessage(2, { provider: "gemini" })] }, "unknown provider");
  await refuse({ ...baseline, messages: [userMessage(1), agentMessage(2, { model: "a b" })] }, "bad model");
  await refuse({ ...baseline, messages: [userMessage(1), userMessage(1, "again")] }, "duplicate message id");
  await refuse({ ...baseline, messages: [{ ...userMessage(1), id: "m-0" }] }, "bad message id");
  await refuse({ ...baseline, messages: [{ ...userMessage(1), at: "yesterday" }] }, "bad time");
  await refuse({ ...baseline, title: "" }, "empty title");
  await refuse({ ...baseline, id: "chat-ffffffffffff" }, "a conversation that was never created");
  for (const [rule, proposal] of [
    ["bad proposal id", proposalWith({ id: "p-xyz" })], ["bad proposal state", proposalWith({ state: "done" })],
    ["empty summary", proposalWith({ summary: "" })], ["summary over 300", proposalWith({ summary: "s".repeat(301) })],
    ["no operations", proposalWith({ operations: [], results: [] })],
    ["41 operations", proposalWith({ operations: Array.from({ length: 41 }, () => ({ op: "queue_task", id: "T-1" })), results: undefined })],
    ["a bad operation", proposalWith({ operations: [{ op: "delete_task", id: "T-1", extra: true }], results: undefined })],
    ["results of another length", proposalWith({ results: [{ ok: true }] })],
    ["a bad result error", proposalWith({ operations: [{ op: "delete_task", id: "T-1" }], results: [{ ok: false, error: "teapot" }] })],
    ["a result without ok", proposalWith({ operations: [{ op: "delete_task", id: "T-1" }], results: [{ error: "invalid" }] })],
    ["results that are not a list", proposalWith({ results: "applied" })],
  ]) await refuse({ ...baseline, messages: [userMessage(1), proposalMessage(proposal)] }, rule);
  assert.equal(await store.save("../x", baseline), false);
  assert.equal(await store.save(repositoryId, null), false);
  assert.equal(await store.save(repositoryId, "chat"), false);
});

test("the edges of the message and answer bounds are accepted", async (context) => {
  const { store } = await workspace(context);
  const created = await store.create(repositoryId, { provider: "claude", model: null, title: "t".repeat(80) });
  const messages = [userMessage(1, "u".repeat(MESSAGE_LENGTH)), agentMessage(2, { text: "a".repeat(ANSWER_LENGTH) })];
  assert.equal(await store.save(repositoryId, { ...created, messages }), true);
  const full = Array.from({ length: MESSAGE_LIMIT }, (_, index) => (index % 2 === 0 ? userMessage(index + 1, "q") : agentMessage(index + 1, { text: "" })));
  assert.equal(await store.save(repositoryId, { ...created, messages: full }), true);
  assert.equal((await store.read(repositoryId, created.id)).messages.length, MESSAGE_LIMIT);
});

test("a conversation larger than the file bound is not written", async (context) => {
  const { store, directory } = await workspace(context);
  const created = await store.create(repositoryId, { provider: "claude", model: null, title: "Big" });
  assert.equal(await store.save(repositoryId, { ...created, messages: [userMessage(1)] }), true);
  const onDisk = await fs.readFile(fileOf(directory, created.id), "utf8");
  // 120 answers, each with a proposal of 40 operations of 4,000 characters, come to about 19 MB.
  const operations = Array.from({ length: 40 }, () => ({ op: "create_task", text: "w".repeat(4000) }));
  const messages = Array.from({ length: 120 }, (_, index) => agentMessage(index + 1, { proposal: { id: "p-0123456789ab", summary: "Big", operations, state: "pending" } }));
  assert.equal(await store.save(repositoryId, { ...created, messages }), false);
  assert.equal(await fs.readFile(fileOf(directory, created.id), "utf8"), onDisk);
  assert.deepEqual(await fs.readdir(path.join(directory, repositoryId)), [`${created.id}.json`]);
});

test("a failed write answers false and leaves no temporary file", async (context) => {
  const { directory, now } = await workspace(context);
  const failing = createAgentChatStore({ directory, now, filesystem: { ...fs, writeFile: async () => { throw new Error("disk full"); } } });
  const created = await failing.create(repositoryId, { provider: "claude", model: null, title: "Plan" });
  assert.equal(await failing.save(repositoryId, { ...created, messages: [userMessage(1)] }), false);
  const renameFails = createAgentChatStore({ directory, now, filesystem: { ...fs, rename: async () => { throw new Error("locked"); } } });
  const second = await renameFails.create(repositoryId, { provider: "claude", model: null, title: "Plan" });
  assert.equal(await renameFails.save(repositoryId, { ...second, messages: [userMessage(1)] }), false);
  const names = await fs.readdir(path.join(directory, repositoryId)).catch(() => []);
  assert.deepEqual(names, []);
});

test("a repository or conversation identifier outside its format answers empty, null, or false and touches no path outside the directory", async (context) => {
  const { store, root, directory } = await workspace(context);
  const created = await store.create(repositoryId, { provider: "claude", model: null, title: "Plan" });
  await store.save(repositoryId, { ...created, messages: [userMessage(1)] });
  const outside = path.join(root, "x.json");
  await fs.writeFile(outside, "keep");
  const badRepositories = ["../x", "..\\x", "../../x", "repo-0123", "repo-0123456789ABCDEF01234567", `${repositoryId}/..`, "", undefined, null, 5, `C:\\${repositoryId}`];
  const badConversations = ["../x", "..\\x", "../../x", "x", "chat-short", "chat-0123456789AB", `${created.id}/..`, "", undefined, null];
  for (const bad of badRepositories) {
    assert.deepEqual(await store.index(bad), [], String(bad));
    assert.equal(await store.read(bad, created.id), null);
    assert.equal(await store.create(bad, { provider: "claude", model: null, title: "t" }), null);
    assert.equal(await store.save(bad, conversationOf(created.id)), false);
    assert.equal(await store.remove(bad, created.id), false);
  }
  for (const bad of badConversations) {
    assert.equal(await store.read(repositoryId, bad), null, String(bad));
    assert.equal(await store.remove(repositoryId, bad), false);
    assert.equal(await store.save(repositoryId, conversationOf(bad)), false);
  }
  assert.deepEqual((await fs.readdir(root)).sort(), ["store", "x.json"]);
  assert.equal(await fs.readFile(outside, "utf8"), "keep");
  assert.deepEqual((await fs.readdir(directory)).sort(), [repositoryId]);
  assert.deepEqual(await fs.readdir(path.join(directory, repositoryId)), [`${created.id}.json`]);
});

test("concurrent saves of one conversation end with the last one on disk", async (context) => {
  const { store, directory } = await workspace(context);
  const created = await store.create(repositoryId, { provider: "claude", model: null, title: "Plan" });
  const versions = Array.from({ length: 6 }, (_, index) => ({ ...created, updatedAt: `2026-10-01T1${index}:00:00.000Z`, messages: [userMessage(1, `Version ${index}`)] }));
  assert.deepEqual(await Promise.all(versions.map((version) => store.save(repositoryId, version))), Array(6).fill(true));
  const last = versions.at(-1);
  assert.deepEqual(await store.read(repositoryId, created.id), last);
  assert.deepEqual(JSON.parse(await fs.readFile(fileOf(directory, created.id), "utf8")).conversation, last);
  assert.deepEqual(await fs.readdir(path.join(directory, repositoryId)), [`${created.id}.json`]);
  assert.deepEqual(await createAgentChatStore({ directory }).read(repositoryId, created.id), last);
});

test("a remove that follows a save waits for it, so the file does not come back", async (context) => {
  const { store, directory } = await workspace(context);
  const created = await store.create(repositoryId, { provider: "claude", model: null, title: "Plan" });
  const saving = store.save(repositoryId, { ...created, messages: [userMessage(1)] });
  assert.equal(await store.remove(repositoryId, created.id), true);
  await saving;
  await assert.rejects(fs.stat(fileOf(directory, created.id)));
  assert.deepEqual(await createAgentChatStore({ directory }).index(repositoryId), []);
});

test("removing a conversation that was created but never saved succeeds without a file", async (context) => {
  const { store } = await workspace(context);
  const created = await store.create(repositoryId, { provider: "claude", model: null, title: "Plan" });
  assert.equal(await store.remove(repositoryId, created.id), true);
  assert.equal(await store.read(repositoryId, created.id), null);
});

test("a conversation with a proposal, its results, and partial run and complete-when parts round-trips unchanged", async (context) => {
  const messages = [userMessage(1), agentMessage(2, { text: "Here you go", proposal: proposalWith(), proposalUnreadable: true })];
  const conversation = conversationOf("chat-0123456789ab", messages);
  assert.deepEqual(normalizeConversation(conversation), conversation);
  const normalized = normalizeConversation(conversation).messages[1].proposal;
  assert.deepEqual(normalized.operations[1].run, { provider: "claude", model: "claude-opus-4-1", effort: "high" });
  assert.deepEqual(normalized.operations[3].run, { effort: "low" });
  assert.deepEqual(normalized.operations[3].completeWhen, { own: null });
  assert.deepEqual(normalized.operations[4].completeWhen, { checks: [] });
  assert.deepEqual(normalized.operations[4].run, { provider: "codex", model: null });
  assert.deepEqual(normalized.results[4], { ok: false, error: "conflict", taskId: "T-9" });
  const { store, directory } = await workspace(context);
  const created = await store.create(repositoryId, { provider: "claude", model: "claude-opus-4-1", title: "A title" });
  const saved = { ...conversation, id: created.id, createdAt: created.createdAt, updatedAt: created.updatedAt };
  assert.equal(await store.save(repositoryId, saved), true);
  assert.deepEqual(await createAgentChatStore({ directory }).read(repositoryId, created.id), saved);
});

test("a conversation keeps only the contract's keys, so no other value is stored", () => {
  const dirty = conversationOf("chat-0123456789ab", [
    { ...userMessage(1), path: "C:\\private\\repo", token: "synthetic-token" },
    agentMessage(2, { cwd: "C:\\private\\repo", proposal: { ...proposalWith({ operations: [{ op: "delete_task", id: "T-1" }], results: [{ ok: true, detail: "private" }] }), secret: "x" } }),
  ], { repositoryRoot: "C:\\private\\repo" });
  const clean = normalizeConversation(dirty);
  const serialized = JSON.stringify(clean);
  for (const value of ["private", "synthetic-token", "secret", "detail"]) assert.equal(serialized.includes(value), false, value);
  assert.deepEqual(Object.keys(clean).sort(), ["createdAt", "id", "messages", "model", "provider", "title", "updatedAt"]);
  assert.deepEqual(Object.keys(clean.messages[0]).sort(), ["at", "id", "role", "text"]);
  assert.deepEqual(clean.messages[1].proposal.results, [{ ok: true }]);
});

test("a stored result keeps a task ID only when it is well-formed, and an agent message may have an empty answer", () => {
  const withResult = (result) => normalizeConversation(conversationOf("chat-0123456789ab", [userMessage(1), agentMessage(2, { text: "", status: "stopped", proposal: proposalWith({ operations: [{ op: "delete_task", id: "T-1" }], results: [result], state: "partial" }) })]));
  assert.deepEqual(withResult({ ok: true, taskId: "T-0" }).messages[1].proposal.results, [{ ok: true }]);
  assert.deepEqual(withResult({ ok: false, error: "limit", taskId: "T-12" }).messages[1].proposal.results, [{ ok: false, error: "limit", taskId: "T-12" }]);
  assert.equal(withResult({ ok: false, error: "limit" }).messages[1].text, "");
  assert.equal(withResult({ ok: false }), null);
  assert.equal(withResult({ ok: "yes" }), null);
});

test("a conversation outside the contract does not normalize", () => {
  const good = conversationOf("chat-0123456789ab");
  assert.ok(normalizeConversation(good));
  for (const [rule, value] of [
    ["null", null], ["array", []], ["string", "chat"], ["bad id", { ...good, id: "chat-xyz" }], ["upper-case id", { ...good, id: "chat-0123456789AB" }],
    ["empty title", { ...good, title: "" }], ["title over 80", { ...good, title: "t".repeat(81) }], ["bad provider", { ...good, provider: "gemini" }],
    ["bad model", { ...good, model: "../x" }], ["bad created time", { ...good, createdAt: "never" }], ["bad updated time", { ...good, updatedAt: 5 }],
    ["messages not a list", { ...good, messages: {} }], ["unknown role", { ...good, messages: [{ ...userMessage(1), role: "system" }] }],
    ["message id of seven digits", { ...good, messages: [{ ...userMessage(1), id: "m-1234567" }] }],
  ]) assert.equal(normalizeConversation(value), null, rule);
});

const IMAGE_A = { id: "img-0123456789ab", type: "png", bytes: 11 };
const IMAGE_B = { id: "img-ba9876543210", type: "webp", bytes: 4096 };

test("an owner message keeps its images as { id, type, bytes } and nothing else, and an agent message keeps none", () => {
  const dirty = conversationOf("chat-0123456789ab", [
    { ...userMessage(1), images: [{ ...IMAGE_A, file: "C:\\private\\a.png", path: "x" }, IMAGE_B] },
    agentMessage(2, { images: [IMAGE_A] }),
  ]);
  const clean = normalizeConversation(dirty);
  assert.deepEqual(clean.messages[0].images, [IMAGE_A, IMAGE_B]);
  assert.deepEqual(Object.keys(clean.messages[0]).sort(), ["at", "id", "images", "role", "text"]);
  assert.equal(JSON.stringify(clean).includes("private"), false);
  assert.equal(Object.hasOwn(clean.messages[1], "images"), false);
  const plain = normalizeConversation(conversationOf("chat-0123456789ab"));
  assert.equal(Object.hasOwn(plain.messages[0], "images"), false);
});

test("an owner message with images outside the contract makes the conversation invalid", () => {
  const withImages = (images) => normalizeConversation(conversationOf("chat-0123456789ab", [{ ...userMessage(1), images }]));
  assert.ok(withImages([IMAGE_A]));
  assert.ok(withImages(["a", "b", "c", "d"].map((_, index) => ({ ...IMAGE_A, id: `img-00000000000${index}` }))), "four images");
  const long = Array.from({ length: 5 }, (_, index) => ({ ...IMAGE_A, id: `img-00000000000${index}` }));
  const refused = [
    null, [], long, [IMAGE_A, IMAGE_A], "img", {}, [null], ["img-0123456789ab"], [{ ...IMAGE_A, id: "img-x" }], [{ ...IMAGE_A, id: "IMG-0123456789AB" }], [{ ...IMAGE_A, type: "svg" }],
    [{ ...IMAGE_A, type: "jpg" }], [{ ...IMAGE_A, bytes: 0 }], [{ ...IMAGE_A, bytes: -3 }], [{ ...IMAGE_A, bytes: 2.5 }], [{ ...IMAGE_A, bytes: "11" }], [{ ...IMAGE_A, bytes: 5 * 1024 * 1024 + 1 }],
    [{ id: IMAGE_A.id, type: "png" }],
  ];
  for (const images of refused) assert.equal(withImages(images), null, JSON.stringify(images));
});

test("the store saves a message with images, reads it back, and refuses a bad image list without changing the file", async (context) => {
  const { store, directory } = await workspace(context);
  const created = await store.create(repositoryId, { provider: "claude", model: null, title: "Plan" });
  const good = { ...created, messages: [{ ...userMessage(1), images: [IMAGE_A, IMAGE_B] }, agentMessage(2)] };
  assert.equal(await store.save(repositoryId, good), true);
  assert.deepEqual(await createAgentChatStore({ directory }).read(repositoryId, created.id), good);
  const onDisk = await fs.readFile(fileOf(directory, created.id), "utf8");
  assert.equal(await store.save(repositoryId, { ...good, messages: [{ ...userMessage(1), images: [] }, agentMessage(2)] }), false);
  assert.equal(await store.save(repositoryId, { ...good, messages: [{ ...userMessage(1), images: [IMAGE_A, IMAGE_A] }, agentMessage(2)] }), false);
  assert.equal(await fs.readFile(fileOf(directory, created.id), "utf8"), onDisk);
  assert.deepEqual(await store.read(repositoryId, created.id), good);
});

test("a stored result keeps part images only on a failure, and refuses any other part", () => {
  const withResult = (result) => normalizeConversation(conversationOf("chat-0123456789ab", [userMessage(1), agentMessage(2, { proposal: proposalWith({ operations: [{ op: "delete_task", id: "T-1" }], results: [result], state: "partial" }) })]));
  const results = (conversation) => conversation.messages[1].proposal.results;
  assert.deepEqual(results(withResult({ ok: false, error: "limit", taskId: "T-9", part: "images" })), [{ ok: false, error: "limit", taskId: "T-9", part: "images" }]);
  assert.deepEqual(results(withResult({ ok: false, error: "conflict", part: "images" })), [{ ok: false, error: "conflict", part: "images" }]);
  assert.deepEqual(results(withResult({ ok: false, error: "unavailable", part: "images" })), [{ ok: false, error: "unavailable", part: "images" }]);
  assert.deepEqual(results(withResult({ ok: false, error: "limit", taskId: "T-9" })), [{ ok: false, error: "limit", taskId: "T-9" }], "no part is no part");
  assert.deepEqual(results(withResult({ ok: true, taskId: "T-9", part: "images" })), [{ ok: true, taskId: "T-9" }], "a success has no part");
  for (const part of ["docs", "image", "IMAGES", "", null, 5, ["images"], {}]) assert.equal(withResult({ ok: false, error: "limit", part }), null, String(part));
  assert.equal(withResult({ ok: false, part: "images" }), null, "an error is still required");
  assert.equal(withResult({ ok: false, error: "teapot", part: "images" }), null);
});

test("a proposal with images round-trips: images on create_task and attach_images are kept as written", async (context) => {
  const operations = [
    { op: "create_task", text: "Match the mock-up", queue: true, images: [IMAGE_A.id, IMAGE_B.id] },
    { op: "attach_images", id: "T-4", images: [IMAGE_B.id] },
  ];
  const proposal = proposalWith({ operations, results: [{ ok: false, error: "limit", taskId: "T-9", part: "images" }, { ok: false, error: "skipped" }] });
  const conversation = conversationOf("chat-0123456789ab", [{ ...userMessage(1), images: [IMAGE_A, IMAGE_B] }, agentMessage(2, { proposal })]);
  assert.deepEqual(normalizeConversation(conversation), conversation);
  const { store, directory } = await workspace(context);
  const created = await store.create(repositoryId, { provider: "claude", model: "claude-opus-4-1", title: "A title" });
  const saved = { ...conversation, id: created.id, createdAt: created.createdAt, updatedAt: created.updatedAt };
  assert.equal(await store.save(repositoryId, saved), true);
  assert.deepEqual(await createAgentChatStore({ directory }).read(repositoryId, created.id), saved);
});

test("a stored proposal with a bad image list in an operation makes the conversation invalid", () => {
  const withOperation = (operation) => normalizeConversation(conversationOf("chat-0123456789ab", [userMessage(1), agentMessage(2, { proposal: proposalWith({ operations: [operation], results: undefined, state: "pending" }) })]));
  assert.ok(withOperation({ op: "attach_images", id: "T-1", images: [IMAGE_A.id] }));
  for (const operation of [
    { op: "attach_images", id: "T-1", images: [] }, { op: "attach_images", id: "T-1" }, { op: "attach_images", id: "T-1", images: [IMAGE_A.id, IMAGE_A.id] },
    { op: "attach_images", id: "T-1", images: ["img-x"] }, { op: "create_task", text: "x", images: [] }, { op: "create_task", text: "x", images: [IMAGE_A.id, IMAGE_A.id] },
    { op: "attach_images", id: "T-1", images: [IMAGE_A.id], extra: true },
  ]) assert.equal(withOperation(operation), null, JSON.stringify(operation));
});
