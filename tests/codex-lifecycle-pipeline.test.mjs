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

  now = NOW + 130_000;
  await appendFile(rollout, `${record(now, "response_item", { type: "function_call", name: "exec", call_id: "progress-tool", arguments: "{}" })}\n`, "utf8");
  await restarted.hydrate("lifecycle-root");
  await waitFor(() => restartedCandidates.length > beforeCompletion);
  assert.equal((await restartedProvider.listSessions()).find((entry) => entry.localId === "lifecycle-root").activityStatus, "working");

  now = NOW + 250_001;
  const quiet = await restartedProvider.listSessions();
  assert.equal(quiet.find((entry) => entry.localId === "lifecycle-root").activityStatus, "unknown");
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
