import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";
import { assertNoPrivateFixtureSentinels, readProviderFixture } from "./helpers/provider-fixtures.mjs";

const AT = Date.parse("2026-08-11T18:00:00.000Z");

async function writeFixture(file, fixture) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await readProviderFixture(fixture), "utf8");
}

function appThread(id, options = {}) {
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
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-schemas-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions", "2026", "08", "11");
  await writeFixture(path.join(sessions, "rollout-schema-v1.jsonl"), "codex/schema-rollout-v1.jsonl");
  await writeFixture(path.join(sessions, "rollout-schema-v2.jsonl"), "codex/schema-rollout-v2.jsonl");

  const direct = appThread("app-schema-direct", {
    turns: [{ items: [{ type: "futureItem", content: "RESPONSE_MUST_NOT_LEAK" }] }],
  });
  const enveloped = appThread("app-schema-enveloped", {
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
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-failures-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions", "2026", "08", "11");
  await writeFixture(path.join(sessions, "rollout-schema-v1.jsonl"), "codex/schema-rollout-v1.jsonl");
  const rootThread = appThread("app-root");
  const missingChild = appThread("missing-child", {
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

test("multiple large live rollouts use one bounded read each and reuse provider caches", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-performance-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions", "2026", "08", "11");
  await mkdir(sessions, { recursive: true });
  const count = 8;
  const maximumTailBytes = 16 * 1024;
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
  });
  provider.qaStats(true);
  const first = await provider.readSession("large-root", { historical: false });
  const firstStats = provider.qaStats();
  assert.equal(first.agents.length, count);
  assert.equal(firstStats.reads, count);
  assert.equal(firstStats.bytes <= count * maximumTailBytes, true);
  assert.equal(firstStats.cacheEntries, count);

  await provider.readSession("large-root", { historical: false });
  const secondStats = provider.qaStats();
  assert.equal(secondStats.reads, firstStats.reads);
  assert.equal(secondStats.cacheHits >= count, true);

  await appendFile(path.join(sessions, "rollout-large-root.jsonl"), `\n${JSON.stringify({
    timestamp: new Date(AT + 3).toISOString(),
    type: "future_record",
    payload: { private: "TOOL_OUTPUT_MUST_NOT_LEAK" },
  })}\n`, "utf8");
  await provider.readSession("large-root", { historical: false });
  const thirdStats = provider.qaStats();
  assert.equal(thirdStats.reads, firstStats.reads + 1);
  assert.equal(thirdStats.bytes <= (count + 1) * maximumTailBytes, true);
});

test("concurrent catalog polls share one app-server request and one cache entry", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const thread = appThread("coalesced-catalog");
  const provider = createCodexProvider({
    codexHome: path.join(os.tmpdir(), "threadlight-codex-coalesced-missing"),
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
