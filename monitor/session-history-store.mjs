import crypto from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizedRequestWork } from "./request-work.mjs";
import { normalizedWorkKind, toolWorkKind } from "./work-kind.mjs";

const MAX_SESSIONS = 24;
const MAX_RESIDENT = 1;
const PAGE_ROWS = 128;
const REQUEST_ID = /^request-[a-f0-9]{16}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fileName(sessionId) {
  return `history-${crypto.createHash("sha256").update(sessionId).digest("hex")}.json`;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function safeInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function safeTime(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
function safeAgent(value) { return typeof value === "string" && AGENT_ID.test(value) ? value : null; }
function safeRequest(value) {
  if (!isObject(value) || !REQUEST_ID.test(value.id || "") || !safeAgent(value.agentId) || !safeTime(value.observedAt)) return null;
  const numeric = ["uncachedInputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens", "totalTokens"];
  if (numeric.some((key) => safeInteger(value[key]) === null) || value.totalTokens <= 0) return null;
  if (value.totalTokens !== value.uncachedInputTokens + value.cacheWriteTokens + value.cacheReadTokens + value.outputTokens) return null;
  const precedingWork = normalizedRequestWork(value.precedingWork);
  const issuedWork = normalizedRequestWork(value.issuedWork);
  return {
    id: value.id, agentId: value.agentId, observedAt: safeTime(value.observedAt),
    cacheLifetime: ["5m", "1h", "mixed", "30m+"].includes(value.cacheLifetime) ? value.cacheLifetime : null,
    uncachedInputTokens: value.uncachedInputTokens, cacheWriteTokens: value.cacheWriteTokens,
    cacheReadTokens: value.cacheReadTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens,
    precedingWork, precedingAssociation: precedingWork.length ? "transcript_adjacency" : null,
    issuedWork, issuedAssociation: issuedWork.length ? "recorded_link" : null,
  };
}
function safeText(value, maximum, allowEmpty = false) { return typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value) ? value : null; }
function safeActivity(value, requests) {
  if (!isObject(value) || !safeText(value.id, 256) || !safeTime(value.timestamp) || !safeText(value.actor, 160)
    || !safeText(value.tool, 160) || safeText(value.detail, 512, true) === null) return null;
  const agentId = value.agentId === null ? null : safeAgent(value.agentId); if (value.agentId !== null && !agentId) return null;
  const durationMs = value.durationMs === null ? null : safeInteger(value.durationMs);
  if (durationMs !== null && durationMs > 86_400_000) return null;
  const requestId = REQUEST_ID.test(value.requestId || "") ? value.requestId : null;
  return { id: value.id, timestamp: safeTime(value.timestamp), actor: value.actor, tool: value.tool,
    workKind: normalizedWorkKind(value.workKind, toolWorkKind(value.tool, { detail: value.detail })), detail: value.detail,
    status: value.status === "failed" ? "failed" : null, durationMs, requestId, agentId,
    requestNumber: requestId ? (requests.get(requestId)?.number || null) : null };
}
function sortRows(items, timestamp) {
  return [...items].sort((a, b) => Date.parse(b[timestamp]) - Date.parse(a[timestamp]) || a.id.localeCompare(b.id));
}
function sortRequests(items) {
  return [...items].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.id.localeCompare(b.id));
}

/** Persisted, browser-safe history only. Provider IDs, paths, and raw records never enter this store. */
export class SessionHistoryStore {
  #records = new Map(); #touch = new Map();
  constructor({ directory = null, maxSessions = MAX_SESSIONS, maxResident = MAX_RESIDENT } = {}) {
    this.directory = directory; this.maxSessions = maxSessions; this.maxResident = maxResident;
  }
  async publish(sessionId, candidate) {
    if (typeof sessionId !== "string" || sessionId.length < 3 || sessionId.length > 640) return null;
    // Never replace a usable committed revision with incomplete acquisition.
    if (!candidate || candidate.complete !== true) return this.#load(sessionId);
    const current = await this.#load(sessionId);
    const priorNumbers = new Map(Object.entries(current?.numberRegistry || {}).filter((entry) => Number.isSafeInteger(entry[1])));
    for (const item of current?.requests || []) priorNumbers.set(item.id, item.number);
    let nextNumber = current?.nextNumber || 1;
    const requests = new Map();
    for (const raw of Array.isArray(candidate?.requests) ? candidate.requests : []) {
      const item = safeRequest(raw); if (!item) continue;
      const number = priorNumbers.get(item.id) || nextNumber;
      requests.set(item.id, { ...item, number });
      if (!priorNumbers.has(item.id)) nextNumber += 1;
    }
    nextNumber = Math.max(nextNumber, ...[...requests.values()].map((item) => item.number + 1));
    const numberRegistry = Object.fromEntries(priorNumbers);
    for (const item of requests.values()) numberRegistry[item.id] = item.number;
    const activities = new Map();
    for (const raw of Array.isArray(candidate?.activity) ? candidate.activity : []) {
      const normal = safeActivity(raw, requests); if (!normal) continue;
      activities.set(normal.id, normal);
    }
    const resolvedActivity = [...activities.values()].map((item) => ({
      ...item, requestNumber: item.requestId ? (requests.get(item.requestId)?.number || null) : null,
    }));
    const record = { version: 1, sessionId, revision: (current?.revision || 0) + 1, complete: candidate?.complete === true,
      nextNumber, numberRegistry, requests: sortRequests([...requests.values()]), activity: sortRows(resolvedActivity, "timestamp") };
    if (current && JSON.stringify({ ...current, revision: 0 }) === JSON.stringify({ ...record, revision: 0 })) return current;
    await this.#write(record); this.#remember(sessionId, record); return record;
  }
  async read(sessionId, query = {}) {
    // Serving deliberately consumes only a compact committed index and the
    // selected data blocks. Full normalized arrays are materialized only by
    // background publication/replacement, never a GET.
    if (this.directory) return (await this.#readIndexed(sessionId, query)) || { status: "unavailable", kind: query.kind === "requests" ? "requests" : "activity", revision: "0", total: 0, offset: 0, items: [], linkedCount: 0 };
    const record = await this.#load(sessionId); const kind = query.kind === "requests" ? "requests" : "activity";
    if (!record) return { status: "unavailable", kind, revision: "0", total: 0, offset: 0, items: [], linkedCount: 0 };
    let rows = record[kind]; const scope = query.scope || "all";
    if (scope === "primary") rows = rows.filter((item) => item.agentId === "primary");
    else if (scope === "subagents") rows = rows.filter((item) => item.agentId && item.agentId !== "primary");
    else if (scope !== "all" && safeAgent(scope)) rows = rows.filter((item) => item.agentId === scope);
    if (kind === "activity" && REQUEST_ID.test(query.filterRequestId || "")) rows = rows.filter((item) => item.requestId === query.filterRequestId);
    const total = rows.length; const maximum = kind === "activity" ? 8 : 60;
    const limit = Math.max(1, Math.min(maximum, Number.parseInt(query.limit, 10) || maximum));
    let offset = query.offset === "latest" ? Math.max(0, total - limit)
      : query.offset === "last" ? Math.max(0, total - limit)
        : Math.max(0, Number.parseInt(query.offset, 10) || 0);
    const target = kind === "requests" ? query.requestId : (query.requestId || query.anchor);
    if (typeof target === "string") {
      const index = rows.findIndex((item) => item.id === target || (kind === "activity" && item.requestId === target));
      if (index >= 0 && kind === "activity" && query.anchor) offset = index;
      else if (index >= 0 && kind === "activity") offset = Math.floor(index / limit) * limit;
      else if (index >= 0) offset = Math.max(0, index - Math.floor(limit / 2));
    }
    offset = Math.min(offset, Math.max(0, total - 1));
    const items = rows.slice(offset, offset + limit).map(clone);
    const requestedId = query.requestId || query.filterRequestId;
    const linkedCount = kind === "requests" && REQUEST_ID.test(requestedId || "")
      ? record.activity.filter((item) => item.requestId === requestedId && scopeMatches(item, scope)).length
      : REQUEST_ID.test(requestedId || "") ? rows.filter((item) => item.requestId === requestedId).length : 0;
    return { status: "ready", kind, revision: String(record.revision), total, offset, items, linkedCount };
  }
  async #load(sessionId) {
    if (this.#records.has(sessionId)) { this.#touch.set(sessionId, Date.now()); return this.#records.get(sessionId); }
    if (!this.directory) return null;
    try { const value = JSON.parse(await readFile(path.join(this.directory, fileName(sessionId)), "utf8"));
      if (!this.#validRecord(value, sessionId)) return null;
      const requests = new Map(value.requests.map((raw) => {
        const item = safeRequest(raw); return [item.id, { ...item, number: raw.number }];
      }));
      const normalized = { version: 1, sessionId, revision: value.revision, complete: value.complete === true,
        nextNumber: value.nextNumber, requests: sortRequests([...requests.values()]),
        activity: sortRows(value.activity.map((item) => safeActivity(item, requests)), "timestamp") };
      this.#remember(sessionId, normalized); return normalized;
    } catch { return null; }
  }
  #remember(sessionId, value) { this.#records.set(sessionId, value); this.#touch.set(sessionId, Date.now());
    while (this.#records.size > this.maxResident) { const oldest = [...this.#touch.entries()].sort((a,b) => a[1]-b[1])[0]?.[0]; if (!oldest) break; this.#records.delete(oldest); this.#touch.delete(oldest); }
  }
  #validRecord(value, sessionId) {
    if (!isObject(value) || value.version !== 1 || value.sessionId !== sessionId || !Number.isSafeInteger(value.revision)
      || !Number.isSafeInteger(value.nextNumber) || !Array.isArray(value.requests) || !Array.isArray(value.activity)) return false;
    const requests = new Map();
    for (const raw of value.requests) { const item = safeRequest(raw); if (!item || !Number.isSafeInteger(raw.number) || raw.number < 1 || requests.has(item.id)) return false; requests.set(item.id, { ...item, number: raw.number }); }
    return value.activity.every((item) => Boolean(safeActivity(item, requests)));
  }
  async #write(record) {
    if (!this.directory) return;
    await mkdir(this.directory, { recursive: true });
    const key = crypto.createHash("sha256").update(record.sessionId).digest("hex");
    const destination = path.join(this.directory, `${key}.index.json`);
    let previousRevision = null;
    try { const prior = JSON.parse(await readFile(destination, "utf8")); if (Number.isSafeInteger(prior?.revision) && prior.revision > 0) previousRevision = prior.revision; } catch { /* no committed prior generation */ }
    const generation = `${key}-${record.revision}`;
    const generationDir = path.join(this.directory, generation);
    await mkdir(generationDir, { recursive: true });
    const index = { version: 2, sessionId: record.sessionId, revision: record.revision, complete: record.complete,
      nextNumber: record.nextNumber, requests: [], activity: [] };
    for (const kind of ["requests", "activity"]) {
      const rows = record[kind];
      for (let page = 0; page * PAGE_ROWS < rows.length; page += 1) {
        const block = rows.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS);
        await writeFile(path.join(generationDir, `${kind}-${page}.json`), JSON.stringify(block), "utf8");
        for (let slot = 0; slot < block.length; slot += 1) {
          const item = block[slot]; index[kind].push(kind === "requests"
            ? { id: item.id, agentId: item.agentId, number: item.number, page, slot }
            : { id: item.id, agentId: item.agentId, requestId: item.requestId, page, slot });
        }
      }
    }
    // Complete backing snapshot is durable before the manifest makes this
    // generation visible to serving readers.
    const legacy = path.join(this.directory, fileName(record.sessionId)); const legacyTemp = `${legacy}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(legacyTemp, JSON.stringify(record), "utf8"); await rename(legacyTemp, legacy);
    const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify(index), "utf8"); await rename(temp, destination);
    // Publication is complete before pruning. Retain the immediately previous
    // generation for readers that obtained its manifest just before the swap.
    void this.#pruneGenerations(key, new Set([record.revision, previousRevision].filter(Number.isSafeInteger)));
  }
  async #pruneGenerations(key, keep) {
    let names; try { names = await readdir(this.directory, { withFileTypes: true }); } catch { return; }
    const root = path.resolve(this.directory); const prefix = `${key}-`;
    await Promise.allSettled(names.filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix)).map(async (entry) => {
      const revision = Number(entry.name.slice(prefix.length));
      if (!Number.isSafeInteger(revision) || keep.has(revision)) return;
      const target = path.resolve(root, entry.name);
      // Never recursively remove an unresolved or escaping path on Windows.
      if (!target.startsWith(`${root}${path.sep}`)) return;
      await rm(target, { recursive: true, force: true });
    }));
  }
  async #readIndexed(sessionId, query) {
    const key = crypto.createHash("sha256").update(sessionId).digest("hex"); let index;
    try { index = JSON.parse(await readFile(path.join(this.directory, `${key}.index.json`), "utf8")); } catch { return null; }
    const kind = query.kind === "requests" ? "requests" : "activity";
    if (!isObject(index) || index.version !== 2 || index.sessionId !== sessionId || !Number.isSafeInteger(index.revision) || index.revision < 1 || !Array.isArray(index[kind]) || !Array.isArray(index.activity) || !Array.isArray(index.requests)) return null;
    const scope = query.scope || "all";
    let refs = index[kind].filter((item) => isObject(item) && typeof item.id === "string" && Number.isSafeInteger(item.page) && Number.isSafeInteger(item.slot) && scopeMatches(item, scope));
    if (kind === "activity" && REQUEST_ID.test(query.filterRequestId || "")) refs = refs.filter((item) => item.requestId === query.filterRequestId);
    const total = refs.length; const maximum = kind === "activity" ? 8 : 60; const limit = Math.max(1, Math.min(maximum, Number.parseInt(query.limit, 10) || maximum));
    let offset = query.offset === "latest" || query.offset === "last" ? Math.max(0, total - limit) : Math.max(0, Number.parseInt(query.offset, 10) || 0);
    const target = kind === "requests" ? query.requestId : (query.requestId || query.anchor);
    if (target) { const position = refs.findIndex((item) => item.id === target || (kind === "activity" && item.requestId === target));
      if (position >= 0 && kind === "activity" && query.anchor) offset = position;
      else if (position >= 0 && kind === "activity") offset = Math.floor(position / limit) * limit;
      else if (position >= 0) offset = Math.max(0, position - Math.floor(limit / 2)); }
    offset = Math.min(offset, Math.max(0, total - 1)); const selected = refs.slice(offset, offset + limit);
    const blocks = new Map();
    await Promise.all([...new Set(selected.map((item) => item.page))].map(async (page) => {
      try { blocks.set(page, JSON.parse(await readFile(path.join(this.directory, `${key}-${index.revision}`, `${kind}-${page}.json`), "utf8"))); } catch { blocks.set(page, []); }
    }));
    const requestNumbers = new Map(index.requests.filter((item) => REQUEST_ID.test(item?.id || "") && Number.isSafeInteger(item.number) && item.number > 0).map((item) => [item.id, { number: item.number }]));
    const items = selected.map((ref) => {
      const raw = blocks.get(ref.page)?.[ref.slot];
      if (kind === "requests") {
        const value = safeRequest(raw); return value && Number.isSafeInteger(raw.number) && raw.number > 0 ? { ...value, number: raw.number } : null;
      }
      return safeActivity(raw, requestNumbers);
    });
    if (items.some((item) => item === null) || items.length !== selected.length) return null;
    const requestedId = query.requestId || query.filterRequestId;
    const linkedCount = REQUEST_ID.test(requestedId || "") ? (kind === "requests" ? index.activity.filter((item) => item.requestId === requestedId && scopeMatches(item, scope)).length : refs.filter((item) => item.requestId === requestedId).length) : 0;
    return { status: "ready", kind, revision: String(index.revision), total, offset, items, linkedCount };
  }
}

function scopeMatches(item, scope) {
  return scope === "all" || !scope || (scope === "primary" && item.agentId === "primary")
    || (scope === "subagents" && item.agentId && item.agentId !== "primary") || item.agentId === scope;
}
