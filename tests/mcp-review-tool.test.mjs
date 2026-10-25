import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildPomegrMcpServer as buildCodexServer } from "../mcp/server.mjs";
import { buildPomegrMcpServer as buildClaudeServer } from "../plugins/claude-code/mcp/server.mjs";
import { registerTaskTools } from "../mcp/task-tools.mjs";
import { AGENT_TASK_NO_ANSWER } from "../shared/agent-query-transport.mjs";
import { bindClaudeQueryWrite } from "../plugin-src/claude-query-session.mjs";
import { createTaskBindingProof } from "../plugin-src/task-binding-proof.mjs";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const THREAD = "019a0000-2222-7333-8444-555566667777";
const SENTINEL = "REVIEW_PRIVATE_SENTINEL";
const TOKEN = "claude-capability-token-".padEnd(43, "k");
const NOW = 1_800_000_000_000;
const REF = `claude:${SESSION_ID}`;
const codexMeta = () => ({ mcpReq: { _meta: { threadId: THREAD } } });
const proofFor = (tool) => createTaskBindingProof({ token: TOKEN, tool, sessionRef: REF, now: NOW });
const parse = (tool, input) => tool.config.inputSchema.safeParse(input);

function setup({ ref = "claude:x", hookBound = false, answer = { ok: true } } = {}) {
  const tools = {};
  const calls = [];
  registerTaskTools({ registerTool: (name, config, handler) => { tools[name] = { config, handler }; } }, {
    resolveSession: () => ref, hookBound,
    post: async (pathname, body) => {
      calls.push({ pathname, body });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  return { tools, calls };
}

function claudeServer() {
  const calls = [];
  const server = buildClaudeServer({ readBindingToken: async () => TOKEN, now: () => NOW, query: async () => ({}),
    taskPost: async (pathname, body) => { calls.push({ pathname, body }); return { ok: true }; } });
  return { tools: server._registeredTools, calls };
}

test("report_review schema accepts only a verdict and bounded reasons for failure", () => {
  const tool = setup().tools.report_review;
  assert.deepEqual(tool.config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.equal(parse(tool, { verdict: "pass" }).success, true);
  assert.deepEqual(parse(tool, { verdict: "fail", reasons: ["  unmet: checks failed  "] }).data,
    { verdict: "fail", reasons: ["unmet: checks failed"] });
  assert.equal(parse(tool, { verdict: "fail", reasons: Array(10).fill("x".repeat(200)), task_id: "T-12" }).success, true);
  for (const input of [{}, { verdict: "other" }, { verdict: "pass", reasons: ["x"] }, { verdict: "pass", reasons: [] },
    { verdict: "fail" }, ...[[], Array(11).fill("x"), ["x".repeat(201)], ["a\nb"], ["a\rb"], ["a\u2028b"], ["a\u2029b"], ["a\u0000b"], ["   "]].map((reasons) => ({ verdict: "fail", reasons })),
    { verdict: "pass", task_id: "T-0" }, { verdict: "pass", repository: "x" }, { verdict: "pass", session_ref: "claude:x" }]) {
    assert.equal(parse(tool, input).success, false, JSON.stringify(input));
  }
  for (const input of [{ verdict: "pass", reasons: ["x"] }, { verdict: "fail" }]) {
    assert.match(parse(tool, input).error.message, /Reasons are required for fail and must be omitted for pass/u);
  }
  assert.equal(parse(setup({ hookBound: true }).tools.report_review,
    { verdict: "pass", session_ref: "claude:x", session_proof: "p" }).success, true);
});

test("report_review posts the exact body and returns only fixed verdict text", async () => {
  for (const [input, body, text] of [
    [{ verdict: "pass" }, { sessionRef: "claude:x", verdict: "pass" }, "Review reported: passed."],
    [{ verdict: "fail", reasons: [" unmet: checks ", "unknown: CI"], task_id: "T-12" },
      { sessionRef: "claude:x", verdict: "fail", reasons: ["unmet: checks", "unknown: CI"], taskId: "T-12" }, "Review reported: failed, with 2 reasons."],
  ]) {
    const { tools, calls } = setup({ answer: { ok: true, secret: SENTINEL }, hookBound: true });
    const out = await tools.report_review.handler(parse(tools.report_review, { ...input, session_ref: "ignored", session_proof: "ignored" }).data);
    assert.equal(out.isError, undefined);
    assert.equal(out.content[0].text, text);
    assert.deepEqual(calls, [{ pathname: "/api/agent/v1/tasks/review", body }]);
  }
});

test("report_review maps fixed errors, unavailable answers, unbound calls, and uncertain writes", async () => {
  const texts = {
    invalid: "Pomegr rejected the report as invalid, so nothing was reported.",
    not_found: "This session is not the reviewer of a task, or that task ID is not one it reviews.",
    not_reviewable: "The task is no longer in Review, so no verdict was recorded.",
    unavailable: "Pomegr is unavailable, so nothing was reported.",
  };
  for (const [reason, text] of Object.entries(texts)) {
    const out = await setup({ answer: { ok: false, reason, detail: SENTINEL } }).tools.report_review.handler({ verdict: "pass" });
    assert.equal(out.isError, true);
    assert.equal(out.content[0].text, text);
  }
  for (const answer of [null, {}, { ok: false, reason: SENTINEL }, new Error(SENTINEL)]) {
    assert.equal((await setup({ answer }).tools.report_review.handler({ verdict: "pass" })).content[0].text, texts.unavailable);
  }
  const unbound = setup({ ref: null });
  assert.equal((await unbound.tools.report_review.handler({ verdict: "pass" })).content[0].text,
    "Pomegr could not bind this call to the current session, so no verdict was recorded.");
  assert.equal(unbound.calls.length, 0);
  assert.equal((await setup({ answer: new Error(AGENT_TASK_NO_ANSWER) }).tools.report_review.handler({ verdict: "pass" })).content[0].text,
    "Pomegr did not answer in time, so it is unknown whether the verdict was recorded. It may have been: do not assume it failed. Retry the same verdict only if it still describes the review; an identical retry changes nothing.");
});

test("report_review binds Codex metadata and Claude hook proofs for both tool prefixes", async () => {
  const calls = [];
  const codex = buildCodexServer({ currentSessionRef: null, query: async () => ({}), taskPost: async (pathname, body) => {
    calls.push({ pathname, body });
    return { ok: true };
  } });
  const tool = codex._registeredTools.report_review;
  assert.match((await tool.handler({ verdict: "pass" })).content[0].text, /no verdict was recorded/u);
  assert.equal(calls.length, 0);
  assert.equal((await tool.handler({ verdict: "pass" }, codexMeta())).content[0].text, "Review reported: passed.");
  assert.equal(calls[0].body.sessionRef, `codex:${THREAD}`);
  for (const prefix of ["mcp__pomegr__", "mcp__plugin_pomegr_pomegr__"]) {
    const bound = (await bindClaudeQueryWrite({ hook_event_name: "PreToolUse", tool_name: `${prefix}report_review`,
      tool_input: { verdict: "fail", reasons: ["unmet: checks"], task_id: "T-12" }, transcript_path: path.resolve("private", `${SESSION_ID}.jsonl`) },
    { readToken: async () => TOKEN, now: () => NOW })).hookSpecificOutput;
    assert.equal(bound.permissionDecision, undefined);
    assert.equal(bound.updatedInput.session_proof, proofFor("report_review"));
    const claude = claudeServer();
    for (const binding of [{}, { session_ref: REF }, { session_ref: REF, session_proof: proofFor("complete_task") },
      { session_ref: REF, session_proof: "invalid" }]) {
      const denied = await claude.tools.report_review.handler({ verdict: "pass", ...binding });
      assert.equal(denied.isError, true);
      assert.equal(denied.content[0].text, "Pomegr could not bind this call to the current session, so no verdict was recorded.");
    }
    assert.equal(claude.calls.length, 0);
    assert.equal((await claude.tools.report_review.handler(bound.updatedInput)).content[0].text, "Review reported: failed, with 1 reason.");
    assert.deepEqual(claude.calls[0], { pathname: "/api/agent/v1/tasks/review", body: { sessionRef: REF, verdict: "fail", reasons: ["unmet: checks"], taskId: "T-12" } });
  }
});

