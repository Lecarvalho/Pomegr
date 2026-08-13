import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexProvider, resolveCodexHome } from "../monitor/providers/codex.mjs";
import { normalizeCodexThreadMetadata } from "../monitor/providers/codex-session-metadata.mjs";
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
  const child = appThread("child-thread", { parentThreadId: "app-thread", source: { subAgent: "review" } });
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
  assert.deepEqual(evidence.agents.map(({ id, parentId, label, kind, status }) => ({ id, parentId, label, kind, status })), [
    { id: "primary", parentId: null, label: "Primary agent", kind: "orchestrator", status: "idle" },
    { id: "agent-child-thread", parentId: "primary", label: "Unnamed subagent", kind: "reviewer", status: "idle" },
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
  });
  assertNoPrivateFixtureSentinels(evidence, "Codex rollout evidence");
  assert.doesNotMatch(JSON.stringify(evidence), /rollout-parent|parent\.jsonl/);
  assert.equal(await provider.readSession("missing-rollout", { historical: true }), null);
  assert.equal(await provider.readSession("../private", { historical: true }), null);
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
