import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  mergeCodexActivityEvents,
  parseCodexAssistantReplyRecords,
  parseCodexCanonicalActivityEvents,
  parseCodexActivityRecords,
  parseCodexCanonicalTurns,
} from "../monitor/providers/codex-activity-events.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { createCodexIncrementalObserver } from "../monitor/providers/codex-observation.mjs";
import {
  assertNoPrivateFixtureSentinels,
  monitorStateFromProviderEvidence,
  readProviderFixture,
  readProviderJsonlFixture,
} from "./helpers/provider-fixtures.mjs";

const ACTOR = { id: "primary", label: "Primary agent" };
const STARTED_SECONDS = Date.parse("2026-08-10T19:00:00.000Z") / 1000;
const COMPLETED_SECONDS = Date.parse("2026-08-10T19:00:02.000Z") / 1000;

test("normalizes delivered Codex assistant text without retaining content or counting it as a tool", () => {
  const records = [
    { timestamp: "2026-08-10T19:00:00.000Z", type: "event_msg", payload: {
      type: "agent_message", id: "reply-1", phase: "final_answer", message: "RESPONSE_MUST_NOT_LEAK",
    } },
    { timestamp: "2026-08-10T19:00:00.000Z", type: "response_item", payload: {
      type: "message", id: "reply-1", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "RESPONSE_MUST_NOT_LEAK" }],
    } },
    { timestamp: "2026-08-10T19:00:01.000Z", type: "event_msg", payload: {
      type: "item_completed", item: { type: "agent_message", id: "reply-2", text: "SAME_REPLY_MUST_NOT_LEAK" },
    } },
    { timestamp: "2026-08-10T19:00:01.000Z", type: "response_item", payload: {
      type: "message", id: "reply-3", role: "assistant",
      content: [{ type: "output_text", text: "SAME_REPLY_MUST_NOT_LEAK" }],
    } },
    { timestamp: "2026-08-10T19:00:02.000Z", type: "event_msg", payload: {
      type: "agent_reasoning", text: "REASONING_MUST_NOT_LEAK",
    } },
    { timestamp: "2026-08-10T19:00:03.000Z", type: "event_msg", payload: {
      type: "user_message", message: "PROMPT_MUST_NOT_LEAK",
    } },
    { timestamp: "2026-08-10T19:00:04.000Z", type: "response_item", payload: {
      type: "function_call", name: "shell_command", call_id: "tool-1", arguments: "{}",
    } },
    { timestamp: "2026-08-10T19:00:05.000Z", type: "event_msg", payload: {
      type: "agent_message", synthetic: true, message: "SYNTHETIC_MUST_NOT_LEAK",
    } },
    { timestamp: "2026-08-10T19:00:06.000Z", type: "response_item", payload: {
      type: "message", role: "assistant", channel: "reasoning",
      content: [{ type: "output_text", text: "REASONING_CHANNEL_MUST_NOT_LEAK" }],
    } },
  ];
  const events = parseCodexAssistantReplyRecords(records, { actor: ACTOR, sourceKey: "reply-fixture" });

  assert.equal(events.length, 3);
  assert.deepEqual(events.map(({ tool, workKind, detail, status }) => ({ tool, workKind, detail, status })), [
    { tool: "Assistant replied", workKind: "report", detail: "", status: null },
    { tool: "Assistant replied", workKind: "report", detail: "", status: null },
    { tool: "Assistant replied", workKind: "report", detail: "", status: null },
  ]);
  assert.equal(new Set(events.map((event) => event.id)).size, 3);
  assertNoPrivateFixtureSentinels(events, "Codex assistant reply activity");
  assert.doesNotMatch(JSON.stringify(events), /RESPONSE|REASONING|PROMPT|message|text|phase/iu);
});

test("pairs id-less event and response mirrors while retaining repeated identical replies", () => {
  const records = [
    { timestamp: "2026-08-10T19:00:00.000Z", type: "event_msg", payload: {
      type: "agent_message", phase: "final_answer", message: "SAME_REPLY_MUST_NOT_LEAK",
    } },
    { timestamp: "2026-08-10T19:00:00.250Z", type: "response_item", payload: {
      type: "message", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "SAME_REPLY_MUST_NOT_LEAK" }],
    } },
    { timestamp: "2026-08-10T19:00:01.000Z", type: "event_msg", payload: {
      type: "agent_message", phase: "final_answer", message: "SAME_REPLY_MUST_NOT_LEAK",
    } },
    { timestamp: "2026-08-10T19:00:01.250Z", type: "response_item", payload: {
      type: "message", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "SAME_REPLY_MUST_NOT_LEAK" }],
    } },
  ];
  const options = { actor: ACTOR, sourceKey: "reply-fixture" };
  const events = parseCodexAssistantReplyRecords(records, options);

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.timestamp), [
    "2026-08-10T19:00:00.250Z",
    "2026-08-10T19:00:01.250Z",
  ]);
  assert.notEqual(events[0].id, events[1].id);
  assert.equal(parseCodexAssistantReplyRecords(records.slice(0, 1), options)[0].id, events[0].id);
  assert.equal(parseCodexAssistantReplyRecords(records.slice(2), options)[0].id, events[1].id);
  const boundary = { type: "event_msg", timestamp: records[0].timestamp, payload: { type: "task_started", turn_id: "next" } };
  assert.equal(parseCodexAssistantReplyRecords([records[0], boundary, records[1]], options).length, 2);
  assertNoPrivateFixtureSentinels(events, "id-less Codex assistant reply mirrors");
});

test("omits unobserved timestamps, reasoning-channel messages, and synthetic replies", () => {
  const payload = { type: "message", id: "reply", role: "assistant", content: [{ type: "output_text", text: "RESPONSE_MUST_NOT_LEAK" }] };
  for (const record of [
    { type: "response_item", payload },
    { type: "response_item", timestamp: "invalid", payload },
    { type: "response_item", timestamp: "2026-08-10T19:00:00Z", payload: { ...payload, channel: "analysis" } },
    { type: "response_item", timestamp: "2026-08-10T19:00:00Z", payload: { ...payload, synthetic: true } },
  ]) assert.deepEqual(parseCodexAssistantReplyRecords([record], { fallbackTimestamp: "2026-08-10T19:00:00Z" }), []);
  assert.deepEqual(parseCodexCanonicalActivityEvents([{ startedAt: STARTED_SECONDS, items: [payload] }], { fallbackTimestamp: "2026-08-10T19:00:00Z" }), []);
  assert.deepEqual(mergeCodexActivityEvents([[{ id: "bounded", timestamp: "2026-08-10T19:00:00Z" }]], 0), []);
});

test("Codex observer retains reply events across mirror appends and unrelated tail growth", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-replies-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "root.jsonl");
  const event = (timestamp) => ({ type: "event_msg", timestamp, payload: { type: "agent_message", phase: "final_answer", message: "PRIVATE_REPLY" } });
  const response = (timestamp) => ({ type: "response_item", timestamp, payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "PRIVATE_REPLY" }] } });
  const lines = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  await writeFile(file, lines([event("2026-08-10T19:00:00Z")]));
  const published = [];
  const observer = createCodexIncrementalObserver({
    list: async () => [{ localId: "root", isLive: true }],
    discoveredMetadata: async () => [{ localId: "root", sessionId: "root", rolloutFile: file }],
    transcriptPathsBySessionId: new Map(), watchTargets: [], catalogWatchTargets: [], intervalMs: 60_000,
    async readEvidence(_id, options) {
      const records = options.completeStory
        ? (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse)
        : options.incrementalRecordsByFile.get(file) || [];
      return { localId: "root", historical: false, session: {}, agents: [{ ...ACTOR, skills: [], toolCalls: 0 }],
        workflows: [], usageSnapshots: [], toolCalls: [], activity: parseCodexAssistantReplyRecords(records), planTasks: [], compactions: [],
        efficiencyRuleEvidence: {}, pullRequestCreations: [] };
    },
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, invalidateSession() {}, publishSession(_id, evidence) { published.push(evidence); } }, controller.signal);
  await observer.hydrate("root");
  const initial = published.at(-1).activity[0];
  await appendFile(file, lines([response("2026-08-10T19:00:00.250Z")]));
  await observer.hydrate("root");
  assert.equal(published.at(-1).activity.length, 1);
  assert.equal(published.at(-1).activity[0].id, initial.id);
  const filler = Array.from({ length: 40 }, () => ({ type: "unknown", value: "PRIVATE_FILLER".repeat(2000) }));
  await appendFile(file, lines([...filler, event("2026-08-10T19:10:00Z"), response("2026-08-10T19:10:00.250Z")]));
  await observer.hydrate("root");
  assert.equal(published.at(-1).activity.length, 2);
  assert.equal(published.at(-1).toolCalls.length, 0);
  assert.equal(published.at(-1).usageSnapshots.length, 0);
  assert.doesNotMatch(JSON.stringify(published.at(-1).activity), /PRIVATE|message|phase|text/);
});

test("uses the latest observed rollout timestamp for streamed same-id assistant text", () => {
  const events = parseCodexAssistantReplyRecords([
    { timestamp: "2026-08-10T19:00:00.000Z", type: "event_msg", payload: {
      type: "agent_message", id: "stream-1", phase: "final_answer", message: "FIRST_FRAGMENT_MUST_NOT_LEAK",
    } },
    { timestamp: "2026-08-10T19:00:00.500Z", type: "response_item", payload: {
      type: "message", id: "stream-1", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "COMPLETE_REPLY_MUST_NOT_LEAK" }],
    } },
  ], { actor: ACTOR, sourceKey: "reply-fixture" });

  assert.equal(events.length, 1);
  assert.equal(events[0].timestamp, "2026-08-10T19:00:00.500Z");
  assertNoPrivateFixtureSentinels(events, "streamed Codex assistant reply");
});

test("normalizes canonical agent messages and merges only matching mirror identities", () => {
  const canonical = parseCodexCanonicalActivityEvents([{
    id: "turn-replies",
    completedAt: COMPLETED_SECONDS,
    items: [
      { type: "agentMessage", id: "reply-1", phase: "final_answer", text: "RESPONSE_MUST_NOT_LEAK" },
      { type: "message", id: "reply-2", timestamp: "2026-08-10T19:00:01.000Z", role: "assistant", content: [{ type: "output_text", text: "SAME_REPLY_MUST_NOT_LEAK" }] },
      { type: "reasoning", id: "reasoning-1", summary: [{ type: "summary_text", text: "REASONING_MUST_NOT_LEAK" }] },
      { type: "message", id: "user-1", role: "user", content: [{ type: "input_text", text: "PROMPT_MUST_NOT_LEAK" }] },
    ],
  }], { actor: ACTOR });
  const rollout = parseCodexAssistantReplyRecords([
    { timestamp: "2026-08-10T19:00:02.000Z", type: "response_item", payload: {
      type: "message", id: "reply-1", role: "assistant", content: [{ type: "output_text", text: "RESPONSE_MUST_NOT_LEAK" }],
    } },
  ], { actor: ACTOR, sourceKey: "reply-fixture" });
  const merged = mergeCodexActivityEvents([canonical, rollout]);

  assert.equal(canonical.length, 2);
  assert.equal(merged.length, 2);
  assertNoPrivateFixtureSentinels(merged, "canonical Codex assistant reply activity");
  assert.doesNotMatch(JSON.stringify(merged), /RESPONSE|REASONING|PROMPT|message|text|phase/iu);
});

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
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-activity-"));
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
      items: [
        { id: "command-1", type: "commandExecution", command: "COMMAND_MUST_NOT_LEAK", commandActions: [], cwd: "C:\\synthetic\\repo", status: "completed" },
        { id: "reply-1", type: "agentMessage", phase: "final_answer", text: "RESPONSE_MUST_NOT_LEAK" },
      ],
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
  assert.equal(evidence.activity.length, 1);
  assert.deepEqual(evidence.activity[0], {
    id: evidence.activity[0].id,
    timestamp: "2026-08-10T19:00:02.000Z",
    actor: "Primary agent",
    tool: "Assistant replied",
    workKind: "report",
    detail: "",
    status: null,
  });
  assert.equal(monitorStateFromProviderEvidence("codex", evidence).metrics.toolCalls, 6);
  assertNoPrivateFixtureSentinels(evidence, "merged Codex provider evidence");
  assertNoPrivateFixtureSentinels(monitorStateFromProviderEvidence("codex", evidence), "Codex activity MonitorState");
});
