import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationLedger, NOTIFICATION_MAX_BYTES, NOTIFICATION_MAX_OCCURRENCES } from "../../../server/notifications/notification-ledger.mjs";

const t0 = Date.parse("2026-10-03T12:00:00.000Z");
function session(id, needsInput, updatedAt = new Date(t0).toISOString()) { return { id: `codex:${id}`, provider: "codex", title: id, updatedAt, isLive: true, needsInput }; }
function catalog(sessions, revision, readiness = "ready", sourceScope = "local") { return { catalog: { sessions, revision, readiness, sourceScope } }; }
function status(status, revision, checkedAt = new Date(t0).toISOString(), overrides = {}) { return { providerStatus: { revision, providers: [{ provider: "claude", status, readiness: "ready", freshness: "fresh", checkedAt, updatedAt: checkedAt, ...overrides }] } }; }

test("startup baseline shows Needs input without native eligibility; explicit resolution and recurrence create new ID", () => {
  let time = t0;
  const ledger = createNotificationLedger({ now: () => time });
  const first = ledger.acceptFacts(catalog([session("one", true)], 1));
  assert.equal(first.occurrences[0].deliveryEligible, false);
  assert.equal(first.occurrences[0].lifecycle, "active");
  assert.equal(ledger.acceptFacts(catalog([], 2)).revision, first.revision, "missing row is not resolution");
  ledger.acceptFacts(catalog([session("one", false, new Date(++time).toISOString())], 3));
  assert.equal(ledger.readSnapshot().occurrences[0].lifecycle, "resolved");
  time++;
  ledger.acceptFacts(catalog([session("one", true, new Date(time).toISOString())], 4));
  const current = ledger.readSnapshot();
  assert.equal(current.occurrences.length, 2);
  assert.notEqual(current.occurrences[0].id, current.occurrences[1].id);
  assert.equal(current.occurrences[0].deliveryEligible, true);
  assert.equal(current.occurrences[0].lifecycle, "active");
});

test("partial, stale, unavailable, and out-of-order facts preserve active condition", () => {
  let time = t0 + 1000;
  const ledger = createNotificationLedger({ now: () => time });
  ledger.acceptFacts(catalog([session("one", true)], 5));
  ledger.acceptFacts(catalog([session("one", false)], 6, "partial"));
  ledger.acceptFacts(catalog([session("one", false)], 4));
  ledger.acceptFacts(catalog([session("one", false)], 7, "stale"));
  assert.equal(ledger.readSnapshot().occurrences[0].lifecycle, "active");
  assert.equal(ledger.readSnapshot().readiness.catalog, "stale");
  ledger.acceptFacts(catalog([session("one", false, new Date(t0 - 1000).toISOString())], 8));
  assert.equal(ledger.readSnapshot().occurrences[0].lifecycle, "active");
  time += 1000;
  ledger.acceptFacts(catalog([session("one", false, new Date(time).toISOString())], 9));
  assert.equal(ledger.readSnapshot().occurrences[0].lifecycle, "resolved");
});

test("provider incident recovery is coalesced and does not claim session causation", () => {
  let time = t0;
  const ledger = createNotificationLedger({ now: () => time });
  ledger.acceptFacts(status("operational", 1));
  time += 1000;
  ledger.acceptFacts(status("outage", 2, new Date(time).toISOString()));
  ledger.acceptFacts(status("outage", 3, new Date(time).toISOString()));
  assert.equal(ledger.readSnapshot().occurrences.length, 1);
  assert.equal(ledger.readSnapshot().occurrences[0].kind, "provider_incident");
  time += 1000;
  ledger.acceptFacts(status("operational", 4, new Date(time).toISOString(), { freshness: "stale" }));
  assert.equal(ledger.readSnapshot().occurrences.length, 1);
  ledger.acceptFacts(status("operational", 5, new Date(time).toISOString()));
  assert.deepEqual(ledger.readSnapshot().occurrences.map((row) => row.kind), ["provider_recovery", "provider_incident"]);
  assert.equal(ledger.readSnapshot().occurrences[1].lifecycle, "resolved");
  ledger.acceptFacts(status("operational", 6, new Date(time).toISOString()));
  assert.equal(ledger.readSnapshot().occurrences.length, 2);
  assert.deepEqual(ledger.readSnapshot().occurrences[0].data, { status: "operational" });
});

test("private source scope resets baseline without appearing in public snapshot", () => {
  const ledger = createNotificationLedger({ now: () => t0 });
  ledger.acceptFacts(catalog([session("one", true)], 1, "ready", "source-A"));
  const first = ledger.readSnapshot().occurrences[0].id;
  ledger.acceptFacts(catalog([], 1, "unavailable", "source-B"));
  assert.equal(ledger.readSnapshot().occurrences.length, 0, "old profile conditions disappear before new evidence is ready");
  ledger.acceptFacts(catalog([session("one", true)], 1, "ready", "source-B"));
  assert.equal(ledger.readSnapshot().occurrences[0].deliveryEligible, false);
  assert.notEqual(ledger.readSnapshot().occurrences[0].id, first);
  assert.equal(JSON.stringify(ledger.readSnapshot()).includes("source-A"), false);
  assert.equal(JSON.stringify(ledger.readSnapshot()).includes("source-B"), false);
});

test("bounds active session conditions and keeps an explicit overflow count", () => {
  const ledger = createNotificationLedger({ now: () => t0 });
  const sessions = Array.from({ length: 120 }, (_, index) => session(`s${index}`, true));
  ledger.acceptFacts(catalog(sessions, 1));
  assert.equal(ledger.readSnapshot().occurrences.length, 100);
  assert.equal(ledger.readSnapshot().activeSessionOverflow, 20);
  ledger.acceptFacts(catalog(sessions, 2));
  assert.equal(ledger.readSnapshot().activeSessionOverflow, 20);
  const projected = catalog(sessions.slice(0, 100), 3);
  projected.catalog.activeSessionOverflow = 40;
  ledger.acceptFacts(projected);
  assert.equal(ledger.readSnapshot().activeSessionOverflow, 40, "bounded committed projection retains full-source overflow");
});

test("retention, count and byte bounds apply with immutable revisions", () => {
  let time = t0;
  const ledger = createNotificationLedger({ now: () => time });
  ledger.acceptFacts(catalog([], 1));
  for (let index = 0; index < 220; index++) {
    time += 1000;
    const id = `s${index}`;
    ledger.acceptFacts(catalog([session(id, true, new Date(time).toISOString())], index * 2 + 2));
    ledger.acceptFacts(catalog([session(id, false, new Date(time + 1).toISOString())], index * 2 + 3));
  }
  const old = ledger.readSnapshot();
  assert.ok(old.occurrences.length <= NOTIFICATION_MAX_OCCURRENCES);
  assert.ok(Buffer.byteLength(JSON.stringify(old)) <= NOTIFICATION_MAX_BYTES);
  assert.ok(Object.isFrozen(old.occurrences[0]));
  time += 31 * 24 * 60 * 60_000;
  ledger.acceptFacts(catalog([], 500));
  assert.equal(ledger.readSnapshot().occurrences.length, 0);
  assert.ok(ledger.readSnapshot().revision > old.revision);
});

test("failed derivation retains last known good state and does not notify subscribers", () => {
  let updates = 0;
  const ledger = createNotificationLedger({ now: () => t0, rules: [{ kind: "synthetic", source: "synthetic", category: "system", severity: "info", priority: 1, action: "open_workspace", delivery: "in_app",
    derive: (input) => { if (input.fail) throw new Error("private failure"); return [{ key: "one", active: true, provider: "codex", at: new Date(t0).toISOString(), data: {} }]; } }] });
  ledger.subscribe(() => updates++);
  const first = ledger.acceptFacts({ synthetic: { revision: 1 } });
  assert.equal(first.occurrences[0].kind, "synthetic", "test-only registration reaches ledger without renderer changes");
  assert.throws(() => ledger.acceptFacts({ synthetic: { revision: 2, fail: true } }), /private failure/u);
  assert.equal(ledger.readSnapshot(), first);
  assert.equal(updates, 1);
});

test("resolved high-priority history cannot evict an active provider condition", () => {
  let time = t0;
  const ledger = createNotificationLedger({ now: () => time });
  ledger.acceptFacts(status("outage", 1));
  const incidentId = ledger.readSnapshot().occurrences[0].id;
  for (let index = 0; index < 210; index++) {
    time += 1000;
    ledger.acceptFacts(catalog([session("one", true, new Date(time).toISOString())], index * 2 + 1));
    time++;
    ledger.acceptFacts(catalog([session("one", false, new Date(time).toISOString())], index * 2 + 2));
  }
  ledger.acceptFacts(status("outage", 2, new Date(time).toISOString()));
  const incidents = ledger.readSnapshot().occurrences.filter((row) => row.kind === "provider_incident");
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].id, incidentId);
  assert.equal(incidents[0].lifecycle, "active");
});

test("mixed fresh and stale provider rows expose partial readiness", () => {
  const ledger = createNotificationLedger({ now: () => t0 });
  const facts = status("outage", 1);
  facts.providerStatus.providers.push({ ...facts.providerStatus.providers[0], provider: "codex", freshness: "stale" });
  const snapshot = ledger.acceptFacts(facts);
  assert.equal(snapshot.readiness.providerStatus, "partial");
  assert.equal(snapshot.occurrences.length, 1);
});

test("active condition details update without a new occurrence or delivery transition", () => {
  let time = t0;
  const ledger = createNotificationLedger({ now: () => time });
  ledger.acceptFacts(status("operational", 1));
  time += 1000;
  const incident = ledger.acceptFacts(status("degraded", 2, new Date(time).toISOString())).occurrences[0];
  for (const [index, value] of ["outage", "maintenance"].entries()) {
    time += 1000;
    const snapshot = ledger.acceptFacts(status(value, index + 3, new Date(time).toISOString()));
    assert.equal(snapshot.occurrences.length, 1);
    assert.deepEqual(snapshot.occurrences[0], { ...incident, data: { status: value } });
  }
  ledger.acceptFacts(status("degraded", 5, new Date(t0).toISOString()));
  assert.equal(ledger.readSnapshot().occurrences[0].data.status, "maintenance");
  ledger.acceptFacts(catalog([session("one", true, new Date(time).toISOString())], 1));
  const condition = ledger.readSnapshot().occurrences.find((row) => row.kind === "needs_input");
  time += 1000;
  const renamed = { ...session("one", true, new Date(time).toISOString()), title: "Renamed session" };
  ledger.acceptFacts(catalog([renamed], 2));
  assert.deepEqual(ledger.readSnapshot().occurrences.find((row) => row.kind === "needs_input"), {
    ...condition, data: { sessionId: "codex:one", sessionTitle: "Renamed session" },
  });
});

test("all-stale provider observations preserve condition and expose stale readiness", () => {
  const ledger = createNotificationLedger({ now: () => t0 });
  ledger.acceptFacts(status("outage", 1));
  const snapshot = ledger.acceptFacts(status("operational", 2, new Date(t0).toISOString(), { freshness: "stale" }));
  assert.equal(snapshot.readiness.providerStatus, "stale");
  assert.equal(snapshot.occurrences[0].lifecycle, "active");
  assert.equal(snapshot.occurrences[0].data.status, "outage");
});

test("notification serialization exposes only the bounded public envelope and kind data", () => {
  const ledger = createNotificationLedger({ now: () => t0 });
  const privateValue = "PRIVATE_NOTIFICATION_SENTINEL";
  const facts = catalog([{ ...session("one", true), prompt: privateValue, transcriptPath: privateValue }], 1, "ready", privateValue);
  facts.providerStatus = { ...status("outage", 1).providerStatus, sourceScope: privateValue };
  facts.providerStatus.providers[0].incidents = [{ body: privateValue, url: privateValue }];
  const snapshot = ledger.acceptFacts(facts);
  assert.equal(JSON.stringify(snapshot).includes(privateValue), false);
  assert.deepEqual(Object.keys(snapshot).sort(), ["version", "revision", "generatedAt", "readiness", "occurrences", "activeSessionOverflow"].sort());
  for (const row of snapshot.occurrences) {
    assert.deepEqual(Object.keys(row).sort(), ["id", "kind", "category", "severity", "lifecycle", "priority", "occurredAt", "timeBasis", "deliveryEligible", "action", "provider", "data"].sort());
    assert.match(row.id, /^[a-f0-9]{32}$/u);
    assert.deepEqual(Object.keys(row.data).sort(), row.kind === "needs_input" ? ["sessionId", "sessionTitle"] : ["status"]);
  }
});
