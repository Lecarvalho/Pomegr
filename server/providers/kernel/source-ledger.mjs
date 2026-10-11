import fs from "node:fs";
import { parseableTimestamp } from "../../normalize/primitives.mjs";

const DEFAULT_MAX_ENTRIES = 20_000;
const MAX_FAMILY_IDENTITIES = 500;
const MAX_IDENTITY_LENGTH = 128;
const DEFAULT_MISS_TTL_MS = 60_000;
const MAX_REMEMBERED_MISSES = 1024;
const MIN_CANONICAL_PATH_CACHE = 8_192;

function safeIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH ? value : null;
}

// Translate an adapter-supplied header into the ledger's bounded neutral shape. Anything
// the adapter did not provide, or provided in an unsafe shape, degrades to null/false.
function normalizeHeader(raw) {
  if (!raw || typeof raw !== "object") return null;
  const localId = safeIdentity(raw.localId);
  if (!localId) return null;
  return {
    localId,
    parentId: safeIdentity(raw.parentId),
    forkedFromId: safeIdentity(raw.forkedFromId),
    groupId: safeIdentity(raw.groupId),
    archived: Boolean(raw.archived),
    createdAt: parseableTimestamp(raw.createdAt),
    lastRecordAt: parseableTimestamp(raw.lastRecordAt),
    // Adapter-defined ordering between two files that carry the same identity.
    preference: Number.isFinite(raw.preference) ? raw.preference : null,
  };
}

function statGeneration(file, operations) {
  let stat;
  try { stat = operations.statSync(file); } catch { return null; }
  if (!stat.isFile()) return null;
  return { identity: `${stat.dev ?? ""}:${stat.ino ?? ""}`, size: stat.size };
}

function canonicalPathKey(file, operations, cache, limit) {
  if (typeof file !== "string" || !file) return file;
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  let resolved;
  try { resolved = operations.realpathSync(file); } catch {
    return process.platform === "win32" ? file.toLowerCase() : file;
  }
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  cache.set(file, key);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
  return key;
}

function preferred(candidate, existing) {
  const left = candidate.preference ?? Number.NEGATIVE_INFINITY;
  const right = existing.preference ?? Number.NEGATIVE_INFINITY;
  if (left !== right) return left > right;
  return !candidate.archived && existing.archived;
}

export function closeSourceFamily(rootId, items) {
  const id = safeIdentity(rootId);
  const entries = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const header = normalizeHeader(item?.header);
    if (!header) continue;
    const existing = entries.get(header.localId);
    if (!existing || preferred(header, existing.header)) {
      entries.set(header.localId, { header, file: typeof item.file === "string" ? item.file : null });
    }
  }
  if (!id || !entries.has(id)) return null;
  const byKey = new Map();
  const link = (key, candidateId) => {
    if (!key) return;
    const list = byKey.get(key);
    if (list) list.push(candidateId); else byKey.set(key, [candidateId]);
  };
  for (const [candidateId, entry] of entries) {
    link(entry.header.parentId, candidateId);
    link(entry.header.forkedFromId, candidateId);
    link(entry.header.groupId, candidateId);
  }
  const included = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const memberId = queue.shift();
    for (const key of [memberId, entries.get(memberId)?.header.groupId].filter(Boolean)) {
      for (const candidateId of byKey.get(key) || []) {
        if (included.has(candidateId)) continue;
        if (included.size >= MAX_FAMILY_IDENTITIES) throw new Error("selected_family_limit");
        included.add(candidateId);
        queue.push(candidateId);
      }
    }
  }
  return [...included].map((memberId) => {
    const entry = entries.get(memberId);
    return { localId: memberId, file: entry.file, header: entry.header };
  });
}

export function createSourceLedger(options = {}) {
  const parseHeader = typeof options.parseHeader === "function" ? options.parseHeader : null;
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES;
  const missTtlMs = Number.isFinite(options.missTtlMs) && options.missTtlMs >= 0 ? options.missTtlMs : DEFAULT_MISS_TTL_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const operations = options.fs || fs;

  /** @type {Map<string, { header: object, file: string|null, generation: object|null, observedGrowthAt: number|null }>} */
  const bySourceId = new Map();
  /** @type {Map<string, string>} canonical file key -> the identity that currently owns it */
  const fileToId = new Map();
  /** @type {Map<string, { header: object, generation: object }>} canonical file key -> its parsed header */
  const fileHeaders = new Map();
  const liveIds = new Set();
  /** @type {Map<string, number>} identity -> time until which a cold miss is remembered */
  const misses = new Map();
  /** @type {Map<string, string>} literal path -> canonical key (see `canonicalPathKey`) */
  const canonicalCache = new Map();
  // Two path forms per file at most (configured root and realpath), so a warm pass over a
  // full ledger never thrashes the memo.
  const canonicalLimit = Math.max(MIN_CANONICAL_PATH_CACHE, maxEntries * 2);
  const canon = (file) => canonicalPathKey(file, operations, canonicalCache, canonicalLimit);

  function removeEntry(id) {
    const entry = bySourceId.get(id);
    if (!entry) return;
    bySourceId.delete(id);
    if (entry.file && fileToId.get(canon(entry.file)) === id) fileToId.delete(canon(entry.file));
  }

  function detachFile(key, exceptId) {
    const owner = fileToId.get(key);
    if (!owner || owner === exceptId) return;
    fileToId.delete(key);
    const stale = bySourceId.get(owner);
    // The path now carries a different identity. The stale identity keeps its topology
    // record but can no longer resolve to a file.
    if (stale && stale.file && canon(stale.file) === key) stale.file = null;
  }

  function evictIfNeeded() {
    if (bySourceId.size <= maxEntries) return;
    for (const id of [...bySourceId.keys()]) {
      if (bySourceId.size <= maxEntries) break;
      if (!liveIds.has(id)) removeEntry(id);
    }
  }

  // The cached header of a file whose filesystem identity is unchanged and which has only
  // grown since it was parsed (an append-only transcript keeps its header), else null.
  function cachedHeader(file) {
    const key = canon(file);
    const cached = typeof key === "string" ? fileHeaders.get(key) : null;
    if (!cached) return null;
    const current = statGeneration(file, operations);
    if (!current || current.identity !== cached.generation.identity || current.size < cached.generation.size) return null;
    const ownerId = fileToId.get(key);
    const owner = ownerId ? bySourceId.get(ownerId) : null;
    if (owner && current.size > (owner.generation?.size ?? 0)) {
      owner.generation = current;
      owner.observedGrowthAt = now();
    }
    return cached.header;
  }

  function rememberFileHeader(key, header, generation) {
    if (!key || !generation) return;
    fileHeaders.delete(key);
    fileHeaders.set(key, { header, generation });
    while (fileHeaders.size > maxEntries) fileHeaders.delete(fileHeaders.keys().next().value);
  }

  function ingestOne(file, rawHeader) {
    const header = normalizeHeader(rawHeader);
    if (!header) return null;
    misses.delete(header.localId);
    const previous = bySourceId.get(header.localId);
    const filePath = typeof file === "string" && file ? file : previous?.file || null;
    const filePathKey = filePath ? canon(filePath) : null;
    const previousKey = previous?.file ? canon(previous.file) : null;
    if (typeof file === "string" && file) rememberFileHeader(filePathKey, header, statGeneration(file, operations));
    if (previous?.file && filePath && previousKey !== filePathKey) {
      // Two files carry one identity (an archived copy, a move). Keep the preferred file
      // while it still exists; otherwise follow the new path.
      if (statGeneration(previous.file, operations) && !preferred(header, previous.header)) return header.localId;
      if (fileToId.get(previousKey) === header.localId) fileToId.delete(previousKey);
    }
    if (filePathKey) detachFile(filePathKey, header.localId);
    const generation = filePath ? statGeneration(filePath, operations) : null;
    let observedGrowthAt = previous?.observedGrowthAt ?? null;
    if (generation) {
      const priorGeneration = previousKey === filePathKey ? previous.generation : null;
      const rotated = Boolean(priorGeneration?.identity) && priorGeneration.identity !== generation.identity;
      const grew = !rotated && Boolean(priorGeneration) && generation.size > priorGeneration.size;
      if (!priorGeneration || rotated || grew) observedGrowthAt = now();
    }
    bySourceId.delete(header.localId);
    bySourceId.set(header.localId, { header, file: filePath, generation, observedGrowthAt });
    if (filePathKey) fileToId.set(filePathKey, header.localId);
    evictIfNeeded();
    return header.localId;
  }

  return {
    ingestHeaders(batch) {
      if (!Array.isArray(batch)) return;
      for (const item of batch) {
        if (!item || typeof item !== "object") continue;
        ingestOne(item.file ?? null, item.header ?? item);
      }
    },

    cachedHeader,

    noticeSource(file) {
      if (typeof file !== "string" || !file || !parseHeader) return null;
      const known = cachedHeader(file);
      if (known) return { localId: known.localId, isNew: false };
      let header;
      try { header = parseHeader(file); } catch { return null; }
      const localId = safeIdentity(header?.localId);
      if (!localId) return null;
      const isNew = !bySourceId.has(localId);
      const ingestedId = ingestOne(file, header);
      return ingestedId ? { localId: ingestedId, isNew } : null;
    },

    locate(localId) {
      const entry = bySourceId.get(safeIdentity(localId));
      return entry ? { header: entry.header, file: entry.file } : null;
    },

    // The root plus its descendants over the index only (see `closeSourceFamily`). The
    // index may lag the disk; adapters verify completeness against a listing.
    family(localId) {
      return closeSourceFamily(localId, [...bySourceId.values()]);
    },

    rememberMiss(localId) {
      const id = safeIdentity(localId);
      if (!id) return;
      misses.delete(id);
      misses.set(id, now() + missTtlMs);
      while (misses.size > MAX_REMEMBERED_MISSES) misses.delete(misses.keys().next().value);
    },

    recentMiss(localId) {
      const id = safeIdentity(localId);
      const until = id ? misses.get(id) : undefined;
      if (until === undefined) return false;
      if (until > now()) return true;
      misses.delete(id);
      return false;
    },

    recency(localId) {
      const entry = bySourceId.get(safeIdentity(localId));
      if (!entry) return null;
      if (entry.header.lastRecordAt) return entry.header.lastRecordAt;
      return entry.observedGrowthAt ? new Date(entry.observedGrowthAt).toISOString() : null;
    },

    // Mark the identities that must never be evicted under memory pressure,
    // replacing any previously marked set.
    markLive(ids) {
      liveIds.clear();
      for (const value of Array.isArray(ids) ? ids : []) {
        const id = safeIdentity(value);
        if (id) liveIds.add(id);
      }
    },

    // Bounded counts only. Never a path, header, or identity.
    stats() {
      return { entries: bySourceId.size, files: fileToId.size, headers: fileHeaders.size, live: liveIds.size, misses: misses.size };
    },
  };
}
