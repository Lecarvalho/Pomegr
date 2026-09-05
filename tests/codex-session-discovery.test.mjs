import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexProvider, resolveCodexHome } from "../monitor/providers/codex.mjs";
import { mergeCodexMetadata } from "../monitor/providers/codex-session-discovery.mjs";
import { listCodexRolloutMetadata, normalizeCodexThreadMetadata } from "../monitor/providers/codex-session-metadata.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";
import {
  assertNoPrivateFixtureSentinels,
  readProviderFixture,
} from "./helpers/provider-fixtures.mjs";

async function writeRollout(file, fixture, replacements = []) {
  let contents = await readProviderFixture(fixture);
  for (const [from, to] of replacements) contents = contents.replaceAll(from, to);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}

async function beyondDiscoveryWindow(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-discovery-window-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const old = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const write = async (name, id) => {
    const file = path.join(sessionsRoot, name);
    await writeFile(file, `${JSON.stringify({
      type: "session_meta", timestamp: old.toISOString(),
      payload: { id, source: "vscode", cwd: "C:\\synthetic\\repo" },
    })}\n`);
    await utimes(file, old, old);
    return file;
  };
  for (let offset = 0; offset < 510; offset += 50) {
    await Promise.all(Array.from({ length: Math.min(50, 510 - offset) }, (_, index) => {
      const id = `newer-${String(offset + index).padStart(4, "0")}`;
      return write(`rollout-z-${id}.jsonl`, id);
    }));
  }
  const resumedFile = await write("rollout-a-resumed.jsonl", "older-resumed");
  const writerPresence = { refresh: async () => {}, current: () => null, close() {} };
  return { root, sessionsRoot, resumedFile, writerPresence };
}

async function waitForDiscovery(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "discovery did not publish the resumed session");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a watcher admits and hydrates an older resumed session beyond 500 files", async (context) => {
  const fixture = await beyondDiscoveryWindow(context);
  const callbacks = new Map();
  const catalogs = [];
  const evidence = [];
  const provider = createCodexProvider({
    codexHome: fixture.root, includeArchived: false, cacheMs: 60_000,
    writerPresence: fixture.writerPresence, observerIntervalMs: 60_000,
    observerWatchSource(target, _options, callback) {
      callbacks.set(target, callback);
      return { close() {} };
    },
  });
  const observer = provider.createObserver();
  const controller = new AbortController();
  context.after(() => { controller.abort(); observer.stop(); });
  await observer.start({
    publishCatalog(rows) { catalogs.push(rows); },
    publishSession(id, value) { evidence.push({ id, value }); },
    invalidateSession() {},
  }, controller.signal);
  await waitForDiscovery(() => catalogs.length > 0);
  assert.equal(catalogs[0].some((row) => row.localId === "older-resumed"), false);
  const timestamp = new Date().toISOString();
  await appendFile(fixture.resumedFile, `${JSON.stringify({
    type: "event_msg", timestamp, payload: { type: "task_started", turn_id: "resumed-turn" },
  })}\n`);
  const wake = callbacks.get(fixture.sessionsRoot);
  for (let index = 0; index < 100; index += 1) wake("change", path.basename(fixture.resumedFile));
  await waitForDiscovery(() => evidence.some((item) => item.id === "older-resumed"));
  assert.equal(catalogs.at(-1).some((row) => row.localId === "older-resumed" && row.isLive), true);
  assert.doesNotMatch(JSON.stringify(catalogs), /rollout-|session_meta|turn_id|synthetic/);
  assert.ok(observer.diagnostics().reconciliationRuns <= 3, "watcher burst must coalesce catalog work");
});

test("periodic discovery finds an older running session without a watcher after startup", async (context) => {
  const fixture = await beyondDiscoveryWindow(context);
  let now = Date.now();
  const timestamp = new Date().toISOString();
  await appendFile(fixture.resumedFile, `${JSON.stringify({
    type: "event_msg", timestamp, payload: { type: "task_started", turn_id: "already-running" },
  })}\n`);
  const provider = createCodexProvider({
    codexHome: fixture.root, includeArchived: false, cacheMs: 0,
    writerPresence: fixture.writerPresence, now: () => now,
  });
  const initial = await provider.listSessions();
  assert.equal(initial.some((row) => row.localId === "older-resumed"), false);
  let catalog = initial;
  for (let pass = 0; pass < 10 && !catalog.some((row) => row.localId === "older-resumed"); pass += 1) {
    now += 10_000;
    catalog = await provider.listSessions({ fresh: true });
  }
  assert.equal(catalog.some((row) => row.localId === "older-resumed" && row.isLive), true);
});

function appThread(id, options = {}) {
  return {
    id,
    sessionId: id,
    parentThreadId: options.parentThreadId ?? null,
    preview: options.preview || "PROMPT_MUST_NOT_LEAK",
    ephemeral: false,
    createdAt: options.createdAt ?? 1_786_360_000,
    updatedAt: options.updatedAt ?? 1_786_360_100,
    source: options.source || "cli",
    cwd: options.cwd || "C:\\synthetic\\app-project",
    path: options.path || "C:\\PRIVATE_PATH_MUST_NOT_LEAK\\rollout.jsonl",
    gitInfo: { branch: options.branch || "codex/app-server" },
    name: options.name ?? "Explicit app-server title",
    agentNickname: options.agentNickname ?? null,
    agentRole: options.agentRole ?? null,
    status: { type: "notLoaded" },
    turns: options.turns || [{ items: [{ type: "userMessage", text: "PROMPT_MUST_NOT_LEAK" }] }],
  };
}

test("discovers Codex home from the stable environment override before the default", () => {
  assert.equal(
    resolveCodexHome({ homeDir: "C:\\fallback", env: { CODEX_HOME: "C:\\configured-codex" } }),
    path.resolve("C:\\configured-codex"),
  );
  assert.equal(resolveCodexHome({ homeDir: "C:\\fallback", env: {} }), path.resolve("C:\\fallback", ".codex"));
});

test("the bounded catalog retains a live session ahead of more recently updated history", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-catalog-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const history = Array.from({ length: 55 }, (_, index) => appThread(`history-${index}`, { updatedAt: 1_786_360_200 + index }));
  const live = { ...appThread("older-live", { updatedAt: 1_786_350_000 }), status: { type: "active", activeFlags: [] } };
  const provider = createCodexProvider({
    codexHome: root, includeArchived: false,
    appServer: { async listThreads() { return { data: [...history, live] }; } },
  });
  const catalog = await provider.listSessions();
  assert.equal(catalog.length, 50);
  assert.equal(catalog.some((row) => row.localId === "older-live" && row.isLive), true);
  assert.equal(catalog.at(-1).localId, "older-live", "selected rows retain recency ordering");
});

test("prefers safe app-server thread metadata and never exposes preview, turns, or rollout paths", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-app-server-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const active = appThread("app-thread");
  const archived = appThread("archived-thread", {
    name: "Archived explicit title",
    updatedAt: 1_786_350_000,
    branch: "codex/archived",
  });
  const child = appThread("child-thread", {
    parentThreadId: "app-thread",
    source: { subAgent: "review" },
    name: "Trace CLI title",
    agentNickname: "Erdos",
  });
  const appServer = {
    async listThreads(params) {
      calls.push({ method: "thread/list", params });
      return { data: params.archived ? [archived] : [active, child], nextCursor: null };
    },
    async readThread(params) {
      calls.push({ method: "thread/read", params });
      if (params.threadId === active.id) return { thread: active };
      return null;
    },
  };
  const provider = createCodexProvider({ codexHome: root, appServer, cacheMs: 0 });

  const catalog = await provider.listSessions();
  assert.deepEqual(catalog.map(({ localId, title, isLive, needsInput }) => ({ localId, title, isLive, needsInput })), [
    { localId: "app-thread", title: "Explicit app-server title", isLive: false, needsInput: false },
    { localId: "archived-thread", title: "Archived explicit title", isLive: false, needsInput: false },
  ]);
  assertNoPrivateFixtureSentinels(catalog, "Codex app-server catalog");
  assert.doesNotMatch(JSON.stringify(catalog), /preview|rollout\.jsonl|turns/);

  const evidence = await provider.readSession("app-thread", { historical: true });
  assert.equal(evidence.historical, true);
  assert.equal(evidence.session.title, "Explicit app-server title");
  assert.equal(evidence.session.project, "app-project");
  assert.equal(evidence.session.recordedGitBranch, "codex/app-server");
  assert.deepEqual(evidence.agents.map(({ id, parentId, assignment, label, kind, status }) => ({ id, parentId, assignment, label, kind, status })), [
    { id: "primary", parentId: null, assignment: null, label: "Primary agent", kind: "orchestrator", status: "idle" },
    { id: "agent-child-thread", parentId: "primary", assignment: "Trace CLI title", label: "Erdos", kind: "reviewer", status: "idle" },
  ]);
  assert.deepEqual(evidence.activity, []);
  assertNoPrivateFixtureSentinels(evidence, "Codex app-server evidence");
  assert.doesNotMatch(JSON.stringify(evidence), /preview|rollout\.jsonl|turns/);
  assert.equal(calls.some((call) => JSON.stringify(call) === JSON.stringify({
    method: "thread/read",
    params: { threadId: "app-thread", includeTurns: false },
  })), true);
});

test("uses bounded session-index and rollout-header fallbacks for active and archived history", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-fallback-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const parentFile = path.join(root, "sessions", "2026", "08", "10", "rollout-parent.jsonl");
  const archivedFile = path.join(root, "archived_sessions", "rollout-archived.jsonl");
  await writeRollout(parentFile, "codex/parent.jsonl", [["PRIVATE_PATH_MUST_NOT_LEAK", "synthetic"]]);
  await mkdir(path.dirname(archivedFile), { recursive: true });
  await writeFile(archivedFile, `${JSON.stringify({
    timestamp: "2026-08-09T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "codex-archived",
      timestamp: "2026-08-09T12:00:00.000Z",
      cwd: "C:\\synthetic\\archived-project",
      source: "vscode",
      git: { branch: "codex/recorded-archive" },
    },
  })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "PROMPT_MUST_NOT_LEAK" } })}\n`, "utf8");
  await utimes(parentFile, new Date("2026-08-10T14:00:00.000Z"), new Date("2026-08-10T14:00:00.000Z"));
  await utimes(archivedFile, new Date("2026-08-10T11:00:00.000Z"), new Date("2026-08-10T11:00:00.000Z"));
  await writeRollout(path.join(root, "sessions", "2026", "08", "10", "rollout-malformed.jsonl"), "codex/malformed.jsonl");
  await writeFile(path.join(root, "session_index.jsonl"), [
    "not-json",
    JSON.stringify({ id: "codex-fixture-parent", thread_name: "Old title", updated_at: "2026-08-10T13:00:01.000Z" }),
    JSON.stringify({ id: "missing-rollout", thread_name: "Missing session", updated_at: "2026-08-10T14:00:00.000Z" }),
    JSON.stringify({ id: "codex-archived", thread_name: "Archived fixture", updated_at: "2026-08-10T12:00:00.000Z" }),
    JSON.stringify({ id: "codex-fixture-parent", thread_name: "Synthetic Codex fixture", updated_at: "2026-08-10T15:00:00.000Z" }),
    "{",
  ].join("\n"), "utf8");

  const provider = createCodexProvider({ codexHome: root, cacheMs: 0, scanLimit: 20 });
  const catalog = await provider.listSessions();
  assert.deepEqual(catalog.map(({ localId, title, project }) => ({ localId, title, project })), [
    { localId: "codex-fixture-parent", title: "Synthetic Codex fixture", project: "repo" },
    { localId: "codex-archived", title: "Archived fixture", project: "archived-project" },
  ]);
  assert.equal(catalog.every((session) => !session.isLive && !session.needsInput), true);
  assert.equal(catalog.some((session) => session.localId === "missing-rollout"), false);

  const evidence = await provider.readSession("codex-fixture-parent", { historical: true });
  assert.equal(evidence.localId, "codex-fixture-parent");
  assert.equal(evidence.historical, true);
  assert.deepEqual(evidence.session, {
    title: "Synthetic Codex fixture",
    project: "repo",
    cwd: "C:\\synthetic\\repo",
    startedAt: "2026-08-10T13:00:00.000Z",
    updatedAt: "2026-08-10T13:00:16.000Z",
    recordedGitBranch: "codex/synthetic-fixture",
    cost: null,
    approvalMode: { id: "on_request", label: "On request", observedAt: "2026-08-10T13:00:01.000Z", source: "provider" },
    contextMachinery: null,
    summary: null,
    signal: null,
    progress: null,
    pomegrPlugin: {
      status: "active",
      version: "0.4.1",
      policyStatus: "valid",
      policyVersion: 7,
      observedAt: "2026-08-10T13:00:01.000Z",
    },
  });
  assertNoPrivateFixtureSentinels(evidence, "Codex rollout evidence");
  assert.doesNotMatch(JSON.stringify(evidence), /rollout-parent|parent\.jsonl/);
  assert.equal(await provider.readSession("missing-rollout", { historical: true }), null);
  assert.equal(await provider.readSession("../private", { historical: true }), null);
});

test("merges resumed fallback rollouts into one Codex catalog session", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-resumed-fallback-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions", "2026", "09", "04");
  const firstFile = path.join(sessionsRoot, "rollout-2026-09-04T19-03-20-duplicate-root.jsonl");
  const resumedFile = path.join(sessionsRoot, "rollout-2026-09-04T19-40-19-duplicate-root_resumed.jsonl");
  const record = (timestamp) => `${JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: {
      id: "duplicate-root",
      session_id: "duplicate-root",
      timestamp,
      cwd: "C:\\synthetic\\repo",
      source: "vscode",
    },
  })}\n`;
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(firstFile, record("2026-09-04T19:03:20.000Z"), "utf8");
  await writeFile(resumedFile, record("2026-09-04T19:40:19.000Z"), "utf8");
  await utimes(firstFile, new Date("2026-09-04T19:30:00.000Z"), new Date("2026-09-04T19:30:00.000Z"));
  await utimes(resumedFile, new Date("2026-09-04T19:50:00.000Z"), new Date("2026-09-04T19:50:00.000Z"));

  const provider = createCodexProvider({ codexHome: root, sessionsRoot: path.join(root, "sessions"), includeArchived: false, cacheMs: 0 });
  const catalog = await provider.listSessions();
  const discovered = mergeCodexMetadata(listCodexRolloutMetadata(path.join(root, "sessions")));

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].localId, "duplicate-root");
  assert.equal(catalog[0].createdAt, "2026-09-04T19:03:20.000Z");
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].rolloutFile, resumedFile);
});

test("normalizes source kinds internally while the registry keeps Codex IDs provider-qualified", async () => {
  const metadata = normalizeCodexThreadMetadata(appThread("source-thread", {
    source: { subAgent: { thread_spawn: { parent_thread_id: "parent-thread" } } },
    parentThreadId: "parent-thread",
  }));
  assert.equal(metadata.sourceKind, "subAgentThreadSpawn");
  assert.equal(metadata.provider, "codex");
  assert.equal(metadata.source, "Codex");

  const appServer = {
    async listThreads() { return { data: [appThread("qualified-thread")], nextCursor: null }; },
    async readThread({ threadId }) { return { thread: appThread(threadId) }; },
  };
  const registry = createProviderRegistry([createCodexProvider({ appServer, codexHome: os.tmpdir(), includeArchived: false })]);
  assert.deepEqual((await registry.listSessions()).map(({ id, provider, source }) => ({ id, provider, source })), [{
    id: "codex:qualified-thread",
    provider: "codex",
    source: "Codex",
  }]);
  assert.equal((await registry.readSession("codex:qualified-thread")).sessionId, "codex:qualified-thread");
});

test("a fresh Codex catalog read bypasses the short metadata cache after a new rollout appears", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-fresh-catalog-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions", "2026", "08", "29");
  const writeSyntheticRollout = async (id, timestamp) => {
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(path.join(sessionsRoot, `rollout-${id}.jsonl`), `${JSON.stringify({
      timestamp,
      type: "session_meta",
      payload: { id, session_id: id, cwd: "C:\\synthetic\\repo", source: "cli" },
    })}\n`, "utf8");
  };
  await writeSyntheticRollout("cached-one", "2026-08-29T12:00:00.000Z");
  const provider = createCodexProvider({
    codexHome: root,
    sessionsRoot: path.join(root, "sessions"),
    includeArchived: false,
    cacheMs: 60_000,
  });
  assert.deepEqual((await provider.listSessions()).map(({ localId }) => localId), ["cached-one"]);

  await writeSyntheticRollout("fresh-two", "2026-08-29T12:01:00.000Z");
  assert.deepEqual((await provider.listSessions()).map(({ localId }) => localId), ["cached-one"]);
  assert.deepEqual((await provider.listSessions({ fresh: true })).map(({ localId }) => localId), ["fresh-two", "cached-one"]);
});

test("does not promote session-index fallback text into an agent assignment", () => {
  const metadata = normalizeCodexThreadMetadata(appThread("indexed-child", {
    name: "",
    parentThreadId: "parent-thread",
    source: { subAgent: "review" },
  }), { indexName: "PROMPT_MUST_NOT_LEAK" });

  assert.equal(metadata.title, "PROMPT_MUST_NOT_LEAK");
  assert.equal(metadata.agentAssignment, null);
});

test("bounds the app-server catalog even when a provider returns more than requested", async () => {
  const appServer = {
    async listThreads({ archived }) {
      return { data: archived ? [] : [
        appThread("newest", { updatedAt: 1_786_360_300 }),
        appThread("middle", { updatedAt: 1_786_360_200 }),
        appThread("oldest", { updatedAt: 1_786_360_100 }),
      ], nextCursor: null };
    },
  };
  const provider = createCodexProvider({ appServer, codexHome: os.tmpdir(), includeArchived: false, catalogLimit: 2 });
  assert.deepEqual((await provider.listSessions()).map(({ localId }) => localId), ["newest", "middle"]);
});

test("deleted app-server sessions degrade to the existing safe missing-session selection", async () => {
  const appServer = {
    async listThreads() { return { data: [appThread("deleted-thread")], nextCursor: null }; },
    async readThread() { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); },
  };
  const provider = createCodexProvider({ appServer, codexHome: os.tmpdir(), includeArchived: false, cacheMs: 0 });
  const registry = createProviderRegistry([provider]);
  assert.equal(await provider.readSession("deleted-thread", { historical: true }), null);
  assert.equal(await registry.readSession("codex:deleted-thread"), null);
});
