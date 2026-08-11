import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { parseCodexCanonicalSkillUsage, parseCodexSkillUsageRecords } from "../monitor/providers/codex-skill-usage.mjs";
import { assertNoPrivateFixtureSentinels } from "./helpers/provider-fixtures.mjs";

const responseCall = (timestamp, name, input, type = "function_call") => ({
  timestamp,
  type: "response_item",
  payload: {
    type,
    name,
    call_id: `${name}-${timestamp}`,
    [type === "custom_tool_call" ? "input" : "arguments"]: JSON.stringify(input),
  },
});

test("counts only explicit recognized Codex skill invocation records", () => {
  const usage = parseCodexSkillUsageRecords([
    { timestamp: "2026-08-11T16:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: "Use documents:documents" } },
    { timestamp: "2026-08-11T16:00:01.000Z", type: "turn_context", payload: { available_skills: ["mentioned-only"] } },
    responseCall("2026-08-11T16:00:02.000Z", "Skill", { skill: "documents:documents", args: "MCP_ARGUMENT_MUST_NOT_LEAK" }),
    responseCall("2026-08-11T16:00:03.000Z", "invoke_skill", { skill: "github:gh-fix-ci" }, "custom_tool_call"),
    { timestamp: "2026-08-11T16:00:04.000Z", type: "event_msg", payload: { type: "skill_invocation", skill: "documents:documents", prompt: "PROMPT_MUST_NOT_LEAK" } },
    responseCall("2026-08-11T16:00:05.000Z", "read", { skill: "not-invoked" }),
    responseCall("2026-08-11T16:00:06.000Z", "Skill", { skill: "unsafe skill\nPROMPT_MUST_NOT_LEAK" }),
  ]);

  assert.deepEqual(usage, [
    { name: "documents:documents", calls: 2, lastUsed: "2026-08-11T16:00:04.000Z" },
    { name: "github:gh-fix-ci", calls: 1, lastUsed: "2026-08-11T16:00:03.000Z" },
  ]);
  assertNoPrivateFixtureSentinels(usage, "Codex skill evidence");
});

test("supports documented canonical skill tool calls and attaches rollout usage to the actor", async (context) => {
  assert.deepEqual(parseCodexCanonicalSkillUsage([{
    startedAt: Date.parse("2026-08-11T16:30:00.000Z") / 1000,
    items: [{ type: "dynamicToolCall", tool: "invoke_skill", arguments: { skill: "pdf:pdf", private: "MCP_ARGUMENT_MUST_NOT_LEAK" } }],
  }]), [{ name: "pdf:pdf", calls: 1, lastUsed: "2026-08-11T16:30:00.000Z" }]);

  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-skills-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "11");
  await mkdir(directory, { recursive: true });
  const records = [
    { timestamp: "2026-08-11T17:00:00.000Z", type: "session_meta", payload: { id: "skill-parent", cwd: "C:\\synthetic\\repo", source: "cli" } },
    responseCall("2026-08-11T17:00:01.000Z", "Skill", { skill: "documents:documents", args: "MCP_ARGUMENT_MUST_NOT_LEAK" }),
    responseCall("2026-08-11T17:00:02.000Z", "Skill", { skill: "documents:documents" }),
  ];
  await writeFile(path.join(directory, "rollout-skills.jsonl"), `${records.map(JSON.stringify).join("\n")}\n`, "utf8");
  const evidence = await createCodexProvider({ codexHome: root, cacheMs: 0, includeArchived: false })
    .readSession("skill-parent", { historical: true });

  assert.deepEqual(evidence.agents.find((agent) => agent.id === "primary").skills, [
    { name: "documents:documents", calls: 2, lastUsed: "2026-08-11T17:00:02.000Z" },
  ]);
  assertNoPrivateFixtureSentinels(evidence, "Codex provider skill evidence");
});
