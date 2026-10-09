import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildPomegrMcpServer as buildCodexServer } from "../mcp/server.mjs";
import { buildPomegrMcpServer as buildClaudeServer } from "../plugins/claude-code/mcp/server.mjs";
import { registerTaskTools, TASK_ADD_PATH, TASK_UNBOUND_TEXT, TASK_UNAVAILABLE_TEXT } from "../mcp/task-tools.mjs";
import {
  AGENT_QUERY_AUTH_HEADER,
  AGENT_TASK_ADD_PATH,
  AGENT_TASK_BIND_PATH,
  AGENT_TASK_WRITE_PATHS,
  createAgentTaskWriter,
} from "../shared/agent-query-transport.mjs";
import { bindClaudeQuerySession } from "../plugin-src/claude-query-session.mjs";

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
  return { tool: server.tools.add_task, calls };
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

  // The bind path is the second and last write path; nothing else is reachable.
  assert.deepEqual([...AGENT_TASK_WRITE_PATHS], [AGENT_TASK_ADD_PATH, AGENT_TASK_BIND_PATH]);
  const bind = createAgentTaskWriter({ ...base, fetchFn: respond(200, { schemaVersion: 1, ok: true }) });
  assert.deepEqual(await bind(AGENT_TASK_BIND_PATH, { token: "x".repeat(16), sessionRef: "claude:a" }), { schemaVersion: 1, ok: true });
  assert.equal(requests[1].url, "http://127.0.0.1:4317/api/agent/v1/tasks/bind");
  assert.equal(requests[1].init.method, "POST");
  assert.equal(requests[1].init.headers[AGENT_QUERY_AUTH_HEADER], "t".repeat(43));
  assert.equal(requests[1].init.body, JSON.stringify({ token: "x".repeat(16), sessionRef: "claude:a" }));
  for (const bad of [
    "/api/agent/v1/tasks/complete", "/api/agent/v1/tasks/block", "/api/agent/v1/sessions", "/api/agent/v1/tasks/add/../x",
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

test("Codex server binds add_task to CODEX_THREAD_ID and refuses without it", async () => {
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

test("Claude server posts only with a hook-shaped session_ref", async () => {
  const calls = [];
  const taskPost = async (pathname, body) => { calls.push(body); return { ok: true, taskId: "T-3" }; };
  const server = buildClaudeServer({ environment: { CLAUDE_CODE_SESSION_ID: SESSION_ID }, taskPost, query: async () => ({}) });
  const tool = server._registeredTools.add_task;
  assert.equal(tool._meta, undefined);
  for (const input of [{ text: "x" }, { text: "x", session_ref: "claude:explicit" }, { text: "x", session_ref: `codex:${SESSION_ID}` }]) {
    assert.equal((await tool.handler(input)).content[0].text, TASK_UNBOUND_TEXT);
  }
  assert.equal(calls.length, 0);
  const out = await tool.handler({ text: "x", session_ref: `claude:${SESSION_ID}` });
  assert.equal(out.content[0].text, "Task T-3 added to the board, not queued.");
  assert.equal(calls[0].sessionRef, `claude:${SESSION_ID}`);
});

test("Claude hook binds add_task from the host transcript and never honors a model selector", () => {
  const transcripts = [
    path.resolve("private", `${SESSION_ID}.jsonl`),
    path.resolve("private", SESSION_ID, "subagents", "agent-child.jsonl"),
  ];
  for (const prefix of ["mcp__pomegr__", "mcp__plugin_pomegr_pomegr__"]) {
    for (const transcript_path of transcripts) {
      const payload = { hook_event_name: "PreToolUse", tool_name: `${prefix}add_task`,
        tool_input: { text: "t", feature: "F" }, transcript_path };
      const out = bindClaudeQuerySession(payload).hookSpecificOutput;
      assert.equal(out.permissionDecision, undefined);
      assert.deepEqual(out.updatedInput, { text: "t", feature: "F", session_ref: `claude:${SESSION_ID}` });
      for (const bad of [
        { ...payload, tool_input: { text: "t", session_ref: "claude:other" } },
        { ...payload, tool_input: { text: "t", repository: "r" } },
        { ...payload, tool_input: [] },
        { ...payload, tool_input: undefined },
        { ...payload, transcript_path: "private-path-sentinel" },
      ]) {
        const denied = bindClaudeQuerySession(bad).hookSpecificOutput;
        assert.equal(denied.permissionDecision, "deny");
        assert.equal(denied.updatedInput, undefined);
        assert.doesNotMatch(JSON.stringify(denied), /private-path-sentinel|claude:other|"repository"/u);
      }
    }
  }
  assert.equal(bindClaudeQuerySession({ hook_event_name: "PostToolUse", tool_name: "mcp__pomegr__add_task", tool_input: {} }), null);
  assert.equal(bindClaudeQuerySession({ hook_event_name: "PreToolUse", tool_name: "mcp__pomegr__add_task_lookalike", tool_input: {}, transcript_path: transcripts[0] }), null);
  // Read tools keep their behavior: an explicit selector still passes through to the host.
  const read = { hook_event_name: "PreToolUse", tool_name: "mcp__pomegr__get_session_report", tool_input: { session_ref: "claude:x" }, transcript_path: transcripts[0] };
  assert.equal(bindClaudeQuerySession(read), null);
});
