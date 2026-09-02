import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexProvider } from "../monitor/providers/codex.mjs";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

async function waitFor(predicate, timeoutMs = 3_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for observer publication");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function record(timestamp, type, payload) {
  return JSON.stringify({ timestamp: iso(timestamp), type, payload });
}

test("real Codex observer publishes lifecycle state without transcript growth and retains it across restart", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-lifecycle-pipeline-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let now = NOW;
  const sessions = path.join(root, "sessions", "2026", "08", "30");
  const rollout = path.join(sessions, "rollout-lifecycle-root.jsonl");
  await mkdir(sessions, { recursive: true });
  const old = NOW - 20 * 60_000;
  const recent = NOW - 10_000;
  const lines = [
    record(old, "session_meta", { id: "lifecycle-root", session_id: "lifecycle-root", source: "vscode", cwd: "C:\\synthetic\\pomegr" }),
    record(old + 1, "event_msg", { type: "task_started", turn_id: "turn-1" }),
    record(recent - 2_000, "response_item", { type: "function_call_output", call_id: "large-output", output: `PRIVATE_OUTPUT_MUST_NOT_LEAK${"x".repeat(400 * 1024)}` }),
    record(recent, "event_msg", { type: "agent_reasoning", text: "**Rethink the Pomegr Home page**" }),
    record(recent + 1, "response_item", { type: "function_call", name: "exec", call_id: "recent-tool", arguments: "{}" }),
  ];
  await writeFile(rollout, `${lines.join("\n")}\n`, "utf8");
  await utimes(rollout, new Date(NOW), new Date(NOW));

  const candidates = [];
  const catalogs = [];
  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 0,
    now: () => now,
    observerIntervalMs: 60_000,
    maximumTailBytes: 128 * 1024,
    observerWatchSource: () => ({ close() {} }),
  });
  const observer = provider.createObserver();
  const controller = new AbortController();
  context.after(() => controller.abort());
  await observer.start({
    publishCatalog(entries) { catalogs.push(entries); },
    publishSession(_id, candidate) { candidates.push(candidate); },
    invalidateSession() {},
  }, controller.signal);
  await waitFor(() => candidates.length > 0 && catalogs.at(-1)?.some((entry) => entry.localId === "lifecycle-root"));
  assert.equal(catalogs[0].find((entry) => entry.localId === "lifecycle-root").activityStatus, "unknown");
  const active = candidates.at(-1);
  const primary = active.agents.find((agent) => agent.id === "primary");
  assert.equal(primary.status, "active");
  assert.equal(primary.liveness.source, "structured_lifecycle");
  assert.equal(primary.liveness.evidence, "observed");
  assert.equal(catalogs.at(-1).find((entry) => entry.localId === "lifecycle-root").activityStatus, "working");
  assert.doesNotMatch(JSON.stringify(active), /PRIVATE_OUTPUT_MUST_NOT_LEAK|PROMPT|RESPONSE_MUST_NOT_LEAK|TOOL_OUTPUT_MUST_NOT_LEAK/);

  observer.stop();
  now = NOW + 3 * 60 * 60_000;
  const restartedCandidates = [];
  const restartedCatalogs = [];
  const restartedProvider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 0,
    now: () => now,
    observerIntervalMs: 60_000,
    maximumTailBytes: 128 * 1024,
    observerWatchSource: () => ({ close() {} }),
  });
  const restarted = restartedProvider.createObserver();
  const restartedController = new AbortController();
  context.after(() => restartedController.abort());
  await restarted.start({
    publishCatalog(entries) { restartedCatalogs.push(entries); },
    publishSession(_id, candidate) { restartedCandidates.push(candidate); },
    invalidateSession() {},
  }, restartedController.signal);
  await waitFor(() => restartedCandidates.length > 0);
  assert.equal(restartedCandidates.at(-1).agents.find((agent) => agent.id === "primary").status, "active");
  assert.equal(restartedCandidates.at(-1).agents.find((agent) => agent.id === "primary").currentActivity.label, "Rethink the Pomegr Home page");
  const beforeCompletion = restartedCandidates.length;
  assert.equal(await restarted.hydrate("lifecycle-root"), false);
  assert.equal(restartedCandidates.length, beforeCompletion);

  now += 130_000;
  await appendFile(rollout, `${record(now, "response_item", { type: "function_call", name: "exec", call_id: "progress-tool", arguments: "{}" })}\n`, "utf8");
  await restarted.hydrate("lifecycle-root");
  await waitFor(() => restartedCandidates.length > beforeCompletion);
  assert.equal((await restartedProvider.listSessions()).find((entry) => entry.localId === "lifecycle-root").activityStatus, "working");

  now += 120_001;
  const quiet = await restartedProvider.listSessions();
  assert.equal(quiet.find((entry) => entry.localId === "lifecycle-root").activityStatus, "working");
  assert.equal(quiet.find((entry) => entry.localId === "lifecycle-root").isLive, true);
  const beforeSilence = restartedCandidates.length;
  assert.equal(await restarted.hydrate("lifecycle-root"), false);
  assert.equal(restartedCandidates.length, beforeSilence, "silence does not manufacture revisions");
  await appendFile(rollout, `${record(now, "turn_completed", { turn_id: "turn-1", status: "completed" })}\n`, "utf8");
  await restarted.hydrate("lifecycle-root");
  await waitFor(() => restartedCandidates.length > beforeCompletion && restartedCatalogs.at(-1)?.find((entry) => entry.localId === "lifecycle-root")?.activityStatus === "idle");
  assert.equal(restartedCandidates.at(-1).agents.find((agent) => agent.id === "primary").status, "idle");
  assert.equal(restartedCandidates.at(-1).agents.find((agent) => agent.id === "primary").currentActivity, undefined);
  const afterCompletion = restartedCandidates.length;
  assert.equal(await restarted.hydrate("lifecycle-root"), false);
  assert.equal(restartedCandidates.length, afterCompletion);
  restarted.stop();

  const historical = await createCodexProvider({ codexHome: root, includeArchived: false, cacheMs: 0, now: () => NOW }).readSession("lifecycle-root", { historical: true });
  assert.equal(historical.agents.every((agent) => agent.liveness === null || agent.liveness === undefined), true);
});

test("incremental observation rebuilds lifecycle after a larger in-place rollout replacement", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-replaced-pipeline-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions", "2026", "08", "30");
  await mkdir(sessions, { recursive: true });
  const rollout = path.join(sessions, "rollout-replaced-root.jsonl");
  const header = record(NOW, "session_meta", { id: "replaced-root", source: "vscode", cwd: "C:\\synthetic\\pomegr" });
  await writeFile(rollout, header + "\n" + record(NOW, "event_msg", { type: "task_started", turn_id: "old-turn" }) + "\n");
  const candidates = [];
  const catalogs = [];
  const provider = createCodexProvider({ codexHome: root, includeArchived: false, cacheMs: 0, now: () => NOW + 1_000,
    observerIntervalMs: 60_000, observerWatchSource: () => ({ close() {} }) });
  const observer = provider.createObserver();
  const controller = new AbortController();
  context.after(() => controller.abort());
  await observer.start({ publishCatalog(entries) { catalogs.push(entries); },
    publishSession(_id, candidate) { candidates.push(candidate); }, invalidateSession() {} }, controller.signal);
  await waitFor(() => candidates.length > 0);
  assert.equal(catalogs.at(-1).find((entry) => entry.localId === "replaced-root").activityStatus, "working");
  await writeFile(rollout, header + "\n" + record(NOW, "event_msg", { type: "agent_reasoning", text: "PRIVATE_REPLACEMENT".repeat(100) }) + "\n");
  await observer.hydrate("replaced-root");
  assert.equal(catalogs.at(-1).find((entry) => entry.localId === "replaced-root").activityStatus, "unknown");
  assert.notEqual(candidates.at(-1).agents.find((agent) => agent.id === "primary").status, "active");
  assert.doesNotMatch(JSON.stringify(candidates.at(-1)), /PRIVATE_REPLACEMENT/);
  observer.stop();
});

test("pending Codex input keeps catalog and detail aligned during a large incomplete append", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-pending-lifecycle-pipeline-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let now = NOW + 2_000;
  const sessions = path.join(root, "sessions", "2026", "08", "30");
  const rollout = path.join(sessions, "rollout-pending-root.jsonl");
  await mkdir(sessions, { recursive: true });
  const pendingAt = NOW + 1_000;
  const initial = [
    record(NOW, "session_meta", { id: "pending-root", session_id: "pending-root", source: "vscode", cwd: "C:\\synthetic\\pomegr" }),
    record(NOW + 1, "event_msg", { type: "task_started", turn_id: "turn-pending" }),
    record(pendingAt, "response_item", {
      type: "function_call", name: "request_user_input", call_id: "input-pending", turn_id: "turn-pending",
    }),
  ];
  await writeFile(rollout, `${initial.join("\n")}\n`, "utf8");
  await utimes(rollout, new Date(NOW), new Date(NOW));

  const candidates = [];
  const catalogs = [];
  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 0,
    now: () => now,
    observerIntervalMs: 60_000,
    maximumTailBytes: 256,
    observerWatchSource: () => ({ close() {} }),
  });
  const observer = provider.createObserver();
  const controller = new AbortController();
  context.after(() => controller.abort());
  await observer.start({
    publishCatalog(entries) { catalogs.push(entries); },
    publishSession(_id, candidate) { candidates.push(candidate); },
    invalidateSession() {},
  }, controller.signal);
  await waitFor(() => candidates.length > 0 && catalogs.at(-1)?.some((entry) => entry.localId === "pending-root"));
  assert.equal(candidates.at(-1).agents.find((agent) => agent.id === "primary").status, "needs_input");
  assert.equal(catalogs.at(-1).find((entry) => entry.localId === "pending-root").activityStatus, "needs_input");
  const firstPendingCatalog = catalogs.length - 1;

  const incomplete = record(NOW + 2_000, "response_item", {
    type: "function_call_output", call_id: "unrelated-call", output: "x".repeat(4_096),
  });
  await appendFile(rollout, incomplete.slice(0, -1), "utf8");
  now = NOW + 3_000;
  const beforePartial = candidates.length;
  assert.equal(await observer.hydrate("pending-root"), false);
  await waitFor(() => catalogs.length > 1 && catalogs.at(-1)?.find((entry) => entry.localId === "pending-root")?.activityStatus === "needs_input");
  assert.equal(candidates.length, beforePartial, "the incomplete source does not publish a partial detail revision");
  assert.equal(candidates.at(-1).agents.find((agent) => agent.id === "primary").status, "needs_input");
  assert.equal(catalogs.at(-1).find((entry) => entry.localId === "pending-root").activityStatus, "needs_input");

  await appendFile(rollout, `${incomplete.at(-1)}\n`, "utf8");
  await observer.hydrate("pending-root");
  await waitFor(() => candidates.length > beforePartial);
  assert.equal(candidates.at(-1).agents.find((agent) => agent.id === "primary").status, "needs_input");
  assert.equal(catalogs.slice(firstPendingCatalog).every((entries) => (
    entries.find((entry) => entry.localId === "pending-root")?.activityStatus === "needs_input"
  )), true, "no catalog publication may regress pending input before its resolving record arrives");

  const resolvedAt = NOW + 4_000;
  await appendFile(rollout, `${record(resolvedAt, "response_item", {
    type: "function_call_output", call_id: "input-pending", turn_id: "turn-pending",
  })}\n`, "utf8");
  now = resolvedAt + 1_000;
  const beforeResolution = candidates.length;
  await observer.hydrate("pending-root");
  await waitFor(() => candidates.length > beforeResolution
    && catalogs.at(-1)?.find((entry) => entry.localId === "pending-root")?.activityStatus === "working");
  assert.equal(candidates.at(-1).agents.find((agent) => agent.id === "primary").status, "active");

  const completedAt = NOW + 6_000;
  await appendFile(rollout, `${record(completedAt, "turn_completed", { turn_id: "turn-pending", status: "completed" })}\n`, "utf8");
  now = completedAt + 1_000;
  const beforeCompletion = candidates.length;
  await observer.hydrate("pending-root");
  await waitFor(() => candidates.length > beforeCompletion
    && catalogs.at(-1)?.find((entry) => entry.localId === "pending-root")?.activityStatus === "idle");
  assert.equal(candidates.at(-1).agents.find((agent) => agent.id === "primary").status, "idle");
  observer.stop();
});
