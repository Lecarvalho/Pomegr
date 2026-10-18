import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createArilPilot } from "../desktop/runtime/aril-pilot.mjs";
import { createTaskStart } from "../desktop/runtime/task-dispatch.mjs";
import { environment, exe, codexExe, powershell, fakeChild, json, root } from "./helpers/task-dispatch-harness.mjs";
import { GATE_FACTS, REPOSITORY, openTemporaryStore, queueSettings } from "./server/tasks/queue-test-support.mjs";

for (const provider of ["claude", "codex"]) for (const queueOn of [false, true]) test(`pilot directly starts an unqueued Backlog task with ${provider} while queue is ${queueOn ? "on" : "off"}`, async (t) => {
  const { store, clock, directory } = await openTemporaryStore(t, "pomegr-pilot-dispatch-");
  const chosen = { provider, model: provider === "claude" ? "synthetic-small" : "synthetic-large" };
  // An unset task permits model selection; an explicit task preserves its choice.
  store.apply(REPOSITORY, "create", { text: "Synthetic task: no real provider or filesystem effects", run: provider === "claude" ? { ...chosen, effort: "high" } : { effort: "high" } });
  const unqueued = store.readBoard(REPOSITORY);
  assert.equal(unqueued.tasks[0].state, "not_queued");
  assert.equal(unqueued.columns.find((column) => column.id === unqueued.tasks[0].columnId).name, "Backlog");
  assert.equal(queueSettings(store, queueOn).ok, true);
  const routes = [];
  const spawns = [];
  const worktreeRequests = [];
  const worktreeDirectory = path.join(root, "synthetic-task-worktree");
  const gateFacts = { ...GATE_FACTS, treeClean: false };
  const starter = createTaskStart({
    monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "synthetic-desktop-key", platform: "win32",
    environment: { ...environment, POMEGR_CLAUDE_EXECUTABLE: exe, POMEGR_CODEX_EXECUTABLE: codexExe },
    fileExists: (file) => [exe, codexExe, powershell].includes(file), directoryExists: (directory) => directory === root,
    worktrees: { ensure: async (request) => { worktreeRequests.push(request); return { ok: true, directory: worktreeDirectory }; } },
    fetch: async (url, init) => {
      const route = new URL(url).pathname.split("/").at(-1);
      const { repositoryId, payload } = JSON.parse(init.body);
      assert.equal(repositoryId, REPOSITORY);
      routes.push(route);
      const answer = route === "start-plan" ? store.planStart(repositoryId, payload, () => ({ root, pluginReady: true }), () => gateFacts)
        : route === "start-check" ? store.checkStart(repositoryId, payload, () => gateFacts) : store.abortStart(repositoryId, payload);
      return json(answer);
    },
    spawn: (...args) => { spawns.push(args); return fakeChild(); },
  });
  t.after(() => starter.dispose());
  const pilot = createArilPilot({
    directory: path.join(directory, "pilot"), now: () => new Date(clock.now), starter,
    readBoard: async () => store.readBoard(REPOSITORY, { resolveGateFacts: () => gateFacts }),
    readUsage: async () => ({ providers: ["claude", "codex"].map((provider) => ({ provider, readiness: "ready", usageLimits: {
      available: true, fetchedAt: new Date(clock.now).toISOString(), limits: [{ window: "5 hours", percent: 10, active: false, resetsAt: new Date(clock.now + 3_600_000).toISOString() }],
    } })) }),
    decide: async ({ prompt }) => {
      const evidence = JSON.parse(prompt.match(/<evidence>(.*?)<\/evidence>/su)[1]);
      return { status: "complete", text: JSON.stringify({ action: "start", taskId: "T-1", ...chosen, reason: "Selected from authorized work and capacity.", waitUntil: null, evidenceRevision: evidence.evidenceRevision }) };
    },
  });
  t.after(() => pilot.dispose());
  const activation = await pilot.activate({ repositoryId: REPOSITORY, goal: "Synthetic finite goal", taskIds: ["T-1"], allowedRuns: [chosen], inference: chosen });
  assert.equal(activation.ok, true, JSON.stringify(activation));
  await pilot.tick();
  assert.equal(spawns.length, 1);
  assert.deepEqual(worktreeRequests, [{ repositoryRoot: root, repositoryId: REPOSITORY, taskId: "T-1" }]);
  assert.equal(spawns[0][2].cwd, worktreeDirectory);
  assert.deepEqual(routes, ["start-plan", "start-check"]);
  assert.equal((await pilot.read(REPOSITORY)).pilot.receipts.at(-1).status, "started");
  assert.equal(store.readBoard(REPOSITORY).tasks[0].run.provider, chosen.provider);
  assert.equal(store.readBoard(REPOSITORY).tasks[0].run.model, chosen.model);
  assert.equal(store.readBoard(REPOSITORY).tasks[0].run.effort, "high");
  assert.equal((await starter.startQueued(REPOSITORY, "T-1")).status, "not_startable");
  const sessionId = `${provider}:0b8f2c1e-1111-4222-8333-444455556666`;
  assert.equal(store.bindSession({ token: spawns[0][2].env.POMEGR_TASK_TOKEN, sessionId }).ok, true);
  assert.equal(store.readBoard(REPOSITORY).tasks[0].session.id, sessionId);
  clock.now += 300_000;
  await pilot.tick();
  assert.equal(spawns.length, 1);
});
