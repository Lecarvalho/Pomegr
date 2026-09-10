import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { claudeLifecycleSource } from "../monitor/providers/claude-session-status.mjs";
import { incrementalSourceSetDescriptor } from "../monitor/providers/incremental-provider-observer.mjs";
import { monitorStateFromProviderEvidence } from "./helpers/provider-fixtures.mjs";
import { buildActivityFeed, recentActivityEvents, shellFailureActivityEvents } from "../monitor/activity-events.mjs";
import { SessionObservationCheckpointStore } from "../monitor/session-observation-checkpoints.mjs";
import { claudeConversationActivity, claudeTaskNotificationActivity, createClaudeActivityReader, userInputContentType } from "../monitor/providers/claude-activity-events.mjs";

function assistantReply(id, timestamp = "2026-09-07T18:47:00.000Z") {
  return { type: "assistant", uuid: `PRIVATE_RECORD_${id}`, timestamp, message: {
    id, model: "claude-test", content: [{ type: "text", text: "PRIVATE_REPLY" }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 },
  } };
}

function awaySummary(timestamp = "2026-09-07T18:48:00.000Z") {
  return { type: "system", subtype: "away_summary", uuid: "PRIVATE_SUMMARY_ID", timestamp, content: "PRIVATE_SUMMARY" };
}

test("Claude conversation events deduplicate reply fragments and keep summary updates separate", () => {
  const reply = assistantReply("PRIVATE_MESSAGE_ID");
  const later = { ...reply, uuid: "PRIVATE_FRAGMENT_ID", timestamp: "2026-09-07T18:47:02.000Z" };
  const summary = awaySummary();
  const events = claudeConversationActivity([reply, later, reply, summary, summary]);
  assert.deepEqual(events.map(({ id, ...event }) => event), [
    { timestamp: later.timestamp, actor: "Primary agent", tool: "Assistant replied", workKind: "report", detail: "", status: null },
    { timestamp: summary.timestamp, actor: "System", tool: "Summary updated", workKind: "report", detail: "", status: null },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|content|usage|claude-test/);
  const distinct = claudeConversationActivity([reply, assistantReply("PRIVATE_OTHER_ID")]);
  assert.equal(distinct.length, 2, "identical reply text from separate requests remains separate");
  const child = claudeConversationActivity([reply], { id: "child", label: "Builder" });
  assert.equal(child[0].actor, "Builder");
  assert.notEqual(child[0].id, events[0].id);
  assert.equal(claudeConversationActivity([{ ...reply, message: { ...reply.message, usage: undefined } }]).length, 1,
    "delivered text does not require token usage to be an activity event");
  assert.equal(claudeConversationActivity(Array.from({ length: 300 }, (_, i) => assistantReply(`reply-${i}`))).length, 256);
});

test("Claude conversation events reject synthetic, private, malformed, and lookalike records", () => {
  const reply = assistantReply("reply");
  for (const record of [
    { ...reply, timestamp: "invalid" }, { ...reply, timestamp: null },
    { ...reply, type: "user" }, { ...reply, isMeta: true }, { ...reply, isCompactSummary: true },
    { ...reply, isApiErrorMessage: true },
    { ...reply, message: { ...reply.message, model: "<synthetic>" } },
    { ...reply, message: { ...reply.message, usage: { synthetic: true } } },
    { ...reply, message: { ...reply.message, content: [{ type: "thinking", thinking: "PRIVATE_THINKING" }] } },
    { ...reply, message: { ...reply.message, content: [{ type: "tool_use", text: "PRIVATE_TOOL" }] } },
    { ...reply, message: { ...reply.message, content: [{ type: "text", text: " " }] } },
    { ...reply, uuid: null, message: { ...reply.message, id: null } },
    { ...awaySummary(), type: "user" }, { ...awaySummary(), subtype: "compact_boundary" },
    { ...awaySummary(), content: " " }, { ...awaySummary(), timestamp: "invalid" },
  ]) assert.deepEqual(claudeConversationActivity([record]), []);
});

test("classifies direct user input without exposing its content", () => {
  assert.equal(userInputContentType({ type: "user", message: { content: "PRIVATE PROMPT" } }), "Text");
  assert.equal(userInputContentType({ type: "user", message: { content: [{ type: "image", source: { media_type: "image/png", data: "PRIVATE IMAGE" } }] } }), "Image");
  assert.equal(userInputContentType({ type: "user", message: { content: [{ type: "document", source: { media_type: "application/pdf", data: "PRIVATE DOCUMENT" } }] } }), "Document");
  assert.equal(userInputContentType({ type: "user", isMeta: true, message: { content: "INTERNAL META" } }), null);
  assert.equal(userInputContentType({ type: "assistant", message: { content: "NOT USER INPUT" } }), null);
});

test("recognizes answers to input requests but excludes ordinary tool results", () => {
  const answer = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "question-1", content: "PRIVATE ANSWER" }] } };
  assert.equal(userInputContentType(answer, new Set(["question-1"])), "Text");
  assert.equal(userInputContentType(answer, new Set(["shell-1"])), null);
});

test("uses a stable order for every content-type combination", () => {
  const blocks = {
    text: { type: "text", text: "PRIVATE TEXT" },
    document: { type: "document", source: { media_type: "application/pdf", data: "PRIVATE DOCUMENT" } },
    image: { type: "image", source: { media_type: "image/jpeg", data: "PRIVATE IMAGE" } },
  };
  const classify = (...kinds) => userInputContentType({ type: "user", message: { content: kinds.map((kind) => blocks[kind]) } });

  assert.equal(classify("text", "document"), "Text + Document");
  assert.equal(classify("document", "image"), "Document + Image");
  assert.equal(classify("text", "document", "image"), "Text + Document + Image");
  assert.equal(classify("text", "image"), "Text + Image");
});

test("creates sanitized activity events only for finished shell failures", () => {
  const events = shellFailureActivityEvents([
    { id: "toolu_failed", label: "Run tests", status: "failed", startedAt: "2026-08-07T14:31:55.000Z", finishedAt: "2026-08-07T14:32:00.000Z", exitCode: 1, command: "PRIVATE COMMAND", output: "PRIVATE OUTPUT" },
    { id: "toolu_unknown", label: "Check formatting", status: "failed", finishedAt: "2026-08-07T14:33:00.000Z", exitCode: null },
    { id: "toolu_running", label: "Build app", status: "running", finishedAt: null, exitCode: null },
    { id: "toolu_complete", label: "Lint app", status: "completed", finishedAt: "2026-08-07T14:34:00.000Z", exitCode: 0 },
  ]);

  assert.deepEqual(events, [
    {
      id: "toolu_failed-failed",
      timestamp: "2026-08-07T14:32:00.000Z",
      actor: "Primary agent",
      tool: "Shell failed",
      workKind: "shell",
      detail: "Run tests · exit 1",
      status: "failed",
      durationMs: 5_000,
      requestId: null,
    },
    {
      id: "toolu_unknown-failed",
      timestamp: "2026-08-07T14:33:00.000Z",
      actor: "Primary agent",
      tool: "Shell failed",
      workKind: "shell",
      detail: "Check formatting",
      status: "failed",
      durationMs: null,
      requestId: null,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|command|output/i);
});

test("bounds recent activity and resolves timestamp ties deterministically", () => {
  const events = Array.from({ length: 35 }, (_, index) => ({
    id: `event-${String(34 - index).padStart(2, "0")}`,
    timestamp: index < 2 ? "2026-08-10T15:00:35.000Z" : `2026-08-10T15:00:${String(index).padStart(2, "0")}.000Z`,
    actor: "Primary agent",
    tool: "Tool",
    detail: "Safe detail",
    status: index === 34 ? "failed" : "completed",
  }));
  const recent = recentActivityEvents(events);
  assert.equal(recent.length, 35);
  assert.deepEqual(recent.slice(0, 2).map((event) => event.id), ["event-33", "event-34"]);
  assert.equal(recent.every((event) => event.status === null || event.status === "failed"), true);
  assert.equal(recent.every((event) => event.durationMs === null && event.requestId === null), true);
});

test("builds a 200-row served feed with full-retention activity aggregates", () => {
  const toolCalls = Array.from({ length: 256 }, (_, index) => ({
    id: `tool-${index}`,
    timestamp: `2026-08-10T15:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    actor: { id: "primary", label: "Primary agent" }, tool: "Read", workKind: index % 2 ? "read" : "shell",
    detail: "Safe", status: null, durationMs: index % 2 ? 100 : null, requestId: null,
  }));
  const feed = buildActivityFeed({ events: toolCalls, toolCalls, messages: 2, failed: 1 });
  assert.equal(feed.items.length, 200);
  assert.equal(feed.total, 256);
  assert.equal(feed.toolCalls, 256);
  assert.deepEqual(feed.byKind, [
    { kind: "read", count: 128, medianDurationMs: 100 },
    { kind: "shell", count: 128, medianDurationMs: null },
  ]);
  assert.equal(feed.messages, 2);
  assert.equal(feed.failed, 1);
  const evenMedian = buildActivityFeed({ toolCalls: [{ ...toolCalls[0], durationMs: 1 }, { ...toolCalls[2], durationMs: 2 }], events: [] });
  assert.equal(evenMedian.byKind.find((item) => item.kind === "shell").medianDurationMs, 1.5);
});

test("Claude stamps tool rows with their served request id and recorded duration", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-activity-request-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, ".claude", "projects", "fixture", "local.jsonl");
  const records = [
    { type: "user", timestamp: "2026-09-07T18:46:00.000Z", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "PRIVATE_EARLY_RESULT" }] } },
    { type: "assistant", timestamp: "2026-09-07T18:47:00.000Z", message: {
      id: "PRIVATE_REQUEST", model: "claude-test", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "fixture.ts" } }],
    } },
    { type: "user", timestamp: "2026-09-07T18:47:02.000Z", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "PRIVATE_RESULT" }] } },
  ];
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`);
  const state = monitorStateFromProviderEvidence("claude", await createClaudeProvider({ homeDir: root, env: {}, explicitSession: file }).readSession("local"));
  const tool = state.activity.items.find((event) => event.tool === "Read");
  assert.equal(tool.durationMs, 2_000);
  assert.equal(tool.requestId, state.metrics.tokens.requestSnapshots.items[0].id);
  assert.equal(state.activity.byKind.find((item) => item.kind === "read").medianDurationMs, 2_000);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_REQUEST|PRIVATE_RESULT|PRIVATE_EARLY_RESULT/);
});

test("all tool fragments of a subagent request link to one served request even after a final reply", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-streamed-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, ".claude", "projects", "fixture", "local.jsonl");
  const child = path.join(root, ".claude", "projects", "fixture", "local", "subagents", "agent-child.jsonl");
  const fragment = (second, content) => ({ type: "assistant", timestamp: `2026-09-07T18:47:0${second}.000Z`, message: {
    id: "PRIVATE_REQUEST", model: "claude-test", usage: { input_tokens: 10, output_tokens: second, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content,
  } });
  const records = [1, 2, 3].map((second) => fragment(second, [{ type: "tool_use", id: `PRIVATE_TOOL_${second}`, name: "Read", input: { file_path: "fixture.ts" } }]));
  records.push(fragment(4, [{ type: "text", text: "PRIVATE_REPLY" }]));
  await mkdir(path.dirname(child), { recursive: true });
  await writeFile(file, `${JSON.stringify({ type: "user", timestamp: "2026-09-07T18:47:00.000Z", message: { content: "PRIVATE_PROMPT" } })}\n`);
  await writeFile(child, `${records.map(JSON.stringify).join("\n")}\n`);
  const provider = createClaudeProvider({ homeDir: root, env: {}, explicitSession: file });
  for (const historical of [false, true]) {
    const evidence = await provider.readSession("local", { historical });
    const state = monitorStateFromProviderEvidence("claude", evidence);
    const calls = state.activity.items.filter((event) => event.tool === "Read");
    const request = state.metrics.tokens.requestSnapshots.items[0];
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.requestId === request.id));
    assert.deepEqual(request.issuedWork, [{ kind: "read", count: 3 }]);
    assert.equal(state.activity.items.find((event) => event.tool === "Assistant replied").requestId, request.id);
    assert.doesNotMatch(JSON.stringify(evidence), /issuedToolUse|replyActivityId|PRIVATE_REPLY|PRIVATE_PROMPT/);
  }
});

test("Claude reply-only requests link by recorded identity, including fragments and subagents, never by timing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-reply-request-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, ".claude", "projects", "fixture", "local.jsonl");
  const child = path.join(root, ".claude", "projects", "fixture", "local", "subagents", "agent-child.jsonl");
  const reply = assistantReply("PRIVATE_SAME_ID");
  const noUsage = assistantReply("PRIVATE_NO_USAGE");
  delete noUsage.message.usage;
  const unbounded = assistantReply("X".repeat(200));
  const fragment = { ...reply, timestamp: "2026-09-07T18:47:03.000Z", message: { ...reply.message, content: [] } };
  await mkdir(path.dirname(child), { recursive: true });
  await writeFile(file, [reply, noUsage, unbounded, fragment, { ...awaySummary(), content: "Session summary fixture" }, { type: "user", timestamp: reply.timestamp, message: { content: "PRIVATE_PROMPT" } }].map(JSON.stringify).join("\n") + "\n");
  await writeFile(child, JSON.stringify(reply) + "\n");
  const provider = createClaudeProvider({ homeDir: root, env: {}, explicitSession: file });
  for (const historical of [false, true]) {
    const evidence = await provider.readSession("local", { historical });
    const state = monitorStateFromProviderEvidence("claude", evidence);
    const requests = state.metrics.tokens.requestSnapshots.items;
    const primary = requests.find((request) => request.agentId === "primary" && request.observedAt === fragment.timestamp);
    const childRequest = requests.find((request) => request.agentId !== "primary");
    const replies = state.activity.items.filter((event) => event.tool === "Assistant replied");
    assert.equal(replies.length, 4);
    assert.equal(replies.find((event) => event.requestId === primary.id).timestamp, reply.timestamp,
      "a later usage fragment changes the snapshot timestamp without losing the earlier reply link");
    assert.ok(replies.some((event) => event.requestId === childRequest.id), "same native ID on another agent resolves independently");
    assert.equal(replies.filter((event) => event.requestId === null).length, 2, "missing usage and altered identities never acquire nearby links");
    assert.ok(state.activity.items.filter((event) => event.tool !== "Assistant replied").every((event) => event.requestId === null));
    assert.equal(state.activity.toolCalls, 0);
    assert.equal(state.activity.messages, 5);
    assert.deepEqual(state.activity.byKind, []);
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE|replyActivityId|replyIdsByRequest/);
    assert.doesNotMatch(JSON.stringify(evidence), /replyActivityId|replyIdsByRequest|PRIVATE_REPLY|PRIVATE_PROMPT/);
  }
});

function deliveredNotification(status = "completed", overrides = {}) {
  return {
    type: "user", uuid: "PRIVATE_RECORD_ID", timestamp: "2026-09-07T18:47:42.302Z",
    origin: { kind: "task-notification" }, promptSource: "system",
    message: { content: `<task-notification><task-id>PRIVATE_TASK_ID</task-id><status>${status}</status><summary>PRIVATE_SUMMARY</summary><output-file>PRIVATE_PATH</output-file></task-notification>` },
    ...overrides,
  };
}

test("Claude system deliveries are outcomes, while pasted notification text remains user input", () => {
  for (const [status, label] of [
    ["completed", "completed"], ["failed", "failed"], ["error", "failed"],
    ["stopped", "stopped"], ["killed", "stopped"], ["cancelled", "stopped"],
    ["canceled", "stopped"], ["interrupted", "stopped"],
  ]) {
    const record = deliveredNotification(status);
    assert.equal(userInputContentType(record), null);
    const events = claudeTaskNotificationActivity([record]);
    assert.equal(events.length, 1);
    assert.deepEqual({ ...events[0], id: "opaque" }, {
      id: "opaque", timestamp: record.timestamp, actor: "System", tool: `Task ${label}`,
      detail: "Background task", workKind: "process", status: label === "failed" ? "failed" : null,
    });
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|task-notification|promptSource|origin/);
    for (const overrides of [{ origin: undefined }, { promptSource: "user" }]) {
      const pasted = { ...record, ...overrides };
      assert.equal(userInputContentType(pasted), "Text");
      assert.deepEqual(claudeTaskNotificationActivity([pasted]), []);
    }
  }
});

test("Claude suppresses unsupported system deliveries without inventing an outcome or user input", () => {
  for (const record of [
    deliveredNotification("unknown"), deliveredNotification("running"),
    deliveredNotification("completed", { timestamp: "invalid" }),
    deliveredNotification("completed", { message: { content: "PRIVATE malformed content" } }),
    deliveredNotification("completed", { isCompactSummary: true }),
    deliveredNotification("completed", { message: { content: "<task-notification><status>completed</status></task-notification>" } }),
  ]) {
    assert.equal(userInputContentType(record), null);
    assert.deepEqual(claudeTaskNotificationActivity([record]), []);
  }
  assert.equal(claudeTaskNotificationActivity([deliveredNotification("completed", { isMeta: true })]).length, 1);
});

test("Claude delivery classification requires a matching prior structured background launch", () => {
  const notification = deliveredNotification();
  for (const [tool, result, detail, workKind] of [
    ["Agent", { status: "async_launched", isAsync: true, agentId: "PRIVATE_TASK_ID" }, "Background agent", "agent"],
    ["Bash", { backgroundTaskId: "PRIVATE_TASK_ID" }, "Background command", "shell"],
    ["Workflow", { status: "async_launched", taskType: "local_workflow", taskId: "PRIVATE_TASK_ID" }, "Background workflow", "agent"],
  ]) {
    const call = { type: "assistant", message: { content: [{ type: "tool_use", id: "PRIVATE_CALL_ID", name: tool, input: { command: "PRIVATE_COMMAND" } }] } };
    const response = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "PRIVATE_CALL_ID", content: "PRIVATE_OUTPUT" }] }, toolUseResult: result };
    const [event] = claudeTaskNotificationActivity([call, response, notification]);
    assert.equal(event.detail, detail);
    assert.equal(event.workKind, workKind);
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE/);
    for (const records of [
      [response, notification], [notification, call, response], [call, { ...response, toolUseResult: undefined }, notification],
      [call, { ...response, message: { content: [{ ...response.message.content[0], is_error: true }] } }, notification],
      [call, response, { ...notification, message: { content: notification.message.content.replace("<status>", "<tool-use-id>different-call</tool-use-id><status>") } }],
    ]) assert.equal(claudeTaskNotificationActivity(records)[0].detail, "Background task");
  }
});

test("Claude queue operations do not add delivery rows, and replayed delivery IDs are stable and bounded", () => {
  const delivered = deliveredNotification();
  const queue = { type: "queue-operation", operation: "enqueue", timestamp: delivered.timestamp, content: delivered.message.content };
  const events = claudeTaskNotificationActivity([queue, { ...queue, operation: "dequeue" }, delivered, delivered]);
  assert.equal(events.length, 1);
  assert.deepEqual(events, claudeTaskNotificationActivity([delivered]));
  const fallback = { ...delivered, uuid: undefined };
  assert.deepEqual(claudeTaskNotificationActivity([fallback, fallback]), claudeTaskNotificationActivity([fallback]));
  assert.equal(claudeTaskNotificationActivity(Array.from({ length: 300 }, (_, i) => ({ ...delivered, uuid: `record-${i}` }))).length, 256);
});

test("Claude notifications survive acquisition-tail growth, cold replay, and incomplete replacement", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-notification-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  const jsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const reader = createClaudeActivityReader();
  const notification = deliveredNotification();
  await writeFile(file, jsonl([notification, assistantReply("reply"), awaySummary()]));
  const original = await reader(file);
  assert.equal(original.length, 3);
  const renamed = await reader(file, { id: "primary", label: "Renamed agent" });
  assert.equal(renamed.find((event) => event.tool === "Assistant replied").actor, "Renamed agent");
  assert.equal(renamed.find((event) => event.tool === "Summary updated").actor, "System");
  const filler = { type: "system", content: "PRIVATE_FILLER".repeat(5000) };
  await appendFile(file, jsonl(Array.from({ length: 40 }, () => filler)));
  assert.deepEqual(await reader(file), original, "more than 2 MiB of non-activity cannot expire evidence");
  assert.deepEqual(await createClaudeActivityReader()(file), original, "cold replay reads beyond the tail");

  const replacement = jsonl([deliveredNotification("failed", { uuid: "replacement", timestamp: "2026-09-07T18:48:42.302Z" })]);
  await writeFile(file, replacement.slice(0, -3));
  assert.deepEqual(await reader(file), original);
  await appendFile(file, replacement.slice(-3));
  const replaced = await reader(file);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].tool, "Task failed");
  assert.notEqual(replaced[0].id, original[0].id);
  await writeFile(file, "malformed\n");
  assert.deepEqual(await reader(file), replaced);
  await rm(file);
  assert.deepEqual(await reader(file), replaced);
  await writeFile(file, jsonl([{ type: "system" }]));
  assert.deepEqual(await reader(file), [], "a complete valid replacement can remove obsolete evidence");
});

test("Claude replies and summaries reach live, historical, and checkpoint evidence without changing request metrics", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-conversation-events-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, ".claude", "projects", "fixture", "local.jsonl");
  const reply = assistantReply("PRIVATE_REQUEST_ID");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(reply)}\n`);
  const provider = createClaudeProvider({ homeDir: root, env: {}, explicitSession: file });
  const before = monitorStateFromProviderEvidence("claude", await provider.readSession("local"));
  await appendFile(file, `${JSON.stringify(awaySummary())}\n`);
  for (const historical of [false, true]) {
    const evidence = await provider.readSession("local", { historical });
    const state = monitorStateFromProviderEvidence("claude", evidence);
    assert.deepEqual(state.activity.items.map((event) => event.tool), ["Summary updated", "Assistant replied"]);
    assert.equal(state.activity.items[0].timestamp, awaySummary().timestamp);
    assert.equal(state.metrics.toolCalls, 0);
    assert.deepEqual(state.metrics.tokens.requestSnapshots, before.metrics.tokens.requestSnapshots,
      "a summary cannot create a request or advance Last request");
    assert.doesNotMatch(JSON.stringify(state.activity), /PRIVATE|content|usage|model/);
    const checkpoints = new SessionObservationCheckpointStore({ directory: path.join(root, "checkpoints") });
    const written = await checkpoints.write({
      providerId: "claude", localSessionId: "local", evidence: { activity: evidence.activity },
      revision: 1, readiness: { core: "ready", activityEvidence: "ready" },
      observedAt: awaySummary().timestamp, source: { fingerprint: "safe-fingerprint", completeOffset: 42 },
    });
    const persisted = JSON.parse(await readFile(path.join(root, "checkpoints", written.filename), "utf8"));
    assert.doesNotMatch(JSON.stringify(persisted.evidence.activity), /PRIVATE|content|usage|model/);
    const loaded = await checkpoints.load();
    const restored = monitorStateFromProviderEvidence("claude", { ...evidence, activity: loaded.records[0].evidence.activity });
    assert.deepEqual(restored.activity, state.activity);
    assert.deepEqual(restored.metrics.tokens.requestSnapshots, state.metrics.tokens.requestSnapshots);
  }
});

test("Claude U2 distinguishes delivered system outcomes from human input in live and historical API projections", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-notification-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const mainFile = path.join(root, ".claude", "projects", "fixture", "local.jsonl");
  const content = "<task-notification><task-id>private-child</task-id><status>completed</status><summary>PRIVATE_NOTIFICATION_CONTENT</summary><output-file>PRIVATE_NOTIFICATION_PATH</output-file></task-notification>";
  const records = [
    { type: "assistant", timestamp: "2026-09-07T17:46:55.000Z", message: { content: [{
      type: "tool_use", id: "launch", name: "Agent", input: { description: "Inspect fixture", run_in_background: true },
    }] } },
    { type: "user", timestamp: "2026-09-07T17:46:55.359Z", message: { content: [{
      type: "tool_result", tool_use_id: "launch", content: "TOOL_RESULT_PRIVATE",
    }] }, toolUseResult: { status: "async_launched", isAsync: true, agentId: "private-child" } },
    { type: "queue-operation", operation: "enqueue", timestamp: "2026-09-07T18:47:42.224Z", content },
    { type: "queue-operation", operation: "dequeue", timestamp: "2026-09-07T18:47:42.235Z" },
    { type: "user", uuid: "private-notification-id", timestamp: "2026-09-07T18:47:42.302Z",
      origin: { kind: "task-notification" }, promptSource: "system", message: { content } },
    { type: "user", uuid: "human-input", timestamp: "2026-09-07T18:48:00.000Z", message: { content } },
  ];
  await mkdir(path.dirname(mainFile), { recursive: true });
  await writeFile(mainFile, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const provider = createClaudeProvider({ homeDir: root, env: {}, explicitSession: mainFile });
  for (const historical of [false, true]) {
    const evidence = await provider.readSession("local", { historical });
    assert.equal(evidence.activity.length, 2);
    const state = monitorStateFromProviderEvidence("claude", evidence);
    const [notification] = state.activity.items.filter((event) => event.actor === "System");
    assert.equal(notification.tool, "Task completed");
    assert.equal(notification.detail, "Background agent");
    assert.equal(notification.timestamp, "2026-09-07T18:47:42.302Z");
    assert.equal(state.activity.items.filter((event) => event.tool === "User input").length, 1);
    assert.equal(state.metrics.toolCalls, 1, "system notifications do not count as tool calls");
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_NOTIFICATION|TOOL_RESULT_PRIVATE|private-child|private-notification-id|task-notification|promptSource/);
  }

  const historical = !(await provider.listSessions())[0].isLive;
  const legacySource = claudeLifecycleSource(incrementalSourceSetDescriptor([mainFile], mainFile, historical), null);
  const legacyFingerprint = crypto.createHash("sha256").update(`claude\0local\0${legacySource.identity}:system-task-notifications-v1`).digest("hex");
  let checkpoint = { fingerprint: legacyFingerprint, completeOffset: legacySource.size };
  const observer = provider.createObserver();
  const controller = new AbortController();
  context.after(() => controller.abort());
  const published = [];
  await observer.start({
    publishCatalog() {}, invalidateSession() {},
    checkpointFor() { return checkpoint; },
    publishSession(_id, candidate) {
      published.push(candidate);
      checkpoint = candidate.observationSource;
    },
  }, controller.signal);
  await observer.hydrate("local");
  assert.equal(published.length, 1, "old checkpoint must be rebuilt without transcript growth");
  assert.notEqual(checkpoint.fingerprint, legacyFingerprint);
  assert.equal(published[0].activity.find((event) => event.actor === "System").tool, "Task completed");
  await observer.hydrate("local");
  assert.equal(published.length, 1, "unchanged corrected evidence must not churn revisions");
});
