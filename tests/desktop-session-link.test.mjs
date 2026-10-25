import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { installSessionLinkIpc } from "../desktop/runtime/session-link.mjs";

const channel = "pomegr:open-session-link";
const trusted = { trusted: true };
const invalid = { ok: false, error: "invalid" };
function harness(openExternal) {
  const handlers = new Map();
  const calls = [];
  const remove = installSessionLinkIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: (name) => handlers.delete(name) },
    isTrustedEvent: (event) => event === trusted,
    openExternal: openExternal ?? (async (url) => { calls.push(url); }),
  });
  return { run: handlers.get(channel), calls, handlers, remove };
}

test("session links refuse untrusted events, invalid URLs and extra arguments without opening", async () => {
  const { run, calls } = harness();
  const valid = "https://github.com/o/r/actions/runs/4013";
  assert.deepEqual(await run({}, valid), invalid);
  assert.deepEqual(await run(undefined, valid), invalid);
  assert.deepEqual(await run(trusted), invalid);
  assert.deepEqual(await run(trusted, valid, undefined), invalid);
  for (const value of [null, 1, {}, [valid], "http://a.test/", "javascript:alert(1)", "file:///c:/x", "/relative",
    "https://user@a.test/", "https://user:password@a.test/", `https://a.test/${"x".repeat(2048)}`,
    "https://a.test", "HTTPS://a.test/", "https://A.test/", " https://a.test/", "https://a.test:443/", "https://a.test/a/../b",
  ]) assert.deepEqual(await run(trusted, value), invalid);
  assert.deepEqual(calls, []);
});

test("a canonical HTTPS session link opens once, and the handler cleans up", async () => {
  const { run, calls, handlers, remove } = harness();
  const url = "https://github.com/o/r/actions/runs/4013";
  assert.deepEqual(await run(trusted, url), { ok: true });
  assert.deepEqual(calls, [url]);
  const maximum = `https://a.test/${"x".repeat(2048 - "https://a.test/".length)}`;
  assert.deepEqual(await run(trusted, maximum), { ok: true });
  remove();
  assert.equal(handlers.size, 0);
});

test("opener failures return only the fixed invalid result", async () => {
  const { run } = harness(async () => { throw new Error("private"); });
  assert.deepEqual(await run(trusted, "https://a.test/"), invalid);
});

test("preload exposes only the fixed session link invocation", async () => {
  let bridge;
  const calls = [];
  vm.runInNewContext(readFileSync(new URL("../desktop/runtime/preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true }; } } }),
    window: { addEventListener() {} },
  });
  await bridge.openSessionLink("https://a.test/");
  assert.deepEqual(calls, [[channel, "https://a.test/"]]);
});
