import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildUpdateTaskBody, registerTaskTools, TASK_UPDATE_PATH, TASK_UPDATE_UNBOUND_TEXT } from "../mcp/task-tools.mjs";
import { bindClaudeQueryWrite } from "../plugin-src/claude-query-session.mjs";
import { createTaskBindingProof } from "../plugin-src/task-binding-proof.mjs";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const SENTINEL = "TASK_TEXT_SENTINEL_9f3";
const TOKEN = "claude-capability-token-".padEnd(43, "k");
const NOW = 1_800_000_000_000;
const REF = `claude:${SESSION_ID}`;
const proofFor = (tool) => createTaskBindingProof({ token: TOKEN, tool, sessionRef: REF, now: NOW });

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

test("update_task takes a task ID and at least one field, and has no repository, path, or feature input", () => {
  const { tools } = setup();
  const tool = tools.update_task;
  assert.deepEqual(tool.config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  for (const input of [{ task_id: "T-12", text: "x" }, { task_id: "T-1", effort: "high" }, { task_id: "T-1", provider: "codex", model: "gpt-5" },
    { task_id: "T-1", complete_when: [] }, { task_id: "T-1", complete_when: ["pr_open", "ci_passed"], own_condition: "tests green" }, { task_id: "T-1", own_condition: "" },
    { task_id: "T-1", text: "y".repeat(4000) }]) {
    assert.equal(parse(tool, input).success, true, JSON.stringify(input));
  }
  for (const input of [{}, { task_id: "T-1" }, { text: "x" }, { task_id: "12", text: "x" }, { task_id: "T-0", text: "x" }, { task_id: "T-01", text: "x" }, { task_id: 1, text: "x" },
    { task_id: "T-1", text: "" }, { task_id: "T-1", text: "   " }, { task_id: "T-1", text: "y".repeat(4001) }, { task_id: "T-1", provider: "other" }, { task_id: "T-1", model: "../x" },
    { task_id: "T-1", effort: "max" }, { task_id: "T-1", complete_when: ["pr_open", "pr_open"] }, { task_id: "T-1", complete_when: ["other"] }, { task_id: "T-1", own_condition: "z".repeat(501) },
    { task_id: "T-1", text: "x", repository_id: "repo-0123456789abcdef01234567" }, { task_id: "T-1", text: "x", path: "C:/x" }, { task_id: "T-1", text: "x", feature: "f" },
    { task_id: "T-1", text: "x", remote_control: true }, { task_id: "T-1", text: "x", session_ref: "claude:x" }, { id: "T-1", text: "x" }]) {
    assert.equal(parse(tool, input).success, false, JSON.stringify(input));
  }
  // Only a hook-bound harness has the binding fields.
  const bound = setup({ hookBound: true }).tools.update_task;
  assert.equal(parse(bound, { task_id: "T-1", text: "x", session_ref: "claude:x", session_proof: "p" }).success, true);
});

test("update_task sends only the fields that were set, and an empty own condition as a clear", () => {
  assert.deepEqual(buildUpdateTaskBody("claude:x", { task_id: "T-4", text: "new" }), { sessionRef: "claude:x", taskId: "T-4", text: "new" });
  assert.deepEqual(buildUpdateTaskBody("claude:x", { task_id: "T-4", effort: "low" }), { sessionRef: "claude:x", taskId: "T-4", run: { effort: "low" } });
  assert.deepEqual(buildUpdateTaskBody("claude:x", { task_id: "T-4", provider: "codex", model: "gpt-5", complete_when: [] }),
    { sessionRef: "claude:x", taskId: "T-4", run: { provider: "codex", model: "gpt-5" }, completeWhen: { checks: [] } });
  assert.deepEqual(buildUpdateTaskBody("claude:x", { task_id: "T-4", own_condition: "" }), { sessionRef: "claude:x", taskId: "T-4", completeWhen: { own: null } });
  assert.deepEqual(buildUpdateTaskBody("claude:x", { task_id: "T-4", complete_when: ["pr_open"], own_condition: "green", session_ref: "claude:y", session_proof: "p" }),
    { sessionRef: "claude:x", taskId: "T-4", completeWhen: { checks: ["pr_open"], own: "green" } });
});

test("update_task posts the bound session, and maps every answer to fixed text that never carries task content", async () => {
  const done = setup({ ref: "claude:x", answer: { ok: true, taskId: "T-9", text: SENTINEL } });
  const out = await done.tools.update_task.handler({ task_id: "T-4", text: SENTINEL });
  assert.equal(out.isError, undefined);
  assert.equal(out.content[0].text, "Task T-4 updated.");
  assert.deepEqual(done.calls, [{ pathname: TASK_UPDATE_PATH, body: { sessionRef: "claude:x", taskId: "T-4", text: SENTINEL } }]);
  const texts = {
    invalid: "Pomegr rejected the request as invalid, so no task was changed.",
    session_not_found: "Pomegr does not know the current session yet, so no task was changed.",
    repository_unavailable: "Pomegr could not resolve the current session's repository, so no task was changed.",
    not_found: "No task was changed. A task can be changed only while it is on this session's board and has not started.",
    unavailable: "Pomegr is unavailable, so no task was changed.",
  };
  for (const [code, text] of Object.entries(texts)) {
    const refused = await setup({ answer: { ok: false, reason: code, detail: SENTINEL } }).tools.update_task.handler({ task_id: "T-4", text: SENTINEL });
    assert.equal(refused.isError, true);
    assert.equal(refused.content[0].text, text);
  }
  for (const answer of [{ ok: false, reason: SENTINEL }, { ok: false }, null, SENTINEL, { ok: "true" }, new Error(SENTINEL)]) {
    const failed = await setup({ answer }).tools.update_task.handler({ task_id: "T-4", text: SENTINEL });
    assert.equal(failed.isError, true);
    assert.equal(failed.content[0].text, texts.unavailable);
    assert.doesNotMatch(JSON.stringify(failed), new RegExp(SENTINEL, "u"));
  }
  // A call the host did not bind posts nothing.
  for (const ref of [null, "", 7]) {
    const unbound = setup({ ref });
    const refused = await unbound.tools.update_task.handler({ task_id: "T-4", text: "x" });
    assert.equal(refused.isError, true);
    assert.equal(refused.content[0].text, TASK_UPDATE_UNBOUND_TEXT);
    assert.equal(unbound.calls.length, 0);
  }
});

test("Claude hook binds update_task from the host transcript, signed for that tool, and denies any other input", async () => {
  const transcript_path = path.resolve("private", `${SESSION_ID}.jsonl`);
  const options = { readToken: async () => TOKEN, now: () => NOW };
  const tool_input = { task_id: "T-7", text: "x", provider: "claude", model: "m", effort: "low", complete_when: ["pr_open"], own_condition: "c" };
  for (const prefix of ["mcp__pomegr__", "mcp__plugin_pomegr_pomegr__"]) {
    const call = { hook_event_name: "PreToolUse", tool_name: `${prefix}update_task`, tool_input, transcript_path };
    // The hook makes no permission decision, so the host asks the user as for any write.
    assert.deepEqual((await bindClaudeQueryWrite(call, options)).hookSpecificOutput,
      { hookEventName: "PreToolUse", updatedInput: { ...tool_input, session_ref: REF, session_proof: proofFor("update_task") } });
    for (const other of ["add_task", "remove_task", "update_feature"]) assert.notEqual(proofFor("update_task"), proofFor(other));
    for (const bad of [
      { ...call, tool_input: { ...tool_input, session_ref: "claude:other" } },
      { ...call, tool_input: { ...tool_input, session_proof: proofFor("update_task") } },
      { ...call, tool_input: { ...tool_input, repository_id: "repo-0123456789abcdef01234567" } },
      { ...call, tool_input: { ...tool_input, feature: "f" } },
      { ...call, tool_input: { ...tool_input, remote_control: true } },
      { ...call, transcript_path: "private-path-sentinel" },
    ]) {
      const denied = (await bindClaudeQueryWrite(bad, options)).hookSpecificOutput;
      assert.equal(denied.permissionDecision, "deny");
      assert.equal(denied.updatedInput, undefined);
      assert.match(denied.permissionDecisionReason, /no task was changed/u);
      assert.doesNotMatch(JSON.stringify(denied), /private-path-sentinel|claude:other/u);
    }
    assert.equal((await bindClaudeQueryWrite(call, { readToken: async () => null, now: () => NOW })).hookSpecificOutput.permissionDecision, "deny");
  }
  const hooks = JSON.parse(readFileSync(new URL("../plugin-src/claude-hooks.json", import.meta.url), "utf8"));
  assert.ok(hooks.hooks.PreToolUse.some((entry) => new RegExp(entry.matcher, "u").test("mcp__plugin_pomegr_pomegr__update_task")));
});

test("update_task replaces what a task runs after, an empty list clears it, and a refused list has fixed text", async () => {
  const { tools } = setup();
  const tool = tools.update_task;
  for (const runs_after of [[], ["T-1"], Array.from({ length: 8 }, (_, index) => `T-${index + 1}`)]) {
    assert.equal(parse(tool, { task_id: "T-12", runs_after }).success, true, JSON.stringify(runs_after));
  }
  for (const runs_after of [["T-1", "T-1"], ["T-0"], ["x"], [1], "T-1", null, Array.from({ length: 9 }, (_, index) => `T-${index + 1}`)]) {
    assert.equal(parse(tool, { task_id: "T-12", runs_after }).success, false, JSON.stringify(runs_after));
  }
  assert.deepEqual(buildUpdateTaskBody("claude:x", { task_id: "T-4", runs_after: [] }), { sessionRef: "claude:x", taskId: "T-4", after: [] });
  assert.deepEqual(buildUpdateTaskBody("claude:x", { task_id: "T-4", text: "t", runs_after: ["T-2"] }), { sessionRef: "claude:x", taskId: "T-4", text: "t", after: ["T-2"] });
  const texts = {
    after_not_found: "A task in runs_after is not on the board, so no task was changed.",
    after_loop: "These tasks would wait for each other, so no task was changed.",
  };
  for (const [code, text] of Object.entries(texts)) {
    const refused = await setup({ answer: { ok: false, reason: code } }).tools.update_task.handler({ task_id: "T-4", runs_after: ["T-2"] });
    assert.equal(refused.isError, true);
    assert.equal(refused.content[0].text, text);
  }
});
