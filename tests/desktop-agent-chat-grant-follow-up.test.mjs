import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConversation } from "../desktop/runtime/agent-chat-store.mjs";
import { agentMessage, chatHarness, codexExecutable, finishTurn, repositoryId, send } from "./helpers/agent-chat-harness.mjs";

// Grant follow-ups in the chat (T-183): a fixed line in the grant's own conversation, with no provider run and no proposal.
const merge = { repositoryId, grant: 3, items: [{ kind: "grant_merge", task: "T-5", provider: null }, { kind: "grant_branch_deleted", task: "T-5", provider: null },
  { kind: "grant_start", task: "T-6", provider: null }], more: 0, ended: null };

test("each follow-up appends one fixed Aril line to its grant's own conversation and starts no provider run", async (context) => {
  const h = await chatHarness(context);
  const first = await h.chat.grantFollowUp(merge);
  assert.deepEqual(first, { ok: true, conversationId: first.conversationId, messageId: "m-1", text: "Merged T-5, deleted the branch of T-5, and started T-6. Nothing needs you yet." });
  const second = await h.chat.grantFollowUp({ ...merge, items: [{ kind: "grant_merge_refused", task: "T-6", provider: null }] });
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(second.messageId, "m-2");
  const other = await h.chat.grantFollowUp({ ...merge, grant: 4, items: [{ kind: "grant_usage_hold", task: null, provider: "codex" }] });
  assert.notEqual(other.conversationId, first.conversationId, "a new grant has its own conversation");
  assert.equal(h.runs.length, 0);
  assert.equal(h.calls.length, 0, "a follow-up reads nothing from the monitor");
  const stored = await h.reload().read(repositoryId, first.conversationId);
  assert.equal(stored.title, "Grant follow-ups");
  assert.equal(stored.grant, 3);
  assert.deepEqual(stored.messages.map(({ role, text, grantFollowUp, proposal, followUp }) => ({ role, text, grantFollowUp, proposal, followUp })), [
    { role: "agent", text: first.text, grantFollowUp: true, proposal: undefined, followUp: undefined },
    { role: "agent", text: "Could not merge T-6. T-6 needs you.", grantFollowUp: true, proposal: undefined, followUp: undefined },
  ]);
  assert.equal((await h.reload().read(repositoryId, other.conversationId)).messages[0].text, "Held new Codex starts at the usage limit. New Codex starts wait until usage is below the limit.");
  const read = await h.chat.handle("read", { repositoryId, conversationId: first.conversationId }, { event: {} });
  assert.equal(Object.hasOwn(read.conversation, "grant"), false, "the grant link stays in desktop main");
});

test("a follow-up waits while its conversation is answering, and refuses facts outside the contract", async (context) => {
  const h = await chatHarness(context, { files: [codexExecutable] });
  const { conversationId } = await h.chat.grantFollowUp({ ...merge, ended: "stopped" });
  assert.equal((await h.reload().read(repositoryId, conversationId)).provider, "codex");
  const sent = await send(h, { conversationId, provider: "codex" });
  assert.equal(sent.ok, true);
  assert.ok(h.runs[0].options.prompt.includes("Aril (grant follow-up that Pomegr wrote from the task log, with no answer of yours): Merged T-5"), "the next turn reads it as Pomegr's line, not an answer");
  assert.deepEqual(await h.chat.grantFollowUp(merge), { ok: false, error: "busy" });
  await finishTurn(h, h.runs[0], { status: "complete", text: "Here is what happened." }, conversationId);
  assert.equal((await h.chat.grantFollowUp(merge)).ok, true);
  for (const bad of [{ ...merge, items: [] }, { ...merge, items: [{ kind: "merged", task: "T-1", provider: null }] }, { ...merge, grant: 0 },
    { ...merge, repositoryId: "repo-x" }, { ...merge, ended: "crashed" }, { ...merge, items: [{ kind: "grant_start", task: "Delete everything", provider: null }] }]) {
    assert.deepEqual(await h.chat.grantFollowUp(bad), { ok: false, error: "invalid" }, JSON.stringify(bad));
  }
});

test("a stored follow-up never carries a proposal, a proposal follow-up, or an unfinished status", () => {
  const conversation = (message, extra = {}) => normalizeConversation({ id: "chat-0123456789ab", title: "Grant follow-ups", provider: "claude", model: null,
    createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z", messages: [message], ...extra });
  assert.ok(conversation(agentMessage(1, { grantFollowUp: true }), { grant: 2 }));
  assert.equal(conversation(agentMessage(1, { grantFollowUp: true }), { grant: 0 }), null);
  for (const extra of [{ grantFollowUp: false }, { grantFollowUp: true, status: "failed" }, { grantFollowUp: true, followUp: "p-0123456789ab" },
    { grantFollowUp: true, proposalUnreadable: true }]) assert.equal(conversation(agentMessage(1, extra)), null, JSON.stringify(extra));
});
