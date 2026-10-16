import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPomegrMcpServer as buildCodexServer } from "../mcp/server.mjs";
import { buildPomegrMcpServer as buildClaudeServer } from "../plugins/claude-code/mcp/server.mjs";
import { registerTaskTools, TASK_BLOCK_PATH } from "../mcp/task-tools.mjs";
import { createTaskBindingProof } from "../plugin-src/task-binding-proof.mjs";
import { openTaskStore } from "../server/tasks/task-store.mjs";
import { passingGates } from "./server/tasks/queue-test-support.mjs";

const NOW = 1_800_000_000_000;
const TOKEN = "synthetic-capability-token-".padEnd(43, "k");
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const THREAD = "019a0000-2222-7333-8444-555566667777";
const REF = `claude:${SESSION_ID}`;
const SENTINEL = "PRIVATE_REPORT_SENTINEL";
const proofFor = (tool) => createTaskBindingProof({ token: TOKEN, tool, sessionRef: REF, now: NOW });
const codexMeta = () => ({ mcpReq: { _meta: { threadId: THREAD } } });

function setup({ answer }) {
  const tools = {};
  registerTaskTools({ registerTool: (name, config, handler) => { tools[name] = { config, handler }; } }, {
    resolveSession: () => REF, post: async () => answer,
  });
  return { tools };
}

test("complete_task gives truthful fixed feedback when reporting completion retains an owner hold", async () => {
  for (const results of [[], [{ check: "tree_clean", passed: false }, { check: "ci_passed", passed: false, unavailable: true }]]) {
    const { tools } = setup({ answer: { ok: true, state: "needs_review", ownerHold: true, results, reason: SENTINEL, history: SENTINEL } });
    const out = await tools.complete_task.handler({});
    assert.equal(out.isError, undefined);
    assert.match(out.content[0].text, /Task reported complete/u);
    assert.match(out.content[0].text, /earlier block still needs the user to choose Mark done or Requeue/u);
    assert.match(out.content[0].text, /queue state is unchanged/u);
    if (results.length) {
      assert.match(out.content[0].text, /conditions did not pass: Working tree clean/u);
      assert.match(out.content[0].text, /could not verify: CI passed/u);
    }
    assert.doesNotMatch(JSON.stringify(out), new RegExp(SENTINEL, "u"));
  }
});

for (const provider of ["claude", "codex"]) {
  test(`${provider} native task binding accepts alternating reports through the real task store`, async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-report-recovery-"));
    const store = openTaskStore({ directory, now: () => NOW });
    context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
    const repositoryId = "repo-0123456789abcdef01234567";
    const sessionRef = provider === "claude" ? REF : `codex:${THREAD}`;
    assert.equal(store.apply(repositoryId, "create", { text: "Synthetic report recovery" }).ok, true);
    const plan = store.planStart(repositoryId, { id: "T-1" }, () => ({ root: "C:/Synthetic/repo", pluginReady: true }), passingGates);
    assert.equal(plan.ok, true);
    assert.equal(store.bindSession({ token: plan.plan.token, sessionId: sessionRef }).ok, true);
    const taskPost = async (pathname, body) => {
      assert.equal(body.sessionRef, sessionRef);
      assert.equal(body.session_proof, undefined);
      return pathname === TASK_BLOCK_PATH ? store.blockTask({ sessionId: body.sessionRef, reason: body.reason })
        : store.completeTask({ sessionId: body.sessionRef }, () => null);
    };
    const server = provider === "claude"
      ? buildClaudeServer({ environment: {}, taskPost, query: async () => ({}), readBindingToken: async () => TOKEN, now: () => NOW })
      : buildCodexServer({ environment: {}, taskPost, query: async () => ({}) });
    const call = (name, input = {}) => server._registeredTools[name].handler(provider === "claude"
      ? { ...input, session_ref: REF, session_proof: proofFor(name) } : input, provider === "codex" ? codexMeta() : undefined);
    assert.match((await call("complete_task")).content[0].text, /put it in Review/u);
    assert.equal((await call("block_task", { reason: "Owner needed" })).isError, undefined);
    const recovered = await call("complete_task");
    assert.equal(recovered.isError, undefined);
    assert.match(recovered.content[0].text, /task is in Review/u);
    assert.equal((await call("block_task", { reason: "New issue" })).isError, undefined);
    assert.equal(store.readBoard(repositoryId).tasks[0].report.blockReason, "New issue");
  });
}
