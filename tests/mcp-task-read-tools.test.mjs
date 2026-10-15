import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { TASK_GET_PATH, TASK_LIST_PATH, TASK_READ_UNBOUND_TEXT, TASK_TOOL_INSTRUCTIONS, formatTask, registerTaskTools } from "../mcp/task-tools.mjs";
import { AGENT_TASK_NO_ANSWER } from "../shared/agent-query-transport.mjs";
import { bindClaudeQueryWrite } from "../plugin-src/claude-query-session.mjs";
import { createTaskBindingProof } from "../plugin-src/task-binding-proof.mjs";

const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const TOKEN = "claude-capability-token-".padEnd(43, "k");
const NOW = 1_800_000_000_000;
const REF = `claude:${SESSION_ID}`;
const proofFor = (tool) => createTaskBindingProof({ token: TOKEN, tool, sessionRef: REF, now: NOW });

const TASK = {
  id: "T-12", text: "Fix the cache.\nThen [image] the rest.", textCut: false, ownCondition: "Docs updated", completeWhen: ["pr_open", "ci_passed"],
  provider: "claude", model: "claude-opus-5-5", effort: "high", feature: "Tasks 0.8.0", column: "Ready", state: "queued", editable: true,
};

function setup({ ref = "claude:x", hookBound = false, answer = { ok: true } } = {}) {
  const tools = {};
  const calls = [];
  registerTaskTools({ registerTool: (name, config, handler) => { tools[name] = { config, handler }; } }, {
    resolveSession: () => ref,
    hookBound,
    post: async (pathname, body) => {
      calls.push({ pathname, body });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  return { tools, calls };
}

const parse = (tool, input) => tool.config.inputSchema.safeParse(input);

test("get_task and list_tasks are strict read-only tools with no repository, path, or session input", () => {
  const { tools } = setup();
  for (const name of ["get_task", "list_tasks"]) {
    assert.deepEqual(tools[name].config.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const valid = name === "get_task" ? { task_id: "T-1" } : {};
    assert.equal(parse(tools[name], valid).success, true, name);
    for (const extra of [{ repository: "r" }, { repositoryId: "r" }, { path: "C:\\x" }, { sessionRef: "codex:a" }, { session_ref: "claude:a" }, { session_proof: "p" }, { text: "x" }]) {
      assert.equal(parse(tools[name], { ...valid, ...extra }).success, false, `${name} ${JSON.stringify(extra)}`);
    }
  }
  for (const task_id of [undefined, "", "T-0", "T-1234567890", "12", "t-1"]) assert.equal(parse(tools.get_task, { task_id }).success, false, String(task_id));
  assert.equal(parse(tools.list_tasks, { query: "cache", state: "done", feature: "Tasks 0.8.0", editable: false }).success, true);
  for (const bad of [{ query: "" }, { query: "q".repeat(81) }, { query: "two\nlines" }, { state: "running" }, { feature: "f".repeat(81) }, { editable: "yes" }]) {
    assert.equal(parse(tools.list_tasks, bad).success, false, JSON.stringify(bad));
  }
  assert.equal(parse(setup({ hookBound: true }).tools.get_task, { task_id: "T-1", session_ref: "claude:a", session_proof: "p" }).success, true);
});

test("update_task tells the agent to read the task with get_task, and still replaces the text whole", () => {
  const { tools } = setup();
  const description = tools.update_task.config.description;
  assert.match(description, /read the task with get_task first, then set the whole text/u);
  assert.match(description, /replaces the task's whole text, not appends to it/u);
  assert.doesNotMatch(description, /never returns a task's text/u);
  assert.match(TASK_TOOL_INSTRUCTIONS, /read the task with get_task first/u);
  assert.doesNotMatch(TASK_TOOL_INSTRUCTIONS, /no tool reads a task's text/u);
});

test("get_task prints the served task and posts only the bound session and the task ID", async () => {
  const own = setup({ ref: "codex:t1", answer: { ok: true, task: TASK } });
  const read = await own.tools.get_task.handler({ task_id: "T-12" });
  assert.equal(read.isError, undefined);
  assert.equal(read.content[0].text, [
    "Task T-12", "Column: Ready", "State: queued", "Editable with update_task: yes", "Feature: Tasks 0.8.0",
    "Run on: claude, model claude-opus-5-5, effort high", "Complete when: Pull request open, CI passed", "Own condition: Docs updated",
    "Text:", "Fix the cache.\nThen [image] the rest.",
  ].join("\n"));
  assert.deepEqual(own.calls, [{ pathname: TASK_GET_PATH, body: { sessionRef: "codex:t1", taskId: "T-12" } }]);
  const bare = formatTask({ ...TASK, provider: null, model: null, effort: null, feature: null, ownCondition: null, completeWhen: [], editable: false });
  assert.match(bare, /Editable with update_task: no\nFeature: none\nRun on: not set\nComplete when: none\nOwn condition: none/u);

  const missing = await setup({ answer: { ok: false, reason: "not_found" } }).tools.get_task.handler({ task_id: "T-9" });
  assert.equal(missing.isError, true);
  assert.equal(missing.content[0].text, "No such task on this session's board.");
  // An answer that is not the served shape reads as unavailable, never as text.
  for (const answer of [{ ok: true }, { ok: true, task: { ...TASK, state: "running" } }, { ok: true, task: { ...TASK, id: "x" } }, { ok: false, reason: "weird" }]) {
    assert.equal((await setup({ answer }).tools.get_task.handler({ task_id: "T-1" })).content[0].text, "Pomegr is unavailable, so no task was read.");
  }
});

test("list_tasks posts only the filters it was given and prints the match count and each task", async () => {
  const cut = { ...TASK, id: "T-13", text: `${"x".repeat(299)}…`, textCut: true };
  const own = setup({ answer: { ok: true, tasks: [TASK, cut], matched: 140, truncated: true } });
  const listed = await own.tools.list_tasks.handler({ query: "cache", editable: true });
  assert.deepEqual(own.calls[0], { pathname: TASK_LIST_PATH, body: { sessionRef: "claude:x", query: "cache", editable: true } });
  const text = listed.content[0].text;
  assert.match(text, /^140 tasks match; these are the first 2, in board order\. Narrow the list/u);
  assert.match(text, /\n\nTask T-12\n/u);
  assert.match(text, /\n\nTask T-13\n[^]*Text \(cut; call get_task for the whole text\):\nx{299}…$/u);

  const empty = await setup({ answer: { ok: true, tasks: [], matched: 0, truncated: false } }).tools.list_tasks.handler({});
  assert.equal(empty.isError, undefined);
  assert.equal(empty.content[0].text, "No task of the board matches.");
  const one = await setup({ answer: { ok: true, tasks: [TASK], matched: 1, truncated: false } }).tools.list_tasks.handler({});
  assert.match(one.content[0].text, /^1 task matches, in board order\.\n\nTask T-12/u);
});

test("both reads refuse without a bound session and say only that nothing was read", async () => {
  for (const [name, input] of [["get_task", { task_id: "T-1" }], ["list_tasks", {}]]) {
    for (const ref of [null, "", 7]) {
      const unbound = setup({ ref });
      const refused = await unbound.tools[name].handler(input);
      assert.equal(refused.content[0].text, TASK_READ_UNBOUND_TEXT);
      assert.equal(unbound.calls.length, 0);
    }
    for (const error of [new Error("AGENT_QUERY_UNAVAILABLE"), new Error(AGENT_TASK_NO_ANSWER)]) {
      const down = await setup({ answer: error }).tools[name].handler(input);
      assert.equal(down.content[0].text, "Pomegr is unavailable, so no task was read.");
    }
  }
});

test("Claude hook binds and signs get_task and list_tasks for their own name and approves both as reads", async () => {
  const transcript_path = path.resolve("private", `${SESSION_ID}.jsonl`);
  const options = { readToken: async () => TOKEN, now: () => NOW };
  const hooks = JSON.parse(readFileSync(new URL("../plugin-src/claude-hooks.json", import.meta.url), "utf8"));
  for (const [name, tool_input] of [["get_task", { task_id: "T-3" }], ["list_tasks", { query: "q", state: "done", feature: "F", editable: true }], ["list_tasks", {}]]) {
    const call = { hook_event_name: "PreToolUse", tool_name: `mcp__plugin_pomegr_pomegr__${name}`, tool_input, transcript_path };
    assert.deepEqual((await bindClaudeQueryWrite(call, options)).hookSpecificOutput, {
      hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...tool_input, session_ref: REF, session_proof: proofFor(name) },
    });
    assert.notEqual(proofFor(name), proofFor("update_task"));
    const denied = (await bindClaudeQueryWrite({ ...call, tool_input: { ...tool_input, repository_id: "repo-x" } }, options)).hookSpecificOutput;
    assert.equal(denied.permissionDecision, "deny");
    assert.match(denied.permissionDecisionReason, /so no task was read/u);
    assert.equal((await bindClaudeQueryWrite(call, { readToken: async () => null, now: () => NOW })).hookSpecificOutput.permissionDecision, "deny");
    assert.ok(hooks.hooks.PreToolUse.some((entry) => new RegExp(entry.matcher, "u").test(`mcp__plugin_pomegr_pomegr__${name}`)), name);
  }
  // A write is still left to Claude Code's own permission prompt.
  const write = { hook_event_name: "PreToolUse", tool_name: "mcp__pomegr__update_task", tool_input: { task_id: "T-3", text: "t" }, transcript_path };
  assert.equal((await bindClaudeQueryWrite(write, options)).hookSpecificOutput.permissionDecision, undefined);
});
