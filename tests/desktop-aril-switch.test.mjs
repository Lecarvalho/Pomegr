import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createArilSwitch, ARIL_SWITCH_FILE } from "../desktop/runtime/aril-switch.mjs";
import { createArilControl } from "../desktop/runtime/agent-chat-aril.mjs";

async function directory(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-aril-switch-"));
  context.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

const fileOf = (root) => path.join(root, "aril-v1", ARIL_SWITCH_FILE);

test("Aril is Off on a fresh install, with no file, and with a file outside the contract", async (context) => {
  const root = await directory(context);
  const fresh = createArilSwitch({ file: fileOf(root) });
  await fresh.ready;
  assert.deepEqual(fresh.state(), { on: false, pairedOn: false });
  assert.equal(fresh.isOn(), false);
  assert.equal(createArilSwitch().isOn(), false, "a switch in memory starts Off");
  await fs.mkdir(path.dirname(fileOf(root)), { recursive: true });
  for (const content of ["not json", "{}", JSON.stringify({ version: 2, on: true, pairedOn: true }), JSON.stringify({ version: 1, on: "yes", pairedOn: false }), JSON.stringify([true])]) {
    await fs.writeFile(fileOf(root), content);
    const odd = createArilSwitch({ file: fileOf(root) });
    await odd.ready;
    assert.equal(odd.isOn(), false, content);
  }
});

test("before the saved state is read the switch is Off, and it reads On after", async (context) => {
  const root = await directory(context);
  await fs.mkdir(path.dirname(fileOf(root)), { recursive: true });
  await fs.writeFile(fileOf(root), JSON.stringify({ version: 1, on: true, pairedOn: false }));
  const reopened = createArilSwitch({ file: fileOf(root) });
  assert.equal(reopened.isOn(), false, "the file is read asynchronously: until then Aril is Off");
  await reopened.ready;
  assert.equal(reopened.isOn(), true);
});

test("On and Off persist across a restart", async (context) => {
  const root = await directory(context);
  const first = createArilSwitch({ file: fileOf(root) });
  assert.equal(await first.set(true), "ok");
  assert.equal(first.isOn(), true);
  const second = createArilSwitch({ file: fileOf(root) });
  await second.ready;
  assert.equal(second.isOn(), true, "a restart keeps Aril On");
  assert.equal(await second.set(false), "ok");
  const third = createArilSwitch({ file: fileOf(root) });
  await third.ready;
  assert.equal(third.isOn(), false, "a restart keeps Aril Off");
  assert.equal(await third.set("yes"), "invalid");
  assert.equal(JSON.parse(await fs.readFile(fileOf(root), "utf8")).on, false);
});

test("Off takes effect at once, before it is written", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const written = [];
  const filesystem = {
    readFile: async () => JSON.stringify({ version: 1, on: true, pairedOn: false }),
    mkdir: async () => {},
    writeFile: async (_file, content) => { await gate; written.push(JSON.parse(content)); },
    rename: async () => {},
    unlink: async () => {},
  };
  const aril = createArilSwitch({ file: path.resolve("switch.json"), filesystem });
  await aril.ready;
  assert.equal(aril.isOn(), true);
  const turned = aril.set(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aril.isOn(), false, "Off holds while its write is still pending");
  release();
  assert.equal(await turned, "ok");
  assert.deepEqual(written, [{ version: 1, on: false, pairedOn: false }]);
});

test("a write that fails never turns Aril on, and an Off that cannot be written still holds in memory", async () => {
  let failing = true;
  const filesystem = {
    readFile: async () => JSON.stringify({ version: 1, on: true, pairedOn: true }),
    mkdir: async () => {},
    writeFile: async () => { if (failing) throw new Error("disk"); },
    rename: async () => {},
    unlink: async () => {},
  };
  const aril = createArilSwitch({ file: path.resolve("switch.json"), filesystem });
  await aril.ready;
  assert.equal(await aril.set(false), "unavailable");
  assert.equal(aril.isOn(), false, "Off holds even when it could not be written");
  assert.equal(await aril.set(true), "unavailable");
  assert.equal(aril.isOn(), false, "an On that could not be written is not applied");
  failing = false;
  assert.equal(await aril.set(true), "ok");
  assert.equal(aril.isOn(), true);
});

test("an On that is still being written when an Off arrives never applies after it", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const written = [];
  let first = true;
  const filesystem = {
    readFile: async () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); },
    mkdir: async () => {},
    writeFile: async (_file, content) => { if (first) { first = false; await gate; } written.push(JSON.parse(content)); },
    rename: async () => {},
    unlink: async () => {},
  };
  const aril = createArilSwitch({ file: path.resolve("switch.json"), filesystem });
  await aril.ready;
  const on = aril.set(true);
  await new Promise((resolve) => setImmediate(resolve));
  const off = aril.set(false);
  release();
  assert.equal(await on, "superseded");
  assert.equal(await off, "ok");
  assert.equal(aril.isOn(), false);
  assert.equal(written.at(-1).on, false, "the last write is the Off");
});

test("listeners hear a change once, and one that throws does not stop the switch", async () => {
  const aril = createArilSwitch();
  const heard = [];
  aril.subscribe(() => { throw new Error("listener"); });
  const stop = aril.subscribe((state) => heard.push(state.on));
  await aril.set(true);
  await aril.set(true);
  await aril.set(false);
  stop();
  await aril.set(true);
  assert.deepEqual(heard, [true, false]);
});

test("paired devices may turn Aril Off, and On only when the owner allowed it on the desktop", async () => {
  const control = createArilControl({ arilSwitch: createArilSwitch() });
  const desktop = { event: {} };
  const paired = { paired: true };
  const call = (operation, payload, origin) => control.handlers[operation](payload, origin);
  assert.deepEqual(await call("aril_switch", {}, paired), { ok: true, on: false, pairedOn: false }, "anyone reads the switch");
  assert.deepEqual(await call("aril_switch_set", { on: true }, paired), { ok: false, error: "desktop_only" }, "a paired device cannot turn it on by default");
  assert.equal(control.isOn(), false);
  assert.deepEqual(await call("aril_switch_set", { on: true }, undefined), { ok: false, error: "desktop_only" }, "a call with no origin is not the desktop");
  assert.deepEqual(await call("aril_switch_set", { on: true }, desktop), { ok: true, on: true });
  assert.deepEqual(await call("aril_switch_set", { on: false }, paired), { ok: true, on: false }, "a paired device may always turn it off");
  assert.deepEqual(await call("aril_paired_on_set", { allowed: true }, paired), { ok: false, error: "desktop_only" }, "a paired device cannot grant itself the permission");
  assert.deepEqual(await call("aril_paired_on_set", { allowed: true }, desktop), { ok: true, pairedOn: true });
  assert.deepEqual(await call("aril_switch_set", { on: true }, paired), { ok: true, on: true }, "with the permission a paired device may turn it on");
  assert.deepEqual(await call("aril_paired_on_set", { allowed: false }, desktop), { ok: true, pairedOn: false });
  assert.deepEqual(await call("aril_switch_set", { on: false }, paired), { ok: true, on: false });
  assert.deepEqual(await call("aril_switch_set", { on: true }, paired), { ok: false, error: "desktop_only" });
  for (const payload of [{}, { on: "yes" }, { on: true, extra: 1 }, null]) assert.deepEqual(await call("aril_switch_set", payload, desktop), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.deepEqual(await call("aril_switch", { extra: 1 }, desktop), { ok: false, error: "invalid" });
});

test("turning Aril Off drops the follow-ups that wait, and nothing but the owner's call turns it On", async () => {
  let dropped = 0;
  const aril = createArilSwitch({ initial: { on: true } });
  const control = createArilControl({ arilSwitch: aril, onOff: () => { dropped += 1; } });
  await control.handlers.aril_switch_set({ on: false }, { event: {} });
  assert.equal(dropped, 1);
  await control.handlers.aril_switch_set({ on: false }, { event: {} });
  assert.equal(dropped, 1, "an Off that changes nothing drops nothing again");
  assert.equal(control.isOn(), false);
  assert.deepEqual(Object.keys(control.handlers).filter((name) => /switch_set|paired_on/u.test(name)).sort(), ["aril_paired_on_set", "aril_switch_set"]);
});
