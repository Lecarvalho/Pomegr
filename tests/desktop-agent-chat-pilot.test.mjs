import assert from "node:assert/strict";
import test from "node:test";

import { chatHarness, repositoryId, until } from "./helpers/agent-chat-harness.mjs";

test("pilot inference uses the read-only chat runner and leaves no conversation", async (t) => {
  const h = await chatHarness(t);
  const pending = h.chat.decidePilot({ repositoryId, provider: "codex", model: null, prompt: "Synthetic scoped decision" });
  await until(() => h.runs.length === 1);
  assert.equal(h.chat.isBusy(), true);
  assert.equal(h.runs[0].options.provider, "codex");
  assert.equal(h.runs[0].options.prompt, "Synthetic scoped decision");
  assert.deepEqual(await h.chat.handle("list", { repositoryId }), { ok: true, conversations: [], running: null });
  assert.equal((await h.chat.decidePilot({ repositoryId, provider: "claude", model: null, prompt: "Other" })).status, "busy");
  h.runs[0].resolve({ status: "complete", text: '{"action":"wait"}' });
  assert.deepEqual(await pending, { status: "complete", text: '{"action":"wait"}' });
  assert.equal(h.chat.isBusy(), false);
  assert.deepEqual(await h.store.list(repositoryId), []);
  assert.equal(h.calls.some((call) => call.pathname.includes("start-plan")), false);
});

test("interactive chat preempts pilot inference and discards its answer", async (t) => {
  const h = await chatHarness(t);
  const background = h.chat.decidePilot({ repositoryId, provider: "claude", model: null, prompt: "Synthetic decision" });
  await until(() => h.runs.length === 1);
  const interactive = h.chat.handle("send", { repositoryId, conversationId: null, text: "Owner question", provider: "codex", model: null });
  await until(() => h.runs[0].stops === 1);
  h.runs[0].resolve({ status: "complete", text: "Never execute this stopped answer" });
  assert.deepEqual(await background, { status: "interrupted", text: "" });
  assert.equal((await interactive).ok, true);
  assert.equal(h.runs.length, 2);
  h.runs[1].resolve({ status: "complete", text: "Owner answer" });
  await until(() => !h.chat.isBusy());
});
