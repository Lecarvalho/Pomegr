import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  FEATURE_CREATE_PATH, FEATURE_DELETE_PATH, FEATURE_GET_PATH, FEATURE_NO_ANSWER_TEXT, FEATURE_UNBOUND_TEXT, FEATURE_UPDATE_PATH, formatFeature, registerTaskTools,
} from "../mcp/task-tools.mjs";
import { AGENT_TASK_NO_ANSWER } from "../shared/agent-query-transport.mjs";
import { bindClaudeQueryWrite } from "../plugin-src/claude-query-session.mjs";
import { createTaskBindingProof } from "../plugin-src/task-binding-proof.mjs";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const SENTINEL = "FEATURE_TEXT_SENTINEL_4c1";
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

const FEATURE = { id: "feat-0123456789ab", title: "Offline mode", description: `Shared context\n${SENTINEL}`, appVersion: "1.4.0" };

test("the feature tools are strict and bounded with no repository or path input", () => {
  const { tools } = setup();
  assert.deepEqual(tools.get_feature.config.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(tools.create_feature.config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.deepEqual(tools.update_feature.config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(tools.delete_feature.config.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  for (const name of ["get_feature", "create_feature", "update_feature", "delete_feature"]) {
    const valid = name === "create_feature" ? { title: "T" } : name === "update_feature" ? { feature: "F", title: "T" } : { feature: "F" };
    assert.equal(parse(tools[name], valid).success, true, name);
    for (const extra of [{ repository: "r" }, { repositoryId: "r" }, { path: "C:\\x" }, { sessionRef: "codex:a" }, { session_ref: "claude:a" }, { session_proof: "p" }]) {
      assert.equal(parse(tools[name], { ...valid, ...extra }).success, false, name);
    }
  }
  assert.equal(parse(tools.get_feature, {}).success, true);
  for (const feature of ["", "   ", "x".repeat(81), "two\nlines", 4, null]) {
    assert.equal(parse(tools.get_feature, { feature }).success, false, String(feature));
    assert.equal(parse(tools.delete_feature, { feature }).success, false, String(feature));
  }
  assert.equal(parse(tools.delete_feature, {}).success, false);
  assert.equal(parse(tools.create_feature, {}).success, false);
  assert.equal(parse(tools.create_feature, { title: "x".repeat(80), description: "d".repeat(2000), app_version: "v".repeat(40) }).success, true);
  assert.equal(parse(tools.create_feature, { title: "T", description: "two\nlines\tand a tab" }).success, true);
  for (const bad of [{ title: "x".repeat(81) }, { title: "a\nb" }, { title: "T", description: "" }, { title: "T", description: "d".repeat(2001) }, { title: "T", description: "nul\u0000" },
    { title: "T", app_version: "" }, { title: "T", app_version: "v".repeat(41) }, { title: "T", app_version: "1\n2" }, { title: "T", appVersion: "1" }]) {
    assert.equal(parse(tools.create_feature, bad).success, false, JSON.stringify(bad));
  }
  // An update names a feature and sets at least one field; an empty description or app version is a clear.
  assert.equal(parse(tools.update_feature, { feature: "F" }).success, false);
  assert.equal(parse(tools.update_feature, { title: "T" }).success, false);
  assert.equal(parse(tools.update_feature, { feature: "F", title: "" }).success, false);
  assert.equal(parse(tools.update_feature, { feature: "F", description: "" }).success, true);
  assert.equal(parse(tools.update_feature, { feature: "F", app_version: "" }).success, true);
  // The hook-bound server alone takes the hook's two fields.
  const bound = setup({ hookBound: true }).tools;
  assert.equal(parse(bound.get_feature, { session_ref: "claude:a", session_proof: "p" }).success, true);
});

test("get_feature prints the feature the monitor answered and posts only the bound session and the reference", async () => {
  const own = setup({ ref: "codex:t1", answer: { ok: true, feature: FEATURE } });
  const read = await own.tools.get_feature.handler({});
  assert.equal(read.isError, undefined);
  assert.equal(read.content[0].text, `Feature feat-0123456789ab\nTitle: Offline mode\nApp version: 1.4.0\nDescription:\nShared context\n${SENTINEL}`);
  assert.deepEqual(own.calls, [{ pathname: FEATURE_GET_PATH, body: { sessionRef: "codex:t1" } }]);
  const named = setup({ answer: { ok: true, feature: { ...FEATURE, description: null, appVersion: null } } });
  assert.equal((await named.tools.get_feature.handler({ feature: "Offline mode" })).content[0].text, "Feature feat-0123456789ab\nTitle: Offline mode\nApp version: not set\nDescription: not set");
  assert.deepEqual(named.calls[0].body, { sessionRef: "claude:x", feature: "Offline mode" });
  assert.equal(formatFeature(FEATURE), read.content[0].text);

  // An answer that is not a feature is never printed.
  for (const feature of [undefined, null, {}, { ...FEATURE, id: "T-1" }, { ...FEATURE, title: "" }, { ...FEATURE, description: 4 }]) {
    const bad = await setup({ answer: { ok: true, feature } }).tools.get_feature.handler({});
    assert.equal(bad.isError, true);
    assert.equal(bad.content[0].text, "Pomegr is unavailable, so no feature was read or changed.");
  }
  const missing = await setup({ answer: { ok: false, reason: "not_found" } }).tools.get_feature.handler({});
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /^No such feature on the board\./u);
  // A read that got no answer changed nothing, so it does not say the outcome is unknown.
  const late = await setup({ answer: new Error(AGENT_TASK_NO_ANSWER) }).tools.get_feature.handler({});
  assert.equal(late.content[0].text, "Pomegr is unavailable, so no feature was read or changed.");
});

test("create_feature, update_feature, and delete_feature post the fields they were given and answer fixed text", async () => {
  const created = setup({ answer: { ok: true, featureId: FEATURE.id } });
  const made = await created.tools.create_feature.handler({ title: "Offline mode", description: SENTINEL, app_version: "1.4.0" });
  assert.equal(made.isError, undefined);
  assert.equal(made.content[0].text, "Feature feat-0123456789ab created.");
  assert.deepEqual(created.calls, [{ pathname: FEATURE_CREATE_PATH, body: { sessionRef: "claude:x", title: "Offline mode", description: SENTINEL, appVersion: "1.4.0" } }]);
  const bare = setup({ answer: { ok: true, featureId: FEATURE.id } });
  await bare.tools.create_feature.handler({ title: "Bare" });
  assert.deepEqual(bare.calls[0].body, { sessionRef: "claude:x", title: "Bare" });

  const updated = setup({ answer: { ok: true, featureId: FEATURE.id } });
  assert.equal((await updated.tools.update_feature.handler({ feature: FEATURE.id, description: "", app_version: "2.0" })).content[0].text, "Feature feat-0123456789ab updated.");
  // An empty string clears; a field that was left out is not sent.
  assert.deepEqual(updated.calls, [{ pathname: FEATURE_UPDATE_PATH, body: { sessionRef: "claude:x", feature: FEATURE.id, description: null, appVersion: "2.0" } }]);
  const retitled = setup({ answer: { ok: true, featureId: FEATURE.id } });
  await retitled.tools.update_feature.handler({ feature: "Old", title: "New", app_version: "" });
  assert.deepEqual(retitled.calls[0].body, { sessionRef: "claude:x", feature: "Old", title: "New", appVersion: null });

  const deleted = setup({ answer: { ok: true } });
  assert.equal((await deleted.tools.delete_feature.handler({ feature: "Old" })).content[0].text, "Feature deleted.");
  assert.deepEqual(deleted.calls, [{ pathname: FEATURE_DELETE_PATH, body: { sessionRef: "claude:x", feature: "Old" } }]);

  // A success without a feature ID is not announced as one.
  for (const name of ["create_feature", "update_feature"]) {
    const odd = await setup({ answer: { ok: true, featureId: "T-1" } }).tools[name].handler(name === "create_feature" ? { title: "T" } : { feature: "F", title: "T" });
    assert.equal(odd.isError, true);
  }
  const refusals = [
    ["create_feature", { title: "T" }, "conflict", /already exists on the board, so no feature was created/u],
    ["create_feature", { title: "T" }, "limit", /so no feature was created/u],
    ["update_feature", { feature: "F", title: "T" }, "conflict", /Another feature already has that title/u],
    ["update_feature", { feature: "F", title: "T" }, "not_found", /nothing was changed/u],
    ["delete_feature", { feature: "F" }, "conflict", /still has tasks, so it was not deleted/u],
    ["delete_feature", { feature: "F" }, "not_found", /nothing was deleted/u],
    ["delete_feature", { feature: "F" }, "invalid", /rejected the request as invalid/u],
    ["delete_feature", { feature: "F" }, "session_not_found", /does not know the current session/u],
    ["delete_feature", { feature: "F" }, "repository_unavailable", /Git has not confirmed the current session's repository/u],
    ["delete_feature", { feature: "F" }, SENTINEL, /^Pomegr is unavailable/u],
  ];
  for (const [name, input, reason, expected] of refusals) {
    const refused = await setup({ answer: { ok: false, reason } }).tools[name].handler(input);
    assert.equal(refused.isError, true, `${name} ${reason}`);
    assert.match(refused.content[0].text, expected, `${name} ${reason}`);
    assert.doesNotMatch(JSON.stringify(refused), new RegExp(SENTINEL, "u"));
  }
});

test("a feature call the host did not bind posts nothing, and an unanswered write says the outcome is unknown", async () => {
  const inputs = { get_feature: {}, create_feature: { title: SENTINEL }, update_feature: { feature: "F", description: SENTINEL }, delete_feature: { feature: "F" } };
  for (const [name, input] of Object.entries(inputs)) {
    for (const ref of [null, "", 7]) {
      const unbound = setup({ ref });
      const refused = await unbound.tools[name].handler(input);
      assert.equal(refused.isError, true);
      assert.equal(refused.content[0].text, FEATURE_UNBOUND_TEXT);
      assert.equal(unbound.calls.length, 0);
    }
    const down = await setup({ answer: new Error("AGENT_QUERY_UNAVAILABLE") }).tools[name].handler(input);
    assert.equal(down.content[0].text, "Pomegr is unavailable, so no feature was read or changed.");
    if (name === "get_feature") continue;
    const late = await setup({ answer: new Error(AGENT_TASK_NO_ANSWER) }).tools[name].handler(input);
    assert.equal(late.isError, true);
    assert.equal(late.content[0].text, FEATURE_NO_ANSWER_TEXT);
    assert.doesNotMatch(JSON.stringify(late), new RegExp(`${SENTINEL}|AGENT_QUERY`, "u"));
  }
  assert.match(FEATURE_NO_ANSWER_TEXT, /^Pomegr did not answer in time, so it is unknown whether /u);
});

test("Claude hook binds each feature tool signed for that tool, and approves only the read", async () => {
  const transcript_path = path.resolve("private", `${SESSION_ID}.jsonl`);
  const options = { readToken: async () => TOKEN, now: () => NOW };
  const inputs = { get_feature: { feature: "F" }, create_feature: { title: "T", description: "d", app_version: "1" }, update_feature: { feature: "F", title: "T", description: "", app_version: "" }, delete_feature: { feature: "F" } };
  const hooks = JSON.parse(readFileSync(new URL("../plugin-src/claude-hooks.json", import.meta.url), "utf8"));
  for (const prefix of ["mcp__pomegr__", "mcp__plugin_pomegr_pomegr__"]) {
    for (const [name, tool_input] of Object.entries(inputs)) {
      const call = { hook_event_name: "PreToolUse", tool_name: `${prefix}${name}`, tool_input, transcript_path };
      assert.deepEqual((await bindClaudeQueryWrite(call, options)).hookSpecificOutput, {
        hookEventName: "PreToolUse", ...(name === "get_feature" ? { permissionDecision: "allow" } : {}),
        updatedInput: { ...tool_input, session_ref: REF, session_proof: proofFor(name) },
      });
      assert.notEqual(proofFor(name), proofFor("add_task"));
      for (const bad of [
        { ...call, tool_input: { ...tool_input, session_ref: "claude:other" } },
        { ...call, tool_input: { ...tool_input, repository_id: "repo-0123456789abcdef01234567" } },
        { ...call, tool_input: { ...tool_input, text: "x" } },
        { ...call, transcript_path: "private-path-sentinel" },
      ]) {
        const denied = (await bindClaudeQueryWrite(bad, options)).hookSpecificOutput;
        assert.equal(denied.permissionDecision, "deny");
        assert.equal(denied.updatedInput, undefined);
        assert.match(denied.permissionDecisionReason, /no feature was read or changed/u);
        assert.doesNotMatch(JSON.stringify(denied), /private-path-sentinel|claude:other/u);
      }
      // Without the token there is no proof, so even the read is denied, never approved.
      assert.equal((await bindClaudeQueryWrite(call, { readToken: async () => null, now: () => NOW })).hookSpecificOutput.permissionDecision, "deny");
      assert.ok(hooks.hooks.PreToolUse.some((entry) => new RegExp(entry.matcher, "u").test(`mcp__plugin_pomegr_pomegr__${name}`)), name);
    }
  }
  // The hook passes add_task's Remote Control input through instead of denying the call.
  const remote = { hook_event_name: "PreToolUse", tool_name: "mcp__pomegr__add_task", tool_input: { text: "t", remote_control: true }, transcript_path };
  assert.deepEqual((await bindClaudeQueryWrite(remote, options)).hookSpecificOutput.updatedInput, { text: "t", remote_control: true, session_ref: REF, session_proof: proofFor("add_task") });
});
