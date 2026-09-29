import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isClaudeSessionFileLive } from "../../../../server/normalize/session-discovery.mjs";
import { claudeSourceLedgerHeader, createClaudeSessionResolver, ingestClaudeDiscovery, parseClaudeSessionLedgerHeader } from "../../../../server/providers/claude/session-ledger.mjs";
import { createSourceLedger } from "../../../../server/providers/kernel/source-ledger.mjs";
import { createClaudeSourceEventRouter } from "../../../../server/providers/claude/source-routing.mjs";
import { createClaudeProvider } from "../../../../server/providers/claude/index.mjs";

async function tempFile(t, name, contents = "{}\n") {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-session-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, name);
  await writeFile(file, contents);
  return { root, file };
}

test("claudeSourceLedgerHeader names the identity from the file's own basename with no relations", async (t) => {
  const { file } = await tempFile(t, "session-one.jsonl");
  const header = claudeSourceLedgerHeader(file, 1234);
  assert.equal(header.localId, "session-one");
  assert.equal(header.parentId, null);
  assert.equal(header.forkedFromId, null);
  assert.equal(header.groupId, null);
  assert.equal(header.archived, false);
  assert.equal(header.preference, 1234);
});

test("parseClaudeSessionLedgerHeader confirms existence with one stat and no read", async (t) => {
  const { file } = await tempFile(t, "session-two.jsonl", "not valid json at all");
  const header = parseClaudeSessionLedgerHeader(file);
  assert.equal(header.localId, "session-two");
  assert.equal(typeof header.preference, "number");
});

test("parseClaudeSessionLedgerHeader rejects a missing file and an unsafe basename", async (t) => {
  const { root } = await tempFile(t, "seed.jsonl");
  assert.equal(parseClaudeSessionLedgerHeader(path.join(root, "missing.jsonl")), null);
  const unsafe = path.join(root, "bad id!.jsonl");
  fs.writeFileSync(unsafe, "{}\n");
  assert.equal(parseClaudeSessionLedgerHeader(unsafe), null);
});

function ledgerFor(options = {}) {
  return createSourceLedger({ parseHeader: parseClaudeSessionLedgerHeader, maxEntries: 4_096, ...options });
}

test("resolver locates a ledger-known session with no discovery call", async (t) => {
  const { file } = await tempFile(t, "known-session.jsonl");
  const ledger = ledgerFor();
  ledger.ingestHeaders([{ file, header: claudeSourceLedgerHeader(file, 1000) }]);
  let discoverCalls = 0;
  const resolve = createClaudeSessionResolver({
    ledger,
    discover: () => { discoverCalls += 1; return { files: [], liveFile: null, liveFiles: new Set(), registry: new Map(), closedSessionIds: new Set() }; },
    readRegistry: () => ({ registry: new Map(), closedSessionIds: new Set() }),
    explicitFile: () => null, registryAvailable: () => false, now: () => Date.now(),
    selectFile: () => null,
  });
  const resolved = resolve("known-session");
  assert.equal(resolved.mainFile, file);
  assert.equal(discoverCalls, 0, "a ledger-known session must not trigger a discovery pass");
});

test("resolver falls back to discovery for an unknown ID and remembers the miss", async (t) => {
  const ledger = ledgerFor({ now: () => 1000, missTtlMs: 60_000 });
  let discoverCalls = 0;
  const resolve = createClaudeSessionResolver({
    ledger,
    discover: () => { discoverCalls += 1; return { files: [], liveFile: null, liveFiles: new Set(), registry: new Map(), closedSessionIds: new Set() }; },
    readRegistry: () => ({ registry: new Map(), closedSessionIds: new Set() }),
    explicitFile: () => null, registryAvailable: () => false, now: () => 1000,
    selectFile: () => null,
  });
  assert.equal(resolve("never-seen"), null);
  assert.equal(discoverCalls, 1);
  // Inside the miss TTL, a repeated read for the same unknown ID must not walk again.
  assert.equal(resolve("never-seen"), null);
  assert.equal(discoverCalls, 1, "a recently missed ID must not trigger a second discovery pass");
});

test("a notification that ingests a previously-missed ID clears the miss", async () => {
  const ledger = ledgerFor({ now: () => 1000, missTtlMs: 60_000 });
  ledger.rememberMiss("cleared-by-notice");
  assert.equal(ledger.recentMiss("cleared-by-notice"), true);
  ledger.ingestHeaders([{ file: null, header: { localId: "cleared-by-notice" } }]);
  assert.equal(ledger.recentMiss("cleared-by-notice"), false, "ingesting the identity clears its remembered miss");
});

test("resolver falls back to full discovery when the ledger's file is deleted, not a stale path", async (t) => {
  const { file } = await tempFile(t, "gone.jsonl");
  const ledger = ledgerFor();
  ledger.ingestHeaders([{ file, header: claudeSourceLedgerHeader(file, 1000) }]);
  fs.unlinkSync(file);
  let discoverCalls = 0;
  const resolve = createClaudeSessionResolver({
    ledger,
    discover: () => { discoverCalls += 1; return { files: [], liveFile: null, liveFiles: new Set(), registry: new Map(), closedSessionIds: new Set() }; },
    readRegistry: () => ({ registry: new Map(), closedSessionIds: new Set() }),
    explicitFile: () => null, registryAvailable: () => false, now: () => Date.now(),
    selectFile: () => null,
  });
  assert.equal(resolve("gone"), null);
  assert.equal(discoverCalls, 1, "a stale ledger entry must fall through to discovery, not a remembered-miss short-circuit");
  assert.equal(resolve("gone"), null);
  assert.equal(discoverCalls, 1, "the miss that discovery recorded stops a second walk inside the TTL");
});

test("duplicated IDs across two folders keep the newer activity copy regardless of ingestion order", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-session-ledger-dup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "newer"), { recursive: true });
  await mkdir(path.join(root, "older"), { recursive: true });
  const newer = path.join(root, "newer", "shared-id.jsonl");
  const older = path.join(root, "older", "shared-id.jsonl");
  fs.writeFileSync(newer, "{}\n");
  fs.writeFileSync(older, "{}\n");
  for (const order of [[[newer, 2000], [older, 1000]], [[older, 1000], [newer, 2000]]]) {
    const ledger = ledgerFor();
    for (const [file, activityMs] of order) ledger.ingestHeaders([{ file, header: claudeSourceLedgerHeader(file, activityMs) }]);
    assert.equal(ledger.locate("shared-id").file, newer, `newest activity wins for order ${order.map(([f]) => f).join(" -> ")}`);
  }
});

test("eviction under the entry bound keeps a live session and drops a non-live one first", () => {
  const ledger = ledgerFor({ maxEntries: 3 });
  ledger.ingestHeaders([{ file: null, header: claudeSourceLedgerHeader("/a.jsonl", 1) }]);
  ledger.ingestHeaders([{ file: null, header: claudeSourceLedgerHeader("/b.jsonl", 2) }]);
  ledger.ingestHeaders([{ file: null, header: claudeSourceLedgerHeader("/c.jsonl", 3) }]);
  ledger.markLive(["a"]);
  ledger.ingestHeaders([{ file: null, header: claudeSourceLedgerHeader("/d.jsonl", 4) }]);
  assert.ok(ledger.locate("a"), "the live session survives eviction");
  assert.equal(ledger.locate("b"), null, "the least recently touched non-live session is evicted first");
  assert.ok(ledger.locate("c"));
  assert.ok(ledger.locate("d"));
});

test("a discovery pass over the entry bound keeps the newest sessions and evicts the oldest", () => {
  const ledger = ledgerFor({ maxEntries: 3 });
  // Discovery order: newest activity first.
  const files = [["/e.jsonl", 5], ["/d.jsonl", 4], ["/c.jsonl", 3], ["/b.jsonl", 2], ["/a.jsonl", 1]].map(([file, activityMs]) => ({ file, activityMs }));
  ingestClaudeDiscovery(ledger, files);
  ingestClaudeDiscovery(ledger, files);
  for (const id of ["e", "d", "c"]) assert.ok(ledger.locate(id), `newest session ${id} stays indexed`);
  for (const id of ["b", "a"]) assert.equal(ledger.locate(id), null, `oldest session ${id} is evicted`);
});

test("isClaudeSessionFileLive matches liveSessionFiles' rules for one file: explicit, registered, closed, and activity-based", async (t) => {
  const { root, file } = await tempFile(t, "live-check.jsonl");
  const agentDir = path.join(root, "no-subagents");

  assert.equal(isClaudeSessionFileLive(file, { explicitFile: file, agentDir }), true);
  assert.equal(isClaudeSessionFileLive(file, { explicitFile: path.join(root, "other.jsonl"), agentDir }), false);

  const old = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(file, old, old);
  assert.equal(isClaudeSessionFileLive(file, { registrySessionIds: ["live-check"], agentDir, nowMs: Date.now() }), true);

  assert.equal(isClaudeSessionFileLive(file, { closedSessionIds: new Set(["live-check"]), agentDir, nowMs: Date.now() }), false);

  const recent = new Date();
  fs.utimesSync(file, recent, recent);
  assert.equal(isClaudeSessionFileLive(file, { agentDir, nowMs: Date.now() }), true);
  fs.utimesSync(file, old, old);
  assert.equal(isClaudeSessionFileLive(file, { agentDir, nowMs: Date.now() }), false);

  await mkdir(agentDir, { recursive: true });
  const subagent = path.join(agentDir, "agent-child.jsonl");
  fs.writeFileSync(subagent, "{}\n");
  assert.equal(isClaudeSessionFileLive(file, { agentDir, nowMs: Date.now() }), true);
});

// --- Provider round trip: createClaudeProvider now resolves selected sessions through the
// shared source ledger instead of the removed claude-session-locator.mjs.

test("a readSession for a known session performs no projects-tree walk and matches the full-discovery evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-ledger-provider-"));
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
  assert.ok(full, "the first read discovers the session through full discovery and warms the ledger");

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
    "a known session must resolve its file from the ledger, not a fresh projects-tree walk");
  assert.deepStrictEqual(fast, full);
});

test("a deleted or replaced main file falls back to full discovery instead of serving a stale path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-ledger-fallback-"));
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
  assert.ok(await provider.readSession("known-session"), "warms the ledger");

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

test("an unknown session ID is not walked again inside the ledger's remembered-miss window", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-ledger-miss-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, ".claude", "projects");
  const projectDir = path.join(projectsRoot, "fixture-project");
  await mkdir(projectDir, { recursive: true });
  const record = (text) => `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: text } })}\n`;
  await writeFile(path.join(projectDir, "other-session.jsonl"), record("hello"));

  const provider = createClaudeProvider({
    homeDir: root, env: {},
    usageRequest: async () => { throw new Error("usage limits are not exercised by this fixture"); },
  });
  assert.equal(await provider.readSession("never-seen-session"), null, "the first read walks and finds nothing");

  const readdirSync = fs.readdirSync;
  let visits = 0;
  const spy = t.mock.method(fs, "readdirSync", (dir, ...rest) => {
    visits += 1;
    return readdirSync(dir, ...rest);
  });
  try {
    assert.equal(await provider.readSession("never-seen-session"), null);
  } finally {
    spy.mock.restore();
  }
  assert.equal(visits, 0, "a repeated read for a recently-missed unknown ID must not walk the projects tree again");
});

test("readSessionHistory for a known session performs no projects-tree walk", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-ledger-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, ".claude", "projects");
  const projectDir = path.join(projectsRoot, "fixture-project");
  await mkdir(projectDir, { recursive: true });
  const record = (text) => `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: text } })}\n`;
  await writeFile(path.join(projectDir, "known-session.jsonl"), record("hello"));
  const provider = createClaudeProvider({
    homeDir: root, env: {},
    usageRequest: async () => { throw new Error("usage limits are not exercised by this fixture"); },
  });
  assert.ok(await provider.readSession("known-session"), "warms the ledger");

  const readdirSync = fs.readdirSync;
  const visited = [];
  const spy = t.mock.method(fs, "readdirSync", (dir, ...rest) => {
    visited.push(path.resolve(String(dir)));
    return readdirSync(dir, ...rest);
  });
  try {
    await provider.readSessionHistory("known-session");
    await provider.readSessionHistory("known-session");
  } finally {
    spy.mock.restore();
  }
  assert.equal(visited.includes(path.resolve(projectsRoot)), false, "history keys resolve the main file through the ledger");
});

// --- Notification routing: claude-source-routing.mjs notices a trusted main-transcript
// path in the ledger, the same shape as Codex's realpath-contained rollout filter.

test("a filtered new-transcript notification reaches the ledger and clears a remembered miss", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-source-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const projectDir = path.join(projectsRoot, "fixture-project");
  await mkdir(projectDir, { recursive: true });
  const file = path.join(projectDir, "noticed-session.jsonl");
  await writeFile(file, "{}\n");

  const ledger = createSourceLedger({ parseHeader: parseClaudeSessionLedgerHeader, maxEntries: 4_096 });
  ledger.rememberMiss("noticed-session");
  assert.equal(ledger.recentMiss("noticed-session"), true);

  const route = createClaudeSourceEventRouter(projectsRoot, { ledger });
  await route({ candidate: file, eventType: "change" });

  assert.equal(ledger.recentMiss("noticed-session"), false, "a trusted main-transcript notification clears the remembered miss");
  assert.equal(ledger.locate("noticed-session")?.file, file);
});

test("a subagent-tree notification never reaches the ledger as a main-session identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-source-routing-subagent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const agentDir = path.join(projectsRoot, "fixture-project", "known-session", "subagents");
  await mkdir(agentDir, { recursive: true });
  const agentFile = path.join(agentDir, "agent-child.jsonl");
  await writeFile(agentFile, "{}\n");

  const ledger = createSourceLedger({ parseHeader: parseClaudeSessionLedgerHeader, maxEntries: 4_096 });
  const route = createClaudeSourceEventRouter(projectsRoot, { ledger });
  await route({ candidate: agentFile, eventType: "change" });

  assert.equal(ledger.locate("agent-child"), null, "a subagent file must never become a ledger-indexed session identity");
  assert.equal(ledger.locate("known-session"), null, "the router must not fabricate a main-file entry from a subagent notification");
});

test("an escaping realpath (a symlink/junction resolving outside the projects root) never reaches the ledger", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-source-routing-escape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const outside = path.join(root, "outside");
  await mkdir(projectsRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  const realFile = path.join(outside, "escaping-session.jsonl");
  await writeFile(realFile, "{}\n");
  const candidate = path.join(projectsRoot, "escaping-session.jsonl");
  try {
    fs.symlinkSync(realFile, candidate, "file");
  } catch (error) {
    // Windows without symlink rights: the junction test below covers containment.
    t.skip(`platform cannot create a file symlink here: ${error.code || error.message}`);
    return;
  }

  const ledger = createSourceLedger({ parseHeader: parseClaudeSessionLedgerHeader, maxEntries: 4_096 });
  const route = createClaudeSourceEventRouter(projectsRoot, { ledger });
  await route({ candidate, eventType: "change" });

  assert.equal(ledger.locate("escaping-session"), null, "a realpath that escapes the projects root must never reach the ledger");
});

test("a junction inside the projects root that escapes it never reaches the ledger", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-source-routing-junction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const outside = path.join(root, "outside");
  await mkdir(projectsRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "junction-session.jsonl"), "{}\n");
  const linked = path.join(projectsRoot, "linked-project");
  fs.symlinkSync(outside, linked, "junction");

  const ledger = createSourceLedger({ parseHeader: parseClaudeSessionLedgerHeader, maxEntries: 4_096 });
  const route = createClaudeSourceEventRouter(projectsRoot, { ledger });
  await route({ candidate: path.join(linked, "junction-session.jsonl"), eventType: "change" });

  assert.equal(ledger.locate("junction-session"), null, "a junction that escapes the projects root must never reach the ledger");
});

test("a failed projects-root realpath is retried on the next notification", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-source-routing-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const ledger = createSourceLedger({ parseHeader: parseClaudeSessionLedgerHeader, maxEntries: 4_096 });
  const route = createClaudeSourceEventRouter(projectsRoot, { ledger });
  const file = path.join(projectsRoot, "fixture-project", "late-session.jsonl");
  await route({ candidate: file, eventType: "rename" });
  assert.equal(ledger.locate("late-session"), null, "nothing is noticed before the root exists");

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{}\n");
  await route({ candidate: file, eventType: "change" });
  assert.equal(ledger.locate("late-session")?.file, file, "the root is resolved again once it exists");
});
