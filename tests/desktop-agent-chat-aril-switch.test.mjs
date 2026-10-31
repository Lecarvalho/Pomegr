// The Aril switch in the chat: Off means no Aril. The chat refuses what it would start (see desktop-agent-chat-aril-off.test.mjs), Off stops the
// provider runs Aril starts by itself (the follow-up after an answered proposal, and the grant's task writing), and the state survives a restart.
// A missing file reads as On (Pomegr ships with Aril On), and a damaged file reads as Off.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createAgentChat } from "../desktop/runtime/agent-chat.mjs";
import { createArilSwitch, ARIL_SWITCH_FILE } from "../desktop/runtime/aril-switch.mjs";
import { chatHarness, finishTurn, origin, pendingProposal, repositoryId, seed, send, token, until, withProposal } from "./helpers/agent-chat-harness.mjs";

const desktop = { event: {} };
const proposalId = "p-0123456789ab";
const apply = (h, conversationId) => h.handle("apply", { repositoryId, conversationId, proposalId });
const quiet = () => new Promise((resolve) => setTimeout(resolve, 40));

test("an applied proposal asks Aril for one follow-up when it is On, and Off refuses the Apply and asks for none", async (context) => {
  for (const on of [true, false]) {
    const h = await chatHarness(context, { arilSwitch: createArilSwitch({ initial: { on } }) });
    const conversation = await seed(h, { messages: withProposal(pendingProposal()) });
    if (on) {
      assert.deepEqual(await apply(h, conversation.id), { ok: true });
      assert.equal((await h.reload().read(repositoryId, conversation.id)).messages[1].proposal.state, "applied");
      await until(() => h.followUps()[0]);
    } else {
      assert.deepEqual(await apply(h, conversation.id), { ok: false, error: "conflict" }, "Off: the owner's Apply is refused too");
      await quiet();
      assert.equal((await h.reload().read(repositoryId, conversation.id)).messages[1].proposal.state, "pending", "and the proposal waits for Aril to be On again");
      assert.equal(h.runs.length, 0, "no provider run starts");
      assert.equal(h.followUps().length, 0);
      assert.equal(h.actionCalls().length, 0, "and nothing reaches the board");
      assert.equal((await h.handle("read", { repositoryId, conversationId: conversation.id })).turn, null, "no follow-up is shown as starting");
    }
  }
});

test("a dismissed proposal follows the same rule: Off refuses the Dismiss", async (context) => {
  const h = await chatHarness(context, { arilSwitch: createArilSwitch() });
  const conversation = await seed(h, { messages: withProposal(pendingProposal()) });
  assert.deepEqual(await h.handle("dismiss", { repositoryId, conversationId: conversation.id, proposalId }), { ok: false, error: "conflict" });
  await quiet();
  assert.equal(h.runs.length, 0);
  assert.equal((await h.reload().read(repositoryId, conversation.id)).messages[1].proposal.state, "pending");
  assert.deepEqual(await h.chat.handle("aril_switch_set", { on: true }, desktop), { ok: true, on: true });
  assert.deepEqual(await h.handle("dismiss", { repositoryId, conversationId: conversation.id, proposalId }), { ok: true });
  assert.equal((await h.reload().read(repositoryId, conversation.id)).messages[1].proposal.state, "dismissed");
});

test("turning Aril Off drops the follow-ups that wait behind a turn and stops the turn that was running", async (context) => {
  const h = await chatHarness(context, { arilSwitch: createArilSwitch({ initial: { on: true } }) });
  const sent = await send(h);
  assert.equal(sent.ok, true);
  // Another conversation, made after the turn started, holds the proposal: its follow-up waits for the turn.
  const waiting = await seed(h, { messages: withProposal(pendingProposal()) });
  assert.notEqual(waiting.id, sent.conversationId);
  assert.deepEqual(await apply(h, waiting.id), { ok: true });
  assert.equal((await h.handle("read", { repositoryId, conversationId: waiting.id })).turn?.activity, "starting", "the follow-up waits behind the turn");
  assert.deepEqual(await h.chat.handle("aril_switch_set", { on: false }, desktop), { ok: true, on: false });
  assert.equal((await h.handle("read", { repositoryId, conversationId: waiting.id })).turn, null, "it is gone at once");
  assert.equal(h.runs[0].stops, 1, "the turn in flight is stopped, as the owner's Stop stops it");
  await finishTurn(h, h.runs[0], { status: "stopped", text: "" }, sent.conversationId);
  await quiet();
  assert.equal(h.followUps().length, 0, "no follow-up ran after the turn");
});

test("with Aril Off a grant's task writing starts no run; with it On it does", async (context) => {
  const request = { repositoryId, plans: ["docs/plan.md"] };
  const off = await chatHarness(context, { arilSwitch: createArilSwitch() });
  assert.deepEqual(await off.chat.grantWrite(request), { ok: false, error: "unavailable" });
  assert.equal(off.runs.length, 0);
  const on = await chatHarness(context, { arilSwitch: createArilSwitch({ initial: { on: true } }) });
  const writing = on.chat.grantWrite(request);
  const run = await until(() => on.runs[0]);
  run.resolve({ status: "complete", text: "Nothing left.\nNo tasks written." });
  assert.equal((await writing).ok, true);
});

test("the switch lives in desktop main: it is On at first, a saved Off survives a restart, and a restart keeps what the owner chose", async (context) => {
  const first = await chatHarness(context, { viaDataRoot: true, arilSwitch: undefined });
  assert.deepEqual(await first.chat.handle("aril_switch", {}, desktop), { ok: true, on: true, pairedOn: false }, "Pomegr ships with Aril On");
  assert.equal(first.chat.arilOn(), true);
  assert.deepEqual(await first.chat.handle("aril_paired_on_set", { allowed: true }, desktop), { ok: true, pairedOn: true });
  const restarted = () => createAgentChat({ fetch: async () => { throw new Error("unused"); }, monitorOrigin: origin, authorizationToken: token, dataRoot: first.dataRoot });
  const second = restarted();
  context.after(() => second.dispose());
  assert.deepEqual(await second.handle("aril_switch", {}, desktop), { ok: true, on: true, pairedOn: true }, "Aril resumes On after a restart; the owner's choice stands");
  assert.deepEqual(await second.handle("aril_switch_set", { on: false }, { paired: true }), { ok: true, on: false }, "a paired device turns it off");
  const third = restarted();
  context.after(() => third.dispose());
  assert.deepEqual(await third.handle("aril_switch", {}, { paired: true }), { ok: true, on: false, pairedOn: true });
  assert.equal(third.arilOn(), false, "a saved Off stays Off");
  assert.deepEqual(await third.handle("aril_switch_set", { on: true }, desktop), { ok: true, on: true });
  const fourth = restarted();
  context.after(() => fourth.dispose());
  assert.deepEqual(await fourth.handle("aril_switch", {}, desktop), { ok: true, on: true, pairedOn: true });
});

test("a damaged switch file reads as Off for the chat, which then refuses a message; a missing one reads as On and the chat answers", async (context) => {
  const base = await chatHarness(context, { viaDataRoot: true });
  const file = path.join(base.dataRoot, "aril-v1", ARIL_SWITCH_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (const content of ["{", JSON.stringify({ version: 1, on: "yes", pairedOn: false })]) {
    await fs.writeFile(file, content);
    const damaged = createAgentChat({ fetch: async () => { throw new Error("unused"); }, monitorOrigin: origin, authorizationToken: token, dataRoot: base.dataRoot });
    context.after(() => damaged.dispose());
    assert.deepEqual(await damaged.handle("aril_switch", {}, desktop), { ok: true, on: false, pairedOn: false }, content);
    assert.deepEqual(await damaged.handle("send", { repositoryId, conversationId: null, text: "Hello", provider: "claude", model: null }, desktop), { ok: false, error: "conflict" }, content);
  }
  await fs.rm(file);
  const missing = createAgentChat({ fetch: async () => { throw new Error("unused"); }, monitorOrigin: origin, authorizationToken: token, dataRoot: base.dataRoot });
  context.after(() => missing.dispose());
  assert.deepEqual(await missing.handle("aril_switch", {}, desktop), { ok: true, on: true, pairedOn: false });
});

test("a paired device reads the switch and the owner's memory but cannot change the memory", async (context) => {
  const h = await chatHarness(context);
  const paired = { paired: true };
  assert.equal((await h.chat.handle("aril_switch", {}, paired)).ok, true);
  assert.deepEqual(await h.chat.handle("owner_memory", {}, paired), { ok: true, memory: { text: "", previous: null, updatedAt: null, updatedBy: null } });
  for (const [operation, payload] of [["owner_memory_set", { text: "x" }], ["thread_space", {}], ["thread_limit_set", { megabytes: 10 }], ["thread_flush", { repositoryId }]]) {
    assert.deepEqual(await h.chat.handle(operation, payload, paired), { ok: false, error: "desktop_only" }, operation);
  }
});

test("no operation of the chat's own turns, tools, or proposals can reach the switch", async (context) => {
  const h = await chatHarness(context, { arilSwitch: createArilSwitch() });
  const conversation = await seed(h, { messages: withProposal(pendingProposal({ operations: [{ op: "queue_task", id: "T-1" }] })) });
  assert.deepEqual(await apply(h, conversation.id), { ok: false, error: "conflict" }, "an Off Aril applies nothing, so no proposal reaches the board or the switch");
  // An unknown operation name that tries the switch from a proposal is not an operation at all.
  assert.deepEqual(await h.handle("aril_switch_set", { repositoryId, on: true }), { ok: false, error: "invalid" });
  assert.deepEqual(await h.handle("aril_switch_set", { on: true }), { ok: false, error: "desktop_only" }, "with no origin the call is not the desktop window");
  assert.equal(h.chat.arilOn(), false);
});
