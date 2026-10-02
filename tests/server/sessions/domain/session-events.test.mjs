import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_EVENT_KINDS as CONTRACT_KINDS, SESSION_EVENT_LIMIT as CONTRACT_LIMIT } from "../../../../shared/session-domain-contract.ts";
import { createEmptyMonitorState } from "../../../../shared/monitor-state.mjs";
import { SESSION_EVENT_KINDS, SESSION_EVENT_LIMIT, SESSION_EVENT_READINESS_SECTIONS, sessionEvents } from "../../../../server/sessions/domain/session-events.mjs";
import { createSessionDomainStore } from "../../../../server/sessions/domain/session-domain-store.mjs";
import { projectSessionDomains } from "../../../../server/sessions/domain/session-domain-projection.mjs";
import { historicalRepositoryFromSnapshot, snapshotFromLiveCheck } from "../../../../server/repository/repository-snapshot.mjs";
import { liveRepositoryReadiness } from "../../../../server/repository/session-repository-enrichment.mjs";

const READY = { core: "ready", agentEvidence: "ready", activityEvidence: "ready" };
const EVENT_KEYS = ["agentId", "agentLabel", "at", "durationMs", "id", "kind", "pullRequestNumber", "progress", "resource", "signal"].sort();
const PR_URL = "https://github.com/acme/widgets/pull/17";

function at(minute, second = 0, millisecond = 0) {
  return new Date(Date.UTC(2026, 8, 30, 10, minute, second, millisecond)).toISOString();
}

// Every contract field other than `kind` and `at` defaults to null, so a test names only what its kind uses.
function expected(kind, time, fields = {}) {
  return { kind, at: time, agentId: null, agentLabel: null, durationMs: null, signal: null, progress: null, resource: null, pullRequestNumber: null, ...fields };
}
function withoutId({ id, ...event }) {
  assert.match(id, /^event-[a-f0-9]{16}$/u);
  return event;
}
function derive(inputs = {}) {
  return sessionEvents({ readiness: READY, ...inputs });
}
function kinds(feed) { return feed.items.map((item) => item.kind); }

test("the monitor copy of the contract constants matches the shared contract", () => {
  assert.deepEqual([...SESSION_EVENT_KINDS], [...CONTRACT_KINDS]);
  assert.equal(SESSION_EVENT_LIMIT, CONTRACT_LIMIT);
  assert.equal(SESSION_EVENT_LIMIT, 50);
});

test("agent_started names each delegated agent and skips the primary agent", () => {
  const feed = derive({ agents: [
    { id: "primary", label: "Primary agent", status: "active", startedAt: at(0), updatedAt: at(9), lastSeen: at(9) },
    { id: "agent-a", label: "Reviewer", status: "active", startedAt: at(2), updatedAt: at(9), lastSeen: at(9) },
    { id: "agent-b", label: "Builder", status: "idle", startedAt: "not a time", updatedAt: at(9), lastSeen: at(9) },
    { id: "agent-c", label: "Tester", status: "idle", updatedAt: at(9), lastSeen: at(9) },
  ] });
  assert.equal(feed.readiness, "ready");
  assert.equal(feed.total, 1);
  assert.deepEqual(feed.items.map(withoutId), [expected("agent_started", at(2), { agentId: "agent-a", agentLabel: "Reviewer" })]);
});

test("agent_finished and agent_stopped use the frozen terminal time and a valid duration", () => {
  const feed = derive({ agents: [
    { id: "primary", label: "Primary agent", status: "active", startedAt: at(0), updatedAt: at(9), lastSeen: at(9), durationMs: 540_000 },
    { id: "done", label: "Done", status: "finished", startedAt: at(1), updatedAt: at(4), lastSeen: at(8), durationMs: 180_000 },
    { id: "halted", label: "Halted", status: "stopped", startedAt: at(1), updatedAt: at(5), lastSeen: at(8), durationMs: -1 },
    { id: "lastseen", label: "Last seen", status: "finished", startedAt: "invalid", updatedAt: "invalid", lastSeen: at(6), durationMs: Number.NaN },
    { id: "untimed", label: "Untimed", status: "stopped", startedAt: at(1), updatedAt: null, lastSeen: null, durationMs: 1 },
  ] });
  assert.deepEqual(feed.items.map(withoutId), [
    expected("agent_finished", at(6), { agentId: "lastseen", agentLabel: "Last seen" }),
    expected("agent_stopped", at(5), { agentId: "halted", agentLabel: "Halted" }),
    expected("agent_finished", at(4), { agentId: "done", agentLabel: "Done", durationMs: 180_000 }),
    expected("agent_started", at(1), { agentId: "done", agentLabel: "Done" }),
    expected("agent_started", at(1), { agentId: "halted", agentLabel: "Halted" }),
    expected("agent_started", at(1), { agentId: "untimed", agentLabel: "Untimed" }),
  ]);
  assert.equal(feed.total, 6);
});

test("an agent that is neither finished nor stopped has no terminal event", () => {
  const feed = derive({ agents: ["active", "idle", "waiting", "needs_input", "warm", "unknown"].map((status) => (
    { id: `a-${status}`, label: status, status, updatedAt: at(5), lastSeen: at(5), durationMs: 1 })) });
  assert.deepEqual(feed.items, []);
});

test("signal_reported carries only the label and tone of the session and each agent signal", () => {
  const feed = derive({
    session: { signal: { label: "Ready for review", tone: "positive", reportedAt: at(8), description: "private detail" } },
    agents: [
      { id: "primary", label: "Primary agent", status: "active", signal: { label: "Testing", tone: "info", reportedAt: at(7), description: "private detail" } },
      { id: "agent-a", label: "Reviewer", status: "active", signal: { label: "No time", tone: "info", reportedAt: null } },
      { id: "agent-b", label: "Builder", status: "active", signal: { label: "Bad time", tone: "warning", reportedAt: "yesterday-ish" } },
      { id: "agent-c", label: "Tester", status: "active", signal: { label: "Odd tone", tone: "loud", reportedAt: at(3) } },
      { id: "agent-d", label: "Idle", status: "active", signal: null },
    ],
  });
  assert.deepEqual(feed.items.map(withoutId), [
    expected("signal_reported", at(8), { signal: { label: "Ready for review", tone: "positive" } }),
    expected("signal_reported", at(7), { agentId: "primary", agentLabel: "Primary agent", signal: { label: "Testing", tone: "info" } }),
  ]);
  assert.deepEqual(Object.keys(feed.items[0].signal), ["label", "tone"]);
});

test("estimate_updated carries only the percent and phase at the report time", () => {
  const feed = derive({ session: { progress: { phase: "verifying", percent: 80, confidence: "high", remainingMinutesMin: 5, remainingMinutesMax: 9, reportedAt: at(6) } } });
  assert.deepEqual(feed.items.map(withoutId), [expected("estimate_updated", at(6), { progress: { percent: 80, phase: "verifying" } })]);
  assert.deepEqual(Object.keys(feed.items[0].progress), ["percent", "phase"]);
  assert.equal(derive({ session: { progress: { phase: "verifying", percent: 80, reportedAt: null } } }).total, 0);
  assert.equal(derive({ session: { progress: { phase: "dreaming", percent: 80, reportedAt: at(6) } } }).total, 0);
  assert.equal(derive({ session: { progress: { phase: "verifying", percent: "80", reportedAt: at(6) } } }).total, 0);
  assert.equal(derive({ session: { progress: null } }).total, 0);
});

test("user_message comes only from the recorded user-message times, never from the windowed activity rows", () => {
  const feed = derive({ userMessageTimes: [at(1), "garbage", null, 7, at(5), undefined] });
  assert.deepEqual(feed.items.map(withoutId), [expected("user_message", at(5)), expected("user_message", at(1))]);
  // A user-input activity row is not a source: it sits in a sliding window of recent activity.
  const activity = [{ id: "row-1", timestamp: at(1), actor: "User", tool: "User input", workKind: "input", detail: "Text", status: null }];
  assert.equal(derive({ activity }).total, 0);
  assert.equal(derive({ userMessageTimes: "none" }).total, 0);
  assert.equal(derive({ userMessageTimes: undefined }).total, 0, "evidence recorded before the field existed has no user-message events");
});

test("user-message events survive any amount of later tool activity", () => {
  const userMessageTimes = [at(1), at(2)];
  const quiet = derive({ userMessageTimes, activity: [] });
  const busy = derive({ userMessageTimes, activity: Array.from({ length: 256 }, (_, index) => (
    { id: `tool-${index}`, timestamp: at(3, index % 60), actor: "Primary agent", tool: "Read", workKind: "read", detail: "x", status: null })) });
  assert.deepEqual(busy, quiet);
  assert.equal(busy.total, 2);
});

test("resource_peak is the single highest retained peak per field and nothing else", () => {
  const peak = (field, observedAt, value, extra = {}) => ({ id: `p${value}`, field, observedAt, value, matchedTaskIds: ["task"], matchedTaskCount: 1, window: { status: "not_retained", samples: [], minute: null }, ...extra });
  const retainedResources = { readiness: "ready", minutes: [], minutesTruncated: false, curveRemoval: null, peaks: [
    peak("cpu_cores", at(2), 3),
    peak("cpu_cores", at(4), 6),
    peak("cpu_cores", at(3), 5),
    peak("memory_bytes", at(5), 900),
    peak("memory_bytes", at(1), 900), // equal high: the earlier observation wins
    peak("read_bps", at(6), 10),
    peak("write_bps", at(7), 20),
    peak("cpu_machine_percent", at(8), 99), // not a display field
    peak("write_bps", "not a time", 9_999), // unusable timestamp is skipped, not preferred
    peak("read_bps", at(9), Number.NaN),
  ] };
  const feed = derive({ retainedResources });
  assert.deepEqual(feed.items.map(withoutId), [
    expected("resource_peak", at(7), { resource: "write_bps" }),
    expected("resource_peak", at(6), { resource: "read_bps" }),
    expected("resource_peak", at(4), { resource: "cpu_cores" }),
    expected("resource_peak", at(1), { resource: "memory_bytes" }),
  ]);
  for (const readiness of ["loading", "unavailable", "rebuilding", undefined]) {
    assert.equal(derive({ retainedResources: { ...retainedResources, readiness } }).total, 0, `retained ${readiness}`);
  }
  assert.equal(derive({ retainedResources: null }).total, 0);
});

test("commit_observed comes only from the recorded commit times and exposes only their time", () => {
  assert.deepEqual(derive({ commitTimes: [at(1), at(3), "later", null, at(5)] }).items.map(withoutId), [
    expected("commit_observed", at(5)), expected("commit_observed", at(3)), expected("commit_observed", at(1)),
  ]);
  assert.equal(derive({ commitTimes: null }).total, 0, "a record that never read the window has no commit events");
  assert.equal(derive({ commitTimes: "none" }).total, 0);
  // Two commits recorded in the same second are two events.
  assert.equal(derive({ commitTimes: [at(2), at(2)] }).total, 2);
});

test("the public repository value and its short live commit list are never a commit source", () => {
  const commits = [{ hash: "aaaaaaaaaaaa", subject: "current checkout", committedAt: at(3) }];
  const session = { startedAt: at(1), updatedAt: at(5) };
  for (const historical of [false, true]) {
    assert.equal(derive({ session, repository: { available: true, historical, commits } }).total, 0, `historical ${historical}`);
    assert.deepEqual(derive({ session, repository: { available: true, historical, commits }, commitTimes: [at(4)] }).items.map(withoutId),
      [expected("commit_observed", at(4))]);
  }
});

test("pull_request_opened joins the listed pull request number by canonical URL and otherwise stays null", () => {
  const creations = [
    { id: "creation-1", actorId: "primary", timestamp: at(2), url: PR_URL },
    { id: "creation-2", actorId: "agent-a", timestamp: at(4), url: "https://github.com/acme/widgets/pull/18" },
    { id: "creation-3", actorId: "primary", timestamp: null, url: PR_URL },
    { id: "creation-4", actorId: "primary", timestamp: "soon", url: PR_URL },
  ];
  const pullRequests = { status: "ready", items: [
    { number: 17, url: PR_URL, title: "Add widgets" },
    { number: 99, url: "https://github.com/acme/widgets/pull/99", title: "Unrelated" },
    { number: "5", url: "https://github.com/acme/widgets/pull/18", title: "Malformed number" },
  ] };
  assert.deepEqual(derive({ pullRequestCreations: creations, pullRequests }).items.map(withoutId), [
    expected("pull_request_opened", at(4)),
    expected("pull_request_opened", at(2), { pullRequestNumber: 17 }),
  ]);
  assert.deepEqual(derive({ pullRequestCreations: creations, pullRequests: null }).items.map((item) => item.pullRequestNumber), [null, null]);
  assert.deepEqual(derive({ pullRequestCreations: creations, pullRequests: { status: "unavailable", items: [] } }).items.map((item) => item.pullRequestNumber), [null, null]);
});

test("the feed is gated by its three evidence sections and by nothing else", () => {
  const input = { agents: [{ id: "agent-a", label: "A", status: "active", startedAt: at(1) }], session: { progress: { phase: "planning", percent: 1, reportedAt: at(1) } } };
  assert.deepEqual([...SESSION_EVENT_READINESS_SECTIONS], ["core", "agentEvidence", "activityEvidence"]);
  assert.equal(derive(input).total, 2);
  const states = ["ready", "loading", "unavailable"];
  for (const core of states) for (const agentEvidence of states) for (const activityEvidence of states) for (const repository of [...states, undefined]) {
    const readiness = { core, agentEvidence, activityEvidence, repository };
    const gates = [core, agentEvidence, activityEvidence];
    const expectedReadiness = gates.includes("loading") ? "loading" : gates.every((value) => value === "ready") ? "ready" : "unavailable";
    const feed = sessionEvents({ ...input, readiness });
    assert.equal(feed.readiness, expectedReadiness, JSON.stringify(readiness));
    if (expectedReadiness === "ready") assert.equal(feed.total, 2);
    else assert.deepEqual(feed, { readiness: expectedReadiness, items: [], total: 0 }, JSON.stringify(readiness));
  }
  // A missing evidence section is not ready; a section outside the feed is ignored.
  assert.equal(sessionEvents({ ...input, readiness: { core: "ready", agentEvidence: "ready" } }).readiness, "unavailable");
  assert.equal(sessionEvents({ ...input, readiness: {} }).readiness, "unavailable");
  assert.equal(sessionEvents({ ...input, readiness: undefined }).readiness, "unavailable");
  assert.equal(sessionEvents({ ...input, readiness: { ...READY, resources: "loading", contextEvidence: "loading", usageLimits: "unavailable" } }).readiness, "ready");
});

test("the repository section never withholds or withdraws the feed, whatever its live check is doing", () => {
  const input = { agents: [{ id: "agent-a", label: "A", status: "active", startedAt: at(1) }], commitTimes: [at(2)] };
  const served = sessionEvents({ ...input, readiness: { ...READY, repository: "ready" } });
  assert.equal(served.total, 2);
  // No binding, a confirmed mismatch, and a restarted or failing check (pending) all serve the same feed.
  for (const check of ["none", "confirmed", "pending"]) {
    const repository = liveRepositoryReadiness({ historical: false, available: false, check });
    assert.deepEqual(sessionEvents({ ...input, readiness: { ...READY, repository } }), served, `${check} -> ${repository}`);
  }
  assert.equal(liveRepositoryReadiness({ historical: false, available: false, check: "pending" }), "loading");
});

test("every input may be missing", () => {
  assert.deepEqual(sessionEvents(), { readiness: "unavailable", items: [], total: 0 });
  assert.deepEqual(sessionEvents({}), { readiness: "unavailable", items: [], total: 0 });
  assert.deepEqual(derive(), { readiness: "ready", items: [], total: 0 });
  assert.deepEqual(derive({
    session: null, agents: undefined, userMessageTimes: undefined, pullRequestCreations: undefined, pullRequests: undefined, commitTimes: undefined, retainedResources: undefined,
  }), { readiness: "ready", items: [], total: 0 });
  assert.deepEqual(derive({ agents: "none", userMessageTimes: {}, pullRequestCreations: 1, pullRequests: { items: "none" }, commitTimes: 1, retainedResources: { readiness: "ready", peaks: "none" } }),
    { readiness: "ready", items: [], total: 0 });
  assert.deepEqual(derive({ agents: [null, undefined, 7, { label: "No id", status: "finished", updatedAt: at(1) }] }), { readiness: "ready", items: [], total: 0 });
});

test("events are newest first with a deterministic tie-break that ignores input order", () => {
  const inputs = {
    session: {
      startedAt: at(0), updatedAt: at(9),
      signal: { label: "Same moment", tone: "info", reportedAt: at(5) },
      progress: { phase: "implementing", percent: 40, reportedAt: at(5) },
    },
    agents: [
      { id: "agent-b", label: "B", status: "finished", startedAt: at(5), updatedAt: at(5), signal: { label: "B signal", tone: "info", reportedAt: at(5) } },
      { id: "agent-a", label: "A", status: "stopped", startedAt: at(5), updatedAt: at(5) },
    ],
    userMessageTimes: [at(5)],
    commitTimes: [at(5)],
    pullRequestCreations: [
      { id: "c1", timestamp: at(5), url: "https://github.com/acme/widgets/pull/2" },
      { id: "c2", timestamp: at(5), url: "https://github.com/acme/widgets/pull/10" },
    ],
    pullRequests: { items: [{ number: 2, url: "https://github.com/acme/widgets/pull/2" }, { number: 10, url: "https://github.com/acme/widgets/pull/10" }] },
    retainedResources: { readiness: "ready", peaks: [{ field: "cpu_cores", observedAt: at(5), value: 1 }] },
  };
  const feed = derive(inputs);
  assert.equal(feed.total, 12);
  assert.deepEqual(feed.items.map((item) => item.at), Array(12).fill(at(5)));
  // Equal instants order by kind, then scope text ("agent:..." before "session"), then pull-request number text.
  assert.deepEqual(feed.items.map((item) => [item.kind, item.agentId, item.pullRequestNumber]), [
    ["agent_started", "agent-a", null],
    ["agent_started", "agent-b", null],
    ["agent_finished", "agent-b", null],
    ["agent_stopped", "agent-a", null],
    ["signal_reported", "agent-b", null],
    ["signal_reported", null, null],
    ["estimate_updated", null, null],
    ["user_message", null, null],
    ["resource_peak", null, null],
    ["commit_observed", null, null],
    ["pull_request_opened", null, 10],
    ["pull_request_opened", null, 2],
  ]);
  const reversed = derive({
    ...inputs,
    agents: [...inputs.agents].reverse(),
    pullRequestCreations: [...inputs.pullRequestCreations].reverse(),
    retainedResources: { readiness: "ready", peaks: [...inputs.retainedResources.peaks].reverse() },
  });
  assert.deepEqual(reversed, feed);
  assert.deepEqual(derive(inputs), feed, "the same inputs derive the same feed");
});

test("ordering compares instants, not timestamp spellings, and exposes canonical ISO times", () => {
  const feed = derive({ agents: [
    { id: "agent-a", label: "A", status: "active", startedAt: "2026-09-30T10:02:00Z" },
    { id: "agent-b", label: "B", status: "active", startedAt: "2026-09-30T12:01:00+02:00" },
    { id: "agent-c", label: "C", status: "active", startedAt: at(3) },
  ] });
  assert.deepEqual(feed.items.map((item) => [item.agentId, item.at]), [["agent-c", at(3)], ["agent-a", at(2)], ["agent-b", at(1)]]);
});

test("the feed keeps the newest 50 events and total counts the events derivable from the retained evidence", () => {
  const userMessageTimes = Array.from({ length: 120 }, (_, index) => new Date(Date.UTC(2026, 8, 30, 10, 0, index)).toISOString());
  const feed = derive({ userMessageTimes, agents: [{ id: "agent-a", label: "A", status: "active", startedAt: at(0) }] });
  assert.equal(feed.total, 121);
  assert.equal(feed.items.length, SESSION_EVENT_LIMIT);
  assert.equal(feed.items[0].at, userMessageTimes[119]);
  assert.equal(feed.items.at(-1).at, userMessageTimes[70]);
  assert.equal(new Set(feed.items.map((item) => item.kind)).size, 1);
  const sorted = feed.items.map((item) => Date.parse(item.at));
  assert.deepEqual(sorted, [...sorted].sort((left, right) => right - left));
});

test("ids are unique, opaque, and stable for unchanged evidence, even for events at one instant", () => {
  const inputs = { userMessageTimes: Array(8).fill(at(2)), session: { startedAt: at(0), updatedAt: at(9) }, commitTimes: Array(3).fill(at(2)),
    agents: [{ id: "agent-a", label: "A", status: "active", startedAt: at(2), signal: { label: "Hi", tone: "info", reportedAt: at(2) } }] };
  const feed = derive(inputs);
  assert.equal(feed.total, 13);
  assert.equal(new Set(feed.items.map((item) => item.id)).size, 13);
  assert.deepEqual(derive(structuredClone(inputs)).items.map((item) => item.id), feed.items.map((item) => item.id));
  // Evidence of another kind or instant leaves an existing event's id alone.
  const extended = derive({ ...inputs, agents: [...inputs.agents, { id: "agent-b", label: "B", status: "active", startedAt: at(8) }] });
  const idsOf = (items) => items.filter((item) => item.agentId !== "agent-b").map((item) => item.id);
  assert.deepEqual(idsOf(extended.items), idsOf(feed.items));
  for (const item of feed.items) assert.match(item.id, /^event-[a-f0-9]{16}$/u);
});

test("a feed built from sentinel-laden inputs exposes only the ten contract keys and bounded values", () => {
  const sentinels = [
    "SENTINEL_COMMIT_HASH", "SENTINEL_COMMIT_SUBJECT", "SENTINEL_PR_URL", "SENTINEL_PR_OWNER", "SENTINEL_PR_TITLE", "SENTINEL_CREATION_ID", "SENTINEL_CREATION_ACTOR",
    "SENTINEL_USER_DETAIL", "SENTINEL_USER_ROW_ID", "SENTINEL_USER_REQUEST", "SENTINEL_SIGNAL_DESCRIPTION", "SENTINEL_AGENT_DESCRIPTION", "SENTINEL_TASK_LABEL",
    "SENTINEL_TASK_ID", "SENTINEL_PEAK_ID", "SENTINEL_PROGRESS_CONFIDENCE", "SENTINEL_PROVIDER_KIND", "SENTINEL_TRANSCRIPT_PATH",
  ];
  const url = "https://github.com/SENTINEL_PR_OWNER/repo/pull/23";
  const feed = derive({
    session: {
      startedAt: at(0), updatedAt: at(9), cwd: "SENTINEL_TRANSCRIPT_PATH",
      signal: { label: "Needs a look", tone: "warning", reportedAt: at(8), description: "SENTINEL_SIGNAL_DESCRIPTION" },
      progress: { phase: "blocked", percent: 33.5, confidence: "SENTINEL_PROGRESS_CONFIDENCE", remainingMinutesMin: 424242, remainingMinutesMax: 434343, reportedAt: at(7) },
    },
    agents: [
      { id: "primary", label: "Primary agent", status: "active", startedAt: at(0), signal: null },
      { id: "agent-a", label: "Reviewer", status: "finished", kind: "SENTINEL_PROVIDER_KIND", startedAt: at(1), updatedAt: at(6), durationMs: 300_000,
        signal: { label: "Done reviewing", tone: "positive", reportedAt: at(6), description: "SENTINEL_AGENT_DESCRIPTION" } },
      { id: "agent-b", label: "Builder", status: "stopped", updatedAt: at(5), durationMs: 120_000 },
    ],
    activity: [{ id: "SENTINEL_USER_ROW_ID", timestamp: at(2), actor: "User", tool: "User input", workKind: "input", detail: "SENTINEL_USER_DETAIL", requestId: "SENTINEL_USER_REQUEST", status: null }],
    pullRequestCreations: [{ id: "SENTINEL_CREATION_ID", actorId: "SENTINEL_CREATION_ACTOR", timestamp: at(3), url }],
    pullRequests: { status: "ready", items: [{ number: 23, url, title: "SENTINEL_PR_TITLE" }] },
    userMessageTimes: [at(2)],
    commitTimes: [at(4)],
    repository: { available: true, commits: [{ hash: "SENTINEL_COMMIT_HASH", subject: "SENTINEL_COMMIT_SUBJECT", committedAt: at(4, 30) }] },
    retainedResources: { readiness: "ready", peaks: [
      { id: "SENTINEL_PEAK_ID", field: "memory_bytes", observedAt: at(5), value: 987654321, matchedTaskIds: ["SENTINEL_TASK_ID"], matchedTaskCount: 1,
        tasks: [{ id: "SENTINEL_TASK_ID", label: "SENTINEL_TASK_LABEL" }], window: { status: "retained", samples: [{ at: at(5), value: 987654321 }], minute: null } },
    ] },
  });
  assert.equal(feed.total, 10);
  assert.deepEqual(new Set(kinds(feed)), new Set(SESSION_EVENT_KINDS));
  const serialized = JSON.stringify(feed);
  for (const sentinel of sentinels) assert.ok(!serialized.includes(sentinel), `${sentinel} must not reach the feed`);
  for (const forbidden of ["987654321", "424242", "434343"]) assert.ok(!serialized.includes(forbidden), `${forbidden} must not reach the feed`);
  // The only durations are the two agents' own wall times, on their terminal events.
  assert.deepEqual(feed.items.filter((item) => item.durationMs !== null).map((item) => [item.kind, item.durationMs]).sort(),
    [["agent_finished", 300_000], ["agent_stopped", 120_000]]);
  for (const item of feed.items) {
    assert.deepEqual(Object.keys(item).sort(), EVENT_KEYS, item.kind);
    assert.ok(item.signal === null || JSON.stringify(Object.keys(item.signal)) === JSON.stringify(["label", "tone"]));
    assert.ok(item.progress === null || JSON.stringify(Object.keys(item.progress)) === JSON.stringify(["percent", "phase"]));
  }
  assert.deepEqual(feed.items.find((item) => item.kind === "pull_request_opened").pullRequestNumber, 23);
  assert.deepEqual(feed.items.find((item) => item.kind === "resource_peak").resource, "memory_bytes");
});

test("a source object is never spread into an event", () => {
  const agent = { id: "agent-a", label: "A", status: "finished", startedAt: at(1), updatedAt: at(2), durationMs: 1, secret: "SENTINEL_EXTRA", signal: { label: "L", tone: "info", reportedAt: at(1), extra: "SENTINEL_EXTRA" } };
  const feed = derive({ agents: [agent] });
  assert.ok(!JSON.stringify(feed).includes("SENTINEL_EXTRA"));
  for (const item of feed.items) assert.deepEqual(Object.keys(item).sort(), EVENT_KEYS);
});

// --- Integration with the session-domain projection and its commit path -------------------------

const SESSION_ID = "claude:events-session";
const OBSERVED_AT = at(30);

function monitorState(overrides = {}) {
  const base = createEmptyMonitorState({ connected: true, source: "Claude Code", view: "live" });
  return {
    ...base,
    session: {
      id: SESSION_ID, title: "Events", project: "Pomegr", startedAt: at(0), updatedAt: at(20), durationMs: 1_200_000, cost: null, summary: null,
      progress: { phase: "implementing", percent: 55, confidence: "medium", reportedAt: at(15) },
      pomegrPlugin: null, signal: { label: "Almost there", tone: "info", reportedAt: at(16), description: "PRIVATE_SIGNAL_NOTE" },
      repositoryId: "repo-1", contextInventoryRef: null, cwd: "C:/private/workspace",
      repository: { available: true, branch: "feat/x", files: [], comparison: null, historical: false,
        commits: [{ hash: "abc1234", subject: "PRIVATE_COMMIT_SUBJECT", committedAt: at(10) }] },
      pullRequests: { status: "ready", checkedAt: at(25), items: [{ number: 31, url: PR_URL, title: "PRIVATE_PR_TITLE" }] },
    },
    agents: [
      { id: "primary", parentId: null, label: "Primary agent", role: "orchestrator", customType: null, model: "m", status: "active", currentActivity: null, tokens: { total: 20 }, lastSeen: at(20), startedAt: at(0), updatedAt: at(20), durationMs: 1_200_000, cacheLifetime: null, signal: null },
      { id: "agent-a", parentId: "primary", label: "Reviewer", role: "builder", customType: null, model: "m", status: "finished", currentActivity: null, tokens: { total: 10 }, lastSeen: at(20), startedAt: at(4), updatedAt: at(12), durationMs: 480_000, cacheLifetime: null, signal: null },
    ],
    metrics: { ...base.metrics, agents: 2, activeAgents: 1, tokens: { ...base.metrics.tokens, allAgents: 30, contextHistory: { bucketMs: 60_000, buckets: [], boundaries: [] } } },
    readiness: { core: "ready", agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready", repository: "ready", resources: "ready", usageLimits: "ready" },
    ...overrides,
  };
}
function evidence() {
  return {
    activity: [{ id: "PRIVATE_ROW_ID", timestamp: at(2, 30), actor: "User", tool: "User input", workKind: "input", detail: "PRIVATE_USER_TEXT", status: null }],
    userMessageTimes: [at(2)],
    pullRequestCreations: [{ id: "creation-1", actorId: "primary", timestamp: at(14), url: PR_URL }],
    toolCalls: [],
  };
}
function snapshotOf(publicState, observedAt = OBSERVED_AT, snapshotEvidence = evidence()) {
  return { publicState, readiness: publicState.readiness, observedAt, evidence: snapshotEvidence };
}
function retainedBlock(cpuValue = 4) {
  return { readiness: "ready", minutes: [], minutesTruncated: false, curveRemoval: null,
    peaks: [{ id: "p1", field: "cpu_cores", observedAt: at(11), value: cpuValue, matchedTaskIds: [], matchedTaskCount: 0, window: { status: "not_retained", samples: [], minute: null } }] };
}
function summaryOf(store) { return store.read(SESSION_ID, "session-summary").snapshot.value; }
// The recorded in-window commit times, as the observation runtime hands them to the store.
const RECORDED_COMMIT_TIMES = [at(10)];
function eventStore(options = {}) {
  return createSessionDomainStore({ repositoryRecordForSession: () => ({ gitObserved: null, commitTimes: RECORDED_COMMIT_TIMES }), ...options });
}

test("the committed summary carries the derived feed from its normalized inputs", () => {
  const store = eventStore({ retainedResourcesForSession: () => retainedBlock() });
  store.commit(SESSION_ID, snapshotOf(monitorState()));
  const { events } = summaryOf(store);
  assert.equal(events.readiness, "ready");
  assert.equal(events.total, 8);
  assert.deepEqual(events.items.map((item) => [item.kind, item.at]), [
    ["signal_reported", at(16)],
    ["estimate_updated", at(15)],
    ["pull_request_opened", at(14)],
    ["agent_finished", at(12)],
    ["resource_peak", at(11)],
    ["commit_observed", at(10)],
    ["agent_started", at(4)],
    ["user_message", at(2)],
  ]);
  assert.equal(events.items.find((item) => item.kind === "pull_request_opened").pullRequestNumber, 31);
  assert.equal(events.items.find((item) => item.kind === "agent_finished").durationMs, 480_000);
  const serialized = store.read(SESSION_ID, "session-summary").snapshot.serialized;
  for (const sentinel of ["PRIVATE_SIGNAL_NOTE", "PRIVATE_COMMIT_SUBJECT", "abc1234", "PRIVATE_PR_TITLE", "PRIVATE_ROW_ID", "PRIVATE_USER_TEXT", "creation-1"]) {
    assert.ok(!JSON.stringify(events).includes(sentinel), sentinel);
  }
  assert.ok(serialized.includes('"events":'));
});

test("a snapshot committed without evidence still serves a ready feed from the state alone", () => {
  const store = eventStore();
  store.commit(SESSION_ID, { publicState: monitorState(), readiness: monitorState().readiness, observedAt: OBSERVED_AT, evidence: undefined });
  const { events } = summaryOf(store);
  assert.equal(events.readiness, "ready");
  assert.deepEqual(new Set(events.items.map((item) => item.kind)), new Set(["signal_reported", "estimate_updated", "agent_finished", "commit_observed", "agent_started"]));
  assert.equal(events.items.find((item) => item.kind === "commit_observed")?.at, at(10));
});

test("an unchanged feed does not advance the revision; changed resources or evidence do", () => {
  let retained = retainedBlock(4);
  const store = eventStore({ retainedResourcesForSession: () => retained });
  store.commit(SESSION_ID, snapshotOf(monitorState()));
  const first = store.read(SESSION_ID, "session-summary");

  // Only the observation time differs: no new revision, and no event ID churn.
  assert.deepEqual(store.commit(SESSION_ID, snapshotOf(monitorState(), at(45))), []);
  const again = store.read(SESSION_ID, "session-summary");
  assert.equal(again.revision, first.revision);
  assert.equal(again.snapshot.serialized, first.snapshot.serialized);

  // A higher retained peak re-projects the summary and moves the peak event.
  retained = retainedBlock(8);
  retained.peaks[0].observedAt = at(13);
  assert.ok(store.commit(SESSION_ID, snapshotOf(monitorState(), at(46))).some((event) => event.domain === "session-summary"));
  const moved = summaryOf(store).events.items.find((item) => item.kind === "resource_peak");
  assert.equal(moved.at, at(13));
  assert.notEqual(moved.id, first.snapshot.value.events.items.find((item) => item.kind === "resource_peak").id);
  const afterPeak = store.read(SESSION_ID, "session-summary").revision;
  assert.ok(afterPeak > first.revision);
  assert.deepEqual(store.commit(SESSION_ID, snapshotOf(monitorState(), at(47))), []);
  assert.equal(store.read(SESSION_ID, "session-summary").revision, afterPeak);

  // A windowed activity row alone changes nothing; a newly recorded user-message time does.
  const moreActivity = evidence();
  moreActivity.activity.push({ id: "row-2", timestamp: at(18), actor: "User", tool: "User input", workKind: "input", detail: "more", status: null });
  assert.deepEqual(store.commit(SESSION_ID, snapshotOf(monitorState(), at(48), moreActivity)), []);
  const grown = evidence();
  grown.userMessageTimes.push(at(18));
  assert.ok(store.commit(SESSION_ID, snapshotOf(monitorState(), at(48), grown)).some((event) => event.domain === "session-summary"));
  assert.equal(summaryOf(store).events.total, 9);
});

test("a resources block that is not ready contributes no peak, and readiness follows the evidence sections", () => {
  const store = eventStore({ retainedResourcesForSession: () => ({ ...retainedBlock(), readiness: "loading" }) });
  store.commit(SESSION_ID, snapshotOf(monitorState()));
  const bestEffort = summaryOf(store).events;
  assert.equal(bestEffort.readiness, "ready", "retained resources are not a summary section and never hold the feed");
  assert.ok(!bestEffort.items.some((item) => item.kind === "resource_peak"));

  for (const section of ["core", "agentEvidence", "activityEvidence"]) {
    const loadingState = monitorState();
    loadingState.readiness = { ...loadingState.readiness, [section]: "loading" };
    const sessionId = `claude:events-loading-${section}`;
    store.commit(sessionId, snapshotOf(loadingState));
    assert.deepEqual(store.read(sessionId, "session-summary").snapshot.value.events, { readiness: "loading", items: [], total: 0 }, section);
  }
  // Sections the feed does not read never hold it back.
  const otherLoading = monitorState();
  otherLoading.readiness = { ...otherLoading.readiness, contextEvidence: "loading", repository: "loading", resources: "loading", usageLimits: "loading" };
  store.commit("claude:events-other", snapshotOf(otherLoading));
  assert.equal(store.read("claude:events-other", "session-summary").snapshot.value.events.readiness, "ready");
});

test("a session outside any Git repository still reaches a ready feed", () => {
  const state = monitorState();
  state.session.repository = { available: false, branch: "Not a Git repository", files: [], comparison: null, historical: false, commits: [], isMain: false, remote: { status: "unavailable", checkedAt: null } };
  state.session.pullRequests = { status: "unavailable", checkedAt: null, items: [] };
  state.readiness = { ...state.readiness, repository: liveRepositoryReadiness({ historical: false, available: false, check: "none" }) };
  const store = createSessionDomainStore();
  store.commit(SESSION_ID, snapshotOf(state));
  const summary = summaryOf(store);
  assert.equal(summary.sectionReadiness.repository, "ready");
  assert.equal(summary.events.readiness, "ready");
  assert.deepEqual(new Set(summary.events.items.map((item) => item.kind)),
    new Set(["signal_reported", "estimate_updated", "pull_request_opened", "agent_finished", "agent_started", "user_message"]));
});

function liveCheck(overrides = {}) {
  return {
    repository: { available: true, branch: "feat/x", historical: false, isMain: false, files: [], comparison: null, remote: { status: "unavailable", checkedAt: null } },
    pullRequests: { status: "unavailable", checkedAt: null, items: [] },
    commitsInSession: 2, sessionCommitPaths: [], sessionCommitChanges: [], commitTimes: [at(6), at(10)], checkedAt: at(21),
    ...overrides,
  };
}

test("commit events survive the live to historical transition, a merged branch, and a ninth commit", () => {
  const recorded = snapshotFromLiveCheck(liveCheck());
  let times = recorded.commitTimesInWindow;
  const store = createSessionDomainStore({ repositoryRecordForSession: () => ({ gitObserved: null, commitTimes: times }) });
  const commitEvents = () => summaryOf(store).events.items.filter((item) => item.kind === "commit_observed").map((item) => [item.id, item.at]);

  // Live: the public repository value lists only the checkout's newest commits (here a ninth and
  // later ones, none of them the session's), and none of them is read.
  const live = monitorState();
  live.session.repository.commits = Array.from({ length: 8 }, (_, index) => ({ hash: `PRIVATE_HASH_${index}`, subject: "PRIVATE_COMMIT_SUBJECT", committedAt: at(11 + index) }));
  store.commit(SESSION_ID, snapshotOf(live));
  const whileLive = commitEvents();
  assert.deepEqual(whileLive.map(([, time]) => time), [at(10), at(6)]);

  // Historical: the recorded snapshot serves an empty commit list, and the events are unchanged.
  const historical = monitorState({ view: "history" });
  const served = historicalRepositoryFromSnapshot(recorded);
  assert.deepEqual(served.repository.commits, []);
  assert.equal(Object.hasOwn(served.repository, "commitTimesInWindow"), false, "never on session.repository, which /api/state serializes");
  historical.session.repository = served.repository;
  store.commit(SESSION_ID, snapshotOf(historical, at(50)));
  assert.deepEqual(commitEvents(), whileLive, "same events, same IDs");

  // A later live read that no longer lists a commit (merged and deleted branch, amend, rebase)
  // never withdraws a recorded time.
  const reread = snapshotFromLiveCheck(liveCheck({ commitsInSession: 1, commitTimes: [at(10)], checkedAt: at(22), previous: recorded }));
  assert.deepEqual(reread.commitTimesInWindow, [at(6), at(10)]);
  const failed = snapshotFromLiveCheck(liveCheck({ commitsInSession: null, commitTimes: null, checkedAt: at(23), previous: reread }));
  assert.deepEqual(failed.commitTimesInWindow, [at(6), at(10)], "a check that could not read the window carries the list forward");
  times = failed.commitTimesInWindow;
  store.commit(SESSION_ID, snapshotOf(historical, at(51)));
  assert.deepEqual(commitEvents(), whileLive);
});

test("a historical session never gains commit events from current Git state", () => {
  const historical = monitorState({ view: "history" });
  // A populated commit list on a historical value must still yield nothing: only recorded times count.
  historical.session.repository = { available: true, branch: "feat/x", files: [], comparison: null, historical: true, recordedAt: at(21), commitsInSession: 2,
    commits: [{ hash: "abc1234", subject: "PRIVATE_COMMIT_SUBJECT", committedAt: at(10) }] };
  const withoutRecord = createSessionDomainStore();
  withoutRecord.commit(SESSION_ID, snapshotOf(historical));
  const { events } = summaryOf(withoutRecord);
  assert.ok(!events.items.some((item) => item.kind === "commit_observed"), "no recorded times, no commit events");
  assert.ok(events.items.some((item) => item.kind === "pull_request_opened"), "recorded evidence still contributes");

  // A sidecar written before commit times were recorded serves none either (null, never measured).
  const legacy = createSessionDomainStore({ repositoryRecordForSession: () => ({ gitObserved: null, commitTimes: null }) });
  legacy.commit(SESSION_ID, snapshotOf(historical));
  assert.ok(!summaryOf(legacy).events.items.some((item) => item.kind === "commit_observed"));
});

test("the commit times reach only the summary feed, never another domain or session.repository", () => {
  const state = monitorState();
  const { domains } = projectSessionDomains(SESSION_ID, snapshotOf(state), { commitTimes: [at(10)] });
  assert.deepEqual(domains.get("session-summary").events.items.filter((item) => item.kind === "commit_observed").map((item) => item.at), [at(10)]);
  for (const [name, value] of domains) assert.ok(!JSON.stringify(value).includes("commitTimes"), name);
  assert.ok(!JSON.stringify(state.session).includes("commitTimes"));
  assert.equal(Object.hasOwn(domains.get("repository"), "commitTimesInWindow"), false);
});

test("a projection that finds the repository recorder without an answer keeps the last committed commit times", () => {
  let record = { gitObserved: null, commitTimes: [at(6), at(10)] };
  let reads = 0;
  const store = createSessionDomainStore({ repositoryRecordForSession: () => { reads += 1; return record; } });
  const commitTimes = () => summaryOf(store).events.items.filter((item) => item.kind === "commit_observed").map((item) => item.at);
  store.commit(SESSION_ID, snapshotOf(monitorState()));
  assert.equal(reads, 1, "the recorded snapshot is read once per projection");
  assert.deepEqual(commitTimes(), [at(10), at(6)]);

  // The recorder evicted the record: the projection is offered nothing, and nothing is withdrawn.
  record = { gitObserved: null, commitTimes: null };
  assert.deepEqual(store.commit(SESSION_ID, snapshotOf(monitorState(), at(40))), [], "no revision, no retraction");
  assert.deepEqual(commitTimes(), [at(10), at(6)]);
  // Once the record is read back, a longer recorded list replaces the kept one.
  record = { gitObserved: null, commitTimes: [at(6), at(10), at(12)] };
  store.commit(SESSION_ID, snapshotOf(monitorState(), at(41)));
  assert.deepEqual(commitTimes(), [at(12), at(10), at(6)]);

  // The kept list belongs to its session and leaves with it.
  record = { gitObserved: null, commitTimes: null };
  store.commit("claude:other-session", snapshotOf(monitorState()));
  assert.ok(!store.read("claude:other-session", "session-summary").snapshot.value.events.items.some((item) => item.kind === "commit_observed"));
  store.clear();
  store.commit(SESSION_ID, snapshotOf(monitorState()));
  assert.deepEqual(commitTimes(), []);
});

test("the repository domain serves the branch-changed reason only for a live view without a repository", () => {
  const reasonFor = (state, repositoryUnavailableReason) => projectSessionDomains(SESSION_ID, snapshotOf(state), { repositoryUnavailableReason }).domains.get("repository").unavailableReason;
  const available = monitorState();
  assert.equal(reasonFor(available, "branch_changed"), null, "a shown repository carries no reason");
  const unavailable = monitorState();
  unavailable.session.repository = { available: false, branch: "Not a Git repository", files: [], comparison: null, historical: false, commits: [], isMain: false, remote: { status: "unavailable", checkedAt: null } };
  assert.equal(reasonFor(unavailable, "branch_changed"), "branch_changed");
  assert.equal(reasonFor(unavailable, "C:\private\root"), null, "only the recognized enum value is served");
  assert.equal(reasonFor(unavailable, null), null);
  unavailable.session.repository.historical = true;
  assert.equal(reasonFor(unavailable, "branch_changed"), null, "a historical view never reports live check state");
  assert.ok(!JSON.stringify(unavailable.session).includes("unavailableReason"));
});
