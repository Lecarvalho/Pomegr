import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTaskStart } from "../desktop/runtime/task-dispatch.mjs";
import { createTaskLookups } from "../server/runtime/task-start-lookup.mjs";
import { createRequestHandler } from "../server/serving/request-handler.mjs";
import { openTaskStore } from "../server/tasks/task-store.mjs";
import {
  chatHarness, finishTurn, repositoryId, send, until,
} from "./helpers/agent-chat-harness.mjs";

const TOKEN = "integration-desktop-token-0123456789";
const trusted = { trusted: true };
const desktop = { event: trusted };
const executable = "C:\\Users\\tester\\.local\\bin\\claude.exe";
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const startAnswer = "A session should start.\n\n```pomegr-board\n{\"summary\":\"Start T-3\",\"operations\":[{\"op\":\"start_session\",\"id\":\"T-3\"}]}\n```";
const validUsage = (percent = 10) => ({
  available: true, fetchedAt: new Date().toISOString(), attemptedAt: new Date().toISOString(), failureKind: null,
  limits: [
    { window: "5 hours", percent, resetsAt: new Date(Date.now() + 60_000).toISOString() },
    { window: "7 days", percent: 20, resetsAt: new Date(Date.now() + 60_000).toISOString() },
  ],
});

async function setup(context, { treeReader, pluginReady = true, confirmResult = true, after = false, usagePercent = 10, providerState = "operational" } = {}) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-repository-"));
  const storeDirectory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-store-"));
  context.after(async () => {
    store.close();
    await new Promise((resolve) => server.close(resolve));
    await Promise.all([repositoryRoot, storeDirectory].map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  const store = openTaskStore({ directory: storeDirectory });
  for (const id of ["T-1", "T-2", "T-3"]) {
    const created = store.apply(repositoryId, "create", {
      text: `Synthetic ${id}`, run: { provider: "claude", model: null, effort: null },
    });
    assert.equal(created.ok, true);
  }
  if (after) assert.equal(store.apply(repositoryId, "after_set", { id: "T-3", after: ["T-1"] }).ok, true);

  const gateState = {
    usageLimits: () => ({ providers: [
      { provider: "claude", usageLimits: validUsage(usagePercent) },
      { provider: "codex", usageLimits: validUsage() },
    ] }),
    providerStatus: () => ({ providers: [
      { provider: "claude", readiness: "ready", freshness: "fresh", status: providerState },
      { provider: "codex", readiness: "ready", freshness: "fresh", status: "operational" },
    ] }),
    gitReader: treeReader || (() => true),
  };
  const lookups = createTaskLookups({
    observationStore: null,
    catalogSessions: () => [],
    repositoryInventory: {
      repositoryRoot: (id) => id === repositoryId ? repositoryRoot : null,
      readPluginSetup: (id, provider) => id === repositoryId && provider === "claude" && pluginReady
        ? { version: "1.0.0", readiness: "ready", installation: "installed", enabled: true }
        : null,
    },
    gateSources: { ...gateState },
  });
  const runtime = { ...lookups };
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, authorizationToken: TOKEN }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const monitorOrigin = `http://127.0.0.1:${server.address().port}`;

  const plans = [];
  const spawns = [];
  const confirmations = [];
  const starter = createTaskStart({
    isTrustedEvent: (event) => event?.trusted === true,
    monitorOrigin,
    authorizationToken: TOKEN,
    platform: "win32",
    environment: { USERPROFILE: "C:\\Users\\tester", SystemRoot: "C:\\Windows", POMEGR_CLAUDE_EXECUTABLE: executable },
    fileExists: (file) => file === executable || file === powershell,
    directoryExists: (directory) => directory === repositoryRoot,
    confirm: async (request) => { confirmations.push(request); return confirmResult; },
    fetch: async (url, options) => {
      if (url.endsWith("/start-plan")) plans.push(JSON.parse(options.body));
      return fetch(url, options);
    },
    terminal: { ensureHost: async () => {}, create: async ({ executable, args, cwd, env }) => { spawns.push([executable, args, { cwd, env }]); } },
  });
  const h = await chatHarness(context, {
    viaDataRoot: true,
    startTask: (event, id, taskId) => starter.startApproved(event, id, taskId),
  });
  h.state.board.tasks = h.state.board.tasks.map((task) => task.id === "T-3"
    ? { ...task, text: "Synthetic T-3", run: { provider: "claude", model: null, effort: null }, ...(after ? { after: ["T-1"] } : {}) }
    : task);
  const sent = await send(h, { text: "start T-3" });
  const conversation = await finishTurn(h, h.runs[0], { status: "complete", text: startAnswer }, sent.conversationId);
  const proposal = conversation.messages.find((message) => message.proposal)?.proposal;
  assert.ok(proposal, "synthetic Aril response should create a start proposal");
  const payload = { repositoryId, conversationId: conversation.id, proposalId: proposal.id };
  const apply = (origin = desktop) => h.chat.handle("apply", payload, origin);
  return { h, store, lookups, starter, plans, spawns, confirmations, proposal, apply, payload, repositoryRoot, gateState };
}

test("Aril Apply waits for an asynchronous clean-tree reading, then starts through the real manual path once", async (context) => {
  let releaseTree;
  let treeRead;
  const readStarted = new Promise((resolve) => { treeRead = resolve; });
  const pendingTree = new Promise((resolve) => { releaseTree = resolve; });
  const env = await setup(context, { treeReader: () => { treeRead(); return pendingTree; } });

  assert.deepEqual(await env.apply(), { ok: true });
  assert.deepEqual(env.spawns, []);
  assert.deepEqual((await env.h.reload().read(repositoryId, env.payload.conversationId)).messages.find((message) => message.proposal).proposal.results,
    [{ ok: false, error: "not_started", start: "gate_held" }]);
  await readStarted;
  releaseTree(true);
  await until(() => env.lookups.resolveTaskGateFacts(repositoryId).treeClean === true);

  // Only a later explicit Apply may launch after the check commits.
  assert.deepEqual(await env.apply(), { ok: true });
  assert.equal(env.spawns.length, 1);
  assert.equal(env.confirmations.length, 2, "each Apply follows the manual start's native confirmation");
  assert.ok(env.confirmations.every((request) => request.taskId === "T-3"));
  assert.deepEqual(env.plans.map((call) => call.payload), [{ id: "T-3" }, { id: "T-3" }]);
  assert.equal(env.plans.every((call) => call.repositoryId === repositoryId), true);
  const stored = (await env.h.reload().read(repositoryId, env.payload.conversationId)).messages.find((message) => message.proposal).proposal;
  assert.deepEqual(stored.results, [{ ok: true, start: "started" }]);
  assert.equal(stored.state, "applied");

  // Apply is single use, and the same task cannot launch again through its manual entry point.
  assert.deepEqual(await env.apply(), { ok: false, error: "conflict" });
  assert.deepEqual(await env.starter.start(trusted, repositoryId, "T-3"), { status: "not_startable" });
  assert.equal(env.spawns.length, 1);
});

test("manual start recovers from unknown evidence and a later Aril Apply cannot duplicate its launch", async (context) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const env = await setup(context, { treeReader: () => pending });
  assert.deepEqual(await env.starter.start(trusted, repositoryId, "T-3"), { status: "gate_held" });
  assert.equal(env.spawns.length, 0);
  release(true);
  await until(() => env.lookups.resolveTaskGateFacts(repositoryId).treeClean === true);
  assert.equal(env.spawns.length, 0, "successful acquisition alone cannot launch");
  assert.deepEqual(await env.starter.start(trusted, repositoryId, "T-3"), { status: "started" });
  assert.equal(env.spawns.length, 1);
  assert.equal(env.spawns[0][2].cwd, env.repositoryRoot, "the launch uses the bound repository root");
  assert.deepEqual(await env.apply(), { ok: true });
  const stored = (await env.h.reload().read(repositoryId, env.payload.conversationId)).messages.find((message) => message.proposal).proposal;
  assert.deepEqual(stored.results, [{ ok: false, error: "not_started", start: "not_startable" }]);
  assert.equal(env.spawns.length, 1);
});

test("runs-after holds both start paths even with clean evidence", async (context) => {
  const env = await setup(context, { after: true });
  await until(() => env.lookups.resolveTaskGateFacts(repositoryId).treeClean === true);
  assert.deepEqual(await env.starter.start(trusted, repositoryId, "T-3"), { status: "gate_held" });
  assert.deepEqual(await env.apply(), { ok: true });
  assert.equal(env.spawns.length, 0);
  assert.equal(env.store.apply(repositoryId, "after_set", { id: "T-3", after: [] }).ok, true);
  assert.deepEqual(await env.apply(), { ok: true });
  assert.equal(env.spawns.length, 1);
});

test("unavailable Git evidence and a dirty tree keep the proposal pending with fixed feedback", async (context) => {
  const unavailable = await setup(context, { treeReader: async () => { throw new Error("private Git failure"); }, after: false });
  assert.deepEqual(await unavailable.apply(), { ok: true });
  const unknown = (await unavailable.h.reload().read(repositoryId, unavailable.payload.conversationId)).messages.find((message) => message.proposal).proposal;
  assert.equal(unknown.state, "pending");
  assert.deepEqual(unknown.results, [{ ok: false, error: "not_started", start: "gate_held" }]);
  assert.equal(unavailable.spawns.length, 0);
  assert.equal(JSON.stringify(unknown).includes("private Git failure"), false);
  assert.deepEqual(await unavailable.starter.start(trusted, repositoryId, "T-3"), { status: "gate_held" });
  assert.equal(unavailable.spawns.length, 0, "a failed check stays held on a later manual request");

  const dirty = await setup(context, { treeReader: async () => false, after: false });
  await until(() => dirty.lookups.resolveTaskGateFacts(repositoryId).treeClean === false);
  assert.deepEqual(await dirty.apply(), { ok: true });
  const stored = (await dirty.h.reload().read(repositoryId, dirty.payload.conversationId)).messages.find((message) => message.proposal).proposal;
  assert.equal(stored.state, "pending");
  assert.deepEqual(stored.results, [{ ok: false, error: "not_started", start: "tree_dirty" }]);
  assert.deepEqual(await dirty.starter.start(trusted, repositoryId, "T-3"), { status: "tree_dirty" });
  assert.equal(dirty.spawns.length, 0);
});

test("usage and provider incident gates still hold a manually approved proposal", async (context) => {
  for (const options of [{ name: "usage over threshold", usagePercent: 95 }, { name: "provider incident", providerState: "outage" }]) {
    const env = await setup(context, { ...options, after: false });
    await until(() => env.lookups.resolveTaskGateFacts(repositoryId).treeClean === true);
    assert.deepEqual(await env.apply(), { ok: true }, options.name);
    const stored = (await env.h.reload().read(repositoryId, env.payload.conversationId)).messages.find((message) => message.proposal).proposal;
    assert.equal(stored.state, "pending", options.name);
    assert.deepEqual(stored.results, [{ ok: false, error: "not_started", start: "gate_held" }], options.name);
    assert.equal(env.spawns.length, 0, options.name);
  }
});

test("an unavailable task setup and a mismatched repository never launch", async (context) => {
  const unavailable = await setup(context, { pluginReady: false, after: false });
  assert.deepEqual(await unavailable.apply(), { ok: true });
  assert.deepEqual(unavailable.spawns, []);
  assert.deepEqual((await unavailable.h.reload().read(repositoryId, unavailable.payload.conversationId)).messages.find((message) => message.proposal).proposal.results,
    [{ ok: false, error: "not_started", start: "plugin_missing" }]);

  const mismatched = await setup(context, { after: true });
  assert.deepEqual(await mismatched.starter.start(trusted, "repo-fedcba9876543210fedcba98", "T-3"), { status: "not_found" });
  assert.deepEqual(await mismatched.apply(), { ok: true });
  assert.equal(mismatched.spawns.length, 0);
  assert.deepEqual(mismatched.plans.map((call) => call.repositoryId), ["repo-fedcba9876543210fedcba98", repositoryId]);
});

test("a paired device cannot apply a start, and cancellation happens before any plan token is requested", async (context) => {
  const paired = await setup(context);
  assert.deepEqual(await paired.apply(null), { ok: false, error: "desktop_only" });
  assert.deepEqual(paired.plans, []);
  assert.deepEqual(paired.spawns, []);

  const cancelled = await setup(context, { confirmResult: false, after: false });
  assert.deepEqual(await cancelled.apply(), { ok: true });
  assert.deepEqual(cancelled.plans, []);
  assert.deepEqual(cancelled.spawns, []);
  assert.equal(cancelled.confirmations.length, 1);
  const stored = (await cancelled.h.reload().read(repositoryId, cancelled.payload.conversationId)).messages.find((message) => message.proposal).proposal;
  assert.equal(stored.state, "pending");
  assert.equal(Object.hasOwn(stored, "results"), false);
});
