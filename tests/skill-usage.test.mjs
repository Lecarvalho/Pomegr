import assert from "node:assert/strict";
import test from "node:test";
import { buildSkillUsage, normalizedSkillName } from "../monitor/skill-usage.mjs";

const skillCall = (skill, timestamp) => ({
  type: "assistant",
  timestamp,
  message: { content: [{ type: "tool_use", name: "Skill", input: { skill, args: "PRIVATE SKILL ARGUMENTS" } }] },
});

test("groups explicit skill invocations and records the latest use", () => {
  const usage = buildSkillUsage([
    skillCall("documents:documents", "2026-08-06T13:00:00.000Z"),
    skillCall("github:gh-fix-ci", "2026-08-06T13:02:00.000Z"),
    skillCall("documents:documents", "2026-08-06T13:04:00.000Z"),
  ]);

  assert.deepEqual(usage, [
    { name: "documents:documents", calls: 2, lastUsed: "2026-08-06T13:04:00.000Z" },
    { name: "github:gh-fix-ci", calls: 1, lastUsed: "2026-08-06T13:02:00.000Z" },
  ]);
  assert.doesNotMatch(JSON.stringify(usage), /PRIVATE SKILL ARGUMENTS/);
});

test("ignores available, mentioned, and unsafe skill values", () => {
  assert.deepEqual(buildSkillUsage([
    { type: "user", message: { content: "Use documents:documents" } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { skill: "not-invoked" } }] } },
    skillCall("PRIVATE PROMPT\nsecond line", "2026-08-06T13:00:00.000Z"),
  ]), []);
  assert.equal(normalizedSkillName({ skill: " github:gh-fix-ci " }), "github:gh-fix-ci");
  assert.equal(normalizedSkillName({ skill: "contains spaces" }), "");
  assert.equal(normalizedSkillName({ args: "documents:documents" }), "");
});
