import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";
import { createMonitorRuntime, createMonitorServer } from "../monitor/server.mjs";

async function waitFor(predicate) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Native presence publication timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("native presence updates committed Live state without transcript growth or GET acquisition", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-native-presence-pipeline-"));
  const sessionRoot = path.join(root, "sessions");
  const locksRoot = path.join(root, "thread-writer-locks");
  const rollout = path.join(sessionRoot, "rollout-native-presence.jsonl");
  const id = "native-presence";
  const qualifiedId = `codex:${id}`;
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  const timestamp = new Date(now - 2 * 60_000).toISOString();
  await mkdir(sessionRoot);
  await mkdir(locksRoot);
  await writeFile(rollout, [
    { timestamp, type: "session_meta", payload: { id, source: "vscode", cwd: root } },
    { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  await utimes(rollout, new Date(timestamp), new Date(timestamp));
  const initialStat = await stat(rollout);
  let present = false;
  let confirmed = false;
  let acquisitions = 0;
  let closes = 0;
  const listeners = new Set();
  const callbacks = new Map();
  const owner = { pid: 987654321, processStartIdentity: "134000000000000001" };
  const writerPresence = {
    async refresh(threads) {
      acquisitions += 1;
      const next = present && threads.some((thread) => thread.localId === id && !thread.archived);
      if (next !== confirmed) {
        confirmed = next;
        for (const notify of listeners) notify();
      }
    },
    current(localId) { return confirmed && localId === id ? owner : null; },
    invalidate() { confirmed = false; },
    close() { closes += 1; confirmed = false; },
    subscribe(notify) { listeners.add(notify); return () => listeners.delete(notify); },
  };
  const provider = createCodexProvider({
    codexHome: root, includeArchived: false, cacheMs: 0, now: () => now,
    writerPresence, observerIntervalMs: 60_000,
    observerWatchSource(target, options, callback) {
      callbacks.set(target, typeof options === "function" ? options : callback);
      return { close() { callbacks.delete(target); } };
    },
  });
  const registry = createProviderRegistry([provider]);
  const makeRuntime = () => createMonitorRuntime({
    now: () => now,
    providerRegistry: registry, checkpointStore: false, observationCommitDelayMs: 0,
    scheduleObservation: (task, delay) => setTimeout(task, delay),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
    // Keep unrelated Git processes from holding the fixture cwd during Windows cleanup.
    readGitState() {
      return { available: false, branch: "", files: [], isMain: false, comparison: null,
        commits: [], remote: { status: "unavailable", checkedAt: null } };
    },
    async readPullRequests() { return { status: "unavailable", checkedAt: null, items: [] }; },
    repositoryInventoryOptions: { async gitRoot(cwd) { return cwd; } },
  });
  let runtime = makeRuntime();
  let server;
  try {
    await runtime.startObservation();
    const row = () => runtime.serveCatalog().snapshot?.value?.sessions.find((entry) => entry.id === qualifiedId);
    await waitFor(() => row()?.activityStatus === "idle" && runtime.serveSession(qualifiedId).status === "ready");
    assert.equal(row().isLive, false);
    const firstRevision = runtime.serveCatalog().revision;

    present = true;
    callbacks.get(locksRoot)("rename", `${id}.lock`);
    await waitFor(() => row()?.activityStatus === "open" && row()?.isLive === true);
    await waitFor(() => runtime.serveSession(qualifiedId).snapshot?.publicState?.agents?.[0]?.status === "idle");
    assert.ok(runtime.serveCatalog().revision > firstRevision);
    assert.equal(row().updatedAt, timestamp, "ownership does not rewrite activity time");
    const unchangedStat = await stat(rollout);
    assert.equal(unchangedStat.size, initialStat.size);
    assert.equal(unchangedStat.mtimeMs, initialStat.mtimeMs);

    server = createMonitorServer({ runtime });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    // Wait for the event's detail hydration to settle before counting GET-only work.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const beforeGets = acquisitions;
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => fetch(index % 2
      ? `${origin}/api/state?sessionId=${encodeURIComponent(qualifiedId)}`
      : `${origin}/api/sessions`)));
    assert.equal(responses.every((response) => response.status === 200), true);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    assert.equal(acquisitions, beforeGets, "GETs cannot run the native collector");
    for (const body of bodies) assert.doesNotMatch(body, /987654321|134000000000000001|processStartIdentity|resourceOwner|thread-writer-locks|rollout-native-presence|ownerObservation/);

    const openRevision = runtime.serveCatalog().revision;
    present = false;
    callbacks.get(locksRoot)("rename", `${id}.lock`);
    await waitFor(() => row()?.isLive === false && row()?.activityStatus === "idle");
    assert.ok(runtime.serveCatalog().revision > openRevision);

    await new Promise((resolve) => server.close(resolve));
    server = null;
    await runtime.stopObservation();
    assert.ok(closes > 0, "observer shutdown closes its collector");
    present = true;
    runtime = makeRuntime();
    await runtime.startObservation();
    await waitFor(() => row()?.isLive === true && row()?.activityStatus === "open");
    assert.equal(row().updatedAt, timestamp, "restart rechecks native presence, not recency");

    // Isolate the explicit historical read from the restart's independent,
    // asynchronous catalog/ownership lane before comparing acquisition counts.
    await runtime.stopObservation();
    await waitFor(() => !provider.qaStats().catalogPending);
    const beforeHistory = acquisitions;
    const historical = await provider.readSession(id, { historical: true });
    assert.equal(acquisitions, beforeHistory, "historical reads cannot probe current ownership");
    assert.equal(historical.agents.every((agent) => agent.liveness == null), true);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await runtime.stopObservation();
    await rm(root, { recursive: true, force: true });
  }
});
