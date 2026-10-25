import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { bindClaudeQueryWrite } from "../plugin-src/claude-query-session.mjs";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "claude-capability-token-".padEnd(43, "k");
const NOW = 1_800_000_000_000;

test("Claude hook tells each deny cause apart with a fixed sentence that echoes nothing", async () => {
  const transcript_path = path.resolve("private-path-sentinel", `${SESSION_ID}.jsonl`);
  const options = { readToken: async () => TOKEN, now: () => NOW };
  const call = { hook_event_name: "PreToolUse", tool_name: "mcp__plugin_pomegr_pomegr__complete_task", transcript_path };
  const reason = async (payload, opts = options) => {
    const out = (await bindClaudeQueryWrite(payload, opts)).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.equal(out.updatedInput, undefined);
    assert.doesNotMatch(JSON.stringify(out), new RegExp(`${TOKEN}|value-sentinel|error-sentinel|private-path-sentinel|claude:`, "u"));
    return out.permissionDecisionReason;
  };
  const field = "complete_task takes only these fields: attention, task_id. This call held another field, so nothing was reported. "
    + "A plain completion takes no field. Retry once with only those fields.";
  assert.equal(await reason({ ...call, tool_input: { summary: "value-sentinel" } }), field);
  assert.equal(await reason({ ...call, tool_input: { attention: "value-sentinel", result: "value-sentinel" } }), field);
  assert.equal(await reason({ ...call, tool_input: { summary: "value-sentinel" }, transcript_path: "private-path-sentinel" }), field);
  assert.equal(await reason({ ...call, tool_input: { attention: "value-sentinel" }, transcript_path: "private-path-sentinel" }),
    "Pomegr found no Claude Code session for this call, so nothing was reported. Do not retry; tell the user.");
  const unsigned = "Pomegr could not sign this call for the current session, so nothing was reported. Pomegr may not be running; do not retry, tell the user.";
  for (const readToken of [async () => null, async () => { throw new Error(`error-sentinel ${TOKEN}`); }]) {
    assert.equal(await reason({ ...call, tool_input: { attention: "value-sentinel" } }, { readToken, now: () => NOW }), unsigned);
  }
  const block = { ...call, tool_name: "mcp__pomegr__block_task", tool_input: { reason: "value-sentinel", summary: "value-sentinel" } };
  const review = { ...call, tool_name: "mcp__pomegr__report_review", tool_input: { verdict: "pass" } };
  assert.equal(await reason({ ...review, tool_input: { verdict: "pass", summary: "value-sentinel" } }),
    "report_review takes only these fields: verdict, reasons, task_id. This call held another field, so no verdict was recorded. Retry once with only those fields.");
  assert.equal(await reason({ ...review, transcript_path: "private-path-sentinel" }),
    "Pomegr found no Claude Code session for this call, so no verdict was recorded. Do not retry; tell the user.");
  assert.equal(await reason(review, { readToken: async () => null }),
    "Pomegr could not sign this call for the current session, so no verdict was recorded. Pomegr may not be running; do not retry, tell the user.");
  assert.equal(await reason(block),
    "block_task takes only these fields: reason, task_id. This call held another field, so nothing was reported. Retry once with only those fields.");
  assert.match(await reason({ ...call, tool_name: "mcp__pomegr__add_task", tool_input: { title: "value-sentinel" } }),
    /^add_task takes only these fields: text, .*so no task was added\. Retry once/u);
});
