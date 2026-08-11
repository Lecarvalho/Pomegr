import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseCodexActivityRecords,
  parseCodexCanonicalTurns,
} from "../monitor/providers/codex-activity-events.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import {
  assertNoPrivateFixtureSentinels,
  monitorStateFromProviderEvidence,
  readProviderFixture,
  readProviderJsonlFixture,
} from "./helpers/provider-fixtures.mjs";

const ACTOR = { id: "primary", label: "Primary agent" };
const STARTED_SECONDS = Date.parse("2026-08-10T19:00:00.000Z") / 1000;
const COMPLETED_SECONDS = Date.parse("2026-08-10T19:00:02.000Z") / 1000;

test("normalizes canonical Codex items with bounded safe targets and lifecycle status", () => {
  const calls = parseCodexCanonicalTurns([{
    id: "turn-activity",
    status: "completed",
    startedAt: STARTED_SECONDS,
    completedAt: COMPLETED_SECONDS,
    items: [
      { id: "command", type: "commandExecution", command: "COMMAND_MUST_NOT_LEAK", commandActions: [{ command: "STDOUT_MUST_NOT_LEAK" }], cwd: "C:\\PRIVATE_PATH_MUST_NOT_LEAK", status: "failed" },
      { id: "change", type: "fileChange", changes: [{ path: "C:\\PRIVATE_PATH_MUST_NOT_LEAK\\handler.ts", kind: { type: "update" }, diff: "@@ handler @@\n-PATCH_MUST_NOT_LEAK\n+RESPONSE_MUST_NOT_LEAK" }], status: "completed" },
      { id: "mcp", type: "mcpToolCall", server: "synthetic", tool: "lookup", arguments: { private: "MCP_ARGUMENT_MUST_NOT_LEAK" }, status: "completed" },
      { id: "dynamic", type: "dynamicToolCall", namespace: "fixture", tool: "inspect", arguments: { private: "PROMPT_MUST_NOT_LEAK" }, status: "inProgress" },
      { id: "collab", type: "collabAgentToolCall", tool: "spawnAgent", prompt: "DEVELOPER_INSTRUCTIONS_MUST_NOT_LEAK", senderThreadId: "root", receiverThreadIds: ["child"], status: "completed" },
      { id: "web", type: "webSearch", action: { type: "search", query: "PROMPT_MUST_NOT_LEAK" }, query: "PROMPT_MUST_NOT_LEAK" },
      { id: "image-view", type: "imageView", path: "C:\\PRIVATE_PATH_MUST_NOT_LEAK\\preview.png" },
      { id: "image-gen", type: "imageGeneration", revisedPrompt: "PROMPT_MUST_NOT_LEAK", result: "TOOL_OUTPUT_MUST_NOT_LEAK", status: "completed" },
      { id: "sleep", type: "sleep", durationMs: 1250 },
      { id: "unknown", type: "futurePrivateItem", content: "RESPONSE_MUST_NOT_LEAK" },
    ],
  }], { actor: ACTOR });

  assert.deepEqual(calls.map(({ tool, detail, status }) => ({ tool, detail, status })).sort((left, right) => left.tool.localeCompare(right.tool)), [
    { tool: "Dynamic tool", detail: "fixture / inspect", status: "running" },
    { tool: "Shell", detail: "Command execution", status: "failed" },
    { tool: "File change", detail: "handler.ts", status: "completed" },
    { tool: "Image generation", detail: "Generate image", status: "completed" },
    { tool: "MCP", detail: "synthetic / lookup", status: "completed" },
    { tool: "Spawn agent", detail: "", status: "completed" },
    { tool: "View image", detail: "preview.png", status: "completed" },
    { tool: "Wait", detail: "1250ms", status: "completed" },
    { tool: "Web search", detail: "Search", status: "completed" },
  ].sort((left, right) => left.tool.localeCompare(right.tool)));
  assert.equal(calls.find((call) => call.tool === "File change").mutation.scopes.length, 1);
  assertNoPrivateFixtureSentinels(calls, "canonical Codex activity");
  assert.doesNotMatch(JSON.stringify(calls), /commandActions|arguments|prompt|query|diff|futurePrivateItem/);
});

test("pairs rollout calls with outputs, ignores unknown records, and hashes materially different inputs", async () => {
  const { records } = await readProviderJsonlFixture("codex/parent.jsonl");
  const calls = parseCodexActivityRecords(records, { actor: ACTOR, sourceKey: "fixture-parent" });

  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map((call) => call.tool), [
    "Shell",
    "File change",
    "MCP",
    "Dynamic tool",
    "Spawn agent",
    "Request input",
  ]);
  assert.equal(calls.every((call) => call.status === "completed"), true);
  assert.equal(new Set(calls.map((call) => call.id)).size, calls.length);
  assertNoPrivateFixtureSentinels(calls, "rollout Codex activity");

  const variants = parseCodexActivityRecords([
    { timestamp: "2026-08-10T20:00:00.000Z", type: "response_item", payload: { type: "function_call", name: "mcp__fixture__lookup", call_id: "one", arguments: "{\"key\":\"PROMPT_MUST_NOT_LEAK\"}" } },
    { timestamp: "2026-08-10T20:00:01.000Z", type: "response_item", payload: { type: "function_call", name: "mcp__fixture__lookup", call_id: "two", arguments: "{\"key\":\"ANSWER_MUST_NOT_LEAK\"}" } },
    { timestamp: "2026-08-10T20:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "mcp__fixture__lookup", call_id: "three", arguments: "{\"key\":\"PROMPT_MUST_NOT_LEAK\"}" } },
    { timestamp: "2026-08-10T20:00:03.000Z", type: "future_record", payload: { type: "private", content: "RESPONSE_MUST_NOT_LEAK" } },
  ], { actor: ACTOR, sourceKey: "variants" });
  assert.notEqual(variants[0].repetitionSignature, variants[1].repetitionSignature);
  assert.equal(variants[0].repetitionSignature, variants[2].repetitionSignature);
  assertNoPrivateFixtureSentinels(variants, "Codex repetition evidence");
});

test("provider merges rollout and canonical duplicates while agent and grouped totals agree", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-activity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "10");
  await mkdir(directory, { recursive: true });
  const fixture = (await readProviderFixture("codex/parent.jsonl")).replaceAll("PRIVATE_PATH_MUST_NOT_LEAK", "synthetic");
  await writeFile(path.join(directory, "rollout-parent.jsonl"), fixture, "utf8");
  await writeFile(path.join(root, "session_index.jsonl"), `${JSON.stringify({
    id: "codex-fixture-parent",
    thread_name: "Activity fixture",
    updated_at: "2026-08-10T20:00:00.000Z",
  })}\n`, "utf8");
  const canonical = {
    id: "codex-fixture-parent",
    sessionId: "codex-fixture-parent",
    parentThreadId: null,
    preview: "PROMPT_MUST_NOT_LEAK",
    ephemeral: false,
    createdAt: STARTED_SECONDS,
    updatedAt: COMPLETED_SECONDS,
    source: "cli",
    cwd: "C:\\synthetic\\repo",
    gitInfo: { branch: "codex/activity" },
    name: "Activity fixture",
    status: { type: "notLoaded" },
    turns: [{
      id: "canonical-turn",
      status: "completed",
      startedAt: STARTED_SECONDS,
      completedAt: COMPLETED_SECONDS,
      items: [{ id: "command-1", type: "commandExecution", command: "COMMAND_MUST_NOT_LEAK", commandActions: [], cwd: "C:\\synthetic\\repo", status: "completed" }],
    }],
  };
  const appServer = {
    async listThreads() { return { data: [canonical] }; },
    async readThread({ threadId, includeTurns }) {
      return threadId === canonical.id ? { thread: { ...canonical, turns: includeTurns ? canonical.turns : [] } } : null;
    },
  };
  const evidence = await createCodexProvider({ codexHome: root, appServer, cacheMs: 0, includeArchived: false })
    .readSession("codex-fixture-parent", { historical: true });
  const grouped = new Map();
  for (const call of evidence.toolCalls) {
    const key = `${call.actor.id}|${call.tool}|${call.detail}`;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }

  assert.equal(evidence.toolCalls.length, 6);
  assert.equal(evidence.agents.reduce((total, agent) => total + agent.toolCalls, 0), evidence.toolCalls.length);
  assert.equal([...grouped.values()].reduce((total, count) => total + count, 0), evidence.toolCalls.length);
  assert.equal(evidence.toolCalls.filter((call) => call.tool === "Shell").length, 1);
  assertNoPrivateFixtureSentinels(evidence, "merged Codex provider evidence");
  assertNoPrivateFixtureSentinels(monitorStateFromProviderEvidence("codex", evidence), "Codex activity MonitorState");
});
