import { statSync } from "node:fs";

export const MAX_POOLED_CONNECTIONS = 8;
export const POOLED_CONNECTION_IDLE_MS = 30_000;
// The store uses about a dozen distinct statements; the cap only guards against a caller that builds SQL from data.
export const MAX_CACHED_STATEMENTS = 32;

function fileIdentity(location) {
  try {
    const stat = statSync(location, { throwIfNoEntry: false });
    return stat ? `${stat.dev}:${stat.ino}` : null;
  } catch { return null; }
}

export class PooledConnection {
  #database; #statements = new Map(); #onPrepare;
  broken = false;
  constructor(database, onPrepare = null) { this.#database = database; this.#onPrepare = onPrepare; }
  prepare(sql) {
    const cached = this.#statements.get(sql);
    if (cached) return cached;
    const statement = this.#database.prepare(sql);
    this.#onPrepare?.();
    if (this.#statements.size < MAX_CACHED_STATEMENTS) this.#statements.set(sql, statement);
    return statement;
  }
  exec(sql) { return this.#database.exec(sql); }
  statementCount() { return this.#statements.size; }
  close() {
    this.#statements.clear();
    this.#database.close();
  }
}

export class HistoryConnectionPool {
  #entries = new Map(); // key -> entry; iteration order is least to most recently used
  #open; #max; #idleMs; #now; #schedule; #cancel; #identify; #onPrepare;
  #timer = null; #retain = false;
  constructor({ open, maxConnections = MAX_POOLED_CONNECTIONS, idleMs = POOLED_CONNECTION_IDLE_MS,
    now = Date.now, schedule = setTimeout, cancel = clearTimeout, identify = fileIdentity, onPrepare = null } = {}) {
    if (typeof open !== "function") throw new TypeError("History connection pool requires an open function");
    this.#open = open;
    this.#max = Number.isSafeInteger(maxConnections) ? Math.max(0, maxConnections) : MAX_POOLED_CONNECTIONS;
    this.#idleMs = Number.isFinite(idleMs) && idleMs >= 0 ? idleMs : POOLED_CONNECTION_IDLE_MS;
    this.#now = now; this.#schedule = schedule; this.#cancel = cancel; this.#identify = identify; this.#onPrepare = onPrepare;
  }
  /** Connections currently held open by the pool (idle or leased); transient ones are not counted. */
  get size() { return this.#entries.size; }
  resume() { this.#retain = true; }
  use(location, writable, work) {
    const entry = this.#checkout(location, writable);
    let failed = true;
    try {
      const result = work(entry.connection);
      failed = entry.connection.broken;
      return result;
    } finally { this.#checkin(entry, failed); }
  }
  closeAll() {
    this.#retain = false;
    if (this.#timer !== null) { this.#cancel(this.#timer); this.#timer = null; }
    for (const entry of [...this.#entries.values()]) {
      if (entry.leased) entry.connection.broken = true; // closed by its checkin
      else this.#discard(entry);
    }
  }
  sweep() {
    const cutoff = this.#now() - this.#idleMs;
    for (const entry of [...this.#entries.values()]) {
      if (!entry.leased && entry.lastUsed <= cutoff) this.#discard(entry);
    }
    this.#arm();
  }
  #create(location, writable, key, pooled) {
    const connection = new PooledConnection(this.#open(location, writable), this.#onPrepare);
    return { key, connection, pooled, leased: true, lastUsed: this.#now(), identity: pooled ? this.#identify(location) : null };
  }
  #checkout(location, writable) {
    if (!this.#retain || this.#max === 0) return this.#create(location, writable, null, false);
    const key = `${writable ? "w" : "r"}:${location}`;
    const existing = this.#entries.get(key);
    if (existing) {
      if (existing.leased) return this.#create(location, writable, null, false);
      if (existing.identity !== null && this.#identify(location) === existing.identity) {
        existing.leased = true;
        this.#entries.delete(key); this.#entries.set(key, existing);
        return existing;
      }
      this.#discard(existing);
    }
    while (this.#entries.size >= this.#max) {
      const victim = [...this.#entries.values()].find((entry) => !entry.leased);
      if (!victim) return this.#create(location, writable, null, false);
      this.#discard(victim);
    }
    const entry = this.#create(location, writable, key, true);
    this.#entries.set(key, entry);
    return entry;
  }
  #checkin(entry, failed) {
    entry.leased = false;
    if (failed || !entry.pooled || !this.#retain) { this.#discard(entry); return; }
    entry.lastUsed = this.#now();
    this.#arm();
  }
  #discard(entry) {
    if (entry.key !== null && this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    try { entry.connection.close(); } catch { /* already closed, or the file is gone */ }
  }
  #arm() {
    if (this.#timer !== null) return;
    let oldest = Infinity;
    for (const entry of this.#entries.values()) if (!entry.leased && entry.lastUsed < oldest) oldest = entry.lastUsed;
    if (oldest === Infinity) return;
    const delay = Math.max(1, oldest + this.#idleMs - this.#now());
    this.#timer = this.#schedule(() => { this.#timer = null; this.sweep(); }, delay);
    this.#timer?.unref?.();
  }
}
