import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { createCodexWriterPresence } from "../monitor/providers/codex-writer-presence.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";
import { createMonitorRuntime } from "../monitor/server.mjs";

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, typeof message === "function" ? message() : message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("startup and recorded Working/input/end transitions never wait for slow native ownership", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-presence-responsiveness-"));
  const sessionsRoot = path.join(root, "sessions");
  const locksRoot = path.join(root, "thread-writer-locks");
  const id = "responsive-session";
  const qualifiedId = `codex:${id}`;
  const filename = "rollout-responsive.jsonl";
  const rollout = path.join(sessionsRoot, filename);
  let clock = Date.parse("2026-09-02T12:00:00.000Z");
  const timestamp = new Date(clock - 120_000).toISOString();
  const record = (type, payload, at = new Date(clock).toISOString()) => JSON.stringify({ timestamp: at, type, payload }) + "\n";
  await mkdir(sessionsRoot);
  await mkdir(locksRoot);
  await writeFile(rollout,
    record("session_meta", { id, source: "vscode", cwd: root }, timestamp)
    + record("event_msg", { type: "task_started", turn_id: "turn-1" }, timestamp)
    + record("event_msg", { type: "task_complete", turn_id: "turn-1" }, timestamp));
  await utimes(rollout, new Date(timestamp), new Date(timestamp));
  const queries = [];
  const owners = [{ index: 0, pid: 12345, processStartIdentity: "123456789" }];
  const writerPresence = createCodexWriterPresence({
    platform: "win32", writerLocksRoot: locksRoot, now: () => clock,
    readLock: () => ({ state: "held", identity: "stable" }),
    resolveExecutables: () => [path.join(root, "codex.exe")],
    queryOwners(_files, _executables, signal) {
      return new Promise((resolve) => {
        queries.push({ resolve, signal });
        signal.addEventListener("abort", () => resolve([]), { once: true });
      });
    },
  });
  const callbacks = new Map();
  const provider = createCodexProvider({
    codexHome: root, includeArchived: false, cacheMs: 0, now: () => clock,
    writerPresence, observerIntervalMs: 60_000,
    observerWatchSource(target, options, callback) {
      callbacks.set(target, typeof options === "function" ? options : callback);
      return { close() { callbacks.delete(target); } };
    },
  });
  const runtime = createMonitorRuntime({
    now: () => clock, providerRegistry: createProviderRegistry([provider]),
    checkpointStore: false, observationCommitDelayMs: 0,
    scheduleObservation: (task, delay) => setTimeout(task, delay),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  context.after(async () => {
    await runtime.stopObservation();
    for (const query of queries) query.resolve([]);
    await rm(root, { recursive: true, force: true });
  });
  const row = () => runtime.serveCatalog().snapshot?.value?.sessions.find((entry) => entry.id === qualifiedId);
  const agent = () => runtime.serveSession(qualifiedId).snapshot?.publicState?.agents?.[0];
  await runtime.startObservation();
  await waitFor(() => queries.length === 1, "startup must schedule ownership in the background");
  await waitFor(() => row()?.activityStatus === "idle" && agent()?.status === "idle",
    "startup catalog and detail must be ready while the native helper is unresolved");
  assert.equal(queries.length, 1, "catalog and detail reads must not start duplicate helpers");
  queries[0].resolve(owners);
  await waitFor(() => row()?.activityStatus === "open", "owner completion must publish without a timer or transcript event");

  clock += 6_000;
  await provider.listSessions();
  await waitFor(() => queries.length === 2, "reconciliation must launch the next native probe");
  await appendFile(rollout, record("event_msg", { type: "task_started", turn_id: "turn-2" }));
  callbacks.get(sessionsRoot)("change", filename);
  await waitFor(() => row()?.activityStatus === "working" && agent()?.status === "active",
    "a recorded start must replace retained Open in catalog and detail before the probe completes");
  assert.equal(queries[1].signal.aborted, false);

  // Watcher storms must not hold transcript workers or continually cancel the helper.
  for (let index = 0; index < 100; index += 1) callbacks.get(locksRoot)("change", `${id}.lock`);
  clock += 1_000;
  await appendFile(rollout, record("response_item", { type: "function_call", name: "request_user_input", call_id: "input-2", arguments: "{}" }));
  callbacks.get(sessionsRoot)("change", filename);
  await waitFor(() => row()?.needsInput === true && agent()?.status === "needs_input",
    () => `recorded input requests must propagate during an ownership-event burst: ${row()?.activityStatus}/${row()?.needsInput}/${agent()?.status}`);
  assert.equal(queries.length, 2, "a burst must coalesce behind the single running helper");
  assert.equal(queries[1].signal.aborted, false, "lock notifications must not repeatedly kill and restart ownership queries");

  queries[1].resolve(owners);
  await waitFor(() => queries.length === 3, "an invalidated probe needs only one latest-state follow-up");
  queries[2].resolve(owners);
  clock += 1_000;
  await appendFile(rollout,
    record("response_item", { type: "function_call_output", call_id: "input-2", output: "" })
    + record("event_msg", { type: "task_complete", turn_id: "turn-2" }));
  callbacks.get(sessionsRoot)("change", filename);
  await waitFor(() => row()?.activityStatus === "open" && !row()?.needsInput && agent()?.status === "idle",
    "the matching recorded end must return to Open after work finishes");
  const serialized = JSON.stringify([runtime.serveCatalog().snapshot, runtime.serveSession(qualifiedId).snapshot?.publicState]);
  assert.doesNotMatch(serialized, /12345|123456789|processStartIdentity|thread-writer-locks|rollout-responsive/);
});
