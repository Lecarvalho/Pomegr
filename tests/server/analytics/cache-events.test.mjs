import assert from "node:assert/strict";
import test from "node:test";
import { buildCacheEvidence, buildCacheEvents, CACHE_EVENT_RULES } from "../../../server/analytics/cache-events.mjs";

const agent = { id: "primary", label: "Primary agent", role: "orchestrator" };

function snapshot(id, timestamp, {
  actorId = "primary",
  input = 0,
  cacheRead = 0,
  cacheWrite = 0,
  model = "model",
  group = 0,
  cacheLifetime = null,
  cacheMissReason = null,
  cacheMissProviderStatus = null,
  cacheMissDiagnosticState = "absent",
  cacheToolChangeCause = null,
  cacheToolChangeAddedDefinitionCount = undefined,
  cacheMessageChangeSequence = null,
  requestSentAt = undefined,
} = {}) {
  return {
    ...(requestSentAt === undefined ? {} : { requestSentAt }),
    ...(cacheToolChangeAddedDefinitionCount === undefined ? {} : { cacheToolChangeAddedDefinitionCount }),
    dedupeId: id,
    actorId,
    timestamp,
    input,
    output: 10,
    cacheRead,
    cacheWrite,
    model,
    comparisonGroup: group,
    cacheComparable: true,
    cacheLifetime,
    cacheMissReason,
    cacheMissProviderStatus,
    cacheMissDiagnosticState,
    cacheToolChangeCause,
    cacheMessageChangeSequence,
  };
}

test("preserves a documented minimum without inferring expiry at any elapsed gap", () => {
  for (const gapMinutes of [31, 25 * 60]) {
    for (const cacheMissProviderStatus of [null, "previous_cache_entry_unavailable"]) {
      const start = Date.parse("2026-09-02T10:00:00.000Z");
      const result = buildCacheEvidence({ sessionId: "codex:minimum", agents: [agent], enabled: true, usageSnapshots: [
        snapshot("before", new Date(start).toISOString(), { input: 1_000, cacheRead: 9_000, cacheLifetime: "30m+" }),
        snapshot("after", new Date(start + gapMinutes * 60_000).toISOString(), { input: 1_000, cacheWrite: 9_000, cacheLifetime: "30m+", cacheMissProviderStatus }),
      ] });
      assert.equal(result.refillRequests[0].observation.previousCacheLifetime, "30m+");
      assert.equal(result.feed.possibleFullRefills[0].occurrences[0].cacheLifetimeInference, null);
    }
  }
});

test("projects only the fixed message-change sequence onto its qualifying occurrence", () => {
  const feed = buildCacheEvents({
    sessionId: "session",
    agents: [agent],
    enabled: true,
    usageSnapshots: [
      snapshot("before", "2026-08-10T10:00:00.000Z", { input: 1_000, cacheRead: 9_000 }),
      snapshot("after", "2026-08-10T10:05:00.000Z", {
        input: 1_000,
        cacheWrite: 9_000,
        cacheMissReason: "messages_changed",
        cacheMessageChangeSequence: "post_tool_task_notification_resume",
      }),
    ],
  });

  assert.equal(feed.possibleFullRefills[0].occurrences[0].messageChangeSequence, "post_tool_task_notification_resume");
  assert.doesNotMatch(JSON.stringify(feed), /tool_use_id|task-notification|requestId|messageId/);

  const competingReason = buildCacheEvents({
    sessionId: "session",
    agents: [agent],
    enabled: true,
    usageSnapshots: [
      snapshot("before", "2026-08-10T10:00:00.000Z", { input: 1_000, cacheRead: 9_000 }),
      snapshot("after", "2026-08-10T10:05:00.000Z", {
        input: 1_000,
        cacheWrite: 9_000,
        cacheMissReason: "tools_changed",
        cacheMessageChangeSequence: "post_tool_task_notification_resume",
      }),
    ],
  });
  assert.equal(competingReason.possibleFullRefills[0].occurrences[0].messageChangeSequence, null);
});

test("emits a bounded refill to first-reuse pair and an explicit miss-refill", () => {
  const feed = buildCacheEvents({
    sessionId: "codex:thread",
    agents: [agent],
    enabled: true,
    usageSnapshots: [
      snapshot("refill", "2026-08-10T10:00:00.000Z", { input: 1_000, cacheWrite: 8_000 }),
      snapshot("reuse", "2026-08-10T10:05:00.000Z", { input: 1_000, cacheRead: 9_000 }),
      snapshot("extra-reuse", "2026-08-10T10:06:00.000Z", { input: 1_000, cacheRead: 9_000 }),
      snapshot("miss", "2026-08-10T10:36:00.000Z", { input: 1_000, cacheRead: 500, cacheWrite: 8_500, cacheMissReason: "tools_changed", cacheToolChangeCause: "remote_control_connected" }),
    ],
  });

  assert.equal(feed.status, "ready");
  assert.deepEqual(feed.items.map((event) => event.kind), ["miss_refill", "reuse", "refill"]);
  const [miss, reuse, refill] = feed.items;
  assert.equal(miss.promptInputTokens, 10_000);
  assert.equal(miss.cacheReadPercent, 5);
  assert.equal(miss.previousCacheReadPercent, 90);
  assert.equal(miss.gapMs, 30 * 60 * 1_000);
  assert.equal(reuse.relatedEventId, refill.id);
  assert.equal(reuse.gapMs, 5 * 60 * 1_000);
  assert.match(refill.id, /^cache-[a-f0-9]{16}$/);
  assert.deepEqual(feed.possibleFullRefills, [{
    agentId: "primary",
    count: 1,
    occurrences: [{
      observedAt: "2026-08-10T10:36:00.000Z",
      reason: "tools_changed",
      providerStatus: null,
      cacheLifetimeInference: null,
      messageChangeSequence: null,
      toolChangeAttribution: {
        cause: "remote_control_connected",
        changes: [
          { tool: "RemoteTrigger", kind: "added" },
          { tool: "PushNotification", kind: "added" },
          { tool: "ListAgents", kind: "definition_changed" },
        ],
      },
    }],
    reasons: [{ reason: "tools_changed", count: 1 }],
    toolChangeAttributions: [{
      cause: "remote_control_connected",
      count: 1,
      changes: [
        { tool: "RemoteTrigger", kind: "added" },
        { tool: "PushNotification", kind: "added" },
        { tool: "ListAgents", kind: "definition_changed" },
      ],
    }],
  }]);
  assert.doesNotMatch(JSON.stringify(feed), /codex:thread|dedupeId|model|cache_missed_input_tokens|diagnostics/);
});

test("does not infer a miss without a recorded large refill", () => {
  const feed = buildCacheEvents({
    sessionId: "session",
    agents: [agent],
    enabled: true,
    usageSnapshots: [
      snapshot("before", "2026-08-10T10:00:00.000Z", { input: 1_000, cacheRead: 9_000 }),
      snapshot("after", "2026-08-10T10:30:00.000Z", { input: 9_500, cacheRead: 500, cacheWrite: 7_999 }),
    ],
  });
  assert.deepEqual(feed, { status: "ready", items: [], possibleFullRefills: [] });
});

test("enforces comparison boundaries and cache event thresholds", () => {
  const base = snapshot("before", "2026-08-10T10:00:00.000Z", { input: 1_600, cacheRead: 6_400 });
  const qualifying = snapshot("after", "2026-08-10T10:30:00.000Z", { input: 100, cacheRead: 800, cacheWrite: 8_000 });
  const valid = buildCacheEvents({ sessionId: "session", agents: [agent], enabled: true, usageSnapshots: [base, qualifying] });
  assert.equal(valid.items[0].kind, "miss_refill");
  for (const current of [
    { ...qualifying, timestamp: "2026-08-10T10:29:59.999Z" },
    { ...qualifying, model: "other" },
    { ...qualifying, comparisonGroup: 1 },
  ]) {
    const feed = buildCacheEvents({ sessionId: "session", agents: [agent], enabled: true, usageSnapshots: [base, current] });
    assert.equal(feed.items.some((event) => event.kind === "miss_refill"), false);
  }
  const compacted = buildCacheEvents({
    sessionId: "session",
    agents: [agent],
    enabled: true,
    usageSnapshots: [base, qualifying],
    compactions: [{ actorId: "primary", timestamp: "2026-08-10T10:15:00.000Z", trigger: "manual" }],
  });
  assert.equal(compacted.items.some((event) => event.kind === "miss_refill"), false);
  assert.equal(CACHE_EVENT_RULES.maximumSessionEvents, 20);
  assert.equal(CACHE_EVENT_RULES.maximumAgentRefillCount, 999);
});

test("returns unavailable without classifiable evidence and caps newest session events", () => {
  assert.deepEqual(buildCacheEvents({ agents: [agent], enabled: false }), { status: "unavailable", items: [], possibleFullRefills: [] });
  assert.deepEqual(buildCacheEvents({ agents: [agent], enabled: true, usageSnapshots: [
    { ...snapshot("bad", "2026-08-10T10:00:00.000Z", { cacheWrite: 8_000 }), cacheComparable: false },
  ] }), { status: "unavailable", items: [], possibleFullRefills: [] });

  const usageSnapshots = Array.from({ length: 25 }, (_, index) => snapshot(
    `refill-${index}`,
    new Date(Date.parse("2026-08-10T10:00:00.000Z") + index * 1_000).toISOString(),
    { input: 1_000, cacheWrite: 8_000 },
  ));
  const feed = buildCacheEvents({ sessionId: "session", agents: [agent], enabled: true, usageSnapshots });
  assert.equal(feed.items.length, 20);
  assert.equal(feed.items[0].observedAt, usageSnapshots.at(-1).timestamp);
});

test("retains a possible full-refill count after its detailed event falls outside the cap", () => {
  const startedAt = Date.parse("2026-08-10T10:00:00.000Z");
  const rewriteAt = new Date(startedAt + 5 * 60_000).toISOString();
  const usageSnapshots = [
    snapshot("before", new Date(startedAt).toISOString(), { input: 1_000, cacheRead: 99_000 }),
    snapshot("short-gap-rewrite", rewriteAt, { input: 1_000, cacheWrite: 99_000 }),
    ...Array.from({ length: 21 }, (_, index) => snapshot(
      `later-refill-${index}`,
      new Date(startedAt + (index + 6) * 60_000).toISOString(),
      { input: 1_000, cacheRead: 99_000, cacheWrite: 8_000 },
    )),
  ];

  const feed = buildCacheEvents({ sessionId: "session", agents: [agent], enabled: true, usageSnapshots });
  assert.deepEqual(feed.possibleFullRefills, [{
    agentId: "primary",
    count: 1,
    occurrences: [{ observedAt: rewriteAt, reason: null, providerStatus: null, cacheLifetimeInference: null, messageChangeSequence: null, toolChangeAttribution: null }],
    reasons: [],
    toolChangeAttributions: [],
  }]);
  assert.equal(feed.items.length, CACHE_EVENT_RULES.maximumSessionEvents);
  assert.equal(feed.items.some((event) => event.observedAt === rewriteAt), false);
  assert.equal(feed.items.some((event) => event.kind === "miss_refill"), false);
});

test("allowlists refill reasons and keeps reason counts within the bounded refill count", () => {
  const usageSnapshots = [];
  const startedAt = Date.parse("2026-08-10T10:00:00.000Z");
  for (let index = 0; index < CACHE_EVENT_RULES.maximumAgentRefillCount + 2; index += 1) {
    usageSnapshots.push(
      snapshot(`reuse-${index}`, new Date(startedAt + index * 120_000).toISOString(), { input: 1_000, cacheRead: 10_000 }),
      snapshot(`refill-${index}`, new Date(startedAt + index * 120_000 + 60_000).toISOString(), {
        input: 1_000,
        cacheWrite: 9_000,
        cacheMissReason: index === 0 ? "private_provider_reason" : "tools_changed",
        cacheToolChangeCause: index === 1 ? "private_tool_change_cause" : null,
      }),
    );
  }

  const feed = buildCacheEvents({ sessionId: "session", agents: [agent], enabled: true, usageSnapshots });
  assert.equal(feed.possibleFullRefills.length, 1);
  const [summary] = feed.possibleFullRefills;
  assert.equal(summary.agentId, "primary");
  assert.equal(summary.count, CACHE_EVENT_RULES.maximumAgentRefillCount);
  assert.equal(summary.occurrences.length, CACHE_EVENT_RULES.maximumAgentRefillCount);
  assert.deepEqual(summary.occurrences[0], {
    observedAt: new Date(startedAt + 60_000).toISOString(),
    reason: null,
    providerStatus: null,
    cacheLifetimeInference: null,
    messageChangeSequence: null,
    toolChangeAttribution: null,
  });
  assert.deepEqual(summary.occurrences[1], {
    observedAt: new Date(startedAt + 180_000).toISOString(),
    reason: "tools_changed",
    providerStatus: null,
    cacheLifetimeInference: null,
    messageChangeSequence: null,
    toolChangeAttribution: null,
  });
  assert.deepEqual(summary.reasons, [{ reason: "tools_changed", count: CACHE_EVENT_RULES.maximumAgentRefillCount - 1 }]);
  assert.deepEqual(summary.toolChangeAttributions, []);
  assert.doesNotMatch(JSON.stringify(feed), /private_provider_reason|private_tool_change_cause/);
});

test("never retains a reuse whose related refill falls outside the event cap", () => {
  const startedAt = Date.parse("2026-08-10T10:00:00.000Z");
  const usageSnapshots = [
    snapshot("paired-refill", new Date(startedAt).toISOString(), { input: 1_000, cacheWrite: 8_000 }),
    snapshot("paired-reuse", new Date(startedAt + 60_000).toISOString(), { input: 1_000, cacheRead: 9_000 }),
    ...Array.from({ length: 19 }, (_, index) => snapshot(
      `later-refill-${index}`,
      new Date(startedAt + (index + 2) * 60_000).toISOString(),
      { input: 1_000, cacheWrite: 8_000 },
    )),
  ];

  const feed = buildCacheEvents({ sessionId: "session", agents: [agent], enabled: true, usageSnapshots });
  assert.equal(feed.items.length, 19);
  assert.equal(feed.items.some((event) => event.kind === "reuse"), false);
  assert.equal(feed.items.every((event) => (
    event.kind !== "reuse" || feed.items.some((related) => related.id === event.relatedEventId)
  )), true);
});

test("infers cache expiry from the preceding resolved lifetime and bounded provider evidence", () => {
  for (const [cacheLifetime, gapMs, cacheMissProviderStatus] of [
    ["5m", 6 * 60_000, null],
    ["1h", 61 * 60_000, "previous_cache_entry_unavailable"],
    ["mixed", 61 * 60_000, null],
  ]) {
    const start = Date.parse("2026-08-10T10:00:00.000Z");
    const feed = buildCacheEvents({
      sessionId: "session",
      agents: [agent],
      enabled: true,
      usageSnapshots: [
        snapshot(`before-${cacheLifetime}`, new Date(start).toISOString(), { input: 1_000, cacheRead: 9_000, cacheLifetime }),
        snapshot(`after-${cacheLifetime}`, new Date(start + gapMs).toISOString(), {
          input: 1_000,
          cacheWrite: 9_000,
          cacheMissProviderStatus,
          cacheMissDiagnosticState: cacheMissProviderStatus ? "previous_cache_entry_unavailable" : "absent",
        }),
      ],
    });
    assert.deepEqual(feed.possibleFullRefills[0].occurrences[0], {
      observedAt: new Date(start + gapMs).toISOString(),
      reason: null,
      providerStatus: cacheMissProviderStatus,
      cacheLifetimeInference: { cause: "cache_lifetime_elapsed", cacheLifetime, elapsedMs: gapMs },
      messageChangeSequence: null,
      toolChangeAttribution: null,
    });
  }
});

test("fails cache-expiry inference closed below the TTL or with competing or inconclusive evidence", () => {
  const start = Date.parse("2026-08-10T10:00:00.000Z");
  for (const current of [
    snapshot("too-soon", new Date(start + 59 * 60_000).toISOString(), {
      input: 1_000, cacheWrite: 9_000, cacheMissProviderStatus: "previous_cache_entry_unavailable",
    }),
    snapshot("inconclusive-diagnostic", new Date(start + 61 * 60_000).toISOString(), {
      input: 1_000, cacheWrite: 9_000, cacheMissDiagnosticState: "inconclusive",
    }),
    snapshot("direct-reason", new Date(start + 61 * 60_000).toISOString(), {
      input: 1_000,
      cacheWrite: 9_000,
      cacheMissReason: "tools_changed",
      cacheMissProviderStatus: "previous_cache_entry_unavailable",
    }),
  ]) {
    const feed = buildCacheEvents({
      sessionId: "session",
      agents: [agent],
      enabled: true,
      usageSnapshots: [
        snapshot("before", new Date(start).toISOString(), { input: 1_000, cacheRead: 9_000, cacheLifetime: "1h" }),
        current,
      ],
    });
    assert.equal(feed.possibleFullRefills[0].occurrences[0].cacheLifetimeInference, null);
  }
});

const sendStart = Date.parse("2026-08-10T10:00:00.000Z");
const secondsAt = (seconds) => new Date(sendStart + seconds * 1_000).toISOString();

/** A high-reuse request followed by a full rewrite; `answer` is the response time in seconds, `sent` the recorded send time. */
function refillAfter(previous, current, { cacheLifetime = "5m", ...currentOptions } = {}) {
  const result = buildCacheEvidence({ sessionId: "session", agents: [agent], enabled: true, usageSnapshots: [
    snapshot("before", secondsAt(previous.answer), { input: 1_000, cacheRead: 9_000, cacheLifetime, requestSentAt: previous.sent }),
    snapshot("after", secondsAt(current.answer), { input: 1_000, cacheWrite: 9_000, requestSentAt: current.sent, ...currentOptions }),
  ] });
  return { result, occurrence: result.feed.possibleFullRefills[0].occurrences[0] };
}

test("infers cache expiry that elapsed while the earlier request was still being answered", () => {
  // Sent at 0 s, first answered 348 s later; the next request is sent 3 s after that answer.
  const { result, occurrence } = refillAfter({ answer: 348, sent: secondsAt(0) }, { answer: 360, sent: secondsAt(351) });
  assert.deepEqual(occurrence.cacheLifetimeInference, { cause: "cache_lifetime_elapsed", cacheLifetime: "5m", elapsedMs: 351_000 });
  assert.equal(result.refillRequests[0].observation.gapMs, 12_000, "the response-time gap is unchanged");
  assert.doesNotMatch(JSON.stringify(result.feed), /requestSentAt/);
  // The same shape with an answer under five minutes is not an expiry.
  const quick = refillAfter({ answer: 200, sent: secondsAt(0) }, { answer: 212, sent: secondsAt(203) });
  assert.equal(quick.occurrence.cacheLifetimeInference, null);
  assert.equal(quick.result.refillRequests[0].observation.gapMs, 12_000);
});

test("a slow answer to the next request no longer reads as an elapsed lifetime", () => {
  const previous = { answer: 10, sent: secondsAt(0) };
  // Sent 4 s after the earlier answer, then answered 6 minutes later.
  assert.equal(refillAfter(previous, { answer: 370, sent: secondsAt(14) }).occurrence.cacheLifetimeInference, null);
  // Without recorded send times only the response-time gap exists, so the earlier rule applies.
  assert.deepEqual(refillAfter({ answer: 10 }, { answer: 370 }).occurrence.cacheLifetimeInference,
    { cause: "cache_lifetime_elapsed", cacheLifetime: "5m", elapsedMs: 360_000 });
});

test("falls back to the response-time gap unless both send times are recorded and consistent", () => {
  const response = { cause: "cache_lifetime_elapsed", cacheLifetime: "5m", elapsedMs: 360_000 };
  for (const [name, previous, current] of [
    ["previous missing", { answer: 10 }, { answer: 370, sent: secondsAt(14) }],
    ["current null", { answer: 10, sent: secondsAt(0) }, { answer: 370, sent: null }],
    ["previous after its own answer", { answer: 10, sent: secondsAt(20) }, { answer: 370, sent: secondsAt(14) }],
    ["current invalid", { answer: 10, sent: secondsAt(0) }, { answer: 370, sent: "not-a-time" }],
  ]) {
    assert.deepEqual(refillAfter(previous, current).occurrence.cacheLifetimeInference, response, name);
  }
  // Both recorded but out of order is contradictory evidence, so it never establishes expiry.
  assert.equal(refillAfter({ answer: 10, sent: secondsAt(8) }, { answer: 370, sent: secondsAt(5) }).occurrence.cacheLifetimeInference, null);
});

test("send times never relax the other expiry requirements", () => {
  const previous = { answer: 348, sent: secondsAt(0) };
  const current = { answer: 360, sent: secondsAt(351) };
  const reasoned = refillAfter(previous, current, { cacheMissReason: "tools_changed" });
  assert.equal(reasoned.occurrence.reason, "tools_changed");
  assert.equal(reasoned.occurrence.cacheLifetimeInference, null);
  assert.equal(refillAfter(previous, current, { cacheMissDiagnosticState: "inconclusive" }).occurrence.cacheLifetimeInference, null);
  const minimum = refillAfter({ answer: 10, sent: secondsAt(0) }, { answer: 7_300, sent: secondsAt(7_200) }, { cacheLifetime: "30m+" });
  assert.equal(minimum.occurrence.cacheLifetimeInference, null);
  assert.equal(refillAfter({ answer: 10, sent: secondsAt(0) }, { answer: 7_300, sent: secondsAt(7_200) }, { cacheLifetime: null }).occurrence.cacheLifetimeInference, null);
  const unavailable = refillAfter(previous, current, { cacheMissProviderStatus: "previous_cache_entry_unavailable", cacheMissDiagnosticState: "previous_cache_entry_unavailable" });
  assert.equal(unavailable.occurrence.cacheLifetimeInference?.elapsedMs, 351_000);
});

test("evaluates refill and lifetime evidence independently for primary, subagent, and fork", () => {
  const agents = [agent, { id: "child", role: "builder" }, { id: "fork", role: "fork" }];
  const start = Date.parse("2026-08-10T10:00:00.000Z");
  const usageSnapshots = agents.flatMap(({ id }, index) => [
    snapshot("shared-before", new Date(start + index * 1_000).toISOString(), {
      actorId: id, input: 1_000, cacheRead: 9_000, cacheLifetime: id === "child" ? "5m" : "1h",
    }),
    snapshot("shared-after", new Date(start + index * 1_000 + (id === "child" ? 6 : 61) * 60_000).toISOString(), {
      actorId: id, input: 1_000, cacheWrite: 9_000, cacheMissProviderStatus: "previous_cache_entry_unavailable",
    }),
  ]);
  const feed = buildCacheEvents({ sessionId: "session", agents, enabled: true, usageSnapshots });
  assert.deepEqual(feed.possibleFullRefills.map(({ agentId }) => agentId), ["child", "fork", "primary"]);
  assert.deepEqual(feed.possibleFullRefills.map(({ occurrences }) => occurrences[0].cacheLifetimeInference.cacheLifetime), ["5m", "1h", "1h"]);
  assert.doesNotMatch(JSON.stringify(feed), /cacheMissDiagnosticState|recognized_reason|inconclusive/);
});

/** A subagent's long answer: the shared prefix stays cached while the rest outlives a five-minute lifetime. */
function partialAfter(previous, current, { before = {}, ...after } = {}) {
  return buildCacheEvidence({ sessionId: "session", agents: [agent], enabled: true, usageSnapshots: [
    snapshot("before", secondsAt(previous.answer), { input: 2, cacheRead: 135_838, cacheWrite: 1_342, cacheLifetime: "5m", requestSentAt: previous.sent, ...before }),
    snapshot("after", secondsAt(current.answer), { input: 2, cacheRead: 29_587, cacheWrite: 148_096, requestSentAt: current.sent, ...after }),
  ] });
}

test("keeps a partial rewrite whose lifetime elapsed behind a long answer apart from possible full refills", () => {
  const result = partialAfter({ answer: 348, sent: secondsAt(0) }, { answer: 360, sent: secondsAt(354) });
  assert.deepEqual(result.feed.possibleFullRefills, [{
    agentId: "primary",
    count: 0,
    lifetimeElapsedCount: 1,
    occurrences: [{
      observedAt: secondsAt(360),
      kind: "lifetime_elapsed",
      reason: null,
      providerStatus: null,
      cacheLifetimeInference: { cause: "cache_lifetime_elapsed", cacheLifetime: "5m", elapsedMs: 354_000 },
      messageChangeSequence: null,
      toolChangeAttribution: null,
    }],
    reasons: [],
    toolChangeAttributions: [],
  }]);
  assert.deepEqual(result.refillRequests, [], "the session report keeps listing only full refills");
  assert.deepEqual(result.feed.items.map((event) => event.kind), ["refill"], "no miss_refill event for a partial rewrite");
  assert.doesNotMatch(JSON.stringify(result.feed), /requestSentAt|cacheMissDiagnosticState/);
});

test("never marks a partial rewrite as expired without complete lifetime evidence", () => {
  const long = [{ answer: 348, sent: secondsAt(0) }, { answer: 360, sent: secondsAt(354) }];
  const cases = [
    ["answered inside the lifetime", partialAfter({ answer: 200, sent: secondsAt(0) }, { answer: 212, sent: secondsAt(203) })],
    ["inconclusive diagnostic", partialAfter(...long, { cacheMissDiagnosticState: "inconclusive" })],
    ["minimum-only lifetime", partialAfter(...long, { before: { cacheLifetime: "30m+" } })],
    ["unresolved lifetime", partialAfter(...long, { before: { cacheLifetime: null } })],
    ["small write", partialAfter(...long, { cacheWrite: 7_999, cacheRead: 29_587 })],
    // The whole previous prefix was still read: the prompt grew, the cache did not expire.
    ["ordinary growth", partialAfter(...long, { cacheRead: 137_180, cacheWrite: 148_096 })],
    ["comparison group changed", partialAfter(...long, { group: 1 })],
  ];
  for (const [label, result] of cases) assert.deepEqual(result.feed.possibleFullRefills, [], label);
  // A recognized reason stays provider-diagnosed and never gains the expiry inference.
  const reasoned = partialAfter(...long, { cacheMissReason: "tools_changed", cacheMissDiagnosticState: "recognized_reason" }).feed.possibleFullRefills[0];
  assert.deepEqual([reasoned.providerDiagnosedCount, reasoned.lifetimeElapsedCount, reasoned.occurrences[0].kind], [1, undefined, "provider_diagnosed"]);
  assert.equal(reasoned.occurrences[0].cacheLifetimeInference, null);
  // At 10% read share or less the rewrite stays a possible full refill carrying the same inference.
  const full = partialAfter(...long, { cacheRead: 10_000, cacheWrite: 148_096 }).feed.possibleFullRefills[0];
  assert.deepEqual([full.count, full.lifetimeElapsedCount, full.occurrences[0].kind], [1, undefined, undefined]);
  assert.equal(full.occurrences[0].cacheLifetimeInference.elapsedMs, 354_000);
});

const DIAGNOSED_START = Date.parse("2026-10-02T10:00:00.000Z");

function diagnosedPair({ before = {}, after = {}, gapMs = 45 * 60_000 } = {}) {
  return [
    snapshot("before", new Date(DIAGNOSED_START).toISOString(), { input: 800, cacheRead: 213_345, ...before }),
    snapshot("after", new Date(DIAGNOSED_START + gapMs).toISOString(), {
      input: 2, cacheRead: 36_700, cacheWrite: 177_443, cacheMissReason: "tools_changed", ...after,
    }),
  ];
}

function diagnosedFeed(usageSnapshots, compactions = []) {
  return buildCacheEvidence({ sessionId: "session", agents: [agent], enabled: true, usageSnapshots, compactions });
}

test("keeps a provider-diagnosed partial rewrite apart from possible full refills", () => {
  const result = diagnosedFeed(diagnosedPair({ before: { cacheLifetime: "5m" }, after: { cacheMissProviderStatus: "previous_cache_entry_unavailable" } }));
  const afterAt = new Date(DIAGNOSED_START + 45 * 60_000).toISOString();
  assert.deepEqual(result.feed.possibleFullRefills, [{
    agentId: "primary",
    count: 0,
    providerDiagnosedCount: 1,
    occurrences: [{
      observedAt: afterAt,
      kind: "provider_diagnosed",
      reason: "tools_changed",
      providerStatus: "previous_cache_entry_unavailable",
      cacheLifetimeInference: null,
      messageChangeSequence: null,
      toolChangeAttribution: null,
    }],
    reasons: [],
    toolChangeAttributions: [],
  }]);
  assert.deepEqual(result.refillRequests, [], "the session report keeps listing only full refills");
  assert.deepEqual(result.feed.items.map((event) => event.kind), ["refill"], "no miss_refill event for a partial rewrite");
  assert.equal(result.feed.items[0].cacheReadPercent, 17);
  assert.doesNotMatch(JSON.stringify(result.feed), /cacheMissDiagnosticState|recognized_reason|inconclusive/);
});

test("carries the bounded sequence and tool attribution of a provider-diagnosed rewrite without aggregate counts", () => {
  const messages = diagnosedFeed(diagnosedPair({ after: {
    cacheMissReason: "messages_changed", cacheMessageChangeSequence: "post_tool_task_notification_resume", cacheRead: 100_000, cacheWrite: 100_000,
  } })).feed.possibleFullRefills[0];
  assert.equal(messages.providerDiagnosedCount, 1);
  assert.equal(messages.occurrences[0].reason, "messages_changed");
  assert.equal(messages.occurrences[0].messageChangeSequence, "post_tool_task_notification_resume");

  const tools = diagnosedFeed(diagnosedPair({ after: { cacheToolChangeCause: "remote_control_connected" } })).feed.possibleFullRefills[0];
  assert.equal(tools.occurrences[0].toolChangeAttribution.cause, "remote_control_connected");
  assert.deepEqual([tools.count, tools.reasons, tools.toolChangeAttributions], [0, [], []]);
});

test("records no provider-diagnosed occurrence without a recognized reason", () => {
  for (const cacheMissReason of [null, "private_provider_reason", "recognized_reason", ""]) {
    const result = diagnosedFeed(diagnosedPair({ after: { cacheMissReason, cacheMissProviderStatus: "previous_cache_entry_unavailable" } }));
    assert.deepEqual(result.feed.possibleFullRefills, [], String(cacheMissReason));
    assert.deepEqual(result.refillRequests, []);
  }
});

test("requires the write, prompt-size, and previous read-share thresholds", () => {
  const { minimumCacheWriteTokens, minimumPromptInputTokens } = CACHE_EVENT_RULES;
  const cases = [
    ["write at the minimum", { after: { cacheRead: 36_700, cacheWrite: minimumCacheWriteTokens } }, 1],
    ["write below the minimum", { after: { cacheRead: 36_700, cacheWrite: minimumCacheWriteTokens - 1 } }, 0],
    ["previous share at the minimum", { before: { input: 42_669, cacheRead: 170_676 } }, 1],
    ["previous share below the minimum", { before: { input: 42_670, cacheRead: 170_675 } }, 0],
    ["small previous prompt", { before: { input: 100, cacheRead: minimumPromptInputTokens - 101 } }, 0],
  ];
  for (const [label, options, expected] of cases) {
    const result = diagnosedFeed(diagnosedPair(options));
    assert.equal(result.feed.possibleFullRefills[0]?.providerDiagnosedCount ?? 0, expected, label);
  }
});

test("breaks provider-diagnosed comparison on a group, model, or compaction change", () => {
  const between = new Date(DIAGNOSED_START + 20 * 60_000).toISOString();
  for (const [label, options, compactions, expected] of [
    ["comparison group", { after: { group: 1 } }, [], 0],
    ["model", { after: { model: "other-model" } }, [], 0],
    ["compaction between", {}, [{ actorId: "primary", timestamp: between }], 0],
    ["compaction at the previous request", {}, [{ actorId: "primary", timestamp: new Date(DIAGNOSED_START).toISOString() }], 1],
    ["compaction of another agent", {}, [{ actorId: "child", timestamp: between }], 1],
  ]) {
    const result = diagnosedFeed(diagnosedPair(options), compactions);
    assert.equal(result.feed.possibleFullRefills[0]?.providerDiagnosedCount ?? 0, expected, label);
  }
});

test("a full refill with a recognized reason stays a possible full refill", () => {
  const result = diagnosedFeed(diagnosedPair({ after: { cacheRead: 500, cacheWrite: 213_000 } }));
  const [summary] = result.feed.possibleFullRefills;
  assert.equal(summary.count, 1);
  assert.equal(Object.hasOwn(summary, "providerDiagnosedCount"), false);
  assert.equal(Object.hasOwn(summary.occurrences[0], "kind"), false);
  assert.deepEqual(summary.reasons, [{ reason: "tools_changed", count: 1 }]);
  assert.equal(result.refillRequests.length, 1);
  assert.deepEqual(result.feed.items.map((event) => event.kind), ["miss_refill"]);
});

test("counts each occurrence kind separately with its own 999 cap and exact serialized keys", () => {
  const usageSnapshots = [];
  const cap = CACHE_EVENT_RULES.maximumAgentRefillCount;
  for (let index = 0; index < cap + 2; index += 1) {
    const at = (offset) => new Date(DIAGNOSED_START + index * 600_000 + offset).toISOString();
    usageSnapshots.push(
      snapshot(`reuse-${index}`, at(0), { input: 1_000, cacheRead: 213_000 }),
      snapshot(`partial-${index}`, at(60_000), { input: 2, cacheRead: 36_700, cacheWrite: 177_443, cacheMissReason: "tools_changed" }),
      snapshot(`reuse-b-${index}`, at(120_000), { input: 1_000, cacheRead: 213_000 }),
      snapshot(`full-${index}`, at(180_000), { input: 1_000, cacheWrite: 213_000 }),
    );
  }
  const [summary] = diagnosedFeed(usageSnapshots).feed.possibleFullRefills;
  assert.equal(summary.count, cap);
  assert.equal(summary.providerDiagnosedCount, cap);
  assert.equal(summary.occurrences.length, cap * 2);
  assert.deepEqual(Object.keys(summary).sort(), ["agentId", "count", "occurrences", "providerDiagnosedCount", "reasons", "toolChangeAttributions"]);
  const diagnosed = summary.occurrences.filter((occurrence) => occurrence.kind === "provider_diagnosed");
  assert.equal(diagnosed.length, cap);
  assert.deepEqual(Object.keys(diagnosed[0]).sort(), [
    "cacheLifetimeInference", "kind", "messageChangeSequence", "observedAt", "providerStatus", "reason", "toolChangeAttribution",
  ]);
  const full = summary.occurrences.filter((occurrence) => !Object.hasOwn(occurrence, "kind"));
  assert.equal(full.length, cap);
  assert.deepEqual(Object.keys(full[0]).sort(), [
    "cacheLifetimeInference", "messageChangeSequence", "observedAt", "providerStatus", "reason", "toolChangeAttribution",
  ]);
});

test("attributes loaded deferred definitions to either occurrence kind with a bounded count and no tool list", () => {
  const cause = "deferred_definitions_loaded";
  const attribution = { cause, changes: [], addedDefinitionCount: 8 };
  const loaded = { cacheToolChangeCause: cause, cacheToolChangeAddedDefinitionCount: 8 };
  const diagnosed = diagnosedFeed(diagnosedPair({ after: loaded })).feed.possibleFullRefills[0];
  assert.deepEqual(diagnosed.occurrences[0].toolChangeAttribution, attribution);
  assert.deepEqual([diagnosed.count, diagnosed.reasons, diagnosed.toolChangeAttributions], [0, [], []]);
  const full = diagnosedFeed(diagnosedPair({ after: { cacheRead: 500, cacheWrite: 213_000, ...loaded } })).feed.possibleFullRefills[0];
  assert.deepEqual(full.occurrences[0].toolChangeAttribution, attribution);
  // Totals count occurrences; the per-occurrence count is never summed or repeated.
  assert.deepEqual(full.toolChangeAttributions, [{ cause, count: 1, changes: [] }]);
  assert.deepEqual(Object.keys(full.occurrences[0].toolChangeAttribution).sort(), ["addedDefinitionCount", "cause", "changes"]);
  assert.deepEqual(diagnosedFeed(diagnosedPair({ after: { cacheRead: 500, cacheWrite: 213_000, ...loaded } })).refillRequests.length, 1);
});

test("a loaded-definitions attribution needs a tools_changed reason and a positive bounded integer count", () => {
  const cause = "deferred_definitions_loaded";
  const attributionOf = (after) => diagnosedFeed(diagnosedPair({ after })).feed.possibleFullRefills[0]?.occurrences[0]?.toolChangeAttribution;
  assert.equal(attributionOf({ cacheToolChangeCause: cause, cacheToolChangeAddedDefinitionCount: 64 }).addedDefinitionCount, 64);
  assert.equal(attributionOf({ cacheToolChangeCause: cause, cacheToolChangeAddedDefinitionCount: 1 }).addedDefinitionCount, 1);
  for (const count of [undefined, 0, -1, 65, 1.5, "8", null, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(attributionOf({ cacheToolChangeCause: cause, cacheToolChangeAddedDefinitionCount: count }), null, String(count));
  }
  assert.equal(attributionOf({ cacheToolChangeCause: cause, cacheToolChangeAddedDefinitionCount: 8, cacheMissReason: "messages_changed" }), null);
  assert.equal(attributionOf({ cacheToolChangeCause: "unrecognized_cause", cacheToolChangeAddedDefinitionCount: 8 }), null);
  // Remote Control keeps its fixed list and never carries a count, even if one is supplied.
  const remote = attributionOf({ cacheToolChangeCause: "remote_control_connected", cacheToolChangeAddedDefinitionCount: 8 });
  assert.equal(remote.changes.length, 3);
  assert.equal(Object.hasOwn(remote, "addedDefinitionCount"), false);
});
