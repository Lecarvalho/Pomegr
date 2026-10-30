// The Jev key store: encrypted by the operating system's store (Electron's `safeStorage`, faked here), set and removed through its own
// channel, and never answered. No Electron and no real key.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AGENT_CHAT_JEV_CHANNEL, createJevKey, installJevKeyIpc, JEV_KEY_FILE, JEV_KEY_OPERATIONS, JEV_KEY_PATTERN } from "../desktop/runtime/agent-chat-jev-key.mjs";

const SECRET = "jev-secret-key-0123456789";

// A store whose "encryption" is recognizable and is not the plain text.
function fakeSafeStorage({ available = true, backend } = {}) {
  return {
    isEncryptionAvailable: () => available,
    ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
    encryptString: (value) => Buffer.from(`ENC:${Buffer.from(value).reverse().toString("latin1")}`, "latin1"),
    decryptString: (buffer) => {
      const text = Buffer.from(buffer).toString("latin1");
      if (!text.startsWith("ENC:")) throw new Error("not encrypted");
      return Buffer.from(text.slice(4), "latin1").reverse().toString("latin1");
    },
  };
}

async function folder(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-jev-key-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return directory;
}

const filesIn = (directory) => readdirSync(directory);

test("a key is stored encrypted, read back, and survives a restart; nothing on disk holds it as text", async (context) => {
  const directory = await folder(context);
  const file = path.join(directory, JEV_KEY_FILE);
  const store = createJevKey({ file, safeStorage: fakeSafeStorage() });
  assert.equal(await store.state(), "unset");
  assert.equal(await store.read(), null);
  assert.equal(await store.set(SECRET), "ok");
  assert.equal(await store.state(), "set");
  assert.equal(await store.read(), SECRET);
  assert.deepEqual(filesIn(directory), [JEV_KEY_FILE], "one file and no temporary file left");
  const bytes = readFileSync(file);
  assert.equal(bytes.includes(Buffer.from(SECRET)), false, "the file is not the plain text");
  assert.equal(bytes.toString("latin1").startsWith("ENC:"), true, "the file is what the operating system's store produced");
  // A new process reads the same key from the file.
  const restarted = createJevKey({ file, safeStorage: fakeSafeStorage() });
  assert.equal(await restarted.state(), "set");
  assert.equal(await restarted.read(), SECRET);
  // A new key replaces it.
  assert.equal(await store.set("another-key-9876543210"), "ok");
  assert.equal(await createJevKey({ file, safeStorage: fakeSafeStorage() }).read(), "another-key-9876543210");
});

test("remove deletes the file and the key in memory, and removing twice is fine", async (context) => {
  const directory = await folder(context);
  const file = path.join(directory, JEV_KEY_FILE);
  const store = createJevKey({ file, safeStorage: fakeSafeStorage() });
  await store.set(SECRET);
  assert.equal(await store.remove(), "ok");
  assert.equal(existsSync(file), false);
  assert.equal(await store.state(), "unset");
  assert.equal(await store.read(), null);
  assert.equal(await store.remove(), "ok");
  assert.equal(await createJevKey({ file, safeStorage: fakeSafeStorage() }).state(), "unset");
});

test("a key that is not one printable token of 8 to 512 characters is refused and nothing is written", async (context) => {
  const directory = await folder(context);
  const store = createJevKey({ file: path.join(directory, JEV_KEY_FILE), safeStorage: fakeSafeStorage() });
  for (const bad of ["", "short", "has space in it", "tab\tkey-0123456789", "line\nbreak-0123456789", "naïve-key-0123456789", "a".repeat(513), null, undefined, 12345678, {}, [SECRET]]) {
    assert.equal(await store.set(bad), "invalid", JSON.stringify(bad));
  }
  assert.deepEqual(filesIn(directory), []);
  assert.equal(JEV_KEY_PATTERN.test("a".repeat(512)), true);
  assert.equal(JEV_KEY_PATTERN.test("a".repeat(8)), true);
});

test("where the operating system offers no encryption, nothing is stored as text and the option stays off", async (context) => {
  for (const safeStorage of [fakeSafeStorage({ available: false }), fakeSafeStorage({ backend: "basic_text" }), undefined, {}, { isEncryptionAvailable: () => { throw new Error("not ready"); } }]) {
    const directory = await folder(context);
    const store = createJevKey({ file: path.join(directory, JEV_KEY_FILE), safeStorage });
    assert.equal(await store.state(), "unavailable");
    assert.equal(await store.set(SECRET), "unavailable");
    assert.equal(await store.read(), null);
    assert.deepEqual(filesIn(directory), [], "no file, plain or not");
  }
  // A key written while encryption worked is not read when it no longer does.
  const directory = await folder(context);
  const file = path.join(directory, JEV_KEY_FILE);
  await createJevKey({ file, safeStorage: fakeSafeStorage() }).set(SECRET);
  assert.equal(await createJevKey({ file, safeStorage: fakeSafeStorage({ available: false }) }).read(), null);
});

test("a file that cannot be decrypted or holds no key reads as no key, and a relative file path is refused", async (context) => {
  const directory = await folder(context);
  const file = path.join(directory, JEV_KEY_FILE);
  await fs.writeFile(file, "plain text, not what the store wrote");
  const store = createJevKey({ file, safeStorage: fakeSafeStorage() });
  assert.equal(await store.read(), null);
  assert.equal(await store.state(), "unset");
  await fs.writeFile(file, fakeSafeStorage().encryptString("has a space"));
  assert.equal(await createJevKey({ file, safeStorage: fakeSafeStorage() }).read(), null, "a stored value that is not a key is no key");
  assert.throws(() => createJevKey({ file: "relative/jev-key.bin", safeStorage: fakeSafeStorage() }), TypeError);
});

test("a failed write answers unavailable, leaves no temporary file, and keeps the earlier key", async (context) => {
  const directory = await folder(context);
  const file = path.join(directory, JEV_KEY_FILE);
  let failures = 0;
  const filesystem = { mkdir: fs.mkdir, readFile: fs.readFile, unlink: fs.unlink, writeFile: fs.writeFile, rename: async (from, to) => { if (failures > 0) { failures -= 1; throw new Error("EPERM"); } return fs.rename(from, to); } };
  const store = createJevKey({ file, safeStorage: fakeSafeStorage(), filesystem });
  assert.equal(await store.set(SECRET), "ok");
  failures = 1;
  assert.equal(await store.set("second-key-0123456789"), "unavailable");
  assert.deepEqual(filesIn(directory), [JEV_KEY_FILE]);
  assert.equal(await store.read(), SECRET);
});

// The channel the renderer uses. It answers `{ ok, state }` or a fixed refusal, and never the key.
function ipcFixture(store, trusted = () => true) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) };
  const remove = installJevKeyIpc({ ipcMain, isTrustedEvent: trusted, key: store });
  const call = (operation, payload, event = { sender: "window" }) => handlers.get(AGENT_CHAT_JEV_CHANNEL)(event, operation, payload);
  return { call, handlers, remove };
}

test("the renderer can set, ask, and remove the key, and no answer ever holds it", async (context) => {
  const directory = await folder(context);
  const store = createJevKey({ file: path.join(directory, JEV_KEY_FILE), safeStorage: fakeSafeStorage() });
  const { call, handlers, remove } = ipcFixture(store);
  assert.equal(AGENT_CHAT_JEV_CHANNEL, "pomegr:agent-chat-jev");
  assert.deepEqual(JEV_KEY_OPERATIONS, ["status", "set", "remove"]);
  const answers = [];
  answers.push(await call("status"));
  assert.deepEqual(answers.at(-1), { ok: true, state: "unset" });
  answers.push(await call("set", { key: SECRET }));
  assert.deepEqual(answers.at(-1), { ok: true, state: "set" });
  answers.push(await call("status", undefined));
  assert.deepEqual(answers.at(-1), { ok: true, state: "set" });
  answers.push(await call("remove"));
  assert.deepEqual(answers.at(-1), { ok: true, state: "unset" });
  for (const answer of answers) assert.equal(JSON.stringify(answer).includes(SECRET), false);
  remove();
  assert.equal(handlers.size, 0);
});

test("the channel refuses an untrusted caller, an unknown operation, and a malformed key", async (context) => {
  const directory = await folder(context);
  const store = createJevKey({ file: path.join(directory, JEV_KEY_FILE), safeStorage: fakeSafeStorage() });
  const { call } = ipcFixture(store, (event) => event.sender === "window");
  const refused = { ok: false, error: "invalid" };
  assert.deepEqual(await call("set", { key: SECRET }, { sender: "web page" }), refused);
  assert.deepEqual(await call("status", undefined, { sender: "web page" }), refused);
  assert.deepEqual(await call("read"), refused);
  assert.deepEqual(await call("get"), refused);
  assert.deepEqual(await call(undefined), refused);
  assert.deepEqual(await call("set", { key: "bad key" }), refused);
  assert.deepEqual(await call("set", { key: SECRET, extra: 1 }), refused);
  assert.deepEqual(await call("set", SECRET), refused);
  assert.deepEqual(await call("set", [SECRET]), refused);
  assert.deepEqual(await call("set"), refused);
  assert.equal(await store.read(), null, "none of those stored anything");
  // Where the store cannot encrypt, the answer is a fixed word.
  const none = createJevKey({ file: path.join(directory, "none.bin"), safeStorage: fakeSafeStorage({ available: false }) });
  assert.deepEqual(await ipcFixture(none).call("set", { key: SECRET }), { ok: false, error: "unavailable" });
  assert.deepEqual(await ipcFixture(none).call("status"), { ok: true, state: "unavailable" });
});

// The preload and the places a paired device could reach.
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
        ipcRenderer: { invoke: (...args) => { invokes.push(args); return Promise.resolve({ ok: true, state: "set" }); } },
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
    globalThis.window = previousWindow;
  }
  return { exposed, invokes };
}

test("the preload asks the main process only for status, remove, and set with one key of the key's form", async () => {
  const { exposed, invokes } = await loadPreload();
  const invalid = { ok: false, error: "invalid" };
  for (const [operation, payload] of [["read"], ["get"], [""], [undefined], [null], ["status", {}], ["status", { key: SECRET }], ["remove", {}], ["set"], ["set", {}], ["set", null], ["set", SECRET], ["set", [SECRET]],
    ["set", { key: "short" }], ["set", { key: "has space in it" }], ["set", { key: 12345678 }], ["set", { key: "a".repeat(513) }], ["set", { key: SECRET, state: "set" }], ["set", { token: SECRET }]]) {
    assert.deepEqual(await exposed.agentChatJev(operation, payload), invalid, JSON.stringify([operation, payload]));
  }
  assert.equal(invokes.length, 0, "nothing reached the main process");
  await exposed.agentChatJev("status");
  await exposed.agentChatJev("remove");
  await exposed.agentChatJev("set", { key: SECRET });
  assert.deepEqual(invokes, [["pomegr:agent-chat-jev", "status", undefined], ["pomegr:agent-chat-jev", "remove", undefined], ["pomegr:agent-chat-jev", "set", { key: SECRET }]]);
});

test("no paired-device route, chat operation, or MCP server names the key; desktop main hands the chat only the operating system's store", async () => {
  const runtime = (file) => fs.readFile(new URL(`../desktop/runtime/${file}`, import.meta.url), "utf8");
  for (const file of ["lan-gateway.mjs", "lan-sharing.mjs", "lan-pairing-page.mjs"]) assert.doesNotMatch(await runtime(file), /jev/iu, file);
  assert.doesNotMatch(await fs.readFile(new URL("../mcp/agent-chat-server.mjs", import.meta.url), "utf8"), /jev/iu);
  const chat = await runtime("agent-chat.mjs");
  assert.match(chat, /export const AGENT_CHAT_OPERATIONS = Object\.freeze\(\["list", "read", "thread", "search", "send", "stop", "apply", "dismiss", "delete", "warm"\]\)/u);
  const main = await runtime("shell-main.mjs");
  assert.equal([...main.matchAll(/\bsafeStorage\b/gu)].length, 2, "imported once and handed to the chat once");
  assert.match(main, /repositoryGithub, safeStorage, startTask:/u);
  // Nothing but the routing reads the key.
  const sources = await Promise.all(["agent-chat.mjs", "agent-chat-prepare.mjs", "agent-chat-prompt.mjs", "agent-chat-warm.mjs", "agent-chat-compaction.mjs"].map(runtime));
  for (const source of sources) assert.doesNotMatch(source, /jevKey\.read/u);
});
