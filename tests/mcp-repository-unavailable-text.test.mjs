// The plugin's answer when the monitor refuses a session whose repository Git did not confirm (T-200). An agent that
// read "the board is empty" from such a refusal once added its task to an empty board, so every text says otherwise.
import assert from "node:assert/strict";
import test from "node:test";

import { registerTaskTools } from "../mcp/task-tools.mjs";

function tools() {
  const registered = {};
  const server = { registerTool: (name, config, handler) => { registered[name] = { config, handler }; } };
  registerTaskTools(server, { resolveSession: () => "claude:x", hookBound: false, post: async () => ({ ok: false, reason: "repository_unavailable" }) });
  return registered;
}

const CALLS = [
  ["add_task", { text: "a follow-up" }, "no task was added"],
  ["remove_task", { task_id: "T-1" }, "no task was removed"],
  ["update_task", { task_id: "T-1", text: "x" }, "no task was changed"],
  ["assign_task", { task_id: "T-1" }, "no task was assigned"],
  ["unassign_task", { task_id: "T-1" }, "no task was unassigned"],
  ["get_task", { task_id: "T-1" }, "no task was read"],
  ["list_tasks", {}, "no task was read"],
  ["get_feature", {}, "no feature was read or changed"],
  ["create_feature", { title: "F" }, "no feature was read or changed"],
  ["update_feature", { feature: "F", description: "x" }, "no feature was read or changed"],
  ["delete_feature", { feature: "F" }, "no feature was read or changed"],
];

test("every board tool says an unconfirmed repository was not read, never that its board is empty", async () => {
  const registered = tools();
  for (const [name, input, outcome] of CALLS) {
    const out = await registered[name].handler(input);
    assert.equal(out.isError, true, name);
    assert.equal(out.content[0].text,
      `Git has not confirmed the current session's repository, so ${outcome}. It does not mean the board is empty: Pomegr did not read it.`, name);
  }
});
