import { opendir, readFile, rm, rmdir } from "node:fs/promises";
import { activityGroupPlan, emptyActivityGroups, scopeMatches } from "./session-history-groups.mjs";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

// SQLite's rollback journal is the atomic publication marker: old B-tree pages
// remain recoverable until COMMIT. Each changed row updates bounded indexed
// pages; unchanged history is neither deserialized nor rewritten. DELETE mode
// has no growing WAL or replay chain. Freed pages are reused; reclamation is an
// explicit, cooperative incremental_vacuum operation, never part of serving.
export class SessionHistoryBlockStore {
  constructor(directory, validators, { beforeCommit = null } = {}) {
    this.directory = directory; this.validators = validators; this.beforeCommit = beforeCommit;
    this.runtime = crypto.randomBytes(16).toString("hex");
    this.io = { detailReads: 0, detailWrites: 0, writtenBytes: 0, transactions: 0, maintenancePages: 0 };
  }
  location(id) { return path.join(this.directory, `${crypto.createHash("sha256").update(id).digest("hex")}.history.sqlite`); }
  open(id, writable = false) {
    const location = this.location(id);
    if (!writable && !existsSync(location)) return null;
    const db = new DatabaseSync(location, { readOnly: !writable });
    try {
      db.exec("PRAGMA busy_timeout=1000; PRAGMA cache_size=-2048");
      if (writable) {
        db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA auto_vacuum=INCREMENTAL");
        db.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS rows (kind TEXT NOT NULL, id TEXT NOT NULL, time TEXT NOT NULL,
            ref TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind,id));
          CREATE INDEX IF NOT EXISTS row_order ON rows(kind,time,id);
          CREATE TABLE IF NOT EXISTS numbers (id TEXT PRIMARY KEY, number INTEGER NOT NULL);`);
      }
      return db;
    } catch (error) { db.close(); throw error; }
  }
  metadata(db) {
    const raw = db.prepare("SELECT value FROM meta WHERE id=1").get();
    if (!raw) return null;
    const value = JSON.parse(raw.value);
    if (value.version !== 5 || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Invalid history metadata");
    return value;
  }
  meta(id) {
    const db = this.open(id); if (!db) return null;
    try { return this.metadata(db); } finally { db.close(); }
  }
  recover(id) {
    if (!existsSync(this.location(id))) return;
    const db = this.open(id, true); try { this.metadata(db); } finally { db.close(); }
  }
  get(db, kind, id) {
    const raw = db.prepare("SELECT data,version FROM rows WHERE kind=? AND id=?").get(kind, id);
    if (!raw) return null;
    this.io.detailReads += 1;
    return { ...JSON.parse(raw.data), version: raw.version };
  }
  put(db, kind, item, version = 0) {
    const value = { ...item }; delete value.version;
    const ref = kind === "requests"
      ? { id: value.id, agentId: value.agentId, number: value.number, overview: [value.uncachedInputTokens, value.cacheWriteTokens, value.cacheReadTokens, value.outputTokens] }
      : { id: value.id, agentId: value.agentId, requestId: value.requestId, workKind: value.workKind,
          status: value.status, durationMs: value.durationMs, timestamp: value.timestamp };
    const data = JSON.stringify(value); const index = JSON.stringify(ref);
    db.prepare(`INSERT INTO rows(kind,id,time,ref,data,version) VALUES(?,?,?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET time=excluded.time,ref=excluded.ref,data=excluded.data,version=excluded.version`)
      .run(kind, value.id, value.observedAt || value.timestamp, index, data, version);
    this.io.detailWrites += 1; this.io.writtenBytes += Buffer.byteLength(data) + Buffer.byteLength(index);
  }
  transaction(id, body) {
    const db = this.open(id, true);
    try {
      db.exec("BEGIN IMMEDIATE");
      const result = body(db);
      this.beforeCommit?.();
      db.exec("COMMIT"); this.io.transactions += 1;
      return result;
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    finally { db.close(); }
  }
  saveMeta(db, meta) {
    db.prepare("INSERT INTO meta(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(JSON.stringify(meta));
  }
  replace(id, record) {
    return this.transaction(id, (db) => {
      const prior = this.metadata(db);
      if (prior && prior.revision >= record.revision) throw new Error("History publication is stale");
      db.exec("DELETE FROM rows");
      for (const [key, number] of Object.entries(record.numberRegistry || {})) {
        if (/^request-[a-f0-9]{16}$/.test(key) && Number.isSafeInteger(number) && number > 0)
          db.prepare("INSERT OR IGNORE INTO numbers VALUES(?,?)").run(key, number);
      }
      for (const item of record.requests) {
        this.put(db, "requests", item);
        db.prepare("INSERT OR IGNORE INTO numbers VALUES(?,?)").run(item.id, item.number);
      }
      for (const item of record.activity) this.put(db, "activity", item, record.activityVersions?.[item.id] || 0);
      const { requests, activity } = record;
      const rest = { ...record };
      for (const field of ["requests", "activity", "numberRegistry", "activityVersions"]) delete rest[field];
      const meta = { ...rest, version: 5, requestTotal: requests.length, activityTotal: activity.length,
        ...(prior?.activityAdmission ? { activityAdmission: prior.activityAdmission } : {}),
        ...(prior?.requestAdmission ? { requestAdmission: prior.requestAdmission } : {}) };
      this.saveMeta(db, meta); return meta;
    });
  }
  load(id) {
    const db = this.open(id); if (!db) return null;
    try {
      const meta = this.metadata(db); if (!meta) return null;
      const requests = db.prepare("SELECT data FROM rows WHERE kind='requests' ORDER BY time,id").all().map((row) => JSON.parse(row.data));
      const activityRows = db.prepare("SELECT data,version FROM rows WHERE kind='activity' ORDER BY time DESC,id").all();
      this.io.detailReads += requests.length + activityRows.length;
      return { ...meta, version: 1, requests, activity: activityRows.map((row) => JSON.parse(row.data)),
        activityVersions: Object.fromEntries(activityRows.map((row) => [JSON.parse(row.data).id, row.version])),
        numberRegistry: Object.fromEntries(db.prepare("SELECT id,number FROM numbers").all().map((row) => [row.id, row.number])) };
    } finally { db.close(); }
  }
  contribute(id, contribution, domain) {
    return this.transaction(id, (db) => {
      const current = this.metadata(db);
      const meta = current ? { ...current } : { version: 5, sessionId: id, revision: 0, complete: false,
        activityReady: true, requestsReady: false, activityEpoch: 0, activitySequence: 0,
        requestEpoch: 0, requestSequence: 0, nextNumber: 1, requestTotal: 0, activityTotal: 0 };
      const admissionKey = domain === "activity" ? "activityAdmission" : "requestAdmission";
      const prior = meta[admissionKey]?.runtime === this.runtime ? meta[admissionKey] : null;
      if (prior && (contribution.epoch < prior.epoch || contribution.epoch === prior.epoch && contribution.sequence <= prior.sequence))
        return { record: meta, changed: false };
      const prefix = domain === "activity" ? "activity" : "request";
      const epoch = prior ? contribution.epoch === prior.epoch ? prior.effectiveEpoch : prior.effectiveEpoch + 1
        : Math.max(meta[`${prefix}Epoch`] + 1, contribution.epoch);
      meta[admissionKey] = { runtime: this.runtime, epoch: contribution.epoch, sequence: contribution.sequence, effectiveEpoch: epoch };
      meta[`${prefix}Epoch`] = epoch; meta[`${prefix}Sequence`] = contribution.sequence;
      let changed = !current || domain === "requests" && !meta.requestsReady;
      if (domain === "requests") meta.requestsReady = true;
      const number = (requestId) => db.prepare("SELECT number FROM numbers WHERE id=?").get(requestId)?.number || null;
      const requestMap = { get: (requestId) => {
        const row = db.prepare("SELECT 1 FROM rows WHERE kind='requests' AND id=?").get(requestId);
        return row ? { number: number(requestId) } : null;
      } };
      for (const raw of domain === "requests" ? contribution.requests : []) {
        const item = this.validators.request(raw); if (!item) continue;
        const previous = this.get(db, "requests", item.id);
        const assigned = number(item.id) || meta.nextNumber++;
        const value = { ...item, number: assigned };
        db.prepare("INSERT OR IGNORE INTO numbers VALUES(?,?)").run(item.id, assigned);
        const old = { ...previous }; delete old.version;
        if (JSON.stringify(old) === JSON.stringify(value)) continue;
        this.put(db, "requests", value); changed = true;
        if (!previous) meta.requestTotal += 1;
      }
      for (const raw of contribution.activity) {
        const item = this.validators.activity(domain === "activity" ? { ...raw, requestId: null } : raw, requestMap);
        if (!item) continue;
        const previous = this.get(db, "activity", item.id);
        const requestId = item.requestId && requestMap.get(item.requestId) ? item.requestId
          : previous?.requestId && requestMap.get(previous.requestId) ? previous.requestId : null;
        const value = { ...item, durationMs: item.durationMs ?? previous?.durationMs ?? null,
          status: item.status ?? previous?.status ?? null, requestId, requestNumber: requestId ? number(requestId) : null };
        const { version, ...old } = previous || {};
        if (JSON.stringify(old) !== JSON.stringify(value)) {
          this.put(db, "activity", value, domain === "activity" ? contribution.sequence : version || 0);
          changed = true; if (!previous) meta.activityTotal += 1;
        } else if (domain === "activity") db.prepare("UPDATE rows SET version=? WHERE kind='activity' AND id=?").run(contribution.sequence, item.id);
      }
      if (changed) meta.revision += 1;
      this.saveMeta(db, meta);
      return { record: meta, changed };
    });
  }
  // Callback is synchronous, so all compact indexes and selected details come
  // from the same read transaction, with no asynchronous writer/reader race.
  read(id, callback) {
    const db = this.open(id); if (!db) return null;
    try {
      db.exec("BEGIN"); const meta = this.metadata(db); if (!meta) return null;
      const index = { ...meta, version: 3 };
      for (const kind of ["requests", "activity"]) index[kind] = db.prepare(`SELECT ref FROM rows WHERE kind=? ORDER BY time ${kind === "activity" ? "DESC" : "ASC"},id`).all(kind)
        .map((row) => { const value = JSON.parse(row.ref); return { ...value, page: value.id, slot: 0 }; });
      return callback(index, (kind, key) => { const value = this.get(db, kind, key); return value ? [value] : []; });
    } finally { try { db.exec("ROLLBACK"); } catch {} db.close(); }
  }
  maintenanceFile(location, budget) {
    // Caller obtained this exact allowlisted entry from the owned directory.
    const db = new DatabaseSync(location);
    try {
      const before = db.prepare("PRAGMA freelist_count").get().freelist_count;
      let reclaimed = 0;
      while (reclaimed < budget && reclaimed < before) { db.exec("PRAGMA incremental_vacuum(1)"); reclaimed += 1; }
      this.io.maintenancePages += reclaimed; return reclaimed;
    } finally { db.close(); }
  }
}

export function readCommittedHistoryIndex(query, index, load, { safeRequest, safeActivity, overviewTuple, safeAgent }) {
    const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const REQUEST_ID = /^request-[a-f0-9]{16}$/;
    const clone = structuredClone;
    const kind = query.kind === "requests" ? "requests" : "activity";
    if (kind === "requests" && index.requestsReady === false || kind === "activity" && index.activityReady === false)
      return { status: "loading", kind, revision: String(index.revision), total: 0, offset: 0, items: [], linkedCount: 0, ...(kind === "requests" ? { overview: null } : emptyActivityGroups()) };
    const scope = query.scope || "all";
    let refs = index[kind].filter((item) => isObject(item) && typeof item.id === "string" && typeof item.page === "string" && Number.isSafeInteger(item.slot) && scopeMatches(item, scope));
    if (kind === "activity") refs = [...refs].reverse();
    if (kind === "activity" && REQUEST_ID.test(query.filterRequestId || "")) refs = refs.filter((item) => item.requestId === query.filterRequestId);
    const total = refs.length; const maximum = kind === "activity" ? 8 : 60; const limit = Math.max(1, Math.min(maximum, Number.parseInt(query.limit, 10) || maximum));
    let offset = kind === "activity" && (query.offset === "latest" || query.offset === "last")
      ? Math.floor(Math.max(0, total - 1) / limit) * limit
      : query.offset === "latest" || query.offset === "last" ? Math.max(0, total - limit) : Math.max(0, Number.parseInt(query.offset, 10) || 0);
    const target = kind === "requests" ? query.requestId : (query.requestId || query.anchor);
    if (target) { const position = refs.findIndex((item) => item.id === target || (kind === "activity" && item.requestId === target));
      if (position >= 0 && kind === "activity" && query.anchor) offset = position;
      else if (position >= 0 && kind === "activity") offset = Math.floor(position / limit) * limit;
      else if (position >= 0) offset = Math.max(0, position - Math.floor(limit / 2)); }
    offset = Math.min(offset, Math.max(0, total - 1)); const selected = refs.slice(offset, offset + limit);
    const blocks = new Map();
    for (const page of new Set(selected.map((item) => item.page))) blocks.set(page, load(kind, page));
    const requestNumbers = new Map(index.requests.filter((item) => REQUEST_ID.test(item?.id || "") && Number.isSafeInteger(item.number) && item.number > 0).map((item) => [item.id, { number: item.number }]));
    const items = selected.map((ref) => {
      const raw = blocks.get(ref.page)?.[ref.slot];
      if (kind === "requests") {
        const value = safeRequest(raw); return value && Number.isSafeInteger(raw.number) && raw.number > 0 ? { ...value, number: raw.number } : null;
      }
      return safeActivity(raw, requestNumbers);
    });
    if (items.some((item) => item === null) || items.length !== selected.length) { return null; }
    const requestedId = query.requestId || query.filterRequestId;
    const linkedCount = REQUEST_ID.test(requestedId || "") ? (kind === "requests" ? index.activity.filter((item) => item.requestId === requestedId && scopeMatches(item, scope)).length : refs.filter((item) => item.requestId === requestedId).length) : 0;
    const overview = kind === "requests" && query.overview !== "0"
      ? (refs.every((item) => overviewTuple(item.overview) !== null) ? refs.map((item) => overviewTuple(item.overview)) : null)
      : null;
    let groups = null;
    if (kind === "activity") {
      const requestRefs = index.requests.filter((item) => isObject(item) && REQUEST_ID.test(item.id || "")
        && safeAgent(item.agentId) && Number.isSafeInteger(item.number) && item.number > 0
        && typeof item.page === "string" && Number.isSafeInteger(item.slot));
      const activityRefs = index.activity.filter((item) => isObject(item) && typeof item.id === "string"
        && (item.requestId === null || REQUEST_ID.test(item.requestId || ""))
        && (item.agentId === null || Boolean(safeAgent(item.agentId)))
        && typeof item.page === "string" && Number.isSafeInteger(item.slot));
      const plan = activityGroupPlan(requestRefs, activityRefs, query);
      const requestBlocks = new Map(); const activityBlocks = new Map();
      const requestedRequestRefs = plan.requestGroups.map((group) => group.request);
      const requestedActivityRefs = plan.requestGroups.flatMap((group) => group.calls);
      for (const page of new Set(requestedRequestRefs.map((item) => item.page))) requestBlocks.set(page, load("requests", page));
      for (const page of new Set(requestedActivityRefs.map((item) => item.page))) activityBlocks.set(page, load("activity", page));
      const groupRequests = new Map(requestedRequestRefs.map((ref) => {
        const raw = requestBlocks.get(ref.page)?.[ref.slot]; const value = safeRequest(raw);
        return [`${ref.page}:${ref.slot}`, value && raw.number === ref.number ? { ...value, number: raw.number } : null];
      }));
      const groupCalls = new Map(requestedActivityRefs.map((ref) => [
        `${ref.page}:${ref.slot}`, safeActivity(activityBlocks.get(ref.page)?.[ref.slot], requestNumbers),
      ]));
      if ([...groupRequests.values(), ...groupCalls.values()].some((item) => item === null)) { return null; }
      groups = {
        ...plan,
        requestGroups: plan.requestGroups.map((group) => ({
          request: clone(groupRequests.get(`${group.request.page}:${group.request.slot}`)),
          calls: group.calls.map((call) => clone(groupCalls.get(`${call.page}:${call.slot}`))),
          noMatchingCalls: group.noMatchingCalls, continuation: group.continuation,
        })),
      };
    }
    return { status: "ready", kind, revision: String(index.revision), total, offset, items, linkedCount,
      ...(kind === "requests" && query.overview !== "0" ? { overview } : {}), ...(groups || {}) };
  }

/**
   * Bounded, explicitly scheduled maintenance.  Publication and serving never
   * enumerate history directories: callers run this only while no selected or
   * live history work needs the event loop.  A directory handle is retained so
   * a large abandoned-generation set is drained over several turns.
   */
export class SessionHistoryMaintenance {
  constructor(directory, { busy, leased, vacuum }) {
    Object.assign(this, { directory, busy, leased, vacuum, cursor: null, generation: null, stopped: false });
  }
  start() { this.stopped = false; }
  async step({ budget = 16, shouldYield = () => false } = {}) {
    if (!this.directory || this.stopped) return Object.freeze({ scanned: 0, removed: 0, complete: true });
    const limit = Number.isSafeInteger(budget) ? Math.max(1, Math.min(128, budget)) : 16;
    let directory;
    try {
      directory = this.cursor || await opendir(this.directory);
      this.cursor = directory;
    } catch { return Object.freeze({ scanned: 0, removed: 0, complete: true }); }
    let scanned = 0; let removed = 0;
    try {
      while (scanned < limit) {
        if (this.stopped || shouldYield() === true) return Object.freeze({ scanned, removed, complete: false, yielded: true });
        if (this.generation) {
          const pending = this.generation;
          const child = await pending.directory.read(); scanned += 1;
          if (!child) {
            await pending.directory.close(); this.generation = null;
            try { await rmdir(pending.target); removed += 1; } catch { /* unknown entries are retained */ }
          } else if (child.isFile() && /^(?:snapshot|(?:requests|activity)-\d+)\.json$/.test(child.name)) {
            await rm(path.join(pending.target, child.name), { force: true });
          }
          continue;
        }
        const entry = await directory.read();
        if (!entry) {
          await directory.close(); this.cursor = null;
          return Object.freeze({ scanned, removed, complete: true });
        }
        scanned += 1;
        if (entry.isFile() && /^[a-f0-9]{64}\.history\.sqlite$/.test(entry.name)) {
          if (this.busy() || shouldYield()) return Object.freeze({ scanned, removed, complete: false, yielded: true });
          this.vacuum(path.join(this.directory, entry.name), 1);
          continue;
        }
        if (!entry.isDirectory()) continue;
        const match = /^([a-f0-9]{64})-(\d+)$/u.exec(entry.name);
        if (!match) continue;
        const revision = Number(match[2]);
        if (!Number.isSafeInteger(revision)) continue;
        // Read only the compact current marker for this session.  A missing or
        // malformed marker is conservative: an interrupted publication is left
        // for a later reconciliation rather than deleting possible evidence.
        let current = null;
        if (this.stopped || shouldYield() === true) return Object.freeze({ scanned, removed, complete: false, yielded: true });
        try {
          const marker = JSON.parse(await readFile(path.join(this.directory, `${match[1]}.index.json`), "utf8"));
          current = Number.isSafeInteger(marker?.revision) ? marker.revision : null;
        } catch { continue; }
        if (current === null || revision >= current - 1 || this.leased(entry.name)) continue;
        const root = path.resolve(this.directory); const target = path.resolve(root, entry.name);
        if (!target.startsWith(`${root}${path.sep}`)) continue;
        if (this.stopped || shouldYield() === true) return Object.freeze({ scanned, removed, complete: false, yielded: true });
        try { this.generation = { target, directory: await opendir(target) }; } catch { /* a concurrent owner may retain it */ }
      }
      return Object.freeze({ scanned, removed, complete: false });
    } catch {
      try { await directory.close(); } catch {}
      this.cursor = null;
      return Object.freeze({ scanned, removed, complete: true });
    }
  }
  async stop() {
    this.stopped = true;
    for (const handle of [this.cursor, this.generation?.directory]) { try { await handle?.close(); } catch {} }
    this.cursor = null; this.generation = null;
  }
}
