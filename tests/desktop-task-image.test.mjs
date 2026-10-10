import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createTaskImage,
  installTaskImageIpc,
  TASK_IMAGE_CHANNEL,
  TASK_IMAGE_ERRORS,
  TASK_IMAGE_MAX_BYTES,
  TASK_IMAGE_OPERATIONS,
} from "../desktop/runtime/task-image.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const trusted = { trusted: true };
const origin = "http://127.0.0.1:4317";
const imageId = "img-0123456789ab";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const invalid = { ok: false, error: "invalid" };
const unavailable = { ok: false, error: "unavailable" };

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function harness(answer, overrides = {}) {
  const calls = [];
  const action = createTaskImage({
    isTrustedEvent: (event) => event?.trusted === true,
    monitorOrigin: origin,
    authorizationToken: "secret",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return typeof answer === "function" ? answer(url, options) : answer;
    },
    ...overrides,
  });
  return { action, calls };
}

test("the channel, operations and errors are fixed", () => {
  assert.equal(TASK_IMAGE_CHANNEL, "pomegr:task-image");
  assert.deepEqual([...TASK_IMAGE_OPERATIONS], ["add", "remove", "read"]);
  assert.deepEqual([...TASK_IMAGE_ERRORS], ["invalid", "not_found", "limit", "conflict", "unavailable"]);
  assert.equal(TASK_IMAGE_MAX_BYTES, 5 * 1024 * 1024);
});

test("add posts the bytes as the body and answers only the new image's ID", async () => {
  const h = harness(json({ ok: true, imageId, board: { tasks: ["SECRET"] }, path: "C:\\secret" }));
  assert.deepEqual(await h.action.run(trusted, repositoryId, "add", { taskId: "T-7", bytes: PNG }), { ok: true, imageId });
  const [{ url, options }] = h.calls;
  assert.equal(url, `${origin}/internal/tasks/image-add?repositoryId=${repositoryId}&taskId=T-7`);
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "error");
  assert.equal(options.headers["content-type"], "application/octet-stream");
  assert.equal(options.headers["x-pomegr-desktop-authorization"], "secret");
  assert.deepEqual(new Uint8Array(options.body), PNG);
});

test("remove and read post the two identifiers; read answers the type and the bytes", async () => {
  const removing = harness(json({ ok: true }));
  assert.deepEqual(await removing.action.run(trusted, repositoryId, "remove", { taskId: "T-7", imageId }), { ok: true });
  assert.equal(removing.calls[0].url, `${origin}/internal/tasks/image-remove`);
  assert.deepEqual(JSON.parse(removing.calls[0].options.body), { repositoryId, payload: { taskId: "T-7", imageId } });

  const reading = harness(() => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }));
  const read = await reading.action.run(trusted, repositoryId, "read", { taskId: "T-7", imageId });
  assert.equal(read.ok, true);
  assert.equal(read.type, "png");
  assert.deepEqual(read.bytes, PNG);
  assert.deepEqual(Object.keys(read), ["ok", "type", "bytes"]);
});

test("a read that is not one of the four media types, or is empty, is unavailable", async () => {
  for (const response of [
    () => new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } }),
    () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    () => new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "image/png" } }),
  ]) {
    assert.deepEqual(await harness(response).action.run(trusted, repositoryId, "read", { taskId: "T-7", imageId }), unavailable);
  }
});

test("refusals happen before any request", async () => {
  const h = harness(json({ ok: true, imageId }));
  const run = (...args) => h.action.run(...args);
  assert.deepEqual(await run({ trusted: false }, repositoryId, "add", { taskId: "T-7", bytes: PNG }), invalid);
  assert.deepEqual(await run(trusted, "repo-short", "add", { taskId: "T-7", bytes: PNG }), invalid);
  assert.deepEqual(await run(trusted, repositoryId, "list", { taskId: "T-7", imageId }), invalid);
  assert.deepEqual(await run(trusted, repositoryId, "add", { taskId: "T-0", bytes: PNG }), invalid);
  assert.deepEqual(await run(trusted, repositoryId, "add", { taskId: "T-7", bytes: [...PNG] }), invalid);
  assert.deepEqual(await run(trusted, repositoryId, "add", { taskId: "T-7", bytes: "iVBORw0KGgo=" }), invalid);
  assert.deepEqual(await run(trusted, repositoryId, "add", { taskId: "T-7", bytes: new Uint8Array(0) }), invalid);
  assert.deepEqual(await run(trusted, repositoryId, "add", { taskId: "T-7", bytes: new Uint8Array(TASK_IMAGE_MAX_BYTES + 1) }), invalid);
  assert.deepEqual(await run(trusted, repositoryId, "add", { taskId: "T-7", bytes: PNG, path: "C:\\x.png" }), invalid);
  assert.deepEqual(await run(trusted, repositoryId, "read", { taskId: "T-7", imageId: "..\\x" }), invalid);
  assert.deepEqual(await run(trusted, repositoryId, "remove", { taskId: "T-7" }), invalid);
  assert.equal(h.calls.length, 0);
});

test("monitor refusals keep only their fixed code; anything else is unavailable", async () => {
  for (const error of ["invalid", "not_found", "limit", "conflict", "unavailable"]) {
    const h = harness(json({ ok: false, error, detail: "C:\\secret" }, 409));
    assert.deepEqual(await h.action.run(trusted, repositoryId, "add", { taskId: "T-7", bytes: PNG }), { ok: false, error });
  }
  assert.deepEqual(await harness(json({ ok: false, error: "ENOENT C:\\secret" }, 500)).action.run(trusted, repositoryId, "add", { taskId: "T-7", bytes: PNG }), unavailable);
  assert.deepEqual(await harness(json({ ok: true, imageId: "../x" })).action.run(trusted, repositoryId, "add", { taskId: "T-7", bytes: PNG }), unavailable);
  assert.deepEqual(await harness(new Response("nope", { status: 200 })).action.run(trusted, repositoryId, "remove", { taskId: "T-7", imageId }), unavailable);
  assert.deepEqual(await harness(() => { throw new Error("C:\\secret"); }).action.run(trusted, repositoryId, "remove", { taskId: "T-7", imageId }), unavailable);
  assert.deepEqual(await harness(json({ ok: true }), { monitorOrigin: "http://example.com" }).action.run(trusted, repositoryId, "remove", { taskId: "T-7", imageId }), unavailable);
  const disposed = harness(json({ ok: true }));
  disposed.action.dispose();
  assert.deepEqual(await disposed.action.run(trusted, repositoryId, "remove", { taskId: "T-7", imageId }), unavailable);
});

test("the installer owns one handler, removes it and never throws", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) };
  let disposed = 0;
  const remove = installTaskImageIpc({ ipcMain, action: { run: async () => { throw new Error("C:\\secret"); }, dispose() { disposed += 1; } } });
  assert.deepEqual([...handlers.keys()], [TASK_IMAGE_CHANNEL]);
  assert.deepEqual(await handlers.get(TASK_IMAGE_CHANNEL)(trusted, repositoryId, "read", {}), unavailable);
  remove();
  assert.equal(handlers.size, 0);
  assert.equal(disposed, 1);
  assert.throws(() => installTaskImageIpc({}), TypeError);
});

test("the bridge is one trusted-frame channel with a closed surface", async () => {
  const [preload, main, bridge] = await Promise.all([
    "../desktop/runtime/preload.cjs", "../desktop/runtime/shell-main.mjs", "../desktop/runtime/task-image.mjs",
  ].map((file) => readFile(new URL(file, import.meta.url), "utf8")));
  assert.match(preload, /ipcRenderer\.invoke\("pomegr:task-image", repositoryId, operation, payload\)/u);
  assert.match(preload, /new Set\(\["add", "remove", "read"\]\)/u);
  assert.match(main, /installTaskImageIpc\(taskBridge\)/u);
  assert.match(bridge, /if \(!isTrustedEvent\(event\)\) return INVALID;/u);
  assert.match(bridge, /redirect: "error"/u);
  assert.doesNotMatch(bridge, /server\/|node:fs|console\.|writeFile/u);
});

test("preload refuses a bad image call locally", async () => {
  const invokes = [];
  let exposed;
  const Module = (await import("node:module")).default;
  const require = Module.createRequire(import.meta.url);
  const original = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "electron") {
      return {
        contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
        ipcRenderer: { invoke: (...args) => { invokes.push(args); return Promise.resolve({ ok: true }); } },
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
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
  for (const [operation, payload] of [
    ["add", { taskId: "T-7", bytes: "text" }], ["add", { taskId: "T-7", bytes: new Uint8Array(0) }], ["add", { taskId: "T-7", bytes: PNG, name: "x.png" }],
    ["read", { taskId: "T-7", imageId: "x" }], ["remove", { taskId: "T-0", imageId }], ["open", { taskId: "T-7", imageId }],
  ]) {
    assert.deepEqual(await exposed.taskImage(repositoryId, operation, payload), invalid);
  }
  assert.deepEqual(await exposed.taskImage("repo-short", "read", { taskId: "T-7", imageId }), invalid);
  assert.equal(invokes.length, 0);
  assert.deepEqual(await exposed.taskImage(repositoryId, "add", { taskId: "T-7", bytes: PNG }), { ok: true });
  assert.deepEqual(await exposed.taskImage(repositoryId, "read", { taskId: "T-7", imageId }), { ok: true });
  assert.deepEqual(invokes.map((call) => call.slice(0, 3)), [["pomegr:task-image", repositoryId, "add"], ["pomegr:task-image", repositoryId, "read"]]);
});
