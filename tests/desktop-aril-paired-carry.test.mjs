// The one-time carry-over of the first version's per-repository `pairedDevices` to the owner's one permission for paired devices (`pairedOn`).
// It reads every board once, never sets the permission without a repository that had it, and never undoes what the owner chose.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createArilControl } from "../desktop/runtime/agent-chat-aril.mjs";
import { createPairedCarryOver, PAIRED_CARRY_FILE } from "../desktop/runtime/aril-paired-carry.mjs";
import { ARIL_DIRECTORY, ARIL_SWITCH_FILE, createArilSwitch } from "../desktop/runtime/aril-switch.mjs";
import { chatHarness } from "./helpers/agent-chat-harness.mjs";

const idOf = (letter) => `repo-${letter.repeat(24)}`;
const board = (pairedDevices) => ({ readiness: "ready", aril: { settings: { pairedDevices } } });
const desktop = { event: {} };

async function directory(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-paired-carry-"));
  context.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

/** Boards by repository letter: `true` or `false` for the old setting, `null` for a board that cannot be read. */
function reads(values) {
  const asked = [];
  return {
    asked,
    readHome: async () => ({ boards: Object.keys(values).map((letter) => ({ repositoryId: idOf(letter) })) }),
    readBoard: async (repositoryId) => {
      asked.push(repositoryId);
      const value = values[repositoryId.charAt(5)];
      return value === null ? null : board(value);
    },
  };
}

const markerOf = (root) => path.join(root, ARIL_DIRECTORY, PAIRED_CARRY_FILE);
const exists = (file) => fs.access(file).then(() => true, () => false);

test("a repository that had the old permission makes the global one start On, once, and the marker keeps it from running again", async (context) => {
  const root = await directory(context);
  const arilSwitch = createArilSwitch({ file: path.join(root, ARIL_DIRECTORY, ARIL_SWITCH_FILE) });
  const carry = createPairedCarryOver({ file: markerOf(root), arilSwitch });
  assert.equal(arilSwitch.state().pairedOn, false);
  assert.equal(await carry.run(reads({ a: false, b: true, c: false })), "carried");
  assert.equal(arilSwitch.state().pairedOn, true);
  assert.equal(await exists(markerOf(root)), true);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, ARIL_DIRECTORY, ARIL_SWITCH_FILE), "utf8")).pairedOn, true, "the permission is written, not only held");
  // The owner turns it Off; the next start does not turn it On again.
  assert.deepEqual(await arilSwitch.setPairedOn(false), "ok");
  const restarted = createPairedCarryOver({ file: markerOf(root), arilSwitch });
  const again = reads({ b: true });
  assert.equal(await restarted.run(again), "done");
  assert.deepEqual(again.asked, [], "nothing was read");
  assert.equal(arilSwitch.state().pairedOn, false);
});

test("no repository had it: the permission stays Off and only the marker is written, once every board was read", async (context) => {
  const root = await directory(context);
  const arilSwitch = createArilSwitch({ initial: { on: true } });
  const carry = createPairedCarryOver({ file: markerOf(root), arilSwitch });
  const all = reads({ a: false, b: false });
  assert.equal(await carry.run(all), "done");
  assert.equal(arilSwitch.state().pairedOn, false);
  assert.deepEqual(all.asked, [idOf("a"), idOf("b")]);
  assert.equal(await exists(markerOf(root)), true);
  // A repository that is added later has no old value to carry; the marker has ended it.
  const later = reads({ c: true });
  assert.equal(await carry.run(later), "done");
  assert.deepEqual(later.asked, []);
  assert.equal(arilSwitch.state().pairedOn, false);
});

test("a board that cannot be read is tried again, and nothing is decided until every board was read", async (context) => {
  const root = await directory(context);
  const arilSwitch = createArilSwitch({});
  const carry = createPairedCarryOver({ file: markerOf(root), arilSwitch });
  assert.equal(await carry.run(reads({ a: false, b: null })), "later");
  assert.equal(await exists(markerOf(root)), false, "no marker while a board is unknown");
  assert.equal(arilSwitch.state().pairedOn, false);
  assert.equal(await carry.run({ readHome: async () => { throw new Error("monitor not ready"); }, readBoard: async () => null }), "later");
  assert.equal(await carry.run({ readHome: async () => ({ boards: "none" }), readBoard: async () => null }), "later");
  assert.equal(await carry.run(reads({ a: false, b: false })), "done");
  assert.equal(await exists(markerOf(root)), true);
  // One repository that says yes is enough, even while another cannot be read.
  const other = await directory(context);
  const second = createArilSwitch({});
  assert.equal(await createPairedCarryOver({ file: markerOf(other), arilSwitch: second }).run(reads({ a: null, b: true })), "carried");
  assert.equal(second.state().pairedOn, true);
});

test("a board without Aril settings counts as unread, and a malformed repository ID is skipped", async () => {
  const arilSwitch = createArilSwitch({});
  const carry = createPairedCarryOver({ arilSwitch });
  const odd = { readHome: async () => ({ boards: [{ repositoryId: "not-an-id" }, null, { repositoryId: idOf("a") }] }), readBoard: async () => ({ readiness: "ready", aril: null }) };
  assert.equal(await carry.run(odd), "later");
  assert.equal(await carry.run({ readHome: async () => ({ boards: [{ repositoryId: "not-an-id" }] }), readBoard: async () => { throw new Error("never asked"); } }), "done");
  assert.equal(arilSwitch.state().pairedOn, false);
});

test("the owner's own choice ends the carry-over, so it never undoes what the owner chose", async (context) => {
  const root = await directory(context);
  const arilSwitch = createArilSwitch({ initial: { pairedOn: true } });
  const carry = createPairedCarryOver({ file: markerOf(root), arilSwitch });
  // The owner turned the permission Off while a pass was reading: the pass finds the carry-over ended and sets nothing.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = { readHome: async () => ({ boards: [{ repositoryId: idOf("a") }] }), readBoard: async () => { await gate; return board(true); } };
  const pass = carry.run(slow);
  await new Promise((resolve) => setImmediate(resolve));
  const settled = carry.settle();
  assert.deepEqual(await arilSwitch.setPairedOn(false), "ok");
  release();
  assert.equal(await pass, "done");
  assert.equal(await settled, true);
  assert.equal(arilSwitch.state().pairedOn, false);
  assert.equal(await exists(markerOf(root)), true);
});

test("a marker that cannot be written allows nothing, and the permission already On is left as it is", async (context) => {
  const root = await directory(context);
  const arilSwitch = createArilSwitch({});
  const broken = { ...fs, writeFile: async () => { throw new Error("disk full"); } };
  const carry = createPairedCarryOver({ file: markerOf(root), arilSwitch, filesystem: broken });
  assert.equal(await carry.run(reads({ a: true })), "later");
  assert.equal(arilSwitch.state().pairedOn, false, "the marker is written before the permission");
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".tmp")), []);
  const already = createArilSwitch({ initial: { pairedOn: true } });
  assert.equal(await createPairedCarryOver({ arilSwitch: already }).run(reads({ a: true })), "carried");
  assert.equal(already.state().pairedOn, true);
});

test("a marker outside the contract is no marker", async (context) => {
  const root = await directory(context);
  await fs.mkdir(path.join(root, ARIL_DIRECTORY), { recursive: true });
  for (const content of ["not json", "{}", JSON.stringify({ version: 2 })]) {
    await fs.writeFile(markerOf(root), content);
    const arilSwitch = createArilSwitch({});
    assert.equal(await createPairedCarryOver({ file: markerOf(root), arilSwitch }).run(reads({ a: true })), "carried", content);
    assert.equal(arilSwitch.state().pairedOn, true);
  }
  assert.throws(() => createPairedCarryOver({ file: "relative.json", arilSwitch: createArilSwitch({}) }), TypeError);
  assert.throws(() => createPairedCarryOver({}), TypeError);
});

test("start runs a pass at each delay, the timers do not keep the process alive, and cancel stops the ones that wait", async () => {
  const arilSwitch = createArilSwitch({});
  const timers = [];
  const cleared = [];
  const setTimer = (run, delay) => { const timer = { run, delay, unref() { this.unrefed = true; return this; } }; timers.push(timer); return timer; };
  const carry = createPairedCarryOver({ arilSwitch, delaysMs: [10, 20, 30], setTimer, clearTimer: (timer) => cleared.push(timer) });
  const wired = reads({ a: true });
  const handle = carry.start(wired);
  assert.deepEqual(timers.map((timer) => [timer.delay, timer.unrefed]), [[10, true], [20, true], [30, true]]);
  timers[0].run();
  await carry.run(wired);
  assert.equal(arilSwitch.state().pairedOn, true);
  handle.cancel();
  assert.equal(cleared.length, 2, "the two timers that had not fired are cleared");
  const asked = wired.asked.length;
  timers[1].run();
  await carry.run(wired);
  assert.equal(wired.asked.length, asked, "a pass after the carry-over has ended reads nothing");
});

test("the control gives the owner's one permission to paired Apply and to the gateway, and the owner's choice settles the carry-over", async (context) => {
  const root = await directory(context);
  const control = createArilControl({ dataRoot: root });
  assert.equal(await control.pairedAllowed(), false, "false until the owner allows it");
  assert.equal(control.pairedCarry !== null, true);
  // A paired device cannot allow itself.
  assert.deepEqual(await control.handlers.aril_paired_on_set({ allowed: true }, { paired: true }), { ok: false, error: "desktop_only" });
  assert.equal(await control.pairedAllowed(), false);
  assert.equal(await exists(markerOf(root)), false);
  assert.deepEqual(await control.handlers.aril_paired_on_set({ allowed: true }, desktop), { ok: true, pairedOn: true });
  assert.equal(await control.pairedAllowed(), true);
  assert.deepEqual(await control.handlers.aril_paired_on_set({ allowed: false }, desktop), { ok: true, pairedOn: false });
  assert.equal(await control.pairedAllowed(), false);
  // The marker is written by the owner's choice, so a later pass over a repository that had the old permission changes nothing.
  for (let attempt = 0; attempt < 50 && !(await exists(markerOf(root))); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await exists(markerOf(root)), true);
  assert.equal(await control.pairedCarry.run(reads({ a: true })), "done");
  assert.equal(await control.pairedAllowed(), false);
  // A control with no data root keeps no marker and carries nothing.
  const memory = createArilControl({});
  assert.equal(memory.pairedCarry, null);
  assert.equal(await memory.pairedAllowed(), false);
  assert.deepEqual(await memory.handlers.aril_paired_on_set({ allowed: true }, desktop), { ok: true, pairedOn: true });
  assert.equal(await memory.pairedAllowed(), true);
});

test("desktop main starts the carry-over through the chat with the monitor's home and board reads, and closing the chat cancels it", async (context) => {
  const started = [];
  let cancelled = 0;
  const pairedCarry = { start: (wired) => { started.push(wired); return { cancel: () => { cancelled += 1; } }; }, cancel: () => { cancelled += 1; }, settle: async () => true, run: async () => "done" };
  const h = await chatHarness(context, { carryPaired: true, pairedCarry });
  assert.equal(started.length, 1, "started once");
  const home = await started[0].readHome();
  assert.deepEqual(home.boards.map((board) => board.repositoryId), h.state.home.boards.map((board) => board.repositoryId));
  const board = await started[0].readBoard(h.state.home.boards[0].repositoryId);
  assert.equal(board.readiness, "ready");
  assert.equal(await started[0].readBoard(idOf("f")), null, "a board the monitor does not hold is unread");
  h.chat.dispose();
  assert.equal(cancelled, 1);
  // Without the option, a chat (a test, or any other caller) starts nothing.
  const quiet = await chatHarness(context, { pairedCarry: { ...pairedCarry, start: () => { throw new Error("not started"); } } });
  assert.ok(quiet.chat);
});
