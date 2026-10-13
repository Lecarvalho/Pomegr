import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  registerTaskTools, TASK_ASSIGN_NO_ANSWER_TEXT, TASK_ASSIGN_PATH, TASK_ASSIGN_UNBOUND_TEXT, TASK_TOOL_INSTRUCTIONS,
  TASK_UNASSIGN_NO_ANSWER_TEXT, TASK_UNASSIGN_PATH, TASK_UNASSIGN_UNBOUND_TEXT,
} from "../mcp/task-tools.mjs";
import { bindClaudeQueryWrite } from "../plugin-src/claude-query-session.mjs";
import { createTaskBindingProof } from "../plugin-src/task-binding-proof.mjs";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const SENTINEL = "TASK_TEXT_SENTINEL_9f3";
const TOKEN = "claude-capability-token-".padEnd(43, "k");
const NOW = 1_800_000_000_000;
const REF = `claude:${SESSION_ID}`;

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
  return { tools: server.tools, calls };
}

function parse(tool, input) {
  return tool.config.inputSchema.safeParse(input);
}

const proofFor = (tool) => createTaskBindingProof({ token: TOKEN, tool, sessionRef: REF, now: NOW });

test("assign_task and unassign_task take one task ID, are not destructive, and have no repository, path, or text input", () => {
  const { tools } = setup();
  for (const name of ["assign_task", "unassign_task"]) {
    const tool = tools[name];
    assert.deepEqual(tool.config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(parse(tool, { task_id: "T-12" }).success, true);
    for (const input of [{}, { task_id: "12" }, { task_id: "T-0" }, { task_id: "T-01" }, { task_id: " T-1" }, { task_id: "T-1234567890" }, { task_id: 1 },
      { task_id: "T-1", repository_id: "repo-0123456789abcdef01234567" }, { task_id: "T-1", path: "C:\\x" }, { task_id: "T-1", text: "x" }, { task_id: "T-1", session_ref: "claude:x" }]) {
      assert.equal(parse(tool, input).success, false, `${name} ${JSON.stringify(input)}`);
    }
    assert.equal(parse(setup({ hookBound: true }).tools[name], { task_id: "T-1", session_ref: "claude:x", session_proof: "p" }).success, true);
  }
  assert.match(tools.assign_task.config.description, /complete_task or block_task/u);
  assert.match(tools.assign_task.config.description, /first report on a task wins/u);
  assert.doesNotMatch(`${tools.assign_task.config.description}${tools.unassign_task.config.description}`, /attach/iu);
});

test("assign_task and unassign_task post the bound session and the task ID, and map every answer to fixed text", async () => {
  const cases = {
    assign_task: {
      path: TASK_ASSIGN_PATH, unbound: TASK_ASSIGN_UNBOUND_TEXT, ok: "Task T-4 assigned to this session. Report it with complete_task or block_task, naming task_id if this session has more than one task.",
      texts: {
        invalid: "Pomegr rejected the request as invalid, so no task was assigned.",
        session_not_found: "Pomegr does not know the current session yet, so no task was assigned.",
        repository_unavailable: "Pomegr could not resolve the current session's repository, so no task was assigned.",
        not_found: "No task was assigned. A session can be assigned only to a task on its own repository's board.",
        conflict: "No task was assigned. A task that is done cannot be assigned, and this session already reports the task Pomegr started it for.",
        limit: "No task was assigned. A task holds at most 16 assigned sessions, and a session can be assigned to at most 16 tasks.",
        unavailable: "Pomegr is unavailable, so no task was assigned.",
      },
    },
    unassign_task: {
      path: TASK_UNASSIGN_PATH, unbound: TASK_UNASSIGN_UNBOUND_TEXT, ok: "Task T-4 unassigned from this session.",
      texts: {
        invalid: "Pomegr rejected the request as invalid, so no task was unassigned.",
        session_not_found: "Pomegr does not know the current session yet, so no task was unassigned.",
        repository_unavailable: "Pomegr could not resolve the current session's repository, so no task was unassigned.",
        not_found: "No task was unassigned. This session can unassign only a task it is assigned to.",
        unavailable: "Pomegr is unavailable, so no task was unassigned.",
      },
    },
  };
  for (const [name, { path: pathname, unbound, ok, texts }] of Object.entries(cases)) {
    const done = setup({ ref: "claude:x", answer: { ok: true, text: SENTINEL } });
    const out = await done.tools[name].handler({ task_id: "T-4" });
    assert.equal(out.isError, undefined);
    assert.equal(out.content[0].text, ok);
    assert.deepEqual(done.calls, [{ pathname, body: { sessionRef: "claude:x", taskId: "T-4" } }]);
    for (const [code, text] of Object.entries(texts)) {
      const refused = await setup({ answer: { ok: false, reason: code, detail: SENTINEL } }).tools[name].handler({ task_id: "T-4" });
      assert.equal(refused.isError, true);
      assert.equal(refused.content[0].text, text, `${name} ${code}`);
      assert.doesNotMatch(JSON.stringify(refused), new RegExp(SENTINEL, "u"));
    }
    for (const answer of [{ ok: false, reason: SENTINEL }, { ok: false }, null, SENTINEL, { ok: "true" }, new Error(SENTINEL)]) {
      const failed = await setup({ answer }).tools[name].handler({ task_id: "T-4" });
      assert.equal(failed.isError, true);
      assert.equal(failed.content[0].text, texts.unavailable);
    }
    for (const ref of [null, "", 7]) {
      const refused = setup({ ref });
      const out2 = await refused.tools[name].handler({ task_id: "T-4" });
      assert.equal(out2.isError, true);
      assert.equal(out2.content[0].text, unbound);
      assert.equal(refused.calls.length, 0);
    }
  }
  // Only assign_task knows the conflict and limit reasons.
  const stray = await setup({ answer: { ok: false, reason: "conflict" } }).tools.unassign_task.handler({ task_id: "T-4" });
  assert.equal(stray.content[0].text, cases.unassign_task.texts.unavailable);
});

test("complete_task, block_task, and get_feature pass an optional task_id as taskId and map task_required", async () => {
  const done = setup({ answer: { ok: true, state: "done", results: [] } });
  await done.tools.complete_task.handler({ task_id: "T-5", attention: "Check" });
  await done.tools.complete_task.handler({});
  assert.deepEqual(done.calls.map((call) => call.body), [{ sessionRef: "claude:x", taskId: "T-5", attention: "Check" }, { sessionRef: "claude:x" }]);
  const blocked = setup({ answer: { ok: true, state: "blocked" } });
  await blocked.tools.block_task.handler({ task_id: "T-5", reason: "stuck" });
  await blocked.tools.block_task.handler({ reason: "stuck" });
  assert.deepEqual(blocked.calls.map((call) => call.body), [{ sessionRef: "claude:x", taskId: "T-5", reason: "stuck" }, { sessionRef: "claude:x", reason: "stuck" }]);
  const feature = setup({ answer: { ok: false, reason: "invalid" } });
  await feature.tools.get_feature.handler({ task_id: "T-5" });
  await feature.tools.get_feature.handler({ feature: "Offline mode" });
  await feature.tools.get_feature.handler({});
  assert.deepEqual(feature.calls.map((call) => call.body), [{ sessionRef: "claude:x", taskId: "T-5" }, { sessionRef: "claude:x", feature: "Offline mode" }, { sessionRef: "claude:x" }]);
  for (const [name, input] of [["complete_task", {}], ["block_task", { reason: "stuck" }]]) {
    const out = await setup({ answer: { ok: false, reason: "task_required" } }).tools[name].handler(input);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /more than one task.*Call the tool again with task_id/u);
  }
  const needed = await setup({ answer: { ok: false, reason: "task_required" } }).tools.get_feature.handler({});
  assert.match(needed.content[0].text, /more than one task.*Call get_feature again with task_id/u);
  // Existing callers keep working; a bad task_id or both selectors are refused by the schema.
  const { tools } = setup();
  for (const [name, base] of [["complete_task", {}], ["block_task", { reason: "r" }], ["get_feature", {}]]) {
    assert.equal(parse(tools[name], { ...base, task_id: "T-9" }).success, true, name);
    assert.equal(parse(tools[name], base).success, true, name);
    for (const task_id of ["9", "T-0", "t-1", 9]) assert.equal(parse(tools[name], { ...base, task_id }).success, false, `${name} ${task_id}`);
  }
  assert.equal(parse(tools.get_feature, { feature: "Offline mode", task_id: "T-9" }).success, false);
  assert.match(tools.get_feature.config.description, /task_id/u);
});

test("the instructions tell an agent to assign a task it was not started for and to unassign it again", () => {
  assert.match(TASK_TOOL_INSTRUCTIONS, /assign_task/u);
  assert.match(TASK_TOOL_INSTRUCTIONS, /unassign_task/u);
  assert.doesNotMatch(TASK_TOOL_INSTRUCTIONS, /only on its own task|attach/iu);
});

test("Claude hook binds assign_task and unassign_task from the host transcript, signed per tool, without approving them", async () => {
  const transcript_path = path.resolve("private", `${SESSION_ID}.jsonl`);
  const options = { readToken: async () => TOKEN, now: () => NOW };
  for (const name of ["assign_task", "unassign_task"]) {
    for (const prefix of ["mcp__pomegr__", "mcp__plugin_pomegr_pomegr__"]) {
      const call = { hook_event_name: "PreToolUse", tool_name: `${prefix}${name}`, tool_input: { task_id: "T-7" }, transcript_path };
      assert.deepEqual((await bindClaudeQueryWrite(call, options)).hookSpecificOutput,
        { hookEventName: "PreToolUse", updatedInput: { task_id: "T-7", session_ref: REF, session_proof: proofFor(name) } });
      for (const bad of [
        { ...call, tool_input: { task_id: "T-7", session_ref: "claude:other" } },
        { ...call, tool_input: { task_id: "T-7", repository_id: "repo-0123456789abcdef01234567" } },
        { ...call, tool_input: { task_id: "T-7", text: "x" } },
        { ...call, transcript_path: "private-path-sentinel" },
      ]) {
        const denied = (await bindClaudeQueryWrite(bad, options)).hookSpecificOutput;
        assert.equal(denied.permissionDecision, "deny");
        assert.equal(denied.updatedInput, undefined);
        assert.match(denied.permissionDecisionReason, name === "assign_task" ? /no task was assigned/u : /no task was unassigned/u);
      }
      assert.equal((await bindClaudeQueryWrite(call, { readToken: async () => null, now: () => NOW })).hookSpecificOutput.permissionDecision, "deny");
    }
  }
  assert.notEqual(proofFor("assign_task"), proofFor("unassign_task"));
  assert.notEqual(proofFor("assign_task"), proofFor("remove_task"));
  // task_id passes through on the three tools that take it, and get_feature keeps its self-grant.
  for (const [tool_name, tool_input] of [["complete_task", { task_id: "T-7", attention: "x" }], ["block_task", { task_id: "T-7", reason: "r" }], ["get_feature", { task_id: "T-7" }]]) {
    const out = (await bindClaudeQueryWrite({ hook_event_name: "PreToolUse", tool_name: `mcp__pomegr__${tool_name}`, tool_input, transcript_path }, options)).hookSpecificOutput;
    assert.deepEqual(out.updatedInput, { ...tool_input, session_ref: REF, session_proof: proofFor(tool_name) });
    assert.equal(out.permissionDecision, tool_name === "get_feature" ? "allow" : undefined, tool_name);
  }
  const hooks = JSON.parse(readFileSync(new URL("../plugin-src/claude-hooks.json", import.meta.url), "utf8"));
  for (const name of ["assign_task", "unassign_task"]) {
    assert.ok(hooks.hooks.PreToolUse.some((entry) => new RegExp(entry.matcher, "u").test(`mcp__plugin_pomegr_pomegr__${name}`)), name);
  }
});
