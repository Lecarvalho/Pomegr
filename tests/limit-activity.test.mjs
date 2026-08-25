import test from "node:test";
import assert from "node:assert/strict";
import { createHomeLimitActivityTracker } from "../monitor/limit-activity.mjs";

const limit = (fetchedAt, percent, resetsAt = "2026-08-25T17:00:00.000Z") => ({
  provider: "claude",
  source: "Claude Code",
  usageLimits: { fetchedAt, limits: [{ id: "current-session", label: "Current session", window: "5 hours", percent, resetsAt }] },
});
const rejection = (observedAt, resetsAt = "2026-08-25T17:00:00.000Z") => ({ observedAt, resetsAt });
const session = (id, requestObservations, extra = {}) => ({ id, provider: "claude", source: "Claude Code", createdAt: "2026-08-25T11:00:00.000Z", title: id, project: "repo", isLive: false, requestObservations, usageLimitRejections: [], ...extra });
const build = (tracker, providerLimits, sessions = [], generatedAt = "2026-08-25T17:00:00.000Z") => tracker.build({ providerLimits, sessions, generatedAt });
const codexLimits = (fetchedAt = "2026-08-25T17:00:00.000Z") => ({
  provider: "codex",
  source: "Codex",
  usageLimits: {
    fetchedAt,
    limits: [
      { id: "gpt-5.3-codex-spark-primary", label: "GPT-5.3-Codex-Spark", window: "5 hours", percent: 23, resetsAt: "2026-08-25T17:00:00.000Z" },
      { id: "codex-secondary", label: "Codex", window: "7 days", percent: 61, resetsAt: "2026-08-29T17:00:00.000Z" },
    ],
  },
});
const codexSession = (id, models) => session(id, models.map((model, index) => ({ id: `${id}-${index}`, observedAt: `2026-08-25T16:${String(index).padStart(2, "0")}:00.000Z` })), {
  provider: "codex",
  source: "Codex",
  requestModelObservations: models.map((model, index) => ({ model, observedAt: `2026-08-25T16:${String(index).padStart(2, "0")}:00.000Z` })),
});

test("collects a first current five-hour sample", () => {
  const tracker = createHomeLimitActivityTracker();
  const activities = build(tracker, [limit("2026-08-25T12:00:00.000Z", 12)]);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].status, "collecting");
  assert.equal(activities[0].percent, 12);
  assert.equal(activities[0].observedFrom, "2026-08-25T12:00:00.000Z");
  assert.deepEqual(activities[0].observations, [{ observedAt: "2026-08-25T12:00:00.000Z", percent: 12 }]);
});

test("selects the Spark five-hour limit only when Spark is the unique dominant Codex model", () => {
  const tracker = createHomeLimitActivityTracker();
  const activities = build(tracker, [codexLimits()], [
    codexSession("mostly-spark", ["gpt-5.3-codex-spark", "GPT-5.3-CODEX-SPARK", "gpt-5.4"]),
  ]);

  assert.equal(activities.length, 1);
  assert.equal(activities[0].limitId, "gpt-5.3-codex-spark-primary");
  assert.equal(activities[0].label, "GPT-5.3-Codex-Spark");
  assert.equal(activities[0].window, "5 hours");
  assert.doesNotMatch(JSON.stringify(activities), /gpt-5\.4|requestModelObservations/i);
});

test("selects the Codex seven-day limit for other models, ties, or missing model evidence", () => {
  for (const sessions of [
    [codexSession("mostly-standard", ["gpt-5.4", "gpt-5.4", "gpt-5.3-codex-spark"])],
    [codexSession("tie", ["gpt-5.4", "gpt-5.3-codex-spark"])],
    [],
  ]) {
    const tracker = createHomeLimitActivityTracker();
    const activities = build(tracker, [codexLimits()], sessions);
    assert.equal(activities.length, 1);
    assert.equal(activities[0].limitId, "codex-secondary");
    assert.equal(activities[0].window, "7 days");
    assert.equal(activities[0].windowStartsAt, "2026-08-22T17:00:00.000Z");
    assert.equal(activities[0].firstRejectedAt, null);
  }
});

test("uses a wider bounded model sample without adding those sessions to chart lanes", () => {
  const tracker = createHomeLimitActivityTracker();
  const displayed = Array.from({ length: 24 }, (_, index) => codexSession(`spark-${index}`, ["gpt-5.3-codex-spark"]));
  const modelSelectionSessions = [
    ...displayed,
    ...Array.from({ length: 25 }, (_, index) => codexSession(`standard-${index}`, ["gpt-5.4"])),
  ];
  const activities = tracker.build({
    providerLimits: [codexLimits()],
    sessions: displayed,
    modelSelectionSessions,
    generatedAt: "2026-08-25T17:00:00.000Z",
  });

  assert.equal(activities[0].limitId, "codex-secondary");
  assert.equal(activities[0].sessions.length, displayed.length);
  assert.equal(activities[0].sessions.some(({ id }) => id.startsWith("standard-")), false);
});

test("selects the earliest valid five-hour rejection for the current reset across sessions", () => {
  const tracker = createHomeLimitActivityTracker();
  tracker.observe([limit("2026-08-25T12:00:00.000Z", 10)]);
  const activities = build(tracker, [limit("2026-08-25T13:00:00.000Z", 20)], [
    session("later", [{ id: "later-request", observedAt: "2026-08-25T12:30:00.000Z" }], {
      usageLimitRejections: [
        rejection("2026-08-25T12:40:00.000Z"),
        rejection("2026-08-25T12:20:00.000Z", "2026-08-25T18:00:00.000Z"),
        rejection("not-a-time"),
      ],
    }),
    session("earlier", [{ id: "earlier-request", observedAt: "2026-08-25T12:45:00.000Z" }], {
      usageLimitRejections: [
        rejection("2026-08-25T12:10:00.000Z"),
      ],
    }),
  ]);
  assert.equal(activities[0].firstRejectedAt, "2026-08-25T12:10:00.000Z");

  const noRejectionTracker = createHomeLimitActivityTracker();
  noRejectionTracker.observe([limit("2026-08-25T12:00:00.000Z", 10)]);
  const withoutMatch = build(noRejectionTracker, [limit("2026-08-25T13:00:00.000Z", 20)], [
    session("invalid", [{ id: "invalid-request", observedAt: "2026-08-25T12:30:00.000Z" }], {
      usageLimitRejections: [
        rejection("not-a-time"),
        rejection("2026-08-25T12:20:00.000Z", "2026-08-25T18:00:00.000Z"),
      ],
    }),
  ]);
  assert.equal(withoutMatch[0].firstRejectedAt, null);
});

test("carries a warm reset boundary forward when the next sample omits resetsAt", () => {
  const tracker = createHomeLimitActivityTracker();
  tracker.observe([limit("2026-08-25T12:00:00.000Z", 100, "2026-08-25T12:10:00.000Z")]);
  const activities = build(tracker, [limit("2026-08-25T12:17:00.000Z", 0, null)], [
    session("warm", [
      { id: "stale-request", observedAt: "2026-08-25T12:04:00.000Z" },
      { id: "boundary-request", observedAt: "2026-08-25T12:10:00.000Z" },
      { id: "current-request", observedAt: "2026-08-25T12:17:00.000Z" },
    ], {
      usageLimitRejections: [rejection("2026-08-25T12:04:00.000Z", "2026-08-25T12:10:00.000Z")],
    }),
  ], "2026-08-25T12:17:00.000Z");
  assert.equal(activities[0].windowStartsAt, "2026-08-25T12:10:00.000Z");
  assert.equal(activities[0].windowStartsAtExact, true);
  assert.equal(activities[0].firstRejectedAt, null);
  assert.deepEqual(activities[0].sessions[0].requestObservations.map(({ id }) => id), ["boundary-request", "current-request"]);
});

test("derives a cold null-reset window without carrying a stale rejection", () => {
  const tracker = createHomeLimitActivityTracker();
  const activities = build(tracker, [limit("2026-08-25T12:17:00.000Z", 0, null)], [
    session("cold", [{ id: "current-request", observedAt: "2026-08-25T12:17:00.000Z" }], {
      usageLimitRejections: [rejection("2026-08-25T12:04:00.000Z", "2026-08-25T12:10:00.000Z")],
    }),
  ], "2026-08-25T12:17:00.000Z");
  assert.equal(activities[0].windowStartsAt, "2026-08-25T12:10:00.000Z");
  assert.equal(activities[0].windowStartsAtExact, true);
  assert.equal(activities[0].firstRejectedAt, null);
});

test("does not reset observations when null resetsAt follows an unchanged percentage", () => {
  const tracker = createHomeLimitActivityTracker();
  tracker.observe([limit("2026-08-25T12:00:00.000Z", 20, "2026-08-25T12:10:00.000Z")]);
  tracker.observe([limit("2026-08-25T12:05:00.000Z", 25, "2026-08-25T12:10:00.000Z")]);
  let activities = build(tracker, [limit("2026-08-25T12:10:00.000Z", 25, null)], [], "2026-08-25T12:10:00.000Z");
  assert.deepEqual(activities[0].observations, [
    { observedAt: "2026-08-25T12:00:00.000Z", percent: 20 },
    { observedAt: "2026-08-25T12:05:00.000Z", percent: 25 },
    { observedAt: "2026-08-25T12:10:00.000Z", percent: 25 },
  ]);
  assert.equal(activities[0].movements.length, 1);
  assert.equal(activities[0].movements[0].changePoints, 5);
  activities = build(tracker, [limit("2026-08-25T12:15:00.000Z", 30, null)], [], "2026-08-25T12:15:00.000Z");
  assert.equal(activities[0].movements.length, 2);
  assert.equal(activities[0].movements[1].changePoints, 5);
});

test("preserves an exact tracked boundary when resetsAt disappears before a percentage drop", () => {
  const tracker = createHomeLimitActivityTracker();
  tracker.observe([limit("2026-08-25T12:00:00.000Z", 10)]);
  tracker.observe([limit("2026-08-25T12:05:00.000Z", 20, null)]);
  const activities = build(tracker, [limit("2026-08-25T12:10:00.000Z", 0, null)], [], "2026-08-25T12:10:00.000Z");
  assert.equal(activities[0].windowStartsAt, "2026-08-25T12:00:00.000Z");
  assert.equal(activities[0].windowStartsAtExact, true);
  assert.deepEqual(activities[0].observations, [{ observedAt: "2026-08-25T12:10:00.000Z", percent: 0 }]);
});

test("uses a restored reset timestamp only when its effective window changes", () => {
  const tracker = createHomeLimitActivityTracker();
  tracker.observe([limit("2026-08-25T12:00:00.000Z", 10)]);
  tracker.observe([limit("2026-08-25T12:30:00.000Z", 20, null)]);
  let activities = build(tracker, [limit("2026-08-25T12:45:00.000Z", 25)], [], "2026-08-25T12:45:00.000Z");
  assert.equal(activities[0].observations.length, 3);
  activities = build(tracker, [limit("2026-08-25T13:05:00.000Z", 25, "2026-08-25T18:00:00.000Z")], [], "2026-08-25T13:05:00.000Z");
  assert.equal(activities[0].windowStartsAt, "2026-08-25T13:00:00.000Z");
  assert.deepEqual(activities[0].observations, [{ observedAt: "2026-08-25T13:05:00.000Z", percent: 25 }]);
});

test("rejects implausible transcript and provider reset boundaries", () => {
  const staleTracker = createHomeLimitActivityTracker();
  const stale = build(staleTracker, [limit("2026-08-25T17:00:00.000Z", 0, null)], [
    session("stale", [{ id: "request", observedAt: "2026-08-25T16:00:00.000Z" }], {
      usageLimitRejections: [rejection("2026-08-25T01:00:00.000Z", "2026-08-25T15:00:00.000Z")],
    }),
  ]);
  assert.equal(stale[0].windowStartsAt, "2026-08-25T12:00:00.000Z");
  assert.equal(stale[0].windowStartsAtExact, false);
  assert.equal(stale[0].firstRejectedAt, null);

  for (const resetsAt of ["2026-08-25T24:00:00.000Z", "2026-08-25T10:00:00.000Z"]) {
    const tracker = createHomeLimitActivityTracker();
    const activities = build(tracker, [limit("2026-08-25T17:00:00.000Z", 0, resetsAt)]);
    assert.equal(activities[0].windowStartsAt, "2026-08-25T12:00:00.000Z");
    assert.equal(activities[0].windowStartsAtExact, false);
  }
});

test("matches a rejection marker to the provider's current reset identity", () => {
  const tracker = createHomeLimitActivityTracker();
  const activities = build(tracker, [limit("2026-08-25T13:00:00.000Z", 100)], [
    session("mixed", [{ id: "request", observedAt: "2026-08-25T12:30:00.000Z" }], {
      usageLimitRejections: [
        rejection("2026-08-25T12:10:00.000Z", "2026-08-25T12:30:00.000Z"),
        rejection("2026-08-25T12:20:00.000Z", "2026-08-25T17:00:00.000Z"),
      ],
    }),
  ], "2026-08-25T13:00:00.000Z");
  assert.equal(activities[0].windowStartsAt, "2026-08-25T12:00:00.000Z");
  assert.equal(activities[0].firstRejectedAt, "2026-08-25T12:20:00.000Z");
});

test("correlates exclusive, shared, and unobserved positive movements", () => {
  const tracker = createHomeLimitActivityTracker();
  tracker.observe([limit("2026-08-25T12:00:00.000Z", 10)]);
  tracker.observe([limit("2026-08-25T12:30:00.000Z", 20)]);
  tracker.observe([limit("2026-08-25T13:00:00.000Z", 30)]);
  const activities = build(tracker, [limit("2026-08-25T13:00:00.000Z", 30)], [
    session("one", [{ id: "r1", observedAt: "2026-08-25T12:15:00.000Z" }]),
    session("two", [{ id: "r2", observedAt: "2026-08-25T12:45:00.000Z" }]),
  ]);
  assert.deepEqual(activities[0].movements.map((movement) => movement.correlation), ["single", "single"]);
  assert.equal(activities[0].movements[0].changePoints, 10);
  const shared = build(tracker, [limit("2026-08-25T13:30:00.000Z", 40)], [
    session("one", [{ id: "r1", observedAt: "2026-08-25T12:15:00.000Z" }, { id: "r3", observedAt: "2026-08-25T13:15:00.000Z" }]),
    session("two", [{ id: "r2", observedAt: "2026-08-25T12:45:00.000Z" }, { id: "r4", observedAt: "2026-08-25T13:15:00.000Z" }]),
  ]);
  assert.equal(shared[0].movements.at(-1).correlation, "shared");
  const unobserved = build(tracker, [limit("2026-08-25T14:00:00.000Z", 50)], []);
  assert.equal(unobserved[0].movements.at(-1).correlation, "unobserved");
});

test("keeps closed sessions and excludes other providers", () => {
  const tracker = createHomeLimitActivityTracker();
  tracker.observe([limit("2026-08-25T12:00:00.000Z", 10)]);
  tracker.observe([limit("2026-08-25T13:00:00.000Z", 20)]);
  const activities = build(tracker, [limit("2026-08-25T13:00:00.000Z", 20)], [
    session("closed", [{ id: "closed-r", observedAt: "2026-08-25T12:30:00.000Z" }]),
    session("other-provider", [{ id: "other-r", observedAt: "2026-08-25T12:30:00.000Z" }], { provider: "codex" }),
    session("other-repo", [{ id: "repo-r", observedAt: "2026-08-25T12:30:00.000Z" }], { project: "different-repo" }),
  ]);
  assert.deepEqual(activities[0].sessions.map(({ id }) => id), ["closed", "other-repo"]);
  assert.equal(activities[0].movements[0].correlation, "shared");
});

test("keeps session lanes ordered oldest-created-first as request activity changes", () => {
  const tracker = createHomeLimitActivityTracker();
  const current = limit("2026-08-25T13:00:00.000Z", 20);
  const first = build(tracker, [current], [
    session("older", [{ id: "older-latest", observedAt: "2026-08-25T12:50:00.000Z" }], { createdAt: "2026-08-25T10:00:00.000Z" }),
    session("newer", [{ id: "newer-earlier", observedAt: "2026-08-25T12:10:00.000Z" }], { createdAt: "2026-08-25T11:00:00.000Z" }),
  ]);
  const refreshed = build(tracker, [current], [
    session("older", [{ id: "older-earlier", observedAt: "2026-08-25T12:10:00.000Z" }], { createdAt: "2026-08-25T10:00:00.000Z" }),
    session("newer", [{ id: "newer-latest", observedAt: "2026-08-25T12:50:00.000Z" }], { createdAt: "2026-08-25T11:00:00.000Z" }),
  ]);

  assert.deepEqual(first[0].sessions.map(({ id }) => id), ["older", "newer"]);
  assert.deepEqual(refreshed[0].sessions.map(({ id }) => id), ["older", "newer"]);
  assert.equal(first[0].sessions.every((item) => item.createdAt === undefined), true);
});

test("clears history on reset identity change or percentage drop", () => {
  const tracker = createHomeLimitActivityTracker();
  tracker.observe([limit("2026-08-25T12:00:00.000Z", 10)]);
  tracker.observe([limit("2026-08-25T12:30:00.000Z", 20)]);
  tracker.observe([limit("2026-08-25T13:00:00.000Z", 5)]);
  let activities = build(tracker, [limit("2026-08-25T13:00:00.000Z", 5)]);
  assert.equal(activities[0].status, "collecting");
  tracker.observe([limit("2026-08-25T13:30:00.000Z", 15, "2026-08-25T18:00:00.000Z")]);
  activities = build(tracker, [limit("2026-08-25T13:30:00.000Z", 15, "2026-08-25T18:00:00.000Z")]);
  assert.equal(activities[0].status, "collecting");
  assert.equal(activities[0].movements.length, 0);
});

test("ignores stale out-of-order provider observations", () => {
  const tracker = createHomeLimitActivityTracker();
  tracker.observe([limit("2026-08-25T12:30:00.000Z", 20)]);
  tracker.observe([limit("2026-08-25T12:00:00.000Z", 5)]);
  const activities = build(tracker, [limit("2026-08-25T12:00:00.000Z", 5, "2026-08-25T16:00:00.000Z")]);
  assert.equal(activities[0].percent, 20);
  assert.equal(activities[0].resetsAt, "2026-08-25T17:00:00.000Z");
  assert.equal(activities[0].movements.length, 0);
  assert.deepEqual(activities[0].observations, [{ observedAt: "2026-08-25T12:30:00.000Z", percent: 20 }]);
});

test("bounds retained limit histories and supports an explicitly empty history", () => {
  const item = (id, fetchedAt) => ({
    provider: "claude",
    source: "Claude Code",
    usageLimits: { fetchedAt, limits: [{ id, label: id, window: "5h", percent: 10, resetsAt: "2026-08-25T17:00:00.000Z" }] },
  });
  const tracker = createHomeLimitActivityTracker({ maxHistories: 2 });
  const limits = [
    item("oldest", "2026-08-25T12:00:00.000Z"),
    item("middle", "2026-08-25T12:01:00.000Z"),
    item("latest", "2026-08-25T12:02:00.000Z"),
  ];
  const activities = build(tracker, limits);
  assert.deepEqual(activities.map(({ limitId }) => limitId), ["middle", "latest"]);

  const empty = createHomeLimitActivityTracker({ maxObservations: 0 });
  assert.deepEqual(build(empty, [limit("2026-08-25T12:00:00.000Z", 10)]), []);
});

test("rejects invalid evidence and caps public observations globally", () => {
  const tracker = createHomeLimitActivityTracker({ maxPublicEvents: 2 });
  tracker.observe([limit("not-a-time", 10), { provider: "bad", source: "bad", usageLimits: { fetchedAt: "2026-08-25T12:00:00Z", limits: [{ id: "weekly", window: "7 days", percent: 10 }] } }]);
  tracker.observe([limit("2026-08-25T12:00:00.000Z", 10)]);
  tracker.observe([limit("2026-08-25T13:00:00.000Z", 20)]);
  const activities = build(tracker, [limit("2026-08-25T13:00:00.000Z", 20)], [session("s", [
    { id: "r1", observedAt: "2026-08-25T12:10:00Z", tokens: "PRIVATE" },
    { id: "r2", observedAt: "2026-08-25T12:20:00Z", model: "PRIVATE" },
    { id: "r3", observedAt: "2026-08-25T12:30:00Z", prompt: "PRIVATE" },
  ])]);
  assert.equal(activities[0].eventsTruncated, true);
  assert.equal(activities[0].sessions[0].requestObservations.length, 2);
  assert.doesNotMatch(JSON.stringify(activities), /PRIVATE|tokens|model|prompt/);
});

test("shares the public marker cap across session lanes before retaining additional recent requests", () => {
  const tracker = createHomeLimitActivityTracker({ maxPublicEvents: 6 });
  tracker.observe([limit("2026-08-25T12:00:00.000Z", 10)]);
  const requests = (sessionId) => Array.from({ length: 5 }, (_, index) => ({
    id: `${sessionId}-${index}`,
    observedAt: `2026-08-25T12:${String(10 + index).padStart(2, "0")}:00.000Z`,
  }));
  const activities = build(tracker, [limit("2026-08-25T13:00:00.000Z", 20)], [
    session("one", requests("one")),
    session("two", requests("two")),
    session("three", requests("three")),
  ]);

  assert.equal(activities[0].eventsTruncated, true);
  assert.deepEqual(Object.fromEntries(activities[0].sessions.map(({ id, requestObservations }) => [id, requestObservations.length])), {
    one: 2,
    two: 2,
    three: 2,
  });
  assert.equal(activities[0].sessions.every(({ requestObservations }) => requestObservations.every(({ id }) => /-(?:3|4)$/.test(id))), true);
});

test("removes capped-out lanes from movement correlation metadata", () => {
  const tracker = createHomeLimitActivityTracker({ maxPublicEvents: 1 });
  tracker.observe([limit("2026-08-25T12:00:00.000Z", 10)]);
  const activities = build(tracker, [limit("2026-08-25T13:00:00.000Z", 20)], [
    session("alpha", [{ id: "alpha-request", observedAt: "2026-08-25T12:30:00.000Z" }]),
    session("beta", [{ id: "beta-request", observedAt: "2026-08-25T12:30:00.000Z" }]),
  ]);

  assert.deepEqual(activities[0].sessions.map(({ id }) => id), ["alpha"]);
  assert.equal(activities[0].movements[0].correlation, "single");
  assert.deepEqual(activities[0].movements[0].sessionIds, ["alpha"]);
});

test("omits every request lane when the public marker cap is zero", () => {
  const tracker = createHomeLimitActivityTracker({ maxPublicEvents: 0 });
  const activities = build(tracker, [limit("2026-08-25T13:00:00.000Z", 20)], [
    session("hidden", [{ id: "hidden-request", observedAt: "2026-08-25T12:30:00.000Z" }]),
  ]);

  assert.deepEqual(activities[0].sessions, []);
  assert.equal(activities[0].eventsTruncated, true);
});
