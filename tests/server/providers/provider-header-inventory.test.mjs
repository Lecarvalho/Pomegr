import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeProvider } from "../../../server/providers/claude/index.mjs";
import { createCodexProvider } from "../../../server/providers/codex/index.mjs";
import { findCodexRolloutFamily } from "../../../server/providers/codex/session-metadata.mjs";

async function collect(provider) {
  const rows = [];
  const result = await provider.enumerateSessionHeaders({
    async onBatch(batch) {
      assert.ok(batch.length <= 100, "provider batches stay bounded");
      rows.push(...batch);
    },
  });
  return { result, rows };
}

test("Claude enumerates every top-level header in bounded batches without transcript hydration", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-headers-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projects = path.join(root, "projects", "project");
  await mkdir(path.join(projects, "subagents"), { recursive: true });
  await Promise.all(Array.from({ length: 125 }, (_, index) => writeFile(
    path.join(projects, `claude-${String(index).padStart(3, "0")}.jsonl`),
    `${JSON.stringify({ sessionId: `claude-${String(index).padStart(3, "0")}`, type: "user" })}\nTRANSCRIPT_BODY_MUST_NOT_BE_READ\n`,
  )));
  await writeFile(path.join(projects, "subagents", "child.jsonl"), "{}\n");
  const provider = createClaudeProvider({ claudeProjectsDir: path.join(root, "projects"), claudeConfigDir: root, registryRoot: path.join(root, "registry") });
  const { result, rows } = await collect(provider);
  assert.deepEqual(result, { complete: true });
  assert.equal(rows.length, 125);
  assert.equal(rows.some((row) => row.localId === "child"), false);
  assert.equal(rows.every((row) => row.title === "Untitled session" && row.project === "Unknown project"), true);
  assert.equal(rows.every((row) => !row.isLive && row.activityStatus === "idle"), true, "Claude headers carry the adapter non-live fallback");
});

test("Claude keeps enumerating past an empty transcript but reports the scan incomplete", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-empty-header-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, "projects", "a-project"), later = path.join(root, "projects", "b-project");
  await mkdir(first, { recursive: true });
  await mkdir(later, { recursive: true });
  await writeFile(path.join(first, "empty-session.jsonl"), "");
  await writeFile(path.join(later, "later-session.jsonl"), `${JSON.stringify({ sessionId: "later-session", type: "user" })}\n`);
  const provider = createClaudeProvider({ claudeProjectsDir: path.join(root, "projects"), claudeConfigDir: root, registryRoot: path.join(root, "registry") });
  const { result, rows } = await collect(provider);
  assert.deepEqual(result, { complete: false }, "an incomplete scan never prunes committed rows");
  assert.deepEqual(rows.map((row) => row.localId), ["later-session"]);
});

test("Claude includes a configured transcript outside its projects root", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-explicit-header-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const explicit = path.join(root, "external", "explicit-session.jsonl");
  const projects = path.join(root, "projects");
  await mkdir(projects, { recursive: true });
  await mkdir(path.dirname(explicit), { recursive: true });
  await writeFile(explicit, `${JSON.stringify({ sessionId: "explicit-session", type: "user" })}\n`);
  const provider = createClaudeProvider({
    claudeProjectsDir: projects, claudeConfigDir: root,
    registryRoot: path.join(root, "registry"), explicitSession: explicit,
  });
  const { result, rows } = await collect(provider);
  assert.deepEqual(result, { complete: true });
  assert.equal(rows.some((row) => row.localId === "explicit-session"), true);
});

test("Codex enumerates more than 500 rollout headers, including archive, without using the bounded catalog", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-headers-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions", "2026", "09", "27");
  const archived = path.join(root, "archived_sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(archived, { recursive: true });
  const write = (directory, id) => writeFile(path.join(directory, `rollout-${id}.jsonl`), `${JSON.stringify({
    type: "session_meta", timestamp: "2026-09-27T12:00:00.000Z",
    payload: { id, source: "cli", cwd: "C:\\synthetic\\repo" },
  })}\n${"BODY_MUST_NOT_BE_PARSED".repeat(20_000)}`);
  for (let offset = 0; offset < 550; offset += 50) {
    await Promise.all(Array.from({ length: 50 }, (_, index) => write(sessions, `header-${String(offset + index).padStart(3, "0")}`)));
  }
  await write(archived, "archived-header");
  let blockCatalog = false;
  let releaseCatalog;
  const catalogBlocked = new Promise((resolve) => { releaseCatalog = resolve; });
  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: true,
    catalogLimit: 50,
    appServer: {
      async listThreads() { return blockCatalog ? catalogBlocked : { data: [] }; },
      async readThread() { return null; },
    },
  });
  const { result, rows } = await collect(provider);
  assert.deepEqual(result, { complete: true });
  assert.equal(rows.length, 551);
  assert.equal(rows.some((row) => row.localId === "archived-header"), true);
  assert.equal(rows.every((row) => row.activityStatus === "unknown"), true, "Codex headers record no root status");
  assert.equal((await provider.listSessions()).length <= 50, true, "live shell remains bounded");
  blockCatalog = true;
  const globalRead = provider.listSessions({ fresh: true });
  const selected = await Promise.race([
    provider.readSession("header-000", { historical: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("inventory-selected rollout waited for global catalog")), 1_500)),
  ]);
  assert.equal(selected?.localId, "header-000", "an inventory row outside the retained 500 hydrates directly");
  releaseCatalog({ data: [] });
  await globalRead;
});

test("Codex selected family retains shared-session children and rejects overflow", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-family-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions");
  await mkdir(sessions, { recursive: true });
  const write = (name, payload) => writeFile(path.join(sessions, name), `${JSON.stringify({ type: "session_meta", payload })}\n`);
  await write("rollout-a-child.jsonl", { id: "child", session_id: "stable", source: { subAgent: "review" } });
  await write("rollout-z-root.jsonl", { id: "root", session_id: "stable", source: "cli" });
  const family = await findCodexRolloutFamily([{ root: sessions, archived: false }], "root");
  assert.deepEqual(family.map((item) => item.localId).sort(), ["child", "root"]);
  for (let index = 0; index < 501; index += 1) await write(`rollout-overflow-${index}.jsonl`, { id: `overflow-${index}`, parent_thread_id: "overflow-root", source: "sub_agent" });
  await write("rollout-overflow-root.jsonl", { id: "overflow-root", source: "cli" });
  await assert.rejects(findCodexRolloutFamily([{ root: sessions, archived: false }], "overflow-root"), /selected_family_limit/);
});
