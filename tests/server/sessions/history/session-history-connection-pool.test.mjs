import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  HistoryConnectionPool, MAX_CACHED_STATEMENTS, MAX_POOLED_CONNECTIONS, POOLED_CONNECTION_IDLE_MS,
} from "../../../../server/sessions/history/session-history-connection-pool.mjs";

// A database double that counts the work the pool is meant to save.
function fixture({ resume = true, ...options } = {}) {
  const log = { opens: [], closes: 0, prepares: 0, executed: [] };
  let clock = 0;
  const timers = [];
  const identities = new Map();
  const pool = new HistoryConnectionPool({
    open(location, writable) {
      const database = {
        location, writable, closed: false,
        prepare: (sql) => { log.prepares += 1; return { sql, run() {}, get() {}, all() { return []; } }; },
        exec: (sql) => { log.executed.push(sql); },
        close() { if (database.closed) throw new Error("database is not open"); database.closed = true; log.closes += 1; },
      };
      log.opens.push(database);
      return database;
    },
    now: () => clock,
    schedule: (task, delay) => { const timer = { task, delay, cancelled: false, unrefs: 0, unref() { this.unrefs += 1; } }; timers.push(timer); return timer; },
    cancel: (timer) => { timer.cancelled = true; },
    identify: (location) => identities.has(location) ? identities.get(location) : `file:${location}`,
    ...options,
  });
  if (resume) pool.resume();
  const live = () => timers.filter((timer) => !timer.cancelled);
  return {
    pool, log, timers, identities, live,
    advance(ms) { clock += ms; },
    fire() { const timer = live().at(-1); timer.cancelled = true; timer.task(); },
  };
}

test("bounds are named constants chosen for the store's usage", () => {
  assert.equal(MAX_POOLED_CONNECTIONS, 8);
  assert.equal(POOLED_CONNECTION_IDLE_MS, 30_000);
  assert.ok(MAX_CACHED_STATEMENTS >= 16);
});

test("reuses one connection and prepares each statement once however often it is used", () => {
  const { pool, log } = fixture();
  for (let call = 0; call < 50; call += 1) {
    pool.use("a.sqlite", true, (db) => {
      db.prepare("SELECT 1"); db.prepare("INSERT INTO t VALUES(?)"); db.prepare("SELECT 1");
    });
  }
  assert.equal(log.opens.length, 1, "one open for fifty uses");
  assert.equal(log.prepares, 2, "two distinct statements, each prepared once");
  assert.equal(pool.size, 1);
});

test("retains nothing until resumed: every use opens and closes its own connection", () => {
  const { pool, log } = fixture({ resume: false });
  for (let call = 0; call < 5; call += 1) pool.use("a.sqlite", true, () => {});
  assert.equal(log.opens.length, 5);
  assert.equal(log.closes, 5);
  assert.equal(pool.size, 0);
  pool.resume();
  pool.use("b.sqlite", false, () => {}); pool.use("b.sqlite", false, () => {});
  assert.equal(log.opens.length, 6);
  assert.equal(pool.size, 1);
});

test("read-only and read-write access to one file are separate connections", () => {
  const { pool, log } = fixture();
  pool.use("a.sqlite", true, () => {});
  pool.use("a.sqlite", false, () => {});
  pool.use("a.sqlite", true, () => {});
  pool.use("a.sqlite", false, () => {});
  assert.deepEqual(log.opens.map((db) => db.writable), [true, false]);
  assert.equal(pool.size, 2);
});

test("never holds more connections than its bound across more files than the bound, evicting the least recently used", () => {
  const { pool, log } = fixture({ maxConnections: 3 });
  for (let round = 0; round < 3; round += 1) {
    for (let file = 0; file < 10; file += 1) {
      pool.use(`session-${file}.sqlite`, true, () => {});
      assert.ok(pool.size <= 3, `pool size ${pool.size} after file ${file}`);
      assert.ok(log.opens.length - log.closes <= 3, "open handles never exceed the bound");
    }
  }
  assert.equal(pool.size, 3);
  // The three most recently used files are still open; the earlier ones were closed on eviction.
  const open = log.opens.filter((db) => !db.closed).map((db) => db.location).sort();
  assert.deepEqual(open, ["session-7.sqlite", "session-8.sqlite", "session-9.sqlite"]);
  const opensBefore = log.opens.length;
  pool.use("session-9.sqlite", true, () => {});
  pool.use("session-8.sqlite", true, () => {});
  assert.equal(log.opens.length, opensBefore, "recent files are reused");
});

test("a bound of zero disables retention", () => {
  const { pool, log } = fixture({ maxConnections: 0 });
  pool.use("a.sqlite", true, () => {}); pool.use("a.sqlite", true, () => {});
  assert.equal(log.opens.length, 2);
  assert.equal(pool.size, 0);
  assert.equal(log.opens.every((db) => db.closed), true);
});

test("an exception evicts and closes the connection; a bad handle is never reused", () => {
  const { pool, log } = fixture();
  pool.use("a.sqlite", true, () => {});
  assert.throws(() => pool.use("a.sqlite", true, () => { throw new Error("database disk image is malformed"); }), /malformed/);
  assert.equal(pool.size, 0);
  assert.equal(log.opens[0].closed, true);
  pool.use("a.sqlite", true, () => {});
  assert.equal(log.opens.length, 2, "the next use opens a fresh connection");
  assert.notEqual(log.opens[0], log.opens[1]);
});

test("a connection marked broken is closed after the work returns", () => {
  const { pool, log } = fixture();
  const result = pool.use("a.sqlite", false, (db) => { db.broken = true; return "value"; });
  assert.equal(result, "value");
  assert.equal(pool.size, 0);
  assert.equal(log.opens[0].closed, true);
});

test("a failed open registers nothing and the next use retries", () => {
  let attempts = 0;
  const pool = new HistoryConnectionPool({ open() { attempts += 1; if (attempts === 1) throw new Error("file is not a database"); return { prepare() {}, exec() {}, close() {} }; } });
  pool.resume();
  assert.throws(() => pool.use("a.sqlite", true, () => {}), /not a database/);
  assert.equal(pool.size, 0);
  pool.use("a.sqlite", true, () => {});
  assert.equal(pool.size, 1);
});

test("a nested request for a leased connection gets its own, and only the pooled one is retained", () => {
  const { pool, log } = fixture({ maxConnections: 1 });
  pool.use("a.sqlite", true, (outer) => {
    pool.use("a.sqlite", true, (inner) => { assert.notEqual(inner, outer); });
    assert.equal(log.closes, 1, "the nested connection closes on release");
    // Every pooled slot is leased, so a different file also gets a transient connection.
    pool.use("b.sqlite", true, () => {});
    assert.equal(pool.size, 1);
  });
  assert.equal(pool.size, 1);
  assert.equal(log.opens.length - log.closes, 1);
});

test("a file removed or replaced since the connection opened is reopened", () => {
  const { pool, log, identities } = fixture();
  identities.set("a.sqlite", "inode-1");
  pool.use("a.sqlite", true, () => {});
  pool.use("a.sqlite", true, () => {});
  assert.equal(log.opens.length, 1);
  identities.set("a.sqlite", "inode-2"); // replaced by another file at the same path
  pool.use("a.sqlite", true, () => {});
  assert.equal(log.opens.length, 2);
  assert.equal(log.opens[0].closed, true);
  identities.set("a.sqlite", null); // removed
  pool.use("a.sqlite", true, () => {});
  assert.equal(log.opens.length, 3);
  assert.equal(log.opens[1].closed, true);
  // The identity of a missing file cannot be confirmed later, so that connection is not reused.
  pool.use("a.sqlite", true, () => {});
  assert.equal(log.opens.length, 4);
  assert.equal(log.opens[2].closed, true);
});

test("idle connections close on a deterministic schedule and the timer does not keep the process alive", () => {
  const { pool, log, timers, advance, fire, live } = fixture({ idleMs: 1000 });
  pool.use("a.sqlite", true, () => {});
  assert.equal(live().length, 1);
  assert.equal(timers[0].delay, 1000);
  assert.equal(timers[0].unrefs, 1, "unref'd so it cannot keep the process alive");

  advance(600);
  pool.use("b.sqlite", true, () => {});
  assert.equal(live().length, 1, "one timer serves all connections");

  advance(400); // a.sqlite has now been idle for 1000ms, b.sqlite for 400ms
  fire();
  assert.equal(pool.size, 1);
  assert.equal(log.opens[0].closed, true);
  assert.equal(log.opens[1].closed, false);
  assert.equal(live().length, 1, "re-armed for the remaining connection");
  assert.equal(timers.at(-1).delay, 600);
  assert.equal(timers.at(-1).unrefs, 1);

  advance(600);
  fire();
  assert.equal(pool.size, 0);
  assert.equal(log.opens.every((db) => db.closed), true);
  assert.equal(live().length, 0, "no timer remains once nothing is open");
});

test("use refreshes the idle clock", () => {
  const { pool, log, advance, fire } = fixture({ idleMs: 1000 });
  pool.use("a.sqlite", true, () => {});
  advance(900);
  pool.use("a.sqlite", true, () => {});
  advance(100);
  fire();
  assert.equal(pool.size, 1, "used 100ms ago, so still warm");
  assert.equal(log.opens[0].closed, false);
  advance(900);
  fire();
  assert.equal(pool.size, 0);
});

test("closeAll closes every connection, cancels the timer, and stops retaining until resumed", () => {
  const { pool, log, timers, live } = fixture();
  pool.use("a.sqlite", true, () => {}); pool.use("a.sqlite", false, () => {}); pool.use("b.sqlite", true, () => {});
  assert.equal(pool.size, 3);
  pool.closeAll();
  assert.equal(pool.size, 0);
  assert.equal(log.opens.every((db) => db.closed), true);
  assert.equal(live().length, 0);
  assert.equal(timers.every((timer) => timer.cancelled), true);
  pool.closeAll(); // idempotent

  pool.use("a.sqlite", true, () => {});
  assert.equal(pool.size, 0, "after shutdown a late call opens and closes its own connection");
  assert.equal(log.opens.every((db) => db.closed), true);

  pool.resume();
  pool.use("a.sqlite", true, () => {});
  assert.equal(pool.size, 1);
});

test("closeAll during a leased use closes that connection when it is released", () => {
  const { pool, log } = fixture();
  pool.use("a.sqlite", true, () => { pool.closeAll(); assert.equal(log.opens[0].closed, false); });
  assert.equal(pool.size, 0);
  assert.equal(log.opens[0].closed, true);
});

test("closing tolerates a connection that is already closed", () => {
  const { pool, log } = fixture();
  pool.use("a.sqlite", true, () => {});
  log.opens[0].closed = true;
  assert.doesNotThrow(() => pool.closeAll());
  assert.equal(pool.size, 0);
});

test("the real timer is unref'd and cancelled on shutdown", () => {
  let handle = null; let cancelled = null;
  const pool = new HistoryConnectionPool({
    open: () => ({ prepare() {}, exec() {}, close() {} }),
    schedule: (task, delay) => { handle = setTimeout(task, delay); return handle; },
    cancel: (timer) => { cancelled = timer; clearTimeout(timer); },
  });
  pool.resume();
  pool.use("a.sqlite", true, () => {});
  assert.ok(handle, "an idle timer was scheduled");
  assert.equal(handle.hasRef(), false);
  pool.closeAll();
  assert.equal(cancelled, handle, "shutdown cancels the pending timer");
});

test("an uncached statement beyond the cache cap is still prepared and usable", () => {
  const { pool, log } = fixture();
  pool.use("a.sqlite", true, (db) => {
    for (let index = 0; index < MAX_CACHED_STATEMENTS + 4; index += 1) db.prepare(`SELECT ${index}`);
    assert.equal(db.statementCount(), MAX_CACHED_STATEMENTS);
  });
  assert.equal(log.prepares, MAX_CACHED_STATEMENTS + 4);
});

test("closing a connection finalizes its cached statements and releases the file", async (t) => {
  // The pool caches prepared statements and relies on node:sqlite finalizing them when the
  // database closes; an unfinalized statement would keep the file open on Windows.
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-pool-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "statements.sqlite");
  const pool = new HistoryConnectionPool({ open: (location) => { const database = new DatabaseSync(location); database.exec("CREATE TABLE IF NOT EXISTS t(a INTEGER)"); return database; } });
  pool.resume();
  let statement;
  pool.use(file, true, (db) => { statement = db.prepare("INSERT INTO t VALUES(?)"); statement.run(1); });
  if (process.platform === "win32") await assert.rejects(rm(file), "Windows refuses to delete a database while a pooled connection holds it open");
  pool.closeAll();
  assert.throws(() => statement.run(2), /finalized/);
  await rm(file);
});
