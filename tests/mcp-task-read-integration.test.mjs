import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildPomegrMcpServer as buildCodexServer } from "../mcp/server.mjs";
import { buildPomegrMcpServer as buildClaudeServer } from "../plugins/claude-code/mcp/server.mjs";
import { bindClaudeQueryWrite } from "../plugin-src/claude-query-session.mjs";
import { publishAgentQueryDescriptor } from "../shared/agent-query-transport.mjs";
import { createRequestHandler } from "../server/serving/request-handler.mjs";
import { openTaskStore } from "../server/tasks/task-store.mjs";
import { createTask, removeDirectory, startedTask, withDatabase } from "./server/tasks/queue-test-support.mjs";

const REPOSITORY = "repo-0123456789abcdef01234567";
const OTHER_REPOSITORY = "repo-fedcba987654321001234567";
const CLAUDE_SESSION = "44444444-4444-4444-8444-444444444444";
const CODEX_THREAD = "019a0000-2222-7333-8444-555566667777";
const TOKEN_A = "synthetic-agent-token-a-".padEnd(43, "a");
const TOKEN_B = "synthetic-agent-token-b-".padEnd(43, "b");
const NOW = 1_800_000_000_000;
const REF_CLAUDE = `claude:${CLAUDE_SESSION}`;
const REF_CODEX = `codex:${CODEX_THREAD}`;
const REF_CLAUDE_OTHER = "claude:55555555-5555-4555-8555-555555555555";
const REF_CODEX_OTHER = "codex:019a0000-3333-7333-8444-555566667777";

async function createMcpClient(context, server) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "synthetic-task-read-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function createMonitor(context, store, token, repositories) {
  const runtime = {
    resolveTaskSession: (sessionRef) => {
      const repositoryId = repositories[sessionRef];
      return repositoryId ? { found: true, repositoryId, repositoryConfirmation: "confirmed" } : null;
    },
  };
  const server = http.createServer(createRequestHandler({
    runtime,
    taskStore: store,
    agentAuthorizationToken: token,
  }));
  let requestCount = 0;
  server.on("request", () => { requestCount += 1; });
  context.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    get requestCount() { return requestCount; },
  })));
}

async function setup(context) {
  const storeDirectory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-read-integration-store-"));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-read-integration-runtime-"));
  const store = openTaskStore({ directory: storeDirectory });
  context.after(async () => {
    store.close();
    await Promise.all([removeDirectory(storeDirectory), removeDirectory(dataRoot)]);
  });

  const feature = store.apply(REPOSITORY, "agent_feature_create", { title: "Offline mode" });
  assert.equal(feature.ok, true);
  createTask(store, REPOSITORY, {
    text: "Fix the cache layer",
    completeWhen: { checks: ["ci_passed"], own: "Review the change" },
    featureId: feature.featureId,
  });
  createTask(store, REPOSITORY, { text: "Started work item" });
  startedTask(storeDirectory, 2, { session: REF_CLAUDE, repositoryId: REPOSITORY });
  createTask(store, REPOSITORY, { text: "Update the release note" });
  assert.equal(store.apply(REPOSITORY, "after_set", { id: "T-3", after: ["T-1"] }).ok, true);
  createTask(store, OTHER_REPOSITORY, { text: "Other board first task" });

  const repositories = {
    [REF_CLAUDE]: REPOSITORY,
    [REF_CODEX]: REPOSITORY,
    [REF_CLAUDE_OTHER]: OTHER_REPOSITORY,
    [REF_CODEX_OTHER]: OTHER_REPOSITORY,
  };
  const monitor = await createMonitor(context, store, TOKEN_A, repositories);
  await publishAgentQueryDescriptor({ dataRoot, origin: monitor.origin, token: TOKEN_A });
  return { store, storeDirectory, dataRoot, repositories, monitor };
}

function buildProvider(provider, { dataRoot } = {}) {
  if (provider === "codex") return buildCodexServer({ environment: {}, dataRoot, query: async () => ({}) });
  return buildClaudeServer({ dataRoot, query: async () => ({}), now: () => NOW });
}

function claudeBoundInput(name, input, sessionRef = REF_CLAUDE, token = TOKEN_A) {
  return bindClaudeQueryWrite({
    hook_event_name: "PreToolUse",
    tool_name: `mcp__plugin_pomegr_pomegr__${name}`,
    tool_input: input,
    transcript_path: path.resolve("synthetic", `${sessionRef.slice("claude:".length)}.jsonl`),
  }, { readToken: async () => token, now: () => NOW }).then((result) => result.hookSpecificOutput.updatedInput);
}

async function call(client, provider, name, input = {}, { otherBoard = false, token = TOKEN_A } = {}) {
  const sessionRef = provider === "claude"
    ? (otherBoard ? REF_CLAUDE_OTHER : REF_CLAUDE)
    : (otherBoard ? REF_CODEX_OTHER : REF_CODEX);
  const args = provider === "claude" ? await claudeBoundInput(name, input, sessionRef, token) : input;
  return client.callTool({
    name,
    arguments: args,
    ...(provider === "codex" ? { _meta: {
      threadId: sessionRef.slice("codex:".length),
      "x-codex-turn-metadata": { thread_id: sessionRef.slice("codex:".length) },
    } } : {}),
  });
}

async function snapshotStoreBytes(directory) {
  withDatabase(directory, (database) => database.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
  return readFile(path.join(directory, "tasks.sqlite"));
}

for (const provider of ["codex", "claude"]) {
  test(`${provider} get_task and list_tasks read the host-bound board through MCP and the real monitor`, { timeout: 10_000 }, async (context) => {
    const env = await setup(context);
    const client = await createMcpClient(context, buildProvider(provider, env));

    const before = await snapshotStoreBytes(env.storeDirectory);
    const task = await call(client, provider, "get_task", { task_id: "T-3" });
    assert.notEqual(task.isError, true);
    assert.match(task.content[0].text, /Runs after: T-1/u);
    assert.match(task.content[0].text, /Update the release note/u);

    const query = await call(client, provider, "list_tasks", { query: "CACHE", editable: true });
    assert.notEqual(query.isError, true);
    assert.match(query.content[0].text, /1 task matches/u);
    assert.match(query.content[0].text, /Fix the cache layer/u);
    assert.doesNotMatch(query.content[0].text, /Started work item|release note/u);

    const state = await call(client, provider, "list_tasks", { state: "blocked" });
    assert.notEqual(state.isError, true);
    assert.equal(state.content[0].text, "No task of the board matches.");
    const feature = await call(client, provider, "list_tasks", { feature: "Offline mode" });
    assert.match(feature.content[0].text, /Fix the cache layer/u);
    const nonEditable = await call(client, provider, "list_tasks", { editable: false });
    assert.match(nonEditable.content[0].text, /Started work item/u);
    assert.doesNotMatch(nonEditable.content[0].text, /Fix the cache layer|release note/u);

    const unknown = await call(client, provider, "get_task", { task_id: "T-99" });
    const otherBoard = await call(client, provider, "get_task", { task_id: "T-2" }, { otherBoard: true });
    assert.equal(unknown.isError, true);
    assert.equal(otherBoard.isError, true);
    assert.equal(unknown.content[0].text, "No such task on this session's board.");
    assert.equal(otherBoard.content[0].text, unknown.content[0].text);
    const boardTask = await call(client, provider, "get_task", { task_id: "T-1" }, { otherBoard: true });
    assert.notEqual(boardTask.isError, true);
    assert.match(boardTask.content[0].text, /Other board first task/u);
    assert.doesNotMatch(boardTask.content[0].text, /Fix the cache layer|Started work item/u);

    const after = await snapshotStoreBytes(env.storeDirectory);
    assert.deepEqual(after, before, "agent reads do not alter the task store files");
  });
}

for (const provider of ["codex", "claude"]) {
  test(`${provider} rereads a rotated runtime descriptor and recovers after the monitor is unavailable`, { timeout: 10_000 }, async (context) => {
    const env = await setup(context);
    const client = await createMcpClient(context, buildProvider(provider, env));
    const before = await snapshotStoreBytes(env.storeDirectory);
    const initial = await call(client, provider, "get_task", { task_id: "T-1" });
    assert.notEqual(initial.isError, true);

    const closedOriginServer = http.createServer();
    await new Promise((resolve) => closedOriginServer.listen(0, "127.0.0.1", resolve));
    const closedOrigin = `http://127.0.0.1:${closedOriginServer.address().port}`;
    await new Promise((resolve) => { closedOriginServer.closeAllConnections(); closedOriginServer.close(resolve); });
    await publishAgentQueryDescriptor({ dataRoot: env.dataRoot, origin: closedOrigin, token: TOKEN_A });
    const unavailable = await call(client, provider, "get_task", { task_id: "T-1" });
    assert.equal(unavailable.isError, true);
    assert.equal(unavailable.content[0].text, "Pomegr is unavailable, so no task was read.");

    const replacement = await createMonitor(context, env.store, TOKEN_B, env.repositories);
    await publishAgentQueryDescriptor({ dataRoot: env.dataRoot, origin: replacement.origin, token: TOKEN_B });
    if (provider === "claude") {
      const staleProof = await call(client, provider, "get_task", { task_id: "T-1" }, { token: TOKEN_A });
      assert.equal(staleProof.isError, true);
      assert.equal(staleProof.content[0].text, "Pomegr could not bind this call to the current session, so no task was read.");
      assert.equal(replacement.requestCount, 0, "a proof signed with the previous capability never reaches the new monitor");
    }
    const recovered = await call(client, provider, "get_task", { task_id: "T-1" }, { token: TOKEN_B });
    assert.notEqual(recovered.isError, true);
    assert.match(recovered.content[0].text, /Fix the cache layer/u);
    assert.equal(replacement.requestCount, 1);
    const after = await snapshotStoreBytes(env.storeDirectory);
    assert.deepEqual(after, before, "descriptor rotation and agent reads do not alter task store bytes");
  });
}

test("both providers send no monitor request when host binding is absent", { timeout: 10_000 }, async (context) => {
  const env = await setup(context);
  for (const provider of ["codex", "claude"]) {
    const client = await createMcpClient(context, buildProvider(provider, env));
    const refused = await client.callTool({ name: "get_task", arguments: { task_id: "T-1" } });
    assert.equal(refused.isError, true, provider);
    assert.equal(refused.content[0].text, "Pomegr could not bind this call to the current session, so no task was read.", provider);
  }
  assert.equal(env.monitor.requestCount, 0);
});
