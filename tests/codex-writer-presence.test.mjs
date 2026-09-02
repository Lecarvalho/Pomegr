import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { createCodexWriterPresence, queryCodexWriterOwners, readCodexWriterLock, resolveCodexWriterExecutables } from "../monitor/providers/codex-writer-presence.mjs";

// Native operations are mocked; fixtures use host paths even when simulating win32.
const root = path.resolve("test-writer-locks");
const executable = path.resolve("test-native", "codex.exe");
const lockPath = (id) => path.join(root, `${id}.lock`);
function thread(localId, extra = {}) { return { localId, ...extra }; }
function fixture(overrides = {}) {
  let clock = 10_000; const locks = new Map(); const calls = { query: 0, yields: 0 };
  const presence = createCodexWriterPresence({ writerLocksRoot: root, platform: "win32", now: () => clock,
    readLock(file) { return locks.get(file) || { state: "missing" }; },
    resolveExecutables: () => [executable],
    async queryOwners(files) { calls.query += 1; return files.map((_file, index) => ({ index, pid: 44 + index, processStartIdentity: `${9000 + index}` })); },
    yieldFn: async () => { calls.yields += 1; }, ...overrides });
  return { presence, locks, calls, setClock(value) { clock = value; }, lock(id, state = "held", identity = `id-${id}`) { locks.set(lockPath(id), { state, identity }); } };
}

test("confirms only stable held locks with one validated owner and prunes missing, unlocked, archived, and unsafe candidates", async () => {
  const value = fixture(); value.lock("good"); value.lock("unlocked", "unlocked"); value.lock("archived");
  await value.presence.refresh([thread("good"), thread("unlocked"), thread("archived", { archived: true }), thread("../../unsafe")]);
  assert.deepEqual(value.presence.current("good"), { pid: 44, processStartIdentity: "9000" });
  assert.equal(value.presence.current("unlocked"), null); assert.equal(value.presence.current("archived"), null);
  await value.presence.refresh([]); value.setClock(16_000); await value.presence.refresh([]);
  assert.equal(value.presence.current("good"), null);
});

test("fails closed on query errors, invalid owners, replacement races, permission failures, timeout, and clock regression", async () => {
  let phase = "valid"; let identitySequence = 0; const value = fixture({
    readLock(file) { if (phase === "permission") return { state: "unavailable" }; if (phase === "race") return { state: "held", identity: file.endsWith("race.lock") ? `race-${++identitySequence}` : "x" }; return { state: "held", identity: "stable" }; },
    async queryOwners() { if (phase === "error") throw new Error("private"); if (phase === "invalid") return [{ index: 0, pid: 0, processStartIdentity: "bad" }]; return [{ index: 0, pid: 55, processStartIdentity: "991" }]; },
  });
  for (const next of ["valid", "error", "invalid", "race", "permission"]) { phase = next; value.presence.invalidate(); await value.presence.refresh([thread("race")]); assert.equal(value.presence.current("race") !== null, next === "valid", next); }
  phase = "valid"; value.presence.invalidate(); await value.presence.refresh([thread("race")]); value.setClock(9_000); assert.equal(value.presence.current("race"), null);
  await value.presence.refresh([thread("race")]); assert.equal(value.presence.current("race"), null);
});

test("bounds candidates, yields every 32 probes, deduplicates concurrent refreshes, and caches repeated failures", async () => {
  let release; const waiting = new Promise((resolve) => { release = resolve; }); let queries = 0; let queriedFiles = 0;
  const value = fixture({ async queryOwners(files) { queries += 1; queriedFiles = files.length; await waiting; return files.map((_file, index) => ({ index, pid: index + 1, processStartIdentity: "10" })); } });
  const threads = Array.from({ length: 600 }, (_value, index) => thread(`s${index}`)); for (const item of threads) value.lock(item.localId);
  const first = value.presence.refresh(threads); const second = value.presence.refresh(threads); release(); await Promise.all([first, second]);
  assert.equal(queries, 1); assert.equal(queriedFiles, 500); assert.equal(value.calls.yields, 15); assert.match(String(value.presence.current("s499")?.pid), /^\d+$/);
  await value.presence.refresh(threads); assert.equal(queries, 1);
});

test("uses completion time for the same-request cooldown after a slow owner query", async () => {
  let clock = 1_000; let queries = 0; let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const presence = createCodexWriterPresence({ writerLocksRoot: root, platform: "win32", now: () => clock,
    readLock: () => ({ state: "held", identity: "stable" }), resolveExecutables: () => [executable],
    async queryOwners() { queries += 1; if (queries === 1) await blocked; return [{ index: 0, pid: 9, processStartIdentity: "9" }]; },
  });
  const first = presence.refresh([thread("same")]);
  clock += 5_001;
  const repeated = presence.refresh([thread("same")]);
  release();
  await Promise.all([first, repeated]);
  assert.equal(queries, 1, "a queued identical refresh must use the completion cooldown");
  assert.deepEqual(presence.current("same"), { pid: 9, processStartIdentity: "9" });
  clock += 5_001;
  await presence.refresh([thread("same")]);
  assert.equal(queries, 2);
});

test("keeps owner health anchored to probe start when the helper completes late", async () => {
  let clock = 1_000; let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const presence = createCodexWriterPresence({ writerLocksRoot: root, platform: "win32", now: () => clock,
    readLock: () => ({ state: "held", identity: "stable" }), resolveExecutables: () => [executable],
    async queryOwners() { await blocked; return [{ index: 0, pid: 9, processStartIdentity: "9" }]; },
  });
  const pending = presence.refresh([thread("late")]);
  clock += 30_001;
  release();
  await pending;
  assert.equal(presence.current("late"), null, "helper completion must not renew the owner observation age");
});

test("native lock reader never treats permission or non-file evidence as held", () => {
  const base = { openSync: () => 3, closeSync() {}, fstatSync: () => ({ isFile: () => true, dev: 1n, ino: 2n, birthtimeNs: 3n }) };
  assert.deepEqual(readCodexWriterLock("x", { fs: { ...base, readSync() { throw Object.assign(new Error(), { code: "EBUSY" }); } } }), { state: "held", identity: "1:2:3" });
  assert.equal(readCodexWriterLock("x", { fs: { ...base, readSync() { throw Object.assign(new Error(), { code: "EACCES" }); } } }).state, "unavailable");
});

test("executable discovery includes only explicit trusted CLI and bounded official Desktop installs", () => {
  const local = path.resolve("test-local");
  const desktop = path.join(local, "OpenAI", "Codex", "bin", "0.152.1-abcd", "codex.exe");
  const cli = path.resolve("test-bin", "codex.exe");
  const files = new Set([desktop, cli]); const fs = { statSync(file) { if (!files.has(file)) throw new Error("missing"); return { isFile: () => true, mode: 0o755 }; }, readdirSync() { return [{ name: "0.152.1-abcd", isDirectory: () => true }]; } };
  const result = resolveCodexWriterExecutables({ platform: "win32", fs, env: { LOCALAPPDATA: local, Path: path.dirname(cli) }, cwd: path.resolve("test-work") });
  assert.deepEqual(result, [cli.toLowerCase(), desktop.toLowerCase()]);
});

test("owner query is unavailable outside Windows without spawning", async () => {
  let spawned = false;
  assert.deepEqual(await queryCodexWriterOwners([lockPath("a")], [executable], { platform: "linux", spawnFn() { spawned = true; } }), []);
  assert.equal(spawned, false);
});

test("unsupported platforms retain no cached owner and perform no filesystem or native query", async () => {
  let reads = 0; let queries = 0;
  const presence = createCodexWriterPresence({ platform: "darwin", writerLocksRoot: root,
    readLock() { reads += 1; return { state: "held", identity: "private" }; },
    queryOwners() { queries += 1; return []; },
  });
  await presence.refresh([thread("known")]);
  assert.equal(reads, 0); assert.equal(queries, 0); assert.equal(presence.current("known"), null);
});

test("failed refreshes are cached briefly and confirmed presence expires without another probe", async () => {
  let clock = 1_000; let queries = 0; let allowOwner = false;
  const presence = createCodexWriterPresence({ platform: "win32", writerLocksRoot: root, now: () => clock,
    readLock: () => ({ state: "held", identity: "same" }), resolveExecutables: () => [executable],
    async queryOwners() { queries += 1; return allowOwner ? [{ index: 0, pid: 17, processStartIdentity: "123" }] : []; },
  });
  await presence.refresh([thread("stale")]); await presence.refresh([thread("stale")]);
  assert.equal(queries, 1); assert.equal(presence.current("stale"), null);
  clock += 5_001; allowOwner = true; await presence.refresh([thread("stale")]);
  assert.deepEqual(presence.current("stale"), { pid: 17, processStartIdentity: "123" });
  clock += 30_001; assert.equal(presence.current("stale"), null);
});

test("native owner query accepts only bounded structured output from one asynchronous process", async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.end = () => queueMicrotask(() => {
    // ConvertTo-Json historically unwraps one pipeline item.  The parser must
    // still conservatively accept this exact bounded single-owner shape.
    child.stdout.emit("data", '{"index":0,"pid":73,"processStartIdentity":"100"}'); child.emit("close", 0);
  });
  let calls = 0;
  const owners = await queryCodexWriterOwners([lockPath("a"), lockPath("b")], [executable], {
    platform: "win32", spawnFn(command, args, options) {
      calls += 1; assert.match(command, /powershell\.exe$/i); assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
      assert.deepEqual(options, { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"] }); return child;
    },
  });
  assert.equal(calls, 1); assert.deepEqual(owners, [{ index: 0, pid: 73, processStartIdentity: "100" }]);
});

test("native owner query times out without exposing process output", async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.end = () => {}; child.kill = () => { child.killed = true; };
  const owners = await queryCodexWriterOwners([lockPath("a")], [executable], { platform: "win32", timeoutMs: 1, spawnFn: () => child });
  assert.deepEqual(owners, []); assert.equal(child.killed, true);
});

test("native owner query cancellation terminates its one helper before resolving", async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.end = () => {};
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null, "SIGTERM")); };
  const controller = new AbortController();
  const pending = queryCodexWriterOwners([lockPath("a")], [executable], { platform: "win32", signal: controller.signal, spawnFn: () => child });
  controller.abort();
  assert.deepEqual(await pending, []); assert.equal(child.killed, true);
});

test("a changed candidate set prunes immediately, bypasses the short acquisition cache, and never republishes removed owners", async () => {
  let queries = 0; let release; const blocked = new Promise((resolve) => { release = resolve; });
  const value = fixture({ async queryOwners(files) {
    queries += 1;
    if (queries === 2) await blocked;
    return files.map((_file, index) => ({ index, pid: 90 + index, processStartIdentity: "77" }));
  } });
  value.lock("a"); value.lock("b");
  await value.presence.refresh([thread("a")]); assert.notEqual(value.presence.current("a"), null);
  const pending = value.presence.refresh([thread("b")]);
  assert.equal(value.presence.current("a"), null, "removed rows are pruned before the next query completes");
  release(); await pending;
  assert.equal(queries, 2); assert.notEqual(value.presence.current("b"), null);
});

test("keeps a fresh accepted map during a pending reconciliation but clears it on completed ambiguity", async () => {
  let phase = 0; let release; const blocked = new Promise((resolve) => { release = resolve; });
  const value = fixture({ async queryOwners() {
    phase += 1;
    if (phase === 2) { await blocked; return [{ index: 0, pid: 2, processStartIdentity: "2" }, { index: 0, pid: 3, processStartIdentity: "3" }]; }
    return [{ index: 0, pid: 1, processStartIdentity: "1" }];
  } });
  value.lock("a"); await value.presence.refresh([thread("a")]); value.setClock(15_001);
  const pending = value.presence.refresh([thread("a")]);
  assert.deepEqual(value.presence.current("a"), { pid: 1, processStartIdentity: "1" });
  release(); await pending; assert.equal(value.presence.current("a"), null);
});

test("notifies only effective owner-map changes, including immediate losses", async () => {
  let clock = 1_000; let held = true;
  const presence = createCodexWriterPresence({ writerLocksRoot: root, platform: "win32", now: () => clock,
    readLock: () => held ? { state: "held", identity: "stable" } : { state: "missing" },
    resolveExecutables: () => [executable],
    async queryOwners() { return [{ index: 0, pid: 8, processStartIdentity: "8" }]; },
  });
  const notifications = [];
  const unsubscribe = presence.subscribe((...args) => { notifications.push(args); });
  await presence.refresh([thread("a")]);
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0], [], "private notification exposes no owner data");
  await presence.refresh([thread("a")]);
  assert.equal(notifications.length, 1, "cache hits do not notify");
  clock += 5_001;
  await presence.refresh([thread("a")]);
  assert.equal(notifications.length, 1, "timestamp-only refreshes do not notify");
  presence.invalidate();
  assert.equal(notifications.length, 2, "invalidation immediately reports confirmed-owner loss");
  await presence.refresh([thread("a")]);
  assert.equal(notifications.length, 3);
  held = false; clock += 5_001;
  await presence.refresh([thread("a")]);
  assert.equal(notifications.length, 4, "a completed negative scan reports owner loss");
  unsubscribe();
  held = true; clock += 5_001;
  await presence.refresh([thread("a")]);
  assert.equal(notifications.length, 4, "unsubscribe detaches the private listener");
});

test("notifies when a same owner returns after health expiry, but not for ordinary or doubly-expired refreshes", async () => {
  let clock = 1_000; let releaseSlow = null; let slow = false;
  const presence = createCodexWriterPresence({ writerLocksRoot: root, platform: "win32", now: () => clock,
    readLock: () => ({ state: "held", identity: "stable" }), resolveExecutables: () => [executable],
    queryOwners() {
      if (!slow) return Promise.resolve([{ index: 0, pid: 8, processStartIdentity: "8" }]);
      return new Promise((resolve) => { releaseSlow = () => resolve([{ index: 0, pid: 8, processStartIdentity: "8" }]); });
    },
  });
  let notifications = 0;
  presence.subscribe(() => { notifications += 1; });
  await presence.refresh([thread("a")]);
  assert.equal(notifications, 1);
  clock += 5_001;
  await presence.refresh([thread("a")]);
  assert.equal(notifications, 1, "a same-owner refresh within health age stays silent");
  clock += 30_001;
  assert.equal(presence.current("a"), null);
  await presence.refresh([thread("a")]);
  assert.equal(notifications, 2, "a same owner becoming healthy again wakes lifecycle publication");
  slow = true; clock += 5_001;
  const pending = presence.refresh([thread("a")]);
  while (!releaseSlow) await new Promise((resolve) => setImmediate(resolve));
  clock += 30_001;
  releaseSlow();
  await pending;
  assert.equal(presence.current("a"), null);
  assert.equal(notifications, 2, "a same owner that is expired both before and after refresh stays silent");
});

test("invalidation bursts retain one latest follow-up without cancelling the active helper", async () => {
  let resolveFirst; let queries = 0; let activeSignal;
  const firstOwner = new Promise((resolve) => { resolveFirst = resolve; });
  const value = fixture({ queryOwners(_files, _executables, signal) {
    queries += 1;
    if (queries === 1) { activeSignal = signal; return firstOwner; }
    return Promise.resolve([{ index: 0, pid: 9, processStartIdentity: "9" }]);
  } });
  value.lock("a");
  const pending = value.presence.refresh([thread("a")]);
  while (!activeSignal) await new Promise((resolve) => setImmediate(resolve));
  for (let count = 0; count < 4; count += 1) {
    value.presence.invalidate();
    void value.presence.refresh([thread("a")]);
  }
  assert.equal(activeSignal.aborted, false, "ordinary invalidation must not repeatedly kill the helper");
  resolveFirst([{ index: 0, pid: 8, processStartIdentity: "8" }]);
  await pending;
  assert.equal(queries, 2, "bursts coalesce to one post-invalidation query");
  assert.deepEqual(value.presence.current("a"), { pid: 9, processStartIdentity: "9" });
});

test("terminal close aborts the helper, removes subscribers, and rejects late ownership", async () => {
  let resolveOwner; let signal; let notifications = 0;
  const owner = new Promise((resolve) => { resolveOwner = resolve; });
  const value = fixture({ queryOwners(_files, _executables, receivedSignal) { signal = receivedSignal; return owner; } }); value.lock("a");
  value.presence.subscribe(() => { notifications += 1; });
  const pending = value.presence.refresh([thread("a")]);
  while (!signal) await new Promise((resolve) => setImmediate(resolve));
  value.presence.close(); assert.equal(signal.aborted, true);
  resolveOwner([{ index: 0, pid: 8, processStartIdentity: "8" }]); await pending;
  assert.equal(value.presence.current("a"), null);
  assert.equal(notifications, 0, "late work cannot notify after close");
  await value.presence.refresh([thread("a")]); assert.equal(value.presence.current("a"), null);
});
