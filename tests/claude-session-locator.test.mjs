import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeSessionLocator, isClaudeSessionFileLive } from "../monitor/providers/claude-session-locator.mjs";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";

async function tempFile(t, name, contents) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-locator-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, name);
  await writeFile(file, contents);
  return { root, file };
}

test("locate() resolves a file the last index() call recorded", async (t) => {
  const { file } = await tempFile(t, "session-one.jsonl", "{}\n");
  const locator = createClaudeSessionLocator();
  locator.index([{ file }]);
  assert.equal(locator.locate("session-one"), file);
});

test("locate() misses for a session that was never indexed", () => {
  const locator = createClaudeSessionLocator();
  assert.equal(locator.locate("never-seen"), null);
});

test("locate() falls back to a miss and forgets the entry once the file is gone", async (t) => {
  const { file } = await tempFile(t, "session-two.jsonl", "{}\n");
  const locator = createClaudeSessionLocator();
  locator.index([{ file }]);
  assert.equal(locator.locate("session-two"), file);
  fs.unlinkSync(file);
  assert.equal(locator.locate("session-two"), null, "a deleted main file is a miss, not a stale path returned anyway");
  // Re-indexing after the file is restored must work again (the stale entry was actually dropped).
  fs.writeFileSync(file, "{}\n");
  locator.index([{ file }]);
  assert.equal(locator.locate("session-two"), file);
});

test("locate() falls back to a miss when the file at the same path has been replaced", async (t) => {
  const { root, file } = await tempFile(t, "session-three.jsonl", "{}\n");
  const locator = createClaudeSessionLocator();
  locator.index([{ file }]);
  assert.equal(locator.locate("session-three"), file);
  // Renaming a different, independently created file onto the same path guarantees
  // a new file identity there, unlike an ordinary append which keeps the same one.
  const replacement = path.join(root, "session-three.jsonl.new");
  fs.writeFileSync(replacement, "{}\n{}\n");
  fs.renameSync(replacement, file);
  assert.equal(locator.locate("session-three"), null, "a same-path replacement is a stale entry, not an ordinary append");
});

test("index() bounds its retained entries", async (t) => {
  const { root } = await tempFile(t, "seed.jsonl", "{}\n");
  const locator = createClaudeSessionLocator();
  const files = [];
  for (let index = 0; index < 4_200; index += 1) {
    const file = path.join(root, `session-${index}.jsonl`);
    fs.writeFileSync(file, "{}\n");
    files.push({ file });
  }
  locator.index(files);
  assert.ok(locator.size() <= 4_096);
});

test("index() keeps discovery's newest copy of a duplicated session ID and evicts the oldest sessions first", async (t) => {
  const { root } = await tempFile(t, "seed.jsonl", "{}\n");
  fs.mkdirSync(path.join(root, "newer"));
  fs.mkdirSync(path.join(root, "older"));
  const newer = path.join(root, "newer", "shared-id.jsonl");
  const older = path.join(root, "older", "shared-id.jsonl");
  fs.writeFileSync(newer, "{}\n");
  fs.writeFileSync(older, "{}\n");
  const locator = createClaudeSessionLocator();
  // Discovery order: newest activity first.
  locator.index([{ file: newer }, { file: older }]);
  assert.equal(locator.locate("shared-id"), newer);

  const files = [];
  for (let index = 0; index < 4_200; index += 1) {
    const file = path.join(root, `session-${index}.jsonl`);
    fs.writeFileSync(file, "{}\n");
    files.push({ file });
  }
  locator.index(files);
  assert.equal(locator.locate("session-0"), files[0].file, "the newest session survives eviction");
  assert.equal(locator.locate("session-4199"), null, "the oldest sessions are evicted first");
});

test("isClaudeSessionFileLive matches liveSessionFiles' rules for one file: explicit, registered, closed, and activity-based", async (t) => {
  const { root, file } = await tempFile(t, "live-check.jsonl", "{}\n");
  const agentDir = path.join(root, "no-subagents");

  // An explicit session is live only when it is the selected file.
  assert.equal(isClaudeSessionFileLive(file, { explicitFile: file, agentDir }), true);
  assert.equal(isClaudeSessionFileLive(file, { explicitFile: path.join(root, "other.jsonl"), agentDir }), false);

  // A registered session is always live, even with old activity.
  const old = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(file, old, old);
  assert.equal(isClaudeSessionFileLive(file, { registrySessionIds: ["live-check"], agentDir, nowMs: Date.now() }), true);

  // A closed session is never live.
  assert.equal(isClaudeSessionFileLive(file, { closedSessionIds: new Set(["live-check"]), agentDir, nowMs: Date.now() }), false);

  // Otherwise, recent activity on the main file makes it live.
  const recent = new Date();
  fs.utimesSync(file, recent, recent);
  assert.equal(isClaudeSessionFileLive(file, { agentDir, nowMs: Date.now() }), true);
  fs.utimesSync(file, old, old);
  assert.equal(isClaudeSessionFileLive(file, { agentDir, nowMs: Date.now() }), false);

  // Recent activity on a subagent file under the session's own tree also counts.
  await mkdir(agentDir, { recursive: true });
  const subagent = path.join(agentDir, "agent-child.jsonl");
  fs.writeFileSync(subagent, "{}\n");
  assert.equal(isClaudeSessionFileLive(file, { agentDir, nowMs: Date.now() }), true);
});

test("a readSession for a known session performs no projects-tree walk and matches the full-discovery evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-locator-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, ".claude", "projects");
  const projectDir = path.join(projectsRoot, "fixture-project");
  await mkdir(projectDir, { recursive: true });
  const record = (text) => `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: text } })}\n`;
  const file = path.join(projectDir, "known-session.jsonl");
  await writeFile(file, record("hello"));
  // A second, unrelated session makes the projects-tree walk this test forbids a real one.
  const otherDir = path.join(projectsRoot, "other-project");
  await mkdir(otherDir, { recursive: true });
  await writeFile(path.join(otherDir, "other-session.jsonl"), record("hello"));

  const frozenNow = Date.now();
  const provider = createClaudeProvider({
    homeDir: root, env: {}, now: () => frozenNow,
    usageRequest: async () => { throw new Error("usage limits are not exercised by this fixture"); },
  });
  const full = await provider.readSession("known-session");
  assert.ok(full, "the first read discovers the session through full discovery and warms the locator");

  const readdirSync = fs.readdirSync;
  const visitedDirectories = [];
  const spy = t.mock.method(fs, "readdirSync", (dir, ...rest) => {
    visitedDirectories.push(path.resolve(String(dir)));
    return readdirSync(dir, ...rest);
  });
  let fast;
  try {
    fast = await provider.readSession("known-session");
  } finally {
    spy.mock.restore();
  }

  assert.equal(visitedDirectories.includes(path.resolve(projectsRoot)), false,
    "a known session must resolve its file from the locator index, not a fresh projects-tree walk");
  assert.deepStrictEqual(fast, full);
});

test("a deleted or replaced main file falls back to full discovery instead of serving a stale path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-locator-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, ".claude", "projects");
  const projectDir = path.join(projectsRoot, "fixture-project");
  await mkdir(projectDir, { recursive: true });
  const record = (text) => `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: text } })}\n`;
  const file = path.join(projectDir, "known-session.jsonl");
  await writeFile(file, record("hello"));

  const provider = createClaudeProvider({
    homeDir: root, env: {},
    usageRequest: async () => { throw new Error("usage limits are not exercised by this fixture"); },
  });
  assert.ok(await provider.readSession("known-session"), "warms the locator index");

  fs.unlinkSync(file);
  assert.equal(await provider.readSession("known-session"), null, "a deleted main file is not silently reused");

  await writeFile(file, record("hello again"));
  const rediscovered = await provider.readSession("known-session");
  assert.ok(rediscovered, "the session is rediscovered through full discovery once its file exists again");

  const replacement = `${file}.new`;
  await writeFile(replacement, record("first") + record("second"));
  fs.renameSync(replacement, file);
  const afterReplacement = await provider.readSession("known-session");
  assert.ok(afterReplacement, "a same-path replacement is not served from the stale cached identity");
  assert.equal(afterReplacement.activity.length, 2);
});
