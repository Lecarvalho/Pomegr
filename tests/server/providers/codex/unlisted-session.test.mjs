import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexIncrementalObserver } from "../../../../server/providers/codex/observation.mjs";
import { createCodexProvider } from "../../../../server/providers/codex/index.mjs";
import { SessionObservationStore } from "../../../../server/sessions/checkpoints/session-observation-store.mjs";
import { createSessionObservationCoordinator } from "../../../../server/runtime/session-observation-coordinator.mjs";

// Real file reads settle on I/O, not on event-loop turns, so a busy machine needs a deadline here.
async function waitFor(predicate, message = "observer state", timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

async function temporaryRoot(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pomegr-unlisted-session-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** The smallest normalized evidence the Codex observer accepts, tagged with the option it was read under. */
function stubEvidence(id, options) {
  return {
    localId: id,
    historical: options.historical === true,
    session: { updatedAt: "2026-08-28T10:00:00.000Z" },
    agents: [{ id: "primary", skills: [], toolCalls: 0 }],
    workflows: [], usageSnapshots: [], toolCalls: [], activity: [], planTasks: [], compactions: [],
    efficiencyRuleEvidence: { repetition: false }, pullRequestCreations: [],
  };
}

async function stubbedObserver(context, { ids, list, observeLifecycleSources }) {
  const root = await temporaryRoot(context);
  const metadata = [];
  for (const id of ids) {
    const rolloutFile = path.join(root, `${id}.jsonl`);
    await writeFile(rolloutFile, `{"id":"${id}"}\n`, "utf8");
    metadata.push({ localId: id, sessionId: id, rolloutFile });
  }
  const reads = [];
  const published = [];
  const observer = createCodexIncrementalObserver({
    list,
    discoveredMetadata: async () => metadata,
    transcriptPathsBySessionId: new Map(),
    watchTargets: [],
    intervalMs: 60_000,
    shouldEagerHydrate: () => false,
    observeLifecycleSources,
    async yieldControl() {},
    readEvidence: async (id, options) => {
      reads.push({ id, historical: options.historical });
      return stubEvidence(id, options);
    },
  });
  const controller = new AbortController();
  context.after(() => controller.abort());
  const start = () => observer.start({
    publishCatalog() {}, publishSession(id, candidate) { published.push({ id, historical: candidate.historical }); }, invalidateSession() {},
  }, controller.signal);
  return { observer, start, reads, published };
}

test("Codex reads a session its catalog lists live as live, and every other hydrated session as historical", async (context) => {
  const { observer, start, reads } = await stubbedObserver(context, {
    ids: ["listed-live", "listed-idle", "unlisted"],
    list: async () => [
      { localId: "listed-live", isLive: true, activityStatus: "working" },
      { localId: "listed-idle", isLive: false, activityStatus: "idle" },
    ],
  });
  await start();
  await waitFor(() => observer.diagnostics().reconciliationRuns === 1 && observer.diagnostics().activeHydrations === 0, "first catalog pass");
  for (const id of ["listed-live", "listed-idle", "unlisted"]) await observer.hydrate(id);
  assert.deepEqual(reads, [
    { id: "listed-live", historical: false },
    { id: "listed-idle", historical: true },
    { id: "unlisted", historical: true },
  ]);
});

test("Codex decides a session requested before the first catalog pass from that pass, without a flip", async (context) => {
  const firstPass = deferred();
  const { observer, start, reads, published } = await stubbedObserver(context, {
    ids: ["live-at-start", "history-at-start"],
    list: async () => firstPass.promise,
  });
  await start();
  const live = observer.hydrate("live-at-start");
  const history = observer.hydrate("history-at-start");
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reads, [], "no read starts before liveness is known");
  firstPass.resolve([{ localId: "live-at-start", isLive: true, activityStatus: "working" }]);
  await Promise.all([live, history]);
  assert.deepEqual(reads.sort((left, right) => left.id.localeCompare(right.id)), [
    { id: "history-at-start", historical: true },
    { id: "live-at-start", historical: false },
  ]);
  assert.deepEqual(published.sort((left, right) => left.id.localeCompare(right.id)), reads.map(({ id, historical }) => ({ id, historical })),
    "each session is published once, as the class it will keep");
});

test("a lifecycle rebuild that reads a catalog without the session re-reads it as historical", async (context) => {
  let entries = [{ localId: "ended", isLive: true, activityStatus: "working" }];
  const { observer, start, reads } = await stubbedObserver(context, {
    ids: ["ended"],
    list: async () => entries,
    observeLifecycleSources: () => true,
  });
  await start();
  await waitFor(() => observer.diagnostics().reconciliationRuns === 1, "first catalog pass");
  await observer.hydrate("ended");
  assert.deepEqual(reads, [{ id: "ended", historical: false }]);
  entries = [];
  await observer.hydrate("ended");
  assert.deepEqual(reads.at(-1), { id: "ended", historical: true },
    "a session the just-read catalog omits is not live, whatever the earlier entry said");
});

const timestamp = (day) => `2026-01-0${day}T12:00:00.000Z`;
const record = (day, type, payload) => `${JSON.stringify({ type, timestamp: timestamp(day), payload })}\n`;

async function writeRollout(root, id, day) {
  const directory = path.join(root, "sessions", "2026", "01", `0${day}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `rollout-${id}.jsonl`), record(day, "session_meta", { id, session_id: id, source: "vscode", cwd: path.join(root, "work") })
    + record(day, "event_msg", { type: "task_started", turn_id: `turn-${id}` })
    + record(day, "event_msg", { type: "task_complete", turn_id: `turn-${id}` }), "utf8");
}

async function twoSessionProvider(context) {
  const root = await temporaryRoot(context);
  await writeRollout(root, "older-session", 1);
  await writeRollout(root, "newer-session", 2);
  // A catalog of one row leaves the older session outside it, as thousands of old sessions are.
  return createCodexProvider({
    codexHome: root, includeArchived: false, cacheMs: 0, catalogLimit: 1,
    now: () => Date.parse("2026-03-01T00:00:00.000Z"), observerIntervalMs: 60_000,
    observerWatchSource: () => ({ close() {} }),
  });
}

test("the real Codex observer publishes a session outside its catalog window as historical evidence", async (context) => {
  const provider = await twoSessionProvider(context);
  const observer = provider.createObserver();
  const catalogs = [];
  const published = new Map();
  const controller = new AbortController();
  context.after(() => { controller.abort(); observer.stop(); });
  await observer.start({
    publishCatalog(entries) { catalogs.push(entries.map((entry) => entry.localId)); },
    publishSession(id, candidate) { published.set(id, candidate); }, invalidateSession() {},
  }, controller.signal);
  await waitFor(() => catalogs.length > 0, "the catalog");
  assert.deepEqual(catalogs.at(-1), ["newer-session"], "only the newest session is listed");
  await observer.hydrate("older-session");
  const unlisted = published.get("older-session");
  assert.equal(unlisted.historical, true);
  assert.equal(unlisted.agents.every((agent) => agent.liveness == null), true, "no live liveness reaches a recorded session");
});

test("a session outside the catalog window is not pinned in the store, so a later selection can evict it", async (context) => {
  const provider = await twoSessionProvider(context);
  const observer = provider.createObserver();
  const store = new SessionObservationStore({ maxEntries: 1 });
  const coordinator = createSessionObservationCoordinator({
    store,
    commitDelayMs: 0,
    registry: {
      providers: [{ id: "codex", source: "Codex" }],
      async startObservers(publisher, signal) {
        await observer.start({
          publishCatalog: (entries) => publisher.publishCatalog("codex", entries),
          publishSession: (id, evidence) => publisher.publishSession("codex", id, evidence),
          invalidateSession: (id, reason) => publisher.invalidateSession("codex", id, reason),
          checkpointFor: (id) => publisher.checkpointFor("codex", id),
        }, signal);
        return { hydrate: (id) => observer.hydrate(id.slice("codex:".length)), stop: observer.stop };
      },
    },
    deriveSession: async ({ evidence }) => ({ readiness: { core: "ready" }, publicState: evidence }),
  });
  context.after(() => coordinator.stop());
  await coordinator.start();

  assert.equal(coordinator.session("codex:older-session").status, "loading");
  await waitFor(() => store.get("codex", "older-session"), "the unlisted session to commit");
  assert.equal(store.get("codex", "older-session").evidence.historical, true);
  await waitFor(() => observer.diagnostics().activeHydrations === 0, "hydration to finish");

  assert.equal(coordinator.session("codex:newer-session").status, "loading");
  await waitFor(() => store.get("codex", "newer-session"), "the listed session to commit");
  assert.equal(store.get("codex", "older-session"), null, "the recorded session was released with the selection");
  assert.equal(store.stats().pinnedEntries, 1, "only the current selection is pinned");
});
