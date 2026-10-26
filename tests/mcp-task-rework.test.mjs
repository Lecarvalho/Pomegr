import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { registerTaskTools } from "../mcp/task-tools.mjs";
import { bindClaudeQueryWrite } from "../plugin-src/claude-query-session.mjs";

const SENTINEL = "PRIVATE-REWORK-SENTINEL";
function setup({ answer } = {}) {
  const tools = {}, calls = [];
  registerTaskTools({ registerTool: (name, config, handler) => { tools[name] = { config, handler }; } }, {
    resolveSession: () => "claude:fixing-session",
    post: async (pathname, body) => { calls.push({ pathname, body }); return answer; },
  });
  return { tools, calls };
}
const parse = (tool, input) => tool.config.inputSchema.safeParse(input);

test("report reworks schemas accept bounded references and causes only", () => {
  const { tools } = setup();
  for (const name of ["complete_task", "block_task"]) {
    const base = name === "block_task" ? { reason: "stuck" } : {};
    for (const cause of ["missed_wiring", "spec_gap", "wrong_behavior", "stale_instructions", "latent", "other"]) {
      assert.equal(parse(tools[name], { ...base, reworks: [{ ref: "T-2", cause }, { ref: "#336", cause }] }).success, true);
    }
    assert.equal(parse(tools[name], { ...base, reworks: Array.from({ length: 5 }, (_, i) => ({ ref: `#${i + 1}`, cause: "other" })) }).success, true);
    for (const reworks of [null, [], {}, Array(6).fill({ ref: "#1", cause: "other" }),
      ...["T-0", "T-01", "#0", "#01", "#9007199254740992", "#1\n", "secret"].map((ref) => [{ ref, cause: "other" }]),
      [{ ref: "T-2" }], [{ ref: "T-2", cause: "unknown" }], [{ ref: "T-2", cause: "other", note: SENTINEL }]]) {
      assert.equal(parse(tools[name], { ...base, reworks }).success, false, JSON.stringify(reworks));
    }
  }
});

test("both report tools send reworks and return only references and fixed outcomes", async () => {
  const reworks = [{ ref: "T-2", cause: "wrong_behavior" }];
  for (const name of ["complete_task", "block_task"]) {
    const { tools, calls } = setup({ answer: { ok: true, state: name === "block_task" ? "blocked" : "needs_review", reworks: [
      { ref: "T-2", status: "recorded", secret: SENTINEL }, { ref: "#3", status: "exists" },
      ...["not_found", "limit", "invalid"].map((reason, i) => ({ ref: `T-${i + 4}`, status: "refused", reason })),
      { ref: SENTINEL, status: "recorded" }, { ref: "T-8", status: "refused", reason: SENTINEL },
    ] } });
    const out = await tools[name].handler({ reworks, ...(name === "block_task" ? { reason: "stuck" } : {}) });
    assert.deepEqual(calls[0].body.reworks, reworks);
    assert.notEqual(out.isError, true);
    assert.match(out.content[0].text, /T-2 recorded.*#3 already existed.*T-4 refused \(not_found\).*T-5 refused \(limit\).*T-6 refused \(invalid\)/u);
    assert.doesNotMatch(out.content[0].text, new RegExp(SENTINEL, "u"));
  }
});

test("Claude report hooks preserve reworks for both tool prefixes", async () => {
  const reworks = [{ ref: "#336", cause: "missed_wiring" }];
  const transcript_path = path.resolve("private", "33333333-3333-4333-8333-333333333333.jsonl");
  for (const prefix of ["mcp__pomegr__", "mcp__plugin_pomegr_pomegr__"]) {
    for (const name of ["complete_task", "block_task"]) {
      const out = (await bindClaudeQueryWrite({ hook_event_name: "PreToolUse", tool_name: prefix + name,
        tool_input: { reworks, ...(name === "block_task" ? { reason: "stuck" } : {}) }, transcript_path },
      { readToken: async () => "a".repeat(43), now: () => 1_800_000_000_000 })).hookSpecificOutput;
      assert.equal(out.permissionDecision, undefined);
      assert.deepEqual(out.updatedInput.reworks, reworks);
      assert.ok(out.updatedInput.session_proof);
    }
  }
});
