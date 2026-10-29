// An agent's board is the board of a repository Git confirmed. A session whose repository is only a guess (a folder
// Git did not answer for, such as a removed worktree) reads and writes no board: every agent board route answers
// `repository_unavailable`, and no empty board is created for the guessed identity (T-200).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRepositoryInventoryRuntime } from "../../../server/repository/repository-inventory-runtime.mjs";
import { resolveTaskSession } from "../../../server/runtime/task-session-lookup.mjs";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const TOKEN = "a".repeat(40);
const MAIN = path.resolve("/work/Clapline");
const WORKTREE = path.join(MAIN, ".claude", "worktrees", "feature");
const REMOVED = path.join(MAIN, ".claude", "worktrees", "merged", "src", "frontend");
const headers = { "x-pomegr-agent-authorization": TOKEN, "content-type": "application/json" };

// Git answers for the main checkout and the linked worktree that still exists; the removed folder gets no answer.
async function gitLookup(cwd) {
  const inside = (root) => cwd === root || cwd.startsWith(`${root}${path.sep}`);
  if (inside(WORKTREE)) return { root: WORKTREE, commonDir: path.join(MAIN, ".git") };
  if (inside(REMOVED)) return null;
  if (inside(MAIN)) return { root: MAIN, commonDir: null };
  return null;
}

async function temporaryDirectory(context, prefix, before = () => {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(async () => {
    before();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; }
      catch (error) {
        if (attempt === 19 || (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
  return directory;
}

// A real task store, closed before its folder is removed.
async function temporaryStore(context) {
  let store = null;
  const directory = await temporaryDirectory(context, "pomegr-unconfirmed-tasks-", () => store?.close());
  store = openTaskStore({ directory });
  return store;
}

// The real inventory, session lookup, request handler, and task store; each session's committed repository ID is
// the one the inventory derived for its working directory.
async function monitor(context, cwds) {
  const inventory = createRepositoryInventoryRuntime({
    registry: { providers: [] }, storeFile: path.join(await temporaryDirectory(context, "pomegr-unconfirmed-inventory-"), "inventory.json"), gitRoot: gitLookup,
  });
  await inventory.ready;
  const committed = new Map();
  for (const [ref, cwd] of Object.entries(cwds)) committed.set(ref.split(":")[1], (await inventory.identify(cwd)).repositoryId);
  const observationStore = { get: (provider, id) => (committed.has(id) ? { publicState: { session: { repositoryId: committed.get(id) } } } : undefined) };
  const store = await temporaryStore(context);
  const runtime = {
    resolveTaskSession: (ref) => resolveTaskSession(ref, {
      observationStore, catalogSessions: () => [], repositoryConfirmation: (repositoryId) => inventory.repositoryConfirmation(repositoryId),
    }),
  };
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, agentAuthorizationToken: TOKEN }));
  context.after(() => new Promise((done) => server.close(done)));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const send = (operation, body) => new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: `/api/agent/v1/tasks/${operation}`, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
  return { inventory, store, send, idOf: (ref) => committed.get(ref.split(":")[1]) };
}

const OPERATIONS = [
  ["add", { text: "a follow-up" }],
  ["update", { taskId: "T-1", text: "changed" }],
  ["remove", { taskId: "T-1" }],
  ["assign", { taskId: "T-1" }],
  ["unassign", { taskId: "T-1" }],
  ["get", { taskId: "T-1" }],
  ["list", {}],
  ["feature-get", {}],
  ["feature-create", { title: "A feature" }],
  ["feature-update", { feature: "A feature", description: "x" }],
  ["feature-delete", { feature: "A feature" }],
];

test("every agent board route refuses a session whose repository Git did not confirm, and creates no board", async (context) => {
  const { inventory, store, send, idOf } = await monitor(context, { "claude:removed": REMOVED });
  const guessed = idOf("claude:removed");
  assert.equal(inventory.repositoryConfirmation(guessed), "guessed");
  for (const [operation, body] of OPERATIONS) {
    const response = await send(operation, { sessionRef: "claude:removed", ...body });
    assert.equal(response.status, 409, operation);
    assert.deepEqual(response.json, { schemaVersion: 1, ok: false, reason: "repository_unavailable" }, operation);
  }
  assert.equal(store.hasBoard(guessed), false, "no empty board was created for the guessed identity");
});

test("a guessed identity is refused even when a board was already made for it", async (context) => {
  const { store, send, idOf } = await monitor(context, { "claude:removed": REMOVED });
  // The phantom board an earlier build made for the removed folder.
  assert.equal(store.apply(idOf("claude:removed"), "create", { text: "phantom" }).ok, true);
  const response = await send("list", { sessionRef: "claude:removed" });
  assert.deepEqual(response.json, { schemaVersion: 1, ok: false, reason: "repository_unavailable" });
});

test("a session in a subfolder or a linked worktree of a repository gets that repository's board", async (context) => {
  const { store, send, idOf } = await monitor(context, {
    "claude:main": MAIN, "claude:subfolder": path.join(MAIN, "src", "backend"), "claude:worktree": path.join(WORKTREE, "src", "frontend"),
  });
  const repositoryId = idOf("claude:main");
  assert.equal(idOf("claude:subfolder"), repositoryId);
  assert.equal(idOf("claude:worktree"), repositoryId);
  for (const [index, sessionRef] of ["claude:main", "claude:subfolder", "claude:worktree"].entries()) {
    assert.deepEqual((await send("add", { sessionRef, text: `from ${sessionRef}` })).json, { schemaVersion: 1, ok: true, taskId: `T-${index + 1}` });
  }
  assert.deepEqual(store.readBoard(repositoryId).tasks.map((task) => task.id), ["T-1", "T-2", "T-3"]);
  const listed = await send("list", { sessionRef: "claude:worktree" });
  assert.equal(listed.json.ok, true);
  assert.deepEqual(listed.json.tasks.map((task) => task.id), ["T-1", "T-2", "T-3"]);
});

test("a confirmed repository still gets its board, and an unconfirmed one only the board it already has", async (context) => {
  const { store, send, idOf } = await monitor(context, { "claude:main": MAIN });
  const repositoryId = idOf("claude:main");
  assert.equal(store.hasBoard(repositoryId), false);
  assert.deepEqual((await send("add", { sessionRef: "claude:main", text: "first" })).json, { schemaVersion: 1, ok: true, taskId: "T-1" });
  assert.equal(store.hasBoard(repositoryId), true, "a confirmed repository's first agent write makes its board");
  assert.equal((await send("get", { sessionRef: "claude:main", taskId: "T-1" })).json.task.id, "T-1");
});

test("a repository the inventory has not seen in this run is served only when its board exists", async (context) => {
  const store = await temporaryStore(context);
  const known = "repo-0123456789abcdef01234567";
  const missing = "repo-ffffffffffffffffffffffff";
  assert.equal(store.apply(known, "create", { text: "kept" }).ok, true);
  // A committed ID from before a monitor restart, before Git answered again.
  const sessions = { "claude:known": known, "claude:missing": missing };
  const runtime = {
    resolveTaskSession: (ref) => ({ found: true, repositoryId: sessions[ref], repositoryConfirmation: "unknown" }),
  };
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, agentAuthorizationToken: TOKEN }));
  context.after(() => new Promise((done) => server.close(done)));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const send = (body) => new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: "/api/agent/v1/tasks/add", headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
  assert.deepEqual(await send({ sessionRef: "claude:known", text: "next" }), { schemaVersion: 1, ok: true, taskId: "T-2" });
  assert.deepEqual(await send({ sessionRef: "claude:missing", text: "lost" }), { schemaVersion: 1, ok: false, reason: "repository_unavailable" });
  assert.equal(store.hasBoard(missing), false);
});

test("the task store answers whether a board exists without creating one", async (context) => {
  const store = await temporaryStore(context);
  const repositoryId = "repo-0123456789abcdef01234567";
  assert.equal(store.hasBoard(repositoryId), false);
  assert.equal(store.hasBoard(repositoryId), false, "asking creates nothing");
  assert.equal(store.hasBoard("not-a-repository"), false);
  store.readBoard(repositoryId);
  assert.equal(store.hasBoard(repositoryId), true);
  store.close();
  assert.equal(store.hasBoard(repositoryId), false, "a closed store has no board to serve");
});
