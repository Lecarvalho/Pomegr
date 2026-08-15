import assert from "node:assert/strict";
import test from "node:test";
import { defineProvider } from "../monitor/providers/provider-contract.mjs";
import { providerRegistry } from "../monitor/providers/index.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";

function provider(id, sessions, reads = new Map(), calls = []) {
  return defineProvider({
    id,
    source: id === "claude" ? "Claude Code" : "Codex",
    capabilities: { liveSessions: true, needsInput: true },
    async listSessions() { return sessions; },
    async readSession(localId, options) {
      calls.push({ id, localId, options });
      const value = reads.get(localId);
      if (value instanceof Error) throw value;
      return value || null;
    },
  });
}

function session(localId, updatedAt, options = {}) {
  return {
    localId,
    title: options.title || localId,
    project: options.project || "pomegr",
    updatedAt,
    isLive: options.isLive ?? true,
    needsInput: options.needsInput ?? false,
    ...(options.resourceOwner ? { resourceOwner: options.resourceOwner } : {}),
  };
}

function evidence(localId, historical = false) {
  return { localId, historical };
}

test("merges provider catalogs with qualified IDs and deterministic ordering", async () => {
  const claude = provider("claude", [
    session("claude-old", "2026-08-10T10:00:00.000Z"),
    session("claude-tie", "2026-08-10T12:00:00.000Z"),
    session("../unsafe", "2026-08-10T13:00:00.000Z"),
  ]);
  const codex = provider("codex", [
    { ...session("codex-new", "2026-08-10T13:00:00.000Z"), privatePath: "PRIVATE_PATH_MUST_NOT_LEAK" },
    session("codex-tie", "2026-08-10T12:00:00.000Z"),
  ]);
  const registry = createProviderRegistry([claude, codex]);

  const catalog = await registry.listSessions();
  assert.deepEqual(catalog.map(({ id }) => id), [
    "codex:codex-new",
    "claude:claude-tie",
    "codex:codex-tie",
    "claude:claude-old",
  ]);
  assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE_PATH_MUST_NOT_LEAK|localId|providerIndex/);
});

test("keeps resource ownership internal while classifying live inspection targets", async () => {
  const uniqueOwner = { pid: 101, processStartIdentity: "unique-start" };
  const sharedOwner = { pid: 202, processStartIdentity: "shared-start" };
  const registry = createProviderRegistry([
    provider("claude", [
      session("unique", "2026-08-10T15:00:00.000Z", { resourceOwner: uniqueOwner }),
      session("shared-a", "2026-08-10T14:00:00.000Z", { resourceOwner: sharedOwner }),
      session("missing", "2026-08-10T12:00:00.000Z"),
      session("history", "2026-08-10T11:00:00.000Z", { isLive: false, resourceOwner: uniqueOwner }),
    ], new Map([
      ["unique", evidence("unique")],
      ["shared-a", evidence("shared-a")],
    ])),
    provider("codex", [
      session("shared-b", "2026-08-10T13:00:00.000Z", { resourceOwner: sharedOwner }),
      session("invalid", "2026-08-10T10:00:00.000Z", {
        resourceOwner: { pid: 303, processStartIdentity: "unsafe identity" },
      }),
    ], new Map()),
  ]);

  const inspected = await registry.inspectSessions();
  assert.deepEqual(inspected.resourceTargets, [
    { sessionId: "claude:unique", pid: 101, processStartIdentity: "unique-start" },
    { sessionId: "claude:shared-a", status: "shared" },
    { sessionId: "codex:shared-b", status: "shared" },
    { sessionId: "claude:missing", status: "unavailable" },
    { sessionId: "codex:invalid", status: "unavailable" },
  ]);
  assert.equal(inspected.sessions.some(({ id }) => id === "claude:history"), true);
  assert.equal(inspected.resourceTargets.some(({ sessionId }) => sessionId === "claude:history"), false);
  assert.doesNotMatch(JSON.stringify(inspected.sessions), /resourceOwner|processStartIdentity|\"pid\"/);

  const catalog = await registry.listSessions();
  const selected = await registry.readSession("claude:unique");
  assert.doesNotMatch(JSON.stringify(catalog), /resourceOwner|processStartIdentity|\"pid\"/);
  assert.doesNotMatch(JSON.stringify(selected), /resourceOwner|processStartIdentity|\"pid\"/);
});

test("automatic selection prefers needs-input, then live recency, then history", async () => {
  const calls = [];
  const claudeReads = new Map([
    ["claude-input", evidence("claude-input")],
    ["claude-history", evidence("claude-history", true)],
  ]);
  const codexReads = new Map([["codex-new", evidence("codex-new")]]);
  const registry = createProviderRegistry([
    provider("claude", [
      session("claude-input", "2026-08-10T10:00:00.000Z", { needsInput: true }),
      session("claude-history", "2026-08-10T14:00:00.000Z", { isLive: false }),
    ], claudeReads, calls),
    provider("codex", [session("codex-new", "2026-08-10T13:00:00.000Z")], codexReads, calls),
  ]);

  const selected = await registry.readSession();
  assert.equal(selected.sessionId, "claude:claude-input");
  assert.deepEqual(calls, [{ id: "claude", localId: "claude-input", options: { historical: false } }]);

  const recentRegistry = createProviderRegistry([
    provider("claude", [session("claude-old", "2026-08-10T10:00:00.000Z")], new Map([["claude-old", evidence("claude-old")]])),
    provider("codex", [session("codex-new", "2026-08-10T13:00:00.000Z")], codexReads),
  ]);
  assert.equal((await recentRegistry.readSession()).sessionId, "codex:codex-new");

  const historyRegistry = createProviderRegistry([
    provider("claude", [session("claude-history", "2026-08-10T14:00:00.000Z", { isLive: false })], claudeReads),
    provider("codex", [], new Map()),
  ]);
  const historical = await historyRegistry.readSession();
  assert.equal(historical.sessionId, "claude:claude-history");
  assert.equal(historical.evidence.historical, true);
});

test("explicit selection routes only qualified safe IDs to their owning provider", async () => {
  const calls = [];
  const registry = createProviderRegistry([
    provider("claude", [], new Map(), calls),
    provider("codex", [], new Map([["thread-1", evidence("thread-1", true)]]), calls),
  ]);

  const selected = await registry.readSession("codex:thread-1");
  assert.equal(selected.sessionId, "codex:thread-1");
  assert.deepEqual(calls, [{ id: "codex", localId: "thread-1", options: { historical: true } }]);

  for (const unsafe of ["thread-1", "unknown:thread-1", "codex:../private", "codex:C:\\private\\thread.jsonl", "codex:thread:child"]) {
    assert.equal(await registry.readSession(unsafe), null);
  }
  assert.equal(calls.length, 1);
});

test("explicit live selection stays live and a failed automatic provider falls through", async () => {
  const explicitCalls = [];
  const explicitRegistry = createProviderRegistry([
    provider(
      "claude",
      [session("live", "2026-08-10T12:00:00.000Z")],
      new Map([["live", evidence("live")]]),
      explicitCalls,
    ),
    provider("codex", [], new Map()),
  ]);
  assert.equal((await explicitRegistry.readSession("claude:live")).sessionId, "claude:live");
  assert.deepEqual(explicitCalls, [{ id: "claude", localId: "live", options: { historical: false } }]);

  const fallbackRegistry = createProviderRegistry([
    provider(
      "claude",
      [session("broken", "2026-08-10T13:00:00.000Z", { needsInput: true })],
      new Map([["broken", new Error("private provider failure")]]),
    ),
    provider(
      "codex",
      [session("healthy", "2026-08-10T12:00:00.000Z")],
      new Map([["healthy", evidence("healthy")]]),
    ),
  ]);
  assert.equal((await fallbackRegistry.readSession()).sessionId, "codex:healthy");
});

test("provider failures degrade independently during catalog and automatic selection", async () => {
  const broken = defineProvider({
    id: "claude",
    source: "Claude Code",
    capabilities: {},
    async listSessions() { throw new Error("private provider failure"); },
    async readSession() { throw new Error("private provider failure"); },
  });
  const codex = provider(
    "codex",
    [session("healthy", "2026-08-10T12:00:00.000Z")],
    new Map([["healthy", evidence("healthy")]]),
  );
  const registry = createProviderRegistry([broken, codex]);

  assert.deepEqual((await registry.listSessions()).map(({ id }) => id), ["codex:healthy"]);
  assert.equal((await registry.readSession()).sessionId, "codex:healthy");
});

test("coalesces only concurrent catalog reads", async () => {
  let catalogCalls = 0;
  let releaseCatalog;
  const catalogReady = new Promise((resolve) => { releaseCatalog = resolve; });
  const codex = defineProvider({
    id: "codex",
    source: "Codex",
    capabilities: { liveSessions: true },
    async listSessions() {
      catalogCalls += 1;
      await catalogReady;
      return [session("live", "2026-08-10T12:00:00.000Z")];
    },
    async readSession(localId) { return evidence(localId); },
  });
  const registry = createProviderRegistry([codex]);

  const listed = registry.listSessions();
  const selected = registry.readSession("codex:live");
  await Promise.resolve();
  assert.equal(catalogCalls, 1);
  releaseCatalog();

  assert.deepEqual((await listed).map(({ id }) => id), ["codex:live"]);
  assert.equal((await selected).sessionId, "codex:live");
  await registry.listSessions();
  assert.equal(catalogCalls, 2);
});

test("explicit reads refresh the catalog before deciding historical state", async () => {
  let catalogCalls = 0;
  let sessions = [session("changing", "2026-08-10T12:00:00.000Z")];
  const readCalls = [];
  const codex = defineProvider({
    id: "codex",
    source: "Codex",
    capabilities: { liveSessions: true },
    async listSessions() {
      catalogCalls += 1;
      return sessions;
    },
    async readSession(localId, options) {
      readCalls.push({ localId, options });
      return evidence(localId, options.historical);
    },
  });
  const registry = createProviderRegistry([codex]);

  await registry.listSessions();
  sessions = [session("changing", "2026-08-10T12:01:00.000Z", { isLive: false })];
  const historical = await registry.readSession("codex:changing");
  assert.equal(catalogCalls, 2);
  assert.equal(historical.evidence.historical, true);

  sessions = [];
  const deleted = await registry.readSession("codex:changing");
  assert.equal(catalogCalls, 3);
  assert.equal(deleted.evidence.historical, true);
  assert.deepEqual(readCalls.map(({ options }) => options), [
    { historical: true },
    { historical: true },
  ]);
});

test("production registry loads Claude and Codex through the provider registry", () => {
  assert.deepEqual(providerRegistry.providers.map(({ id }) => id), ["claude", "codex"]);
});
