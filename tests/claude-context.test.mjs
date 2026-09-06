import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { buildCacheEvents } from "../monitor/cache-events.mjs";
import { parseClaudeContextRecords } from "../monitor/providers/claude-context.mjs";
import { contextCompactions } from "../monitor/context-compactions.mjs";

function assistant(id, timestamp, usage, model = "claude-test", diagnostics = undefined) {
  return { type: "assistant", timestamp, message: { id, model, usage, content: [], ...(diagnostics !== undefined ? { diagnostics } : {}) } };
}

function assistantWithoutIdentity(timestamp, usage, model = "claude-test") {
  return { type: "assistant", timestamp, message: { model, usage, content: [] } };
}

function actionRequest(id, second, content = []) {
  const record = assistant(id, `2026-08-10T10:00:${String(second).padStart(2, "0")}.000Z`, {
    input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  });
  record.message.content = content;
  return record;
}

function actionResults(...ids) {
  return { type: "user", message: { content: ids.map((id) => ({
    type: "tool_result", tool_use_id: id, content: "PRIVATE_RESULT_MUST_NOT_LEAK",
  })) } };
}

test("correlates only bounded work kinds from issued calls and preceding results", () => {
  const records = [
    actionRequest("one", 0, [
      { type: "tool_use", id: "PRIVATE_READ_ID", name: "Read", input: { file_path: "PRIVATE_PATH_MUST_NOT_LEAK" } },
      { type: "tool_use", id: "PRIVATE_TEST_ID", name: "Bash", input: { command: "npm test # PRIVATE_COMMAND_MUST_NOT_LEAK" } },
    ]),
    actionResults("PRIVATE_READ_ID", "PRIVATE_TEST_ID"),
    actionRequest("two", 2),
    actionRequest("three", 3),
  ];
  const snapshots = parseClaudeContextRecords(records);
  const counts = [{ kind: "read", count: 1 }, { kind: "test", count: 1 }];
  assert.deepEqual(snapshots.map(({ precedingWork }) => precedingWork), [[], counts, []]);
  assert.deepEqual(snapshots.map(({ issuedWork }) => issuedWork), [counts, [], []]);
  assert.doesNotMatch(JSON.stringify(snapshots), /PRIVATE|tool_use|file_path|command|content/);
});

test("unknown result identities stay generic, missing identities are ignored, and no-content snapshots stay empty", () => {
  const missingContent = actionRequest("missing", 2);
  delete missingContent.message.content;
  const snapshots = parseClaudeContextRecords([
    actionRequest("one", 0), actionResults("unknown", undefined, ""), actionRequest("two", 1),
    actionResults("unknown"), missingContent, actionRequest("three", 3),
  ]);
  assert.deepEqual(snapshots[1].precedingWork, [{ kind: "shell", count: 1 }]);
  for (const snapshot of snapshots.slice(2)) {
    assert.deepEqual(snapshot.precedingWork, []);
    assert.deepEqual(snapshot.issuedWork, []);
  }
});

test("recognized compactions clear preceding work only within the assistant interval", () => {
  const records = [actionRequest("one", 1, [{ type: "tool_use", id: "read", name: "Read" }]),
    actionResults("read"), actionRequest("two", 3)];
  for (const [second, expected] of [[0, 1], [1, 1], [2, 0], [3, 0], [4, 1]]) {
    const boundary = { type: "system", subtype: "compact_boundary", timestamp: `2026-08-10T10:00:0${second}.000Z`, compactMetadata: { trigger: "auto" } };
    const snapshots = parseClaudeContextRecords(records, {
      compactionTimestamps: contextCompactions([boundary]).map(({ timestamp }) => timestamp),
    });
    assert.equal(snapshots[1].precedingWork.length, expected, `boundary second ${second}`);
  }
  const noUsage = actionRequest("no-usage", 2);
  delete noUsage.message.usage;
  assert.deepEqual(parseClaudeContextRecords([records[0], records[1], noUsage, records[2]], {
    compactionTimestamps: ["2026-08-10T10:00:02.000Z"],
  })[1].precedingWork, []);
});

test("actor-scoped transcript parsing isolates interleaved calls and identical tool IDs", () => {
  // Claude ownership comes from the adapter's transcript-to-actor mapping.
  const interleaved = [
    ["primary", actionRequest("one", 0, [{ type: "tool_use", id: "same", name: "Read" }])],
    ["child", actionRequest("one", 1, [{ type: "tool_use", id: "same", name: "Bash", input: { command: "npm test" } }])],
    ["primary", actionResults("same")], ["child", actionResults("same")],
    ["child", actionRequest("two", 2)], ["primary", actionRequest("two", 3)],
  ];
  for (const [actorId, kind] of [["primary", "read"], ["child", "test"]]) {
    const snapshots = parseClaudeContextRecords(interleaved.filter(([actor]) => actor === actorId).map(([, record]) => record), { actorId });
    assert.equal(snapshots.every((snapshot) => snapshot.actorId === actorId), true);
    assert.deepEqual(snapshots[1].precedingWork, [{ kind, count: 1 }]);
  }
});

test("tool identities from assistant records without usage still resolve later results", () => {
  const noUsage = actionRequest("no-usage", 1, [{ type: "tool_use", id: "test", name: "Bash", input: { command: "npm test" } }]);
  delete noUsage.message.usage;
  const snapshots = parseClaudeContextRecords([actionRequest("one", 0), noUsage, actionResults("test"), actionRequest("two", 2)]);
  assert.deepEqual(snapshots[1].precedingWork, [{ kind: "test", count: 1 }]);
});

test("request work retains the eight largest kinds with deterministic ties and capped counts", () => {
  const names = ["Read", "Write", "Search", "Build", "Git", "WebSearch", "ImageGen", "AskUserQuestion", "Skill"];
  const blocks = names.map((name, index) => ({ type: "tool_use", id: `tool-${index}`, name }));
  for (let index = 0; index < 1_005; index += 1) blocks.push({ type: "tool_use", id: `test-${index}`, name: "Test" });
  const snapshots = parseClaudeContextRecords([
    actionRequest("one", 0, blocks), actionResults(...blocks.map(({ id }) => id)), actionRequest("two", 1),
  ]);
  const expected = ["test", "build", "git", "image", "input", "read", "search", "skill"]
    .map((kind) => ({ kind, count: kind === "test" ? 999 : 1 }));
  assert.deepEqual(snapshots[0].issuedWork, expected);
  assert.deepEqual(snapshots[1].precedingWork, expected);
});

test("strictly normalizes bounded Claude request usage and cache comparability", () => {
  const snapshots = parseClaudeContextRecords([
    assistant("one", "2026-08-10T10:00:00.000Z", {
      input_tokens: 1_000,
      output_tokens: 100,
      cache_creation_input_tokens: 8_000,
      cache_read_input_tokens: 0,
      cache_creation: { private_ttl_breakdown: "PRIVATE_MUST_NOT_LEAK" },
    }, "claude-test", { cache_miss_reason: { type: "tools_changed", cache_missed_input_tokens: 8_000, private: "PRIVATE_MUST_NOT_LEAK" } }),
    assistant("two", "2026-08-10T10:05:00.000Z", {
      input_tokens: 1_000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 9_000,
    }),
  ], { actorId: "primary", sourceKey: "source" });

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.every((snapshot) => snapshot.cacheComparable), true);
  assert.equal(snapshots[0].model, "claude-test");
  assert.equal(snapshots[0].cacheMissReason, "tools_changed");
  assert.equal(snapshots[0].cacheMissDiagnosticState, "recognized_reason");
  assert.equal(snapshots[0].cacheLifetime, null);
  assert.equal(snapshots[0].cacheMissProviderStatus, null);
  assert.equal(snapshots[0].cacheToolChangeCause, null);
  assert.equal(snapshots[1].cacheMissReason, null);
  assert.equal(snapshots[1].cacheMissDiagnosticState, "absent");
  assert.doesNotMatch(JSON.stringify(snapshots), /PRIVATE|cache_creation[^I]|cache_missed_input_tokens|diagnostics/);
});

test("attributes the next tools-changed request to a proven Remote Control connection transition", () => {
  const usage = { input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 0 };
  const records = [
    assistant("baseline", "2026-08-10T10:00:00.000Z", { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 9_000 }),
    { type: "bridge-session", sessionId: "session", bridgeSessionId: "bridge", lastSequenceNum: 1 },
    assistant("activation-request", "2026-08-10T10:01:00.000Z", usage),
    { type: "system", subtype: "bridge_status", content: "/remote-control is active. PRIVATE_STATUS_MUST_NOT_LEAK" },
    assistant("activation-request", "2026-08-10T10:01:01.000Z", usage),
    { type: "last-prompt", sessionId: "session" },
    { type: "bridge-session", sessionId: "session", bridgeSessionId: "bridge", lastSequenceNum: 2 },
    assistant("changed-request", "2026-08-10T10:02:00.000Z", usage, "claude-test", {
      cache_miss_reason: { type: "tools_changed", cache_missed_input_tokens: 8_000 },
    }),
  ];

  const snapshots = parseClaudeContextRecords(records, { actorId: "primary", sourceKey: "source", completeHistory: true, expectedSessionId: "session" });
  assert.equal(snapshots.find((snapshot) => snapshot.dedupeId.endsWith(":changed-request"))?.cacheToolChangeCause, "remote_control_connected");
  assert.doesNotMatch(JSON.stringify(snapshots), /bridgeSessionId|PRIVATE_STATUS|cache_missed_input_tokens/);

  const incomplete = parseClaudeContextRecords(records, { actorId: "primary", sourceKey: "source", completeHistory: false, expectedSessionId: "session" });
  assert.equal(incomplete.every((snapshot) => snapshot.cacheToolChangeCause === null), true);
});

test("does not attribute textual mentions, bridge presence from session start, or a later unrelated request", () => {
  const usage = { input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 0 };
  const textualMention = parseClaudeContextRecords([
    assistant("before", "2026-08-10T10:00:00.000Z", usage),
    { type: "attachment", attachment: { type: "skill_listing", content: "/remote-control is active RemoteTrigger PushNotification" } },
    assistant("after", "2026-08-10T10:01:00.000Z", usage, "claude-test", { cache_miss_reason: { type: "tools_changed" } }),
  ], { actorId: "primary", sourceKey: "text", completeHistory: true, expectedSessionId: "session" });
  assert.equal(textualMention.every((snapshot) => snapshot.cacheToolChangeCause === null), true);

  const activeFromStart = parseClaudeContextRecords([
    { type: "bridge-session", sessionId: "session", bridgeSessionId: "bridge", lastSequenceNum: 1 },
    assistant("before", "2026-08-10T10:00:00.000Z", usage),
    { type: "system", subtype: "bridge_status", content: "/remote-control is active" },
    { type: "bridge-session", sessionId: "session", bridgeSessionId: "bridge", lastSequenceNum: 2 },
    assistant("after", "2026-08-10T10:01:00.000Z", usage, "claude-test", { cache_miss_reason: { type: "tools_changed" } }),
  ], { actorId: "primary", sourceKey: "start", completeHistory: true, expectedSessionId: "session" });
  assert.equal(activeFromStart.every((snapshot) => snapshot.cacheToolChangeCause === null), true);

  const mismatchedBridge = parseClaudeContextRecords([
    assistant("before", "2026-08-10T10:00:00.000Z", usage),
    { type: "bridge-session", sessionId: "session", bridgeSessionId: "bridge-a", lastSequenceNum: 1 },
    assistant("activation", "2026-08-10T10:01:00.000Z", usage),
    { type: "system", subtype: "bridge_status", content: "/remote-control is active" },
    { type: "last-prompt", sessionId: "session" },
    { type: "bridge-session", sessionId: "session", bridgeSessionId: "bridge-b", lastSequenceNum: 2 },
    assistant("after", "2026-08-10T10:02:00.000Z", usage, "claude-test", { cache_miss_reason: { type: "tools_changed" } }),
  ], { actorId: "primary", sourceKey: "mismatch", completeHistory: true, expectedSessionId: "session" });
  assert.equal(mismatchedBridge.every((snapshot) => snapshot.cacheToolChangeCause === null), true);

  const duplicatedBridge = parseClaudeContextRecords([
    assistant("before", "2026-08-10T10:00:00.000Z", usage),
    { type: "bridge-session", sessionId: "session", bridgeSessionId: "bridge", lastSequenceNum: 1 },
    assistant("activation", "2026-08-10T10:01:00.000Z", usage),
    { type: "system", subtype: "bridge_status", content: "/remote-control is active" },
    { type: "bridge-session", sessionId: "session", bridgeSessionId: "bridge", lastSequenceNum: 1 },
    assistant("after", "2026-08-10T10:02:00.000Z", usage, "claude-test", { cache_miss_reason: { type: "tools_changed" } }),
  ], { actorId: "primary", sourceKey: "duplicate", completeHistory: true, expectedSessionId: "session" });
  assert.equal(duplicatedBridge.every((snapshot) => snapshot.cacheToolChangeCause === null), true);

  const foreignSession = parseClaudeContextRecords([
    assistant("before", "2026-08-10T10:00:00.000Z", usage),
    { type: "bridge-session", sessionId: "other-session", bridgeSessionId: "bridge", lastSequenceNum: 1 },
    assistant("activation", "2026-08-10T10:01:00.000Z", usage),
    { type: "system", subtype: "bridge_status", content: "/remote-control is active" },
    { type: "last-prompt", sessionId: "other-session" },
    { type: "bridge-session", sessionId: "other-session", bridgeSessionId: "bridge", lastSequenceNum: 2 },
    assistant("after", "2026-08-10T10:02:00.000Z", usage, "claude-test", { cache_miss_reason: { type: "tools_changed" } }),
  ], { actorId: "primary", sourceKey: "foreign", completeHistory: true, expectedSessionId: "session" });
  assert.equal(foreignSession.every((snapshot) => snapshot.cacheToolChangeCause === null), true);

  const laterRequest = parseClaudeContextRecords([
    assistant("before", "2026-08-10T10:00:00.000Z", usage),
    { type: "bridge-session", sessionId: "session", bridgeSessionId: "bridge", lastSequenceNum: 1 },
    assistant("activation", "2026-08-10T10:01:00.000Z", usage),
    { type: "system", subtype: "bridge_status", content: "/remote-control is active" },
    { type: "last-prompt", sessionId: "session" },
    { type: "bridge-session", sessionId: "session", bridgeSessionId: "bridge", lastSequenceNum: 2 },
    assistant("next-without-diagnostic", "2026-08-10T10:02:00.000Z", usage),
    assistant("later-changed", "2026-08-10T10:03:00.000Z", usage, "claude-test", { cache_miss_reason: { type: "tools_changed" } }),
  ], { actorId: "primary", sourceKey: "later", completeHistory: true, expectedSessionId: "session" });
  assert.equal(laterRequest.every((snapshot) => snapshot.cacheToolChangeCause === null), true);
});

test("recognizes only a complete tool-result, provider-notification, directly resumed messages-changed sequence", () => {
  const usage = { input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 9_000, cache_read_input_tokens: 0 };
  const toolRequest = assistant("tool-request", "2026-08-10T10:00:00.000Z", usage);
  toolRequest.requestId = "request-tool";
  toolRequest.uuid = "assistant-tool";
  toolRequest.message.content = [{ type: "tool_use", id: "PRIVATE_TOOL_USE_ID", name: "PRIVATE_TOOL_NAME", input: { private: true } }];
  const toolResult = {
    type: "user",
    uuid: "tool-result-record",
    parentUuid: "assistant-tool",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "PRIVATE_TOOL_USE_ID", content: "PRIVATE_TOOL_RESULT" }] },
  };
  const notification = {
    type: "user",
    uuid: "notification-record",
    parentUuid: "tool-result-record",
    isMeta: true,
    origin: { kind: "task-notification", private: "PRIVATE_NOTIFICATION" },
    message: { role: "user", content: [{ type: "text", text: "PRIVATE_NOTIFICATION_TEXT" }] },
  };
  const changed = assistant("changed", "2026-08-10T10:01:00.000Z", usage, "claude-test", {
    cache_miss_reason: { type: "messages_changed", cache_missed_input_tokens: 9_000 },
  });
  changed.requestId = "request-changed";
  changed.parentUuid = "notification-record";

  const snapshots = parseClaudeContextRecords([toolRequest, toolResult, notification, changed], {
    actorId: "child",
    sourceKey: "source",
    completeHistory: true,
  });
  assert.equal(snapshots.find((snapshot) => snapshot.dedupeId.endsWith(":changed"))?.cacheMessageChangeSequence, "post_tool_task_notification_resume");
  assert.doesNotMatch(JSON.stringify(snapshots), /PRIVATE|task-notification|tool_use|tool_result|notification-record|request-changed/);

  const variants = [
    { records: [toolRequest, toolResult, notification, changed], completeHistory: false },
    { records: [{ ...toolRequest, message: { ...toolRequest.message, content: [{ type: "text", text: "tool-free" }] } }, toolResult, notification, changed], completeHistory: true },
    { records: [toolRequest, toolResult, { ...notification, isMeta: false }, changed], completeHistory: true },
    { records: [toolRequest, toolResult, notification, { type: "user", message: { role: "user", content: [{ type: "text", text: "intervening input" }] } }, changed], completeHistory: true },
    { records: [toolRequest, toolResult, notification, { ...changed, parentUuid: "different-parent" }], completeHistory: true },
  ];
  for (const [index, variant] of variants.entries()) {
    const result = parseClaudeContextRecords(variant.records, {
      actorId: "child",
      sourceKey: `negative-${index}`,
      completeHistory: variant.completeHistory,
    });
    assert.equal(result.every((snapshot) => snapshot.cacheMessageChangeSequence === null), true);
  }
});

test("unrecognized or inconclusive Claude cache diagnostics remain unavailable", () => {
  const records = ["previous_message_not_found", "unavailable", "future_private_reason"].map((type, index) => (
    assistant(`diagnostic-${index}`, `2026-08-10T10:0${index}:00.000Z`, {
      input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 0,
    }, "claude-test", { cache_miss_reason: { type, cache_missed_input_tokens: 8_000 } })
  ));
  records.push(assistant("malformed-diagnostic", "2026-08-10T10:03:00.000Z", {
    input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 0,
  }, "claude-test", { cache_miss_reason: "invalid" }));
  records.push(assistant("unrelated-diagnostic", "2026-08-10T10:04:00.000Z", {
    input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 0,
  }, "claude-test", { unrelated_private_field: "PRIVATE_MUST_NOT_LEAK" }));
  records.push(assistant("null-diagnostic", "2026-08-10T10:05:00.000Z", {
    input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 0,
  }, "claude-test", null));
  const snapshots = parseClaudeContextRecords(records, { actorId: "primary", sourceKey: "source" });
  assert.equal(snapshots.every((snapshot) => snapshot.cacheMissReason === null), true);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.cacheMissProviderStatus), [
    "previous_cache_entry_unavailable", null, null, null, null, null,
  ]);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.cacheMissDiagnosticState), [
    "previous_cache_entry_unavailable", "inconclusive", "inconclusive", "inconclusive", "absent", "absent",
  ]);
  assert.doesNotMatch(JSON.stringify(snapshots), /PRIVATE|unrelated_private_field/);
});

test("resolves only complete provider cache-lifetime breakdowns", () => {
  const records = [
    ["five", 8_000, { ephemeral_5m_input_tokens: 8_000, ephemeral_1h_input_tokens: 0 }],
    ["hour", 8_000, { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 8_000 }],
    ["mixed", 8_000, { ephemeral_5m_input_tokens: 3_000, ephemeral_1h_input_tokens: 5_000 }],
    ["mismatch", 8_000, { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1, private: "PRIVATE_MUST_NOT_LEAK" }],
  ].map(([id, cacheWrite, cacheCreation], index) => assistant(id, `2026-08-10T10:0${index}:00.000Z`, {
    input_tokens: 1_000,
    output_tokens: 10,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: 0,
    cache_creation: cacheCreation,
  }));
  const snapshots = parseClaudeContextRecords(records, { actorId: "primary", sourceKey: "source" });
  assert.deepEqual(snapshots.map(({ cacheLifetime }) => cacheLifetime), ["5m", "1h", "mixed", null]);
  assert.doesNotMatch(JSON.stringify(snapshots), /ephemeral|PRIVATE|cache_creation/);
});

test("missing or malformed cache evidence breaks comparison without losing valid context", () => {
  const snapshots = parseClaudeContextRecords([
    assistant("before", "2026-08-10T10:00:00.000Z", {
      input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 9_000,
    }),
    assistant("legacy", "2026-08-10T10:05:00.000Z", { input_tokens: 2_000, output_tokens: 10 }),
    assistant("malformed", "2026-08-10T10:10:00.000Z", {
      input_tokens: 1_000, output_tokens: 10, cache_read_input_tokens: "invalid",
    }),
    assistant("after", "2026-08-10T11:00:00.000Z", {
      input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 0,
    }),
  ], { actorId: "primary", sourceKey: "source" });

  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[1].cacheComparable, false);
  assert.notEqual(snapshots[0].comparisonGroup, snapshots[2].comparisonGroup);
  assert.equal(snapshots[1].input, 2_000);
});

test("fallback Claude usage identities remain stable when a moving tail drops preceding records", () => {
  const options = { actorId: "primary", sourceKey: "source" };
  const prefix = assistantWithoutIdentity("2026-08-10T09:00:00.000Z", {
    input_tokens: 500, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  });
  const suffix = [
    assistantWithoutIdentity("2026-08-10T10:00:00.000Z", {
      input_tokens: 1_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }),
    assistantWithoutIdentity("2026-08-10T10:00:00.000Z", {
      input_tokens: 2_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    }),
  ];
  const complete = parseClaudeContextRecords([prefix, ...suffix], options);
  const tail = parseClaudeContextRecords(suffix, options);
  assert.equal(complete.length, 3);
  assert.equal(tail.length, 2);
  assert.equal(new Set(tail.map(({ dedupeId }) => dedupeId)).size, 2);
  for (const input of [1_000, 2_000]) {
    assert.equal(
      complete.find((snapshot) => snapshot.input === input)?.dedupeId,
      tail.find((snapshot) => snapshot.input === input)?.dedupeId,
    );
  }
  assert.equal(tail.every(({ dedupeId }) => dedupeId.startsWith("source:fallback-")), true);

  const withoutTimestamp = assistantWithoutIdentity(undefined, {
    input_tokens: 3_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  });
  const earlierFallback = parseClaudeContextRecords([withoutTimestamp], {
    ...options,
    fallbackTimestamp: "2026-08-10T11:00:00.000Z",
  });
  const laterFallback = parseClaudeContextRecords([withoutTimestamp], {
    ...options,
    fallbackTimestamp: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(earlierFallback[0].dedupeId, laterFallback[0].dedupeId);
});

test("an assistant record without a usable usage object breaks cache comparison fail-closed", () => {
  const unusableMessages = [
    { id: "missing", model: "claude-test" },
    { id: "non-object", model: "claude-test", usage: "invalid" },
    { id: "invalid", model: "claude-test", usage: { input_tokens: "invalid", output_tokens: 10 } },
  ];
  for (const [index, message] of unusableMessages.entries()) {
    const snapshots = parseClaudeContextRecords([
      assistant("before", "2026-08-10T10:00:00.000Z", {
        input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 9_000,
      }),
      { type: "assistant", timestamp: "2026-08-10T10:10:00.000Z", message },
      assistant("after", "2026-08-10T10:30:00.000Z", {
        input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 0,
      }),
    ], { actorId: "primary", sourceKey: `source-${index}` });

    assert.equal(snapshots.length, 2);
    assert.notEqual(snapshots[0].comparisonGroup, snapshots[1].comparisonGroup);
    const feed = buildCacheEvents({
      agents: [{ id: "primary", kind: "orchestrator" }],
      usageSnapshots: snapshots,
      enabled: true,
    });
    assert.equal(feed.items.some((event) => event.kind === "miss_refill"), false);
  }
});

test("deduplicates message identities and bounds observations per agent", () => {
  const records = Array.from({ length: 1_005 }, (_, index) => assistant(
    `message-${index}`,
    new Date(Date.parse("2026-08-10T10:00:00.000Z") + index).toISOString(),
    { input_tokens: 100 + index, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ));
  records.push({ ...records.at(-1), timestamp: "2026-08-10T11:00:00.000Z" });
  const snapshots = parseClaudeContextRecords(records, { actorId: "primary", sourceKey: "source" });
  assert.equal(snapshots.length, 1_000);
  assert.equal(snapshots.some((snapshot) => snapshot.dedupeId.endsWith(":message-0")), false);
  assert.equal(snapshots.at(-1).timestamp, "2026-08-10T11:00:00.000Z");
});

test("Claude adapter supplies recognized actor compactions to request action correlation", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-request-work-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const mainFile = path.join(root, "projects", "fixture", "request-work.jsonl");
  const first = { type: "assistant", timestamp: "2026-08-12T14:00:00.000Z", message: { content: [{ type: "tool_use", id: "read", name: "Read", input: {} }] } };
  const result = { type: "user", timestamp: "2026-08-12T14:00:01.000Z", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "PRIVATE_RESULT_MUST_NOT_LEAK" }] } };
  const writeRecords = async (file, records) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  };
  first.message.id = "before";
  first.message.usage = { input_tokens: 100, output_tokens: 10 };
  const next = {
    type: "assistant", timestamp: "2026-08-12T14:00:03.000Z",
    message: { id: "after", usage: { input_tokens: 100, output_tokens: 10 }, content: [] },
  };
  const provider = createClaudeProvider({ homeDir: root, projectsRoot: path.join(root, "projects"), explicitSession: mainFile });
  await writeRecords(mainFile, [first, result]);
  const initial = await provider.readSession("request-work", { historical: false });
  assert.deepEqual(initial.usageSnapshots[0].issuedWork, [{ kind: "read", count: 1 }]);
  await appendFile(mainFile, `${JSON.stringify(next)}\n`);
  const linked = await provider.readSession("request-work", { historical: false });
  assert.deepEqual(linked.usageSnapshots.at(-1).precedingWork, [{ kind: "read", count: 1 }]);
  // Replace the source with a recognized compaction between the result and request.
  await writeRecords(mainFile, [first, result, {
    type: "system", subtype: "compact_boundary", timestamp: "2026-08-12T14:00:02.000Z",
    compactMetadata: { trigger: "manual" },
  }, next]);
  const compacted = await provider.readSession("request-work", { historical: false });
  assert.deepEqual(compacted.usageSnapshots.at(-1).precedingWork, []);
  assert.deepEqual(compacted.usageSnapshots[0].issuedWork, [{ kind: "read", count: 1 }]);
});
