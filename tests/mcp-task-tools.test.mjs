import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { buildPomegrMcpServer as buildCodexServer } from "../mcp/server.mjs";
import { buildPomegrMcpServer as buildClaudeServer } from "../plugins/claude-code/mcp/server.mjs";
import {
  buildAddTaskBody, registerTaskTools, resolveCodexCallSession, TASK_ADD_PATH, TASK_BLOCK_PATH, TASK_COMPLETE_PATH, TASK_REPORT_UNBOUND_TEXT, TASK_UNBOUND_TEXT,
  TASK_UNAVAILABLE_TEXT,
} from "../mcp/task-tools.mjs";
import {
  AGENT_QUERY_AUTH_HEADER,
  AGENT_TASK_ADD_PATH,
  AGENT_TASK_BIND_PATH,
  AGENT_TASK_BLOCK_PATH,
  AGENT_TASK_COMPLETE_PATH,
  AGENT_TASK_WRITE_PATHS,
  createAgentTaskWriter,
  readAgentQueryDescriptor,
} from "../shared/agent-query-transport.mjs";
import { bindClaudeQuerySession, bindClaudeQueryWrite, runClaudeQuerySessionHook } from "../plugin-src/claude-query-session.mjs";
import {
  createTaskBindingProof, TASK_BINDING_PROOF_FUTURE_SKEW_MS, TASK_BINDING_PROOF_WINDOW_MS, verifyTaskBindingProof,
} from "../plugin-src/task-binding-proof.mjs";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const SENTINEL = "TASK_TEXT_SENTINEL_9f3";

function fakeServer() {
  const tools = {};
  return { tools, registerTool: (name, config, handler) => { tools[name] = { config, handler }; } };
}

function setup({ ref = "claude:x", hookBound = false, answer = { ok: true, taskId: "T-4" } } = {}) {
  const server = fakeServer();
  const calls = [];
  registerTaskTools(server, {
    resolveSession: () => ref,
    hookBound,
    post: async (pathname, body) => {
      calls.push({ pathname, body });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  return { tool: server.tools.add_task, tools: server.tools, calls };
}

function parse(tool, input) {
  const schema = tool.config?.inputSchema ?? tool.inputSchema;
  return schema.safeParse(input);
}

test("add_task schema is strict and bounded with no repository or path input", () => {
  const { tool } = setup();
  assert.deepEqual(tool.config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.equal(tool.config._meta, undefined);
  assert.equal(parse(tool, { text: "do it" }).success, true);
  assert.equal(parse(tool, { text: "   " }).success, false);
  assert.equal(parse(tool, { text: "a".repeat(4001) }).success, false);
  assert.equal(parse(tool, { text: "a".repeat(4000) }).success, true);
  for (const extra of [{ repository: "r" }, { repositoryId: "r" }, { path: "C:\\x" }, { column: "Todo" }, { sessionRef: "codex:a" }]) {
    assert.equal(parse(tool, { text: "x", ...extra }).success, false);
  }
  assert.equal(parse(tool, { text: "x", provider: "other" }).success, false);
  assert.equal(parse(tool, { text: "x", effort: "max" }).success, false);
  for (const model of ["../model", "C:\\model", "a b", "<b>", "a/b", "a".repeat(121), ""]) {
    assert.equal(parse(tool, { text: "x", model }).success, false, model);
  }
  assert.equal(parse(tool, { text: "x", model: "gpt-5.5" }).success, true);
  assert.equal(parse(tool, { text: "x", done_when: ["pr_open", "pr_open"] }).success, false);
  assert.equal(parse(tool, { text: "x", done_when: ["nope"] }).success, false);
  assert.equal(parse(tool, { text: "x", done_when: ["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed"] }).success, true);
  assert.equal(parse(tool, { text: "x", own_condition: "a".repeat(501) }).success, false);
  assert.equal(parse(tool, { text: "x", feature: "a".repeat(81) }).success, false);
  assert.equal(parse(tool, { text: "x", feature: "" }).success, false);
});

test("session_ref exists only when the harness binds by hook", () => {
  assert.equal(parse(setup({ hookBound: false }).tool, { text: "x", session_ref: "claude:a" }).success, false);
  assert.equal(parse(setup({ hookBound: true }).tool, { text: "x", session_ref: "claude:a" }).success, true);
  assert.equal(parse(setup({ hookBound: false }).tool, { text: "x", session_proof: "1.a" }).success, false);
  assert.equal(parse(setup({ hookBound: true }).tool, { text: "x", session_ref: "claude:a", session_proof: "1.a" }).success, true);
  assert.equal(parse(setup({ hookBound: true }).tool, { text: "x", session_proof: "x".repeat(101) }).success, false);
  for (const hookBound of [false, true]) {
    const { tools } = setup({ hookBound });
    assert.equal(parse(tools.complete_task, { session_proof: "1.a" }).success, hookBound);
    assert.equal(parse(tools.block_task, { reason: "r", session_proof: "1.a" }).success, hookBound);
  }
});

test("resolveSession receives the tool name and may be async", async () => {
  const server = fakeServer();
  const seen = [];
  const calls = [];
  registerTaskTools(server, {
    resolveSession: async (_input, _extra, tool) => { seen.push(tool); return "claude:x"; },
    post: async (pathname, body) => { calls.push(body); return { ok: true, taskId: "T-1", state: "blocked" }; },
  });
  await server.tools.add_task.handler({ text: "x" });
  await server.tools.complete_task.handler({});
  await server.tools.block_task.handler({ reason: "r" });
  assert.deepEqual(seen, ["add_task", "complete_task", "block_task"]);
  assert.equal(calls.length, 3);
});

test("an unbound call returns the fixed refusal and posts nothing", async () => {
  const { tool, calls } = setup({ ref: null });
  const out = await tool.handler({ text: SENTINEL });
  assert.equal(out.isError, true);
  assert.equal(out.content[0].text, TASK_UNBOUND_TEXT);
  assert.equal(calls.length, 0);
});

test("body mapping omits or null-fills optional groups", async () => {
  const minimal = setup({ ref: "codex:t1" });
  await minimal.tool.handler({ text: "hello" });
  assert.deepEqual(minimal.calls, [{ pathname: TASK_ADD_PATH, body: { sessionRef: "codex:t1", text: "hello" } }]);
  assert.equal(TASK_ADD_PATH, AGENT_TASK_ADD_PATH);

  const full = setup({ ref: "codex:t1" });
  await full.tool.handler({ text: "t", effort: "high", own_condition: "looks right", feature: "Billing" });
  assert.deepEqual(full.calls[0].body, {
    sessionRef: "codex:t1", text: "t",
    run: { provider: null, model: null, effort: "high" },
    doneWhen: { checks: [], own: "looks right" },
    feature: "Billing",
  });
  const checks = setup({ ref: "codex:t1" });
  await checks.tool.handler({ text: "t", provider: "claude", model: "m-1", done_when: ["pr_open"] });
  assert.deepEqual(checks.calls[0].body.run, { provider: "claude", model: "m-1", effort: null });
  assert.deepEqual(checks.calls[0].body.doneWhen, { checks: ["pr_open"], own: null });
});

test("results map to fixed sentences and never echo task or monitor text", async () => {
  const ok = await setup({ answer: { ok: true, taskId: "T-12" } }).tool.handler({ text: SENTINEL });
  assert.equal(ok.isError, undefined);
  assert.equal(ok.content[0].text, "Task T-12 added to the board, not queued.");
  const texts = new Set();
  for (const reason of ["invalid", "session_not_found", "repository_unavailable", "feature_not_found", "limit", "unavailable"]) {
    const out = await setup({ answer: { ok: false, reason, message: "MONITOR_TEXT" } }).tool.handler({ text: SENTINEL });
    assert.equal(out.isError, true);
    texts.add(out.content[0].text);
    assert.doesNotMatch(out.content[0].text, new RegExp(`${SENTINEL}|MONITOR_TEXT`, "u"));
  }
  assert.equal(texts.size, 6);
  for (const answer of [{ ok: true, taskId: "T-<b>" }, { ok: false, reason: "weird" }, null, "x", { ok: true }]) {
    const out = await setup({ answer }).tool.handler({ text: SENTINEL });
    assert.equal(out.isError, true);
    assert.equal(out.content[0].text, TASK_UNAVAILABLE_TEXT);
  }
  const thrown = await setup({ answer: new Error(`boom ${SENTINEL}`) }).tool.handler({ text: SENTINEL });
  assert.equal(thrown.content[0].text, TASK_UNAVAILABLE_TEXT);
  assert.doesNotMatch(JSON.stringify(thrown), new RegExp(SENTINEL, "u"));
});

test("transport POST sends the descriptor token, JSON, and refuses other paths and large bodies", async () => {
  const requests = [];
  const descriptor = JSON.stringify({ version: 1, origin: "http://127.0.0.1:4317", token: "t".repeat(43) });
  const base = {
    descriptorPath: path.resolve("descriptor.json"),
    statFn: async () => ({ isFile: () => true, size: descriptor.length }),
    readFileFn: async () => descriptor,
  };
  const respond = (status, body) => async (url, init) => {
    requests.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  const write = createAgentTaskWriter({ ...base, fetchFn: respond(200, { schemaVersion: 1, ok: true, taskId: "T-1" }) });
  assert.deepEqual(await write(AGENT_TASK_ADD_PATH, { text: "x" }), { schemaVersion: 1, ok: true, taskId: "T-1" });
  assert.equal(requests[0].url, "http://127.0.0.1:4317/api/agent/v1/tasks/add");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.headers["content-type"], "application/json");
  assert.equal(requests[0].init.headers[AGENT_QUERY_AUTH_HEADER], "t".repeat(43));
  assert.equal(requests[0].init.body, JSON.stringify({ text: "x" }));

  // Add, bind, complete, and block are the only write paths; nothing else is reachable.
  assert.deepEqual([...AGENT_TASK_WRITE_PATHS], [AGENT_TASK_ADD_PATH, AGENT_TASK_BIND_PATH, AGENT_TASK_COMPLETE_PATH, AGENT_TASK_BLOCK_PATH]);
  assert.equal(AGENT_TASK_COMPLETE_PATH, TASK_COMPLETE_PATH);
  assert.equal(AGENT_TASK_BLOCK_PATH, TASK_BLOCK_PATH);
  const bind = createAgentTaskWriter({ ...base, fetchFn: respond(200, { schemaVersion: 1, ok: true }) });
  assert.deepEqual(await bind(AGENT_TASK_BIND_PATH, { token: "x".repeat(16), sessionRef: "claude:a" }), { schemaVersion: 1, ok: true });
  assert.equal(requests[1].url, "http://127.0.0.1:4317/api/agent/v1/tasks/bind");
  assert.equal(requests[1].init.method, "POST");
  assert.equal(requests[1].init.headers[AGENT_QUERY_AUTH_HEADER], "t".repeat(43));
  assert.equal(requests[1].init.body, JSON.stringify({ token: "x".repeat(16), sessionRef: "claude:a" }));
  for (const bad of [
    "/api/agent/v1/tasks/complete/", "/api/agent/v1/tasks/block?x=1", "/api/agent/v1/tasks/resolve", "/api/agent/v1/sessions", "/api/agent/v1/tasks/add/../x",
    "/api/tasks", "/api/agent/v1/tasks/bind/", "/api/agent/v1/tasks/bind?token=x", "/api/agent/v1/tasks/bind/x", "/api/agent/v1/tasks/Bind", "",
  ]) {
    await assert.rejects(() => write(bad, {}), /AGENT_QUERY_PATH_INVALID/u);
    await assert.rejects(() => bind(bad, {}), /AGENT_QUERY_PATH_INVALID/u);
  }
  await assert.rejects(() => write(AGENT_TASK_ADD_PATH, { text: "a".repeat(16 * 1024) }), /AGENT_QUERY_BODY_INVALID/u);
  assert.equal(requests.length, 2);

  const refused = createAgentTaskWriter({ ...base, fetchFn: respond(422, { schemaVersion: 1, ok: false, reason: "invalid" }) });
  assert.deepEqual(await refused(AGENT_TASK_ADD_PATH, {}), { schemaVersion: 1, ok: false, reason: "invalid" });
  const unauthorized = createAgentTaskWriter({ ...base, fetchFn: respond(401, "nope") });
  await assert.rejects(() => unauthorized(AGENT_TASK_ADD_PATH, {}), /AGENT_QUERY_UNAVAILABLE/u);
  const array = createAgentTaskWriter({ ...base, fetchFn: respond(200, "[1]") });
  await assert.rejects(() => array(AGENT_TASK_ADD_PATH, {}), /AGENT_QUERY_UNAVAILABLE/u);
  const down = createAgentTaskWriter({ ...base, fetchFn: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(() => down(AGENT_TASK_ADD_PATH, {}), /AGENT_QUERY_UNAVAILABLE/u);
  const badDescriptor = createAgentTaskWriter({ ...base, readFileFn: async () => "{}", fetchFn: respond(200, { ok: true }) });
  await assert.rejects(() => badDescriptor(AGENT_TASK_ADD_PATH, {}), /AGENT_QUERY_UNAVAILABLE/u);
});

test("Codex server falls back to CODEX_THREAD_ID when a call carries no thread metadata, and refuses without either", async () => {
  const calls = [];
  const taskPost = async (pathname, body) => { calls.push({ pathname, body }); return { ok: true, taskId: "T-2" }; };
  const bound = buildCodexServer({ environment: { CODEX_THREAD_ID: "thread-7" }, taskPost, query: async () => ({}) });
  assert.match(bound.server._instructions, /add_task/u);
  assert.equal(parse(bound._registeredTools.add_task, { text: "x", session_ref: "codex:other" }).success, false);
  const out = await bound._registeredTools.add_task.handler({ text: "x" });
  assert.equal(out.content[0].text, "Task T-2 added to the board, not queued.");
  assert.equal(calls[0].body.sessionRef, "codex:thread-7");

  const unbound = buildCodexServer({ environment: {}, taskPost, query: async () => ({}) });
  const refused = await unbound._registeredTools.add_task.handler({ text: "x" });
  assert.equal(refused.content[0].text, TASK_UNBOUND_TEXT);
  const claudeEnv = buildCodexServer({ environment: { CLAUDE_CODE_SESSION_ID: "abc" }, taskPost, query: async () => ({}) });
  assert.equal((await claudeEnv._registeredTools.add_task.handler({ text: "x" })).isError, true);
  assert.equal(calls.length, 1);
});

const THREAD = "019a0000-2222-7333-8444-555566667777";
const codexMeta = (overrides = {}) => ({ _meta: { threadId: THREAD, "x-codex-turn-metadata": { thread_id: THREAD, session_id: THREAD }, ...overrides } });

test("the Codex call metadata names the thread, and only when it is well formed and agrees with itself", () => {
  assert.equal(resolveCodexCallSession(codexMeta()._meta), `codex:${THREAD}`);
  assert.equal(resolveCodexCallSession({ threadId: THREAD }), `codex:${THREAD}`);
  for (const meta of [
    null, undefined, [], "meta", {}, { threadId: 7 }, { threadId: "" }, { threadId: "../x" }, { threadId: "a b" }, { threadId: "x".repeat(129) },
    { threadId: THREAD, "x-codex-turn-metadata": { thread_id: "other-thread" } },
    { "x-codex-turn-metadata": { thread_id: THREAD } },
  ]) assert.equal(resolveCodexCallSession(meta), null, JSON.stringify(meta));
});

test("Codex server binds every task tool to the calling thread from the call metadata, never from input", async () => {
  const calls = [];
  const taskPost = async (pathname, body) => {
    calls.push({ pathname, body });
    return pathname === TASK_ADD_PATH ? { ok: true, taskId: "T-2" } : pathname === TASK_BLOCK_PATH ? { ok: true, state: "blocked" } : { ok: true, state: "done", results: [] };
  };
  // The launch environment holds no thread identity, as on a real Codex stdio server.
  const server = buildCodexServer({ environment: {}, taskPost, query: async () => ({}) });
  const tools = server._registeredTools;
  assert.match(server.server._instructions, /complete_task/u);
  assert.match(server.server._instructions, /block_task/u);
  for (const name of ["add_task", "complete_task", "block_task"]) {
    assert.equal(parse(tools[name], { text: "x", reason: "r", session_ref: "codex:other" }).success, false, name);
  }
  assert.equal((await tools.add_task.handler({ text: "x" }, codexMeta())).content[0].text, "Task T-2 added to the board, not queued.");
  assert.equal((await tools.complete_task.handler({}, codexMeta())).content[0].text, "Task reported complete. Pomegr marked it done.");
  assert.equal((await tools.block_task.handler({ reason: "stuck" }, codexMeta())).content[0].text, "Task reported as blocked. The user will resolve it.");
  assert.deepEqual(calls.map((call) => [call.pathname, call.body.sessionRef]), [
    [TASK_ADD_PATH, `codex:${THREAD}`], [TASK_COMPLETE_PATH, `codex:${THREAD}`], [TASK_BLOCK_PATH, `codex:${THREAD}`],
  ]);
  assert.deepEqual(calls[1].body, { sessionRef: `codex:${THREAD}` });
  assert.deepEqual(calls[2].body, { sessionRef: `codex:${THREAD}`, reason: "stuck" });
  // The metadata wins over a launch identity, and a call with neither is refused before any post.
  const withEnvironment = buildCodexServer({ environment: { CODEX_THREAD_ID: "thread-7" }, taskPost, query: async () => ({}) });
  await withEnvironment._registeredTools.complete_task.handler({}, codexMeta());
  assert.equal(calls[3].body.sessionRef, `codex:${THREAD}`);
  for (const extra of [undefined, {}, codexMeta({ threadId: "../x" }), codexMeta({ "x-codex-turn-metadata": { thread_id: "other" } })]) {
    assert.equal((await tools.complete_task.handler({}, extra)).content[0].text, TASK_REPORT_UNBOUND_TEXT);
    assert.equal((await tools.block_task.handler({ reason: "stuck" }, extra)).isError, true);
  }
  assert.equal(calls.length, 4);
});

test("complete_task takes only an optional attention line and block_task one bounded line", () => {
  const { tools } = setup();
  for (const name of ["complete_task", "block_task"]) {
    assert.deepEqual(tools[name].config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    assert.equal(tools[name].config._meta, undefined);
  }
  assert.equal(parse(tools.complete_task, {}).success, true);
  assert.equal(parse(tools.complete_task, { attention: "The retry limit is a guess; confirm it" }).success, true);
  assert.equal(parse(tools.complete_task, { attention: "x".repeat(200) }).success, true);
  for (const attention of ["", "   ", "x".repeat(201), "two\nlines", "tab\there", 7, null]) {
    assert.equal(parse(tools.complete_task, { attention }).success, false, JSON.stringify(attention));
  }
  for (const extra of [{ id: "T-1" }, { task: "T-1" }, { repositoryId: "r" }, { reason: "x" }, { session_ref: "claude:a" }, { sessionRef: "claude:a" }]) {
    assert.equal(parse(tools.complete_task, extra).success, false, JSON.stringify(extra));
  }
  assert.equal(parse(tools.block_task, { reason: "The schema needs a decision" }).success, true);
  assert.equal(parse(tools.block_task, { reason: "x".repeat(200) }).success, true);
  for (const input of [{}, { reason: "" }, { reason: "   " }, { reason: "x".repeat(201) }, { reason: "two\nlines" }, { reason: "tab\there" }, { reason: 7 },
    { reason: "x", id: "T-1" }, { reason: "x", session_ref: "claude:a" }]) {
    assert.equal(parse(tools.block_task, input).success, false, JSON.stringify(input));
  }
  const hook = setup({ hookBound: true }).tools;
  assert.equal(parse(hook.complete_task, { session_ref: "claude:a" }).success, true);
  assert.equal(parse(hook.complete_task, { attention: "x", session_ref: "claude:a" }).success, true);
  assert.equal(parse(hook.block_task, { reason: "x", session_ref: "claude:a" }).success, true);
});

test("complete_task reports the state and names only the conditions Pomegr could not confirm", async () => {
  const done = setup({ answer: { ok: true, state: "done", results: [{ check: "tree_clean", passed: true }] } });
  const out = await done.tools.complete_task.handler({});
  assert.equal(out.isError, undefined);
  assert.equal(out.content[0].text, "Task reported complete. Pomegr marked it done.");
  assert.deepEqual(done.calls, [{ pathname: TASK_COMPLETE_PATH, body: { sessionRef: "claude:x" } }]);

  const review = setup({ answer: { ok: true, state: "needs_review", results: [
    { check: "pr_open", passed: false }, { check: "tree_clean", passed: true }, { check: "ci_passed", passed: false }, { check: "made_up", passed: false },
  ] } });
  assert.equal((await review.tools.complete_task.handler({})).content[0].text,
    "Task reported complete, but Pomegr could not confirm: Pull request open, CI passed. The task now needs the user's review; do not report again.");

  // The attention line is the only thing the tool adds to the body, and Review is then what the agent asked for.
  const noted = setup({ answer: { ok: true, state: "needs_review", results: [{ check: "pr_open", passed: true }] } });
  assert.equal((await noted.tools.complete_task.handler({ attention: "Confirm the retry limit" })).content[0].text,
    "Task reported complete. Pomegr put it in Review for the user's attention; do not report again.");
  assert.deepEqual(noted.calls, [{ pathname: TASK_COMPLETE_PATH, body: { sessionRef: "claude:x", attention: "Confirm the retry limit" } }]);
  const both = setup({ answer: { ok: true, state: "needs_review", results: [{ check: "pr_open", passed: false }] } });
  assert.match((await both.tools.complete_task.handler({ attention: "Confirm the retry limit" })).content[0].text, /could not confirm: Pull request open/u);
});

test("the report tools map every refusal to fixed text and never echo the monitor's answer", async () => {
  const texts = {
    invalid: "Pomegr rejected the report as invalid, so nothing was reported.",
    not_found: "No Pomegr task is linked to this session, so nothing was reported.",
    already_reported: "This session already reported on its task, so nothing changed.",
    unavailable: "Pomegr is unavailable, so nothing was reported.",
  };
  for (const [reason, text] of Object.entries(texts)) {
    const { tools } = setup({ answer: { ok: false, reason, detail: SENTINEL } });
    for (const [name, input] of [["complete_task", {}], ["block_task", { reason: "stuck" }]]) {
      const out = await tools[name].handler(input);
      assert.equal(out.isError, true);
      assert.equal(out.content[0].text, text);
    }
  }
  for (const answer of [new Error(SENTINEL), null, { ok: false, reason: SENTINEL }, { ok: true }, { ok: true, state: SENTINEL }, { ok: true, state: "blocked" }]) {
    const out = await setup({ answer }).tools.complete_task.handler({});
    assert.equal(out.content[0].text, texts.unavailable);
    assert.doesNotMatch(JSON.stringify(out), new RegExp(SENTINEL, "u"));
  }
  assert.equal((await setup({ answer: { ok: true, state: "done" } }).tools.block_task.handler({ reason: "stuck" })).content[0].text, texts.unavailable);
  const unbound = setup({ ref: null });
  assert.equal((await unbound.tools.complete_task.handler({})).content[0].text, TASK_REPORT_UNBOUND_TEXT);
  assert.equal((await unbound.tools.block_task.handler({ reason: "stuck" })).content[0].text, TASK_REPORT_UNBOUND_TEXT);
  assert.equal(unbound.calls.length, 0);
});

const TOKEN = "claude-capability-token-".padEnd(43, "k");
const NOW = 1_800_000_000_000;
const REF = `claude:${SESSION_ID}`;
const OTHER_REF = "claude:44444444-4444-4444-8444-444444444444";

function claudeServer({ token = TOKEN, answer } = {}) {
  const calls = [];
  const taskPost = async (pathname, body) => {
    calls.push({ pathname, body });
    return answer ?? (pathname === TASK_BLOCK_PATH ? { ok: true, state: "blocked" }
      : pathname === TASK_COMPLETE_PATH ? { ok: true, state: "done", results: [] } : { ok: true, taskId: "T-3" });
  };
  const readBindingToken = typeof token === "function" ? token : async () => token;
  const server = buildClaudeServer({
    environment: { CLAUDE_CODE_SESSION_ID: SESSION_ID }, taskPost, query: async () => ({}), readBindingToken, now: () => NOW,
  });
  return { tools: server._registeredTools, calls };
}

const proofFor = (tool, overrides = {}) => createTaskBindingProof({ token: TOKEN, tool, sessionRef: REF, now: NOW, ...overrides });
const CLAUDE_CALLS = {
  add_task: { input: { text: "x" }, unbound: TASK_UNBOUND_TEXT, ok: "Task T-3 added to the board, not queued." },
  complete_task: { input: {}, unbound: TASK_REPORT_UNBOUND_TEXT, ok: "Task reported complete. Pomegr marked it done." },
  block_task: { input: { reason: "stuck" }, unbound: TASK_REPORT_UNBOUND_TEXT, ok: "Task reported as blocked. The user will resolve it." },
};

test("Claude server refuses every task tool unless session_ref carries the hook's proof", async () => {
  for (const [name, { input, unbound }] of Object.entries(CLAUDE_CALLS)) {
    const { tools, calls } = claudeServer();
    assert.equal(tools[name]._meta, undefined);
    const bad = [
      {},
      { session_ref: REF },
      { session_ref: REF, session_proof: "not-a-proof" },
      { session_ref: REF, session_proof: `${NOW}.${"A".repeat(43)}` },
      { session_ref: REF, session_proof: proofFor(name, { sessionRef: OTHER_REF }) },
      { session_ref: REF, session_proof: proofFor(name === "add_task" ? "block_task" : "add_task") },
      { session_ref: REF, session_proof: proofFor(name, { now: NOW - TASK_BINDING_PROOF_WINDOW_MS - 1_000 }) },
      { session_ref: REF, session_proof: proofFor(name, { now: NOW + TASK_BINDING_PROOF_FUTURE_SKEW_MS + 1_000 }) },
      { session_ref: REF, session_proof: proofFor(name, { token: "another-capability-token-".padEnd(43, "z") }) },
      { session_ref: "claude:explicit", session_proof: proofFor(name, { sessionRef: "claude:explicit" }) },
      { session_ref: `codex:${SESSION_ID}`, session_proof: proofFor(name, { sessionRef: `codex:${SESSION_ID}` }) },
      { session_proof: proofFor(name) },
    ];
    for (const extra of bad) {
      const out = await tools[name].handler({ ...input, ...extra }, codexMeta());
      assert.equal(out.isError, true, `${name} ${JSON.stringify(extra)}`);
      assert.equal(out.content[0].text, unbound);
    }
    assert.equal(calls.length, 0, name);
  }
});

test("Claude server refuses a signed call when it can read no capability token", async () => {
  for (const token of [null, "", async () => undefined, async () => { throw new Error(SENTINEL); }]) {
    for (const [name, { input, unbound }] of Object.entries(CLAUDE_CALLS)) {
      const { tools, calls } = claudeServer({ token });
      const out = await tools[name].handler({ ...input, session_ref: REF, session_proof: proofFor(name) });
      assert.equal(out.content[0].text, unbound);
      assert.doesNotMatch(JSON.stringify(out), new RegExp(SENTINEL, "u"));
      assert.equal(calls.length, 0);
    }
  }
});

test("Claude server posts once for a hook-made proof and sends neither session_ref nor session_proof", async () => {
  for (const [name, { input, ok }] of Object.entries(CLAUDE_CALLS)) {
    const { tools, calls } = claudeServer();
    const out = await tools[name].handler({ ...input, session_ref: REF, session_proof: proofFor(name, { now: NOW - TASK_BINDING_PROOF_WINDOW_MS + 1_000 }) });
    assert.equal(out.isError, undefined, name);
    assert.equal(out.content[0].text, ok);
    assert.equal(calls.length, 1, name);
    assert.equal(calls[0].body.sessionRef, REF);
    assert.doesNotMatch(JSON.stringify(calls[0].body), /session_ref|session_proof|[0-9]{13}\./u);
  }
  assert.deepEqual(buildAddTaskBody(REF, { text: "t", session_ref: OTHER_REF, session_proof: "p" }), { sessionRef: REF, text: "t" });
});

test("Claude hook binds add_task from the host transcript, signs it, and never honors a model selector", async () => {
  const transcripts = [
    path.resolve("private", `${SESSION_ID}.jsonl`),
    path.resolve("private", SESSION_ID, "subagents", "agent-child.jsonl"),
  ];
  const options = { readToken: async () => TOKEN, now: () => NOW };
  for (const prefix of ["mcp__pomegr__", "mcp__plugin_pomegr_pomegr__"]) {
    for (const transcript_path of transcripts) {
      const payload = { hook_event_name: "PreToolUse", tool_name: `${prefix}add_task`,
        tool_input: { text: "t", feature: "F" }, transcript_path };
      const out = (await bindClaudeQueryWrite(payload, options)).hookSpecificOutput;
      assert.equal(out.permissionDecision, undefined);
      assert.deepEqual(out.updatedInput, { text: "t", feature: "F", session_ref: REF, session_proof: proofFor("add_task") });
      assert.equal(verifyTaskBindingProof({ token: TOKEN, tool: "add_task", sessionRef: REF, proof: out.updatedInput.session_proof, now: NOW }), true);
      assert.doesNotMatch(JSON.stringify(out), new RegExp(TOKEN, "u"));
      for (const bad of [
        { ...payload, tool_input: { text: "t", session_ref: "claude:other" } },
        { ...payload, tool_input: { text: "t", session_proof: proofFor("add_task") } },
        { ...payload, tool_input: { text: "t", repository: "r" } },
        { ...payload, tool_input: [] },
        { ...payload, tool_input: undefined },
        { ...payload, transcript_path: "private-path-sentinel" },
      ]) {
        const denied = (await bindClaudeQueryWrite(bad, options)).hookSpecificOutput;
        assert.equal(denied.permissionDecision, "deny");
        assert.equal(denied.updatedInput, undefined);
        assert.doesNotMatch(JSON.stringify(denied), /private-path-sentinel|claude:other|"repository"/u);
        assert.doesNotMatch(JSON.stringify(denied), new RegExp(TOKEN, "u"));
      }
    }
  }
  assert.equal(await bindClaudeQueryWrite({ hook_event_name: "PostToolUse", tool_name: "mcp__pomegr__add_task", tool_input: {} }, options), null);
  assert.equal(await bindClaudeQueryWrite({ hook_event_name: "PreToolUse", tool_name: "mcp__pomegr__add_task_lookalike", tool_input: {}, transcript_path: transcripts[0] }, options), null);
  // Read tools keep their behavior: an explicit selector still passes through to the host.
  const read = { hook_event_name: "PreToolUse", tool_name: "mcp__pomegr__get_session_report", tool_input: { session_ref: "claude:x" }, transcript_path: transcripts[0] };
  assert.equal(bindClaudeQuerySession(read, options), null);
  assert.equal(await bindClaudeQueryWrite(read, options), null);
  // The read binder never binds a write tool: it has no signed path, so it answers nothing rather than an unsigned value.
  assert.equal(bindClaudeQuerySession({ hook_event_name: "PreToolUse", tool_name: "mcp__pomegr__add_task", tool_input: { text: "t" }, transcript_path: transcripts[0] }, options), null);
});

test("Claude hook binds complete_task and block_task, signed per tool, and denies anything else", async () => {
  const transcript_path = path.resolve("private", `${SESSION_ID}.jsonl`);
  const options = { readToken: async () => TOKEN, now: () => NOW };
  for (const prefix of ["mcp__pomegr__", "mcp__plugin_pomegr_pomegr__"]) {
    const complete = { hook_event_name: "PreToolUse", tool_name: `${prefix}complete_task`, tool_input: {}, transcript_path };
    const block = { hook_event_name: "PreToolUse", tool_name: `${prefix}block_task`, tool_input: { reason: "stuck" }, transcript_path };
    assert.deepEqual((await bindClaudeQueryWrite(complete, options)).hookSpecificOutput,
      { hookEventName: "PreToolUse", updatedInput: { session_ref: REF, session_proof: proofFor("complete_task") } });
    assert.deepEqual((await bindClaudeQueryWrite(block, options)).hookSpecificOutput.updatedInput,
      { reason: "stuck", session_ref: REF, session_proof: proofFor("block_task") });
    assert.deepEqual((await bindClaudeQueryWrite({ ...complete, tool_input: { attention: "look" } }, options)).hookSpecificOutput.updatedInput,
      { attention: "look", session_ref: REF, session_proof: proofFor("complete_task") });
    for (const bad of [
      { ...complete, tool_input: { session_ref: "claude:other" } },
      { ...complete, tool_input: { session_proof: proofFor("complete_task") } },
      { ...complete, tool_input: { reason: "x" } },
      { ...block, tool_input: { reason: "x", id: "T-1" } },
      { ...block, transcript_path: "private-path-sentinel" },
    ]) {
      const denied = (await bindClaudeQueryWrite(bad, options)).hookSpecificOutput;
      assert.equal(denied.permissionDecision, "deny");
      assert.equal(denied.updatedInput, undefined);
      assert.match(denied.permissionDecisionReason, /nothing was reported/u);
      assert.doesNotMatch(JSON.stringify(denied), /private-path-sentinel|claude:other/u);
    }
  }
});

test("Claude hook denies a write it cannot sign and never leaks the token", async () => {
  const transcript_path = path.resolve("private", `${SESSION_ID}.jsonl`);
  for (const readToken of [async () => null, async () => undefined, async () => "", async () => { throw new Error(TOKEN); }]) {
    for (const [name, { input }] of Object.entries(CLAUDE_CALLS)) {
      const denied = (await bindClaudeQueryWrite(
        { hook_event_name: "PreToolUse", tool_name: `mcp__pomegr__${name}`, tool_input: input, transcript_path }, { readToken, now: () => NOW },
      )).hookSpecificOutput;
      assert.equal(denied.permissionDecision, "deny");
      assert.equal(denied.updatedInput, undefined);
      assert.doesNotMatch(JSON.stringify(denied), new RegExp(TOKEN, "u"));
    }
  }
});

test("the hook writes the signed binding and nothing else to stdout, from the real descriptor reader", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "pomegr-binding-"));
  try {
    await writeFile(path.join(dataRoot, "agent-query-runtime.json"), JSON.stringify({ version: 1, origin: "http://127.0.0.1:4317", token: TOKEN }));
    const run = async (root) => {
      let written = "";
      const stream = Readable.from([JSON.stringify({
        hook_event_name: "PreToolUse", tool_name: "mcp__pomegr__complete_task", tool_input: {}, transcript_path: path.resolve("private", `${SESSION_ID}.jsonl`),
      })]);
      await runClaudeQuerySessionHook(stream, { write: (text) => { written += text; } }, {
        readToken: async () => (await readAgentQueryDescriptor({ dataRoot: root }))?.token ?? null, now: () => NOW,
      });
      return written;
    };
    const written = await run(dataRoot);
    const out = JSON.parse(written).hookSpecificOutput;
    assert.deepEqual(Object.keys(out.updatedInput).sort(), ["session_proof", "session_ref"]);
    assert.equal(verifyTaskBindingProof({ token: TOKEN, tool: "complete_task", sessionRef: REF, proof: out.updatedInput.session_proof, now: NOW }), true);
    assert.doesNotMatch(written, new RegExp(TOKEN, "u"));
    assert.equal(JSON.parse(await run(path.join(dataRoot, "missing"))).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("the binding proof is bound to token, tool, session, and a window that outlasts a slow approval, and never throws", () => {
  const proof = createTaskBindingProof({ token: TOKEN, tool: "add_task", sessionRef: REF, now: NOW });
  assert.match(proof, /^\d{13}\.[A-Za-z0-9_-]{43}$/u);
  assert.equal(proof.startsWith(`${NOW}.`), true);
  const check = (overrides) => verifyTaskBindingProof({ token: TOKEN, tool: "add_task", sessionRef: REF, proof, now: NOW, ...overrides });
  assert.equal(check({}), true);
  assert.equal(TASK_BINDING_PROOF_WINDOW_MS, 10 * 60_000);
  assert.equal(check({ now: NOW + 9 * 60_000 }), true, "a permission prompt left open for nine minutes");
  assert.equal(check({ now: NOW + TASK_BINDING_PROOF_WINDOW_MS }), true);
  assert.equal(check({ now: NOW + TASK_BINDING_PROOF_WINDOW_MS + 1 }), false);
  assert.equal(check({ now: NOW - TASK_BINDING_PROOF_FUTURE_SKEW_MS }), true);
  assert.equal(check({ now: NOW - TASK_BINDING_PROOF_FUTURE_SKEW_MS - 1 }), false);
  for (const overrides of [{ token: "other" + TOKEN }, { tool: "block_task" }, { sessionRef: OTHER_REF }, { proof: proof.slice(0, -1) }, { proof: proof + "A" },
    { proof: `${NOW + 1}.${proof.split(".")[1]}` }, { proof: proof.replace(".", ":") }, { proof: `${proof.split(".")[1]}.${NOW}` }, { proof: "" }, { proof: "x".repeat(10_000) },
    { proof: null }, { proof: 7 }, { proof: {} }, { token: null }, { token: "" }, { token: 7 }, { tool: "../x" }, { tool: null }, { sessionRef: "claude:a\nb" }, { sessionRef: null },
    { now: Number.NaN }, { now: "x" }]) {
    assert.equal(check(overrides), false, JSON.stringify(overrides));
  }
  assert.equal(verifyTaskBindingProof(), false);
  assert.equal(verifyTaskBindingProof(null), false);
  assert.equal(verifyTaskBindingProof({ get token() { throw new Error("boom"); } }), false);
  for (const bad of [{ token: "" }, { tool: "Add" }, { sessionRef: "a\nb" }, { now: 1.5 }, { now: 0 }]) {
    assert.equal(createTaskBindingProof({ token: TOKEN, tool: "add_task", sessionRef: REF, now: NOW, ...bad }), null, JSON.stringify(bad));
  }
  assert.equal(createTaskBindingProof(), null);
  assert.notEqual(proof, createTaskBindingProof({ token: TOKEN, tool: "add_task", sessionRef: REF, now: NOW + 1 }));
  assert.doesNotMatch(proof, new RegExp(TOKEN, "u"));
});

test("the proof comparison is constant-time over equal-length buffers", () => {
  const source = readFileSync(new URL("../plugin-src/task-binding-proof.mjs", import.meta.url), "utf8");
  assert.match(source, /timingSafeEqual\(given, expected\)/u);
  assert.match(source, /given\.length === expected\.length/u);
  assert.doesNotMatch(source, /(?:given|expected)\s*===\s*(?:given|expected)/u);
});
