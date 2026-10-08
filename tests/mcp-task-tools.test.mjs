import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildPomegrMcpServer as buildCodexServer } from "../mcp/server.mjs";
import { buildPomegrMcpServer as buildClaudeServer } from "../plugins/claude-code/mcp/server.mjs";
import {
  registerTaskTools, resolveCodexCallSession, TASK_ADD_PATH, TASK_BLOCK_PATH, TASK_COMPLETE_PATH, TASK_REPORT_UNBOUND_TEXT, TASK_UNBOUND_TEXT,
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

test("complete_task takes no input and block_task one bounded line", () => {
  const { tools } = setup();
  for (const name of ["complete_task", "block_task"]) {
    assert.deepEqual(tools[name].config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    assert.equal(tools[name].config._meta, undefined);
  }
  assert.equal(parse(tools.complete_task, {}).success, true);
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
    "Task reported complete, but Pomegr could not confirm: Pull request open, CI passed (not available yet). The task now needs the user's review; do not report again.");
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

test("Claude server posts a report only with a hook-shaped session_ref", async () => {
  const calls = [];
  const taskPost = async (pathname, body) => { calls.push({ pathname, body }); return pathname === TASK_BLOCK_PATH ? { ok: true, state: "blocked" } : { ok: true, state: "done", results: [] }; };
  const server = buildClaudeServer({ environment: { CLAUDE_CODE_SESSION_ID: SESSION_ID }, taskPost, query: async () => ({}) });
  const { complete_task: complete, block_task: block } = server._registeredTools;
  for (const input of [{}, { session_ref: "claude:explicit" }, { session_ref: `codex:${SESSION_ID}` }]) {
    assert.equal((await complete.handler(input, codexMeta())).content[0].text, TASK_REPORT_UNBOUND_TEXT);
    assert.equal((await block.handler({ reason: "stuck", ...input }, codexMeta())).content[0].text, TASK_REPORT_UNBOUND_TEXT);
  }
  assert.equal(calls.length, 0);
  await complete.handler({ session_ref: `claude:${SESSION_ID}` });
  await block.handler({ reason: "stuck", session_ref: `claude:${SESSION_ID}` });
  assert.deepEqual(calls, [
    { pathname: TASK_COMPLETE_PATH, body: { sessionRef: `claude:${SESSION_ID}` } },
    { pathname: TASK_BLOCK_PATH, body: { sessionRef: `claude:${SESSION_ID}`, reason: "stuck" } },
  ]);
});

test("Claude hook binds complete_task and block_task from the host transcript and denies anything else", () => {
  const transcript_path = path.resolve("private", `${SESSION_ID}.jsonl`);
  for (const prefix of ["mcp__pomegr__", "mcp__plugin_pomegr_pomegr__"]) {
    const complete = { hook_event_name: "PreToolUse", tool_name: `${prefix}complete_task`, tool_input: {}, transcript_path };
    const block = { hook_event_name: "PreToolUse", tool_name: `${prefix}block_task`, tool_input: { reason: "stuck" }, transcript_path };
    assert.deepEqual(bindClaudeQuerySession(complete).hookSpecificOutput, { hookEventName: "PreToolUse", updatedInput: { session_ref: `claude:${SESSION_ID}` } });
    assert.deepEqual(bindClaudeQuerySession(block).hookSpecificOutput.updatedInput, { reason: "stuck", session_ref: `claude:${SESSION_ID}` });
    for (const bad of [
      { ...complete, tool_input: { session_ref: "claude:other" } },
      { ...complete, tool_input: { reason: "x" } },
      { ...block, tool_input: { reason: "x", id: "T-1" } },
      { ...block, transcript_path: "private-path-sentinel" },
    ]) {
      const denied = bindClaudeQuerySession(bad).hookSpecificOutput;
      assert.equal(denied.permissionDecision, "deny");
      assert.equal(denied.updatedInput, undefined);
      assert.match(denied.permissionDecisionReason, /nothing was reported/u);
      assert.doesNotMatch(JSON.stringify(denied), /private-path-sentinel|claude:other/u);
    }
  }
});
