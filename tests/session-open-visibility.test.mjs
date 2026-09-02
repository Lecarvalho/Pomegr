import assert from "node:assert/strict";
import test from "node:test";
import { createSessionObservationCoordinator } from "../monitor/session-observation-coordinator.mjs";

const START = Date.parse("2026-09-02T12:00:00.000Z");
const WINDOW = 5 * 60_000;
const at = (offset = 0) => new Date(START + offset).toISOString();
const open = (localId, updatedAt = at(), extra = {}) => ({
  localId, title: localId, updatedAt, isLive: true, needsInput: false, activityStatus: "open", ...extra,
});

async function fixture(context) {
  let clock = START;
  let derivations = 0;
  let hydrations = 0;
  const jobs = new Set();
  const snapshots = new Map();
  const schedule = (task, delay) => { const job = { task, due: clock + delay }; jobs.add(job); return job; };
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "codex", source: "Codex" }, { id: "claude", source: "Claude Code" }],
      async startObservers() { return { async hydrate() { hydrations += 1; }, async stop() {} }; },
    },
    store: { getByQualifiedId: (id) => snapshots.get(id), setPinned() {} },
    async deriveSession() { derivations += 1; return { readiness: {}, publicState: {} }; },
    now: () => clock, monotonicNow: () => clock,
    schedule, cancel: (job) => jobs.delete(job), commitDelayMs: 0,
  });
  context.after(() => coordinator.stop());
  await coordinator.start();
  return {
    coordinator, snapshots, jobs,
    setClock: (value) => { clock = value; },
    counts: () => ({ derivations, hydrations }),
    rows: () => coordinator.catalog().snapshot.value.sessions,
    async advance(milliseconds) {
      const target = clock + milliseconds;
      for (;;) {
        const next = [...jobs].filter((job) => job.due <= target).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        jobs.delete(next); clock = next.due; await next.task();
      }
      clock = target;
    },
  };
}

test("one background deadline expires Open across providers without changing evidence or acquiring on reads", async (context) => {
  const value = await fixture(context);
  const { coordinator, snapshots } = value;
  const snapshot = { revision: 7, evidence: { historical: false }, publicState: {
    agents: [{ id: "primary", status: "idle" }], metrics: { agents: 1, activeAgents: 0, tokens: { allAgents: 42 } },
  } };
  snapshots.set("codex:a", snapshot);
  coordinator.publisher.publishCatalog("codex", [open("a", at(), {
    resourceOwner: { pid: 123456789, processStartIdentity: "PRIVATE_OWNER" }, transcriptPath: "PRIVATE_PATH",
  })]);
  coordinator.publisher.publishCatalog("claude", [open("b", at(-60_000))]);
  await value.advance(0);
  const revision = coordinator.catalog().revision;
  assert.equal(value.jobs.size, 1, "one deadline for the entire bounded catalog");
  await value.advance(WINDOW - 60_000 - 1);
  assert.equal(value.rows().every((row) => row.isLive), true);
  assert.equal(coordinator.catalog().revision, revision);
  const beforeReads = value.counts();
  for (let index = 0; index < 8; index += 1) {
    assert.equal(coordinator.catalog(revision).status, "unchanged");
    coordinator.session("codex:a");
  }
  assert.deepEqual(value.counts(), beforeReads);
  await value.advance(1);
  assert.deepEqual(value.rows().map(({ id, isLive }) => [id, isLive]), [["codex:a", true], ["claude:b", false]]);
  assert.ok(coordinator.catalog().revision > revision);
  await value.advance(60_000);
  assert.equal(value.rows().every((row) => !row.isLive && row.activityStatus === "open"), true);
  assert.equal(value.rows().find((row) => row.id === "codex:a").latestContextTotal, 42);
  assert.equal(snapshots.get("codex:a"), snapshot, "visibility never replaces or checkpoints provider evidence");
  assert.equal(snapshot.evidence.historical, false);
  assert.deepEqual(value.counts(), beforeReads);
  assert.equal(value.jobs.size, 0, "expired rows do not perpetually tick");
  assert.doesNotMatch(coordinator.catalog().snapshot.serialized, /PRIVATE_OWNER|PRIVATE_PATH|123456789|resourceOwner/);
});

test("owner refresh, viewing and restart cannot renew the window; actual activity can", async (context) => {
  const value = await fixture(context);
  const { coordinator } = value;
  const publish = (entry = open("a")) => coordinator.publisher.publishCatalog("codex", [entry]);
  publish(); await value.advance(0);
  await value.advance(4 * 60_000);
  publish(); await value.advance(0);
  await value.advance(60_000);
  assert.equal(value.rows()[0].isLive, false, "repeated owner confirmation retains original deadline");
  assert.equal(value.rows()[0].updatedAt, at());
  await coordinator.stop();
  assert.equal(value.jobs.size, 0);
  await value.advance(60_000);
  await coordinator.start();
  publish(); await value.advance(0);
  assert.equal(value.rows()[0].isLive, false, "restart uses recorded time, not first observation");
  publish(open("a", at(6 * 60_000))); await value.advance(0);
  assert.equal(value.rows()[0].isLive, true);
  assert.equal(value.jobs.size, 1);
  publish(open("a", at(6 * 60_000), { isLive: false })); await value.advance(0);
  assert.equal(value.rows()[0].isLive, false, "recency never creates provider presence");
  assert.equal(value.jobs.size, 0);
  await coordinator.stop();
  const revision = coordinator.catalog().revision;
  await value.advance(WINDOW * 2);
  assert.equal(coordinator.catalog().revision, revision);
});

test("Working and Needs input never expire, and returning work restores Live immediately", async (context) => {
  const value = await fixture(context);
  const { coordinator } = value;
  const entries = [
    open("quiet", at(-WINDOW)),
    open("working-parent", at(-WINDOW * 10), { activityStatus: "working" }),
    open("waiting-child", at(-WINDOW * 10), { activityStatus: "needs_input", needsInput: true }),
    open("input-precedence", at(-WINDOW * 10), { needsInput: true }),
    open("stopped", at(-WINDOW * 10), { activityStatus: "stopped" }),
  ];
  coordinator.publisher.publishCatalog("codex", entries); await value.advance(0);
  assert.equal(value.rows().find((row) => row.id === "codex:quiet").isLive, false);
  assert.equal(value.rows().filter((row) => row.id !== "codex:quiet").every((row) => row.isLive), true);
  await value.advance(WINDOW * 10);
  coordinator.publisher.publishCatalog("codex", entries.map((entry) => entry.localId === "quiet"
    ? { ...entry, activityStatus: "working" } : entry));
  await value.advance(0);
  assert.equal(value.rows().every((row) => row.isLive), true);
  assert.equal(value.jobs.size, 0);
});

test("restart reprojects retained Open rows before any provider republishes", async (context) => {
  const value = await fixture(context);
  const { coordinator } = value;
  coordinator.publisher.publishCatalog("codex", [open("a")]);
  await value.advance(0);
  assert.equal(value.rows()[0].isLive, true);
  await coordinator.stop();
  await value.advance(WINDOW);
  await coordinator.start();
  await value.advance(0);
  assert.equal(value.rows()[0].isLive, false);
  assert.equal(value.rows()[0].activityStatus, "open");
  assert.deepEqual(value.counts(), { derivations: 0, hydrations: 0 });
});

test("missing, malformed, future and clock-regressed activity never grants Open visibility", async (context) => {
  const value = await fixture(context);
  const { coordinator } = value;
  const entries = [open("missing", null), open("invalid", "not-a-date"), open("future", at(60_000)), open("valid")];
  coordinator.publisher.publishCatalog("codex", entries); await value.advance(0);
  assert.deepEqual(value.rows().filter((row) => row.isLive).map((row) => row.id), ["codex:valid"]);
  value.setClock(START - 1);
  coordinator.publisher.publishCatalog("codex", entries); await value.advance(0);
  assert.equal(value.rows().every((row) => !row.isLive && row.activityStatus === "open"), true);
  assert.equal(value.jobs.size, 0);
});
