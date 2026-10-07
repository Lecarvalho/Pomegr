import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createClaudeSourceEventRouter } from "../../../../server/providers/claude/source-routing.mjs";

const projectsRoot = path.resolve("synthetic-claude-projects");
const main = path.join(projectsRoot, "fixture-project", "session-one.jsonl");

test("a main transcript the observer already reads is routed as a known source that still refreshes the catalog", async () => {
  const route = createClaudeSourceEventRouter(projectsRoot);
  assert.deepEqual(await route({ candidate: main, eventType: "change", knownSessionIds: ["session-one"] }),
    { catalog: true, sessionIds: ["session-one"], sourceKnown: true });
});

test("a main transcript no session reads yet is not a known source", async () => {
  const route = createClaudeSourceEventRouter(projectsRoot);
  assert.deepEqual(await route({ candidate: main, eventType: "change" }),
    { catalog: true, sessionIds: ["session-one"], sourceKnown: false });
});

test("a known subagent transcript write is a known source and leaves the catalog alone", async () => {
  const route = createClaudeSourceEventRouter(projectsRoot);
  const agent = path.join(projectsRoot, "fixture-project", "session-one", "subagents", "agent-a.jsonl");
  assert.deepEqual(await route({ candidate: agent, eventType: "change", knownSessionIds: ["session-one"] }),
    { catalog: false, sessionIds: ["session-one"], sourceKnown: true });
});
