import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { mergeCodexMetadata } from "../monitor/providers/codex-session-discovery.mjs";
import { listCodexRolloutMetadata, normalizeCodexThreadMetadata } from "../monitor/providers/codex-session-metadata.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";
import {
  assertNoPrivateFixtureSentinels,
  readProviderFixture,
} from "./helpers/provider-fixtures.mjs";

const AT = Date.parse("2026-08-11T18:00:00.000Z");

async function tempRoot(context, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeRollout(file, fixture, replacements = []) {
  let contents = await readProviderFixture(fixture);
  for (const [from, to] of replacements) contents = contents.replaceAll(from, to);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}

// Synthetic rollout: a session_meta header plus timestamped records. Recency is
// record time, never mtime, so `touch` aligns both when a test needs a stale file.
async function writeSyntheticRollout(file, id, { at = AT, sessionId, parentThreadId, forkedFromId, source = "cli", touch = false } = {}, records = []) {
  const timestamp = new Date(at).toISOString();
  const contents = [
    { timestamp, type: "session_meta", payload: {
      id,
      session_id: sessionId || id,
      ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
      ...(forkedFromId ? { forked_from_id: forkedFromId } : {}),
      source,
      cwd: "C:\\synthetic\\repo",
      timestamp,
    } },
    ...records.map((record, index) => ({ timestamp: new Date(at + index + 1).toISOString(), ...record })),
  ].map((record) => JSON.stringify(record)).join("\n");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
  if (touch) await utimes(file, new Date(at), new Date(at));
  return Buffer.byteLength(contents);
}

async function beyondDiscoveryWindow(context) {
  const root = await tempRoot(context, "pomegr-codex-discovery-window-");
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

test("the bounded catalog retains a live session ahead of more recently updated history", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-live-catalog-");
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
  const root = await tempRoot(context, "pomegr-codex-app-server-");
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
  assert.equal(evidence.session.project, "Unknown project");
  assert.equal(evidence.session.repositoryAttribution, "unknown");
  assert.equal(evidence.session.recordedGitBranch, "");
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

test("a known Codex app-server session bypasses a blocked global catalog sweep", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-selected-direct-");
  let releaseCatalog;
  const catalogBlocked = new Promise((resolve) => { releaseCatalog = resolve; });
  const thread = appThread("direct-selected", { turns: [] });
  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    appServer: {
      async listThreads(params) { return params.ancestorThreadId ? { data: [] } : catalogBlocked; },
      async readThread({ threadId }) { return { thread: { ...thread, id: threadId } }; },
    },
  });
  const globalRead = provider.listSessions();
  const selected = await Promise.race([
    provider.readSession("direct-selected", { historical: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("selected read waited for global catalog")), 250)),
  ]);
  assert.equal(selected?.localId, "direct-selected");
  releaseCatalog({ data: [] });
  await globalRead;
});

test("a retained rollout selection bypasses a blocked global Codex catalog sweep", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-selected-rollout-");
  const rollout = path.join(root, "sessions", "2026", "09", "27", "rollout-known-rollout.jsonl");
  await mkdir(path.dirname(rollout), { recursive: true });
  await writeFile(rollout, `${JSON.stringify({
    type: "session_meta", timestamp: "2026-09-27T12:00:00.000Z",
    payload: { id: "known-rollout", source: "cli", cwd: "C:\\synthetic\\repo" },
  })}\n`, "utf8");
  let blocked = false;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    appServer: {
      async listThreads() { return blocked ? wait : { data: [] }; },
      async readThread() { return null; },
    },
  });
  await provider.listSessions();
  blocked = true;
  const globalRead = provider.listSessions({ fresh: true });
  const selected = await Promise.race([
    provider.readSession("known-rollout", { historical: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("retained rollout waited for global catalog")), 250)),
  ]);
  assert.equal(selected?.localId, "known-rollout");
  release({ data: [] });
  await globalRead;
});

test("uses bounded session-index and rollout-header fallbacks for active and archived history", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-fallback-");
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
    { localId: "codex-fixture-parent", title: "Synthetic Codex fixture", project: "Unknown project" },
    { localId: "codex-archived", title: "Archived fixture", project: "Unknown project" },
  ]);
  assert.equal(catalog.every((session) => !session.isLive && !session.needsInput), true);
  assert.equal(catalog.some((session) => session.localId === "missing-rollout"), false);

  const evidence = await provider.readSession("codex-fixture-parent", { historical: true });
  assert.equal(evidence.localId, "codex-fixture-parent");
  assert.equal(evidence.historical, true);
  assert.deepEqual(evidence.session, {
    title: "Synthetic Codex fixture",
    project: "Unknown project",
    cwd: "C:\\synthetic\\repo",
    repositoryId: null,
    repositoryAttribution: "unknown",
    startedAt: "2026-08-10T13:00:00.000Z",
    updatedAt: "2026-08-10T13:00:16.000Z",
    recordedGitBranch: "",
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
  const root = await tempRoot(context, "pomegr-codex-resumed-fallback-");
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

test("a fresh Codex catalog read bypasses the short metadata cache after a new rollout appears", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-fresh-catalog-");
  const sessionsRoot = path.join(root, "sessions", "2026", "08", "29");
  // Catalog recency comes from file modification time, not the session header.
  const writeSession = (id, timestamp) => writeSyntheticRollout(path.join(sessionsRoot, `rollout-${id}.jsonl`), id, { at: Date.parse(timestamp), touch: true });
  await writeSession("cached-one", "2026-08-29T12:00:00.000Z");
  const provider = createCodexProvider({
    codexHome: root,
    sessionsRoot: path.join(root, "sessions"),
    includeArchived: false,
    cacheMs: 60_000,
  });
  assert.deepEqual((await provider.listSessions()).map(({ localId }) => localId), ["cached-one"]);

  await writeSession("fresh-two", "2026-08-29T12:01:00.000Z");
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

function qaThread(id, options = {}) {
  return {
    id,
    sessionId: options.sessionId || id,
    parentThreadId: options.parentThreadId || null,
    ephemeral: false,
    createdAt: AT / 1_000,
    updatedAt: (AT + 1_000) / 1_000,
    source: options.source || (options.parentThreadId
      ? { subAgent: { threadSpawn: { parentThreadId: options.parentThreadId } } }
      : "cli"),
    cwd: `C:\\synthetic\\${id}`,
    name: `Fixture ${id}`,
    status: options.status || { type: "notLoaded" },
    preview: "PROMPT_MUST_NOT_LEAK",
    turns: options.turns || [],
  };
}

test("two rollout and app-server compatibility shapes normalize without private or cumulative data", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-schemas-");
  const sessions = path.join(root, "sessions", "2026", "08", "11");
  await writeRollout(path.join(sessions, "rollout-schema-v1.jsonl"), "codex/schema-rollout-v1.jsonl");
  await writeRollout(path.join(sessions, "rollout-schema-v2.jsonl"), "codex/schema-rollout-v2.jsonl");

  const direct = qaThread("app-schema-direct", {
    turns: [{ items: [{ type: "futureItem", content: "RESPONSE_MUST_NOT_LEAK" }] }],
  });
  const enveloped = qaThread("app-schema-enveloped", {
    turns: [{ items: [{ type: "futureItem", output: "TOOL_OUTPUT_MUST_NOT_LEAK" }] }],
  });
  const directProvider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 0,
    appServer: {
      async listThreads() { return { data: [direct] }; },
      async readThread() { return { thread: direct }; },
    },
  });
  const envelopedProvider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 0,
    appServer: {
      async request(method) {
        if (method === "thread/list") return { result: { data: [enveloped] } };
        if (method === "thread/read") return { result: { thread: enveloped } };
        throw new Error("OAUTH_TOKEN_MUST_NOT_LEAK");
      },
    },
  });

  const fallbackProvider = createCodexProvider({ codexHome: root, includeArchived: false, cacheMs: 0 });
  const v1 = await fallbackProvider.readSession("schema-rollout-v1", { historical: true });
  const v2 = await fallbackProvider.readSession("schema-rollout-v2", { historical: true });
  assert.equal(v1.agents[0].model, "gpt-synthetic-v1");
  assert.equal(v2.agents[0].model, "gpt-synthetic-v2");
  assert.equal(v1.usageSnapshots.at(-1).input + v1.usageSnapshots.at(-1).cacheRead, 120);
  assert.equal(v2.usageSnapshots.at(-1).input + v2.usageSnapshots.at(-1).cacheRead, 240);
  assert.equal(v1.usageSnapshots.at(-1).totalTokens, 130);
  assert.equal(v2.usageSnapshots.at(-1).totalTokens, 260);
  assertNoPrivateFixtureSentinels([v1, v2], "rollout schema compatibility evidence");

  assert.equal((await directProvider.readSession(direct.id, { historical: true })).session.title, direct.name);
  assert.equal((await envelopedProvider.readSession(enveloped.id, { historical: true })).session.title, enveloped.name);
  assertNoPrivateFixtureSentinels(await directProvider.listSessions(), "direct app-server catalog");
  assertNoPrivateFixtureSentinels(await envelopedProvider.listSessions(), "enveloped app-server catalog");
});

test("missing child rollouts, unavailable app-server, malformed records, and deleted history fail independently", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-failures-");
  const sessions = path.join(root, "sessions", "2026", "08", "11");
  await writeRollout(path.join(sessions, "rollout-schema-v1.jsonl"), "codex/schema-rollout-v1.jsonl");
  const rootThread = qaThread("app-root");
  const missingChild = qaThread("missing-child", {
    sessionId: rootThread.id,
    parentThreadId: rootThread.id,
  });
  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 0,
    appServer: {
      async listThreads() { throw new Error("AUTH_FILE_MUST_NOT_LEAK"); },
      async readThread({ threadId }) {
        if (threadId === rootThread.id) return { thread: rootThread };
        if (threadId === missingChild.id) return { thread: missingChild };
        throw new Error("PRIVATE_PATH_MUST_NOT_LEAK");
      },
      async readRateLimits() { throw new Error("OAUTH_TOKEN_MUST_NOT_LEAK"); },
    },
  });
  const fallbackCatalog = await provider.listSessions();
  assert.deepEqual(fallbackCatalog.map(({ localId }) => localId), ["schema-rollout-v1"]);
  const fallbackEvidence = await provider.readSession("schema-rollout-v1", { historical: true });
  assert.equal(fallbackEvidence.agents.length, 1);
  assertNoPrivateFixtureSentinels(fallbackEvidence, "app-server fallback evidence");

  const missingChildProvider = createCodexProvider({
    codexHome: path.join(root, "missing-home"),
    includeArchived: false,
    cacheMs: 0,
    appServer: {
      async listThreads() { return { data: [rootThread, missingChild] }; },
      async readThread({ threadId }) {
        return { thread: threadId === rootThread.id ? rootThread : missingChild };
      },
    },
  });
  const evidence = await missingChildProvider.readSession(rootThread.id, { historical: true });
  assert.equal(evidence.agents.some((agent) => agent.id === `agent-${missingChild.id}`), true);
  assertNoPrivateFixtureSentinels(evidence, "missing child rollout evidence");

  const registry = createProviderRegistry([provider]);
  assert.equal(await registry.readSession("codex:deleted-history"), null);
  const limits = await provider.readUsageLimits();
  assert.equal(limits.error, "Codex usage limits are temporarily unavailable.");
  assertNoPrivateFixtureSentinels(limits, "usage failure");
});

test("fresh direct thread metadata wins catalog timestamp ties and trusted ancestor results seed descendants", async () => {
  const staleRoot = qaThread("fresh-root", {
    status: { type: "active", activeFlags: ["waitingOnUserInput"] },
  });
  const freshRoot = qaThread("fresh-root", { status: { type: "idle" } });
  const detachedChild = qaThread("ancestor-child", {
    source: { subAgent: "review" },
  });
  const unrelated = qaThread("unrelated-root");
  const provider = createCodexProvider({
    codexHome: path.join(os.tmpdir(), "pomegr-codex-fresh-tree-missing"),
    includeArchived: false,
    cacheMs: 10_000,
    appServer: {
      async listThreads(params) {
        return { data: params.ancestorThreadId ? [detachedChild] : [staleRoot, detachedChild, unrelated] };
      },
      async readThread({ threadId, includeTurns }) {
        const thread = threadId === freshRoot.id ? freshRoot : detachedChild;
        return { thread: { ...thread, ...(includeTurns ? { turns: [] } : {}) } };
      },
    },
  });
  await provider.listSessions();
  const evidence = await provider.readSession(freshRoot.id, { historical: false });
  assert.equal(evidence.agents.find((agent) => agent.id === "primary").status, "idle");
  assert.equal(evidence.agents.some((agent) => agent.id === `agent-${detachedChild.id}`), true);
  assert.equal(evidence.agents.some((agent) => agent.id === `agent-${unrelated.id}`), false);

  const ignoredFilterProvider = createCodexProvider({
    codexHome: path.join(os.tmpdir(), "pomegr-codex-ignored-ancestor-missing"),
    includeArchived: false,
    cacheMs: 10_000,
    appServer: {
      async listThreads() { return { data: [freshRoot, detachedChild, unrelated] }; },
      async readThread({ threadId, includeTurns }) {
        return { thread: { ...freshRoot, id: threadId, sessionId: threadId, ...(includeTurns ? { turns: [] } : {}) } };
      },
    },
  });
  const ignoredEvidence = await ignoredFilterProvider.readSession(freshRoot.id, { historical: true });
  assert.deepEqual(ignoredEvidence.agents.map((agent) => agent.id), ["primary"]);
});

test("fresh app-server descendants read authoritative in-home rollouts before the catalog cache refreshes", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-fresh-runtime-");
  const sessions = path.join(root, "sessions", "2026", "08", "11");
  await mkdir(sessions, { recursive: true });

  const contextRecord = (model, effort) => ({ type: "turn_context", payload: { model, effort } });
  const sessionRolloutFile = (id) => path.join(sessions, `rollout-${id}.jsonl`);

  const rootFile = sessionRolloutFile("authoritative-root");
  await writeSyntheticRollout(rootFile, "authoritative-root", {}, [contextRecord("gpt-parent", "medium")]);
  const rootThread = { ...qaThread("authoritative-root"), path: rootFile };
  let descendants = [];
  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 10_000,
    appServer: {
      async listThreads(params) {
        return { data: params.ancestorThreadId ? descendants : [rootThread] };
      },
      async readThread() { return { thread: rootThread }; },
    },
  });

  await provider.listSessions();

  const childOptions = {
    sessionId: rootThread.id,
    parentThreadId: rootThread.id,
    source: { subagent: { thread_spawn: { parent_thread_id: rootThread.id } } },
  };
  const childFile = sessionRolloutFile("authoritative-child");
  const outsideFile = path.join(root, "outside-rollout.jsonl");
  await writeSyntheticRollout(childFile, "authoritative-child", childOptions, [contextRecord("gpt-child-recorded", "high")]);
  await writeSyntheticRollout(outsideFile, "outside-child", childOptions, [contextRecord("gpt-outside-must-not-be-read", "ultra")]);
  const [childThread, outsideChild] = [["authoritative-child", childFile], ["outside-child", outsideFile]].map(([id, file]) => ({
    ...qaThread(id, { sessionId: rootThread.id, parentThreadId: rootThread.id }),
    path: file,
  }));
  descendants = [childThread, outsideChild];

  const evidence = await provider.readSession(rootThread.id, { historical: false });
  const child = evidence.agents.find((agent) => agent.id === `agent-${childThread.id}`);
  const rejected = evidence.agents.find((agent) => agent.id === `agent-${outsideChild.id}`);
  assert.equal(child.model, "gpt-child-recorded");
  assert.equal(child.effort, "high");
  assert.equal(rejected.model, "unknown");
  assert.equal(rejected.effort, "unspecified");
  assertNoPrivateFixtureSentinels(evidence, "fresh authoritative child runtime evidence");
  assert.doesNotMatch(JSON.stringify(evidence), /rollout-authoritative-child|gpt-outside-must-not-be-read/);
});

test("multiple large live rollouts use one bounded read each and reuse provider caches", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-performance-");
  const sessions = path.join(root, "sessions", "2026", "08", "11");
  await mkdir(sessions, { recursive: true });
  const count = 8;
  const maximumTailBytes = 16 * 1024;
  const maximumTaskHistoryBytes = 64 * 1024;
  const largePrivatePadding = "x".repeat(1_100_000);
  for (let index = 0; index < count; index += 1) {
    const id = index === 0 ? "large-root" : `large-child-${index}`;
    const payload = {
      id,
      session_id: "large-root",
      ...(index ? { parent_thread_id: "large-root", source: { subagent: { thread_spawn: { parent_thread_id: "large-root" } } } } : { source: "cli" }),
      cwd: "C:\\synthetic\\large-rollouts",
      timestamp: new Date(AT).toISOString(),
    };
    const records = [
      JSON.stringify({ timestamp: new Date(AT).toISOString(), type: "session_meta", payload }),
      JSON.stringify({ timestamp: new Date(AT + 1).toISOString(), type: "future_record", payload: { padding: largePrivatePadding } }),
      JSON.stringify({ timestamp: new Date(AT + 2).toISOString(), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10 + index, output_tokens: 1 } } } }),
      "{",
    ];
    await writeFile(path.join(sessions, `rollout-${id}.jsonl`), records.join("\n"), "utf8");
  }
  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 10_000,
    maximumStateTailBytes: maximumTailBytes,
    maximumTaskHistoryBytes,
  });
  provider.qaStats(true);
  const first = await provider.readSession("large-root", { historical: false });
  const firstStats = provider.qaStats();
  assert.equal(first.agents.length, count);
  assert.equal(firstStats.reads, count);
  assert.equal(firstStats.bytes <= count * maximumTailBytes, true);
  assert.equal(firstStats.taskHydrationReads, count);
  assert.equal(firstStats.taskHydrationBytes <= count * maximumTaskHistoryBytes, true);
  assert.equal(firstStats.cacheEntries, count);

  await provider.readSession("large-root", { historical: false });
  const secondStats = provider.qaStats();
  assert.equal(secondStats.reads, firstStats.reads);
  assert.equal(secondStats.cacheHits >= count, true);
  assert.equal(secondStats.taskHydrationReads, firstStats.taskHydrationReads);
  assert.equal(secondStats.taskHydrationBytes, firstStats.taskHydrationBytes);

  await appendFile(path.join(sessions, "rollout-large-root.jsonl"), `\n${JSON.stringify({
    timestamp: new Date(AT + 3).toISOString(),
    type: "future_record",
    payload: { private: "TOOL_OUTPUT_MUST_NOT_LEAK" },
  })}\n`, "utf8");
  await provider.readSession("large-root", { historical: false });
  const thirdStats = provider.qaStats();
  assert.equal(thirdStats.reads, firstStats.reads + 1);
  assert.equal(thirdStats.bytes <= (count + 1) * maximumTailBytes, true);
  assert.equal(thirdStats.taskHydrationReads, firstStats.taskHydrationReads);
});

test("selected session parsing ignores unrelated rollouts and follows collaboration-only descendants", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-selected-tree-");
  const sessions = path.join(root, "sessions", "2026", "08", "11");
  await mkdir(sessions, { recursive: true });
  const selectedContents = [];

  const writeTree = (id, metadata = {}, records = []) => writeSyntheticRollout(path.join(sessions, `rollout-${id}.jsonl`), id, { ...metadata, touch: true }, records);

  selectedContents.push(await writeTree("selected-root", {}, [
    { type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "spawn-detached", arguments: JSON.stringify({ task_name: "detached-child" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "spawn-detached", output: JSON.stringify({ agent_id: "detached-child" }) } },
  ]));
  selectedContents.push(await writeTree("session-child", {
    sessionId: "selected-root",
    source: { subagent: "review" },
  }));
  selectedContents.push(await writeTree("parent-child", {
    parentThreadId: "selected-root",
    source: { subagent: { thread_spawn: { parent_thread_id: "selected-root" } } },
  }));
  selectedContents.push(await writeTree("fork-grandchild", {
    forkedFromId: "parent-child",
    source: "fork",
  }));
  selectedContents.push(await writeTree("detached-child", {
    source: { subagent: "review" },
  }, [
    { type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "spawn-nested", arguments: JSON.stringify({ task_name: "detached-nested" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "spawn-nested", output: JSON.stringify({ agent_id: "detached-nested" }) } },
  ]));
  selectedContents.push(await writeTree("detached-nested", {
    source: { subagent: "review" },
  }));
  for (let index = 0; index < 80; index += 1) {
    const id = `unrelated-${String(index).padStart(3, "0")}`;
    await writeTree(id, { at: AT - 10 * 60_000 }, [
      { type: "future_record", payload: { padding: "x".repeat(8_192) } },
    ]);
  }

  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 10_000,
    scanLimit: 100,
    maximumTailBytes: 1_024,
    now: () => AT + 60_000,
  });
  await provider.listSessions();
  const catalogStats = provider.qaStats();
  assert.equal(catalogStats.livenessRolloutFiles, selectedContents.length);
  assert.equal(catalogStats.livenessRolloutBytes <= selectedContents.length * 1_024, true);
  provider.qaStats(true);
  const evidence = await provider.readSession("selected-root", { historical: true });
  const firstStats = provider.qaStats();
  assert.deepEqual(new Set(evidence.agents.map((agent) => agent.id)), new Set([
    "primary",
    "agent-session-child",
    "agent-parent-child",
    "agent-fork-grandchild",
    "agent-detached-child",
    "agent-detached-nested",
  ]));
  assert.equal(firstStats.reads, selectedContents.length);
  assert.equal(firstStats.bytes, selectedContents.reduce((total, bytes) => total + bytes, 0));
  assert.equal(firstStats.cacheEntries, selectedContents.length);

  await provider.readSession("selected-root", { historical: true });
  const secondStats = provider.qaStats();
  assert.equal(secondStats.reads, firstStats.reads);
  assert.equal(secondStats.bytes, firstStats.bytes);
  assert.equal(secondStats.cacheHits, selectedContents.length);
});

test("concurrent catalog polls share one app-server request and one cache entry", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const thread = qaThread("coalesced-catalog");
  const provider = createCodexProvider({
    codexHome: path.join(os.tmpdir(), "pomegr-codex-coalesced-missing"),
    includeArchived: false,
    cacheMs: 10_000,
    appServer: {
      async listThreads() {
        calls += 1;
        await gate;
        return { data: [thread] };
      },
      async readThread() { return { thread }; },
    },
  });
  const polls = Array.from({ length: 12 }, () => provider.listSessions());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const catalogs = await Promise.all(polls);
  assert.equal(catalogs.every((catalog) => catalog[0]?.localId === thread.id), true);
  await provider.listSessions();
  assert.equal(calls, 1);
});
