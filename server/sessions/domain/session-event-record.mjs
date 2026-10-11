export const SESSION_EVENT_RECORD_VERSION = 1;
export const SESSION_EVENT_RECORD_LIMIT = 256;

const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const REFILL_KINDS = new Set(["possible_full", "provider_diagnosed", "lifetime_elapsed"]);
const COMPACTION_TRIGGERS = new Set(["automatic", "manual"]);
// A refill occurrence without a kind is a possible full refill; the two partial-rewrite kinds keep their own name.
const OCCURRENCE_KINDS = new Map([[undefined, "possible_full"], ["provider_diagnosed", "provider_diagnosed"], ["lifetime_elapsed", "lifetime_elapsed"]]);
// A snapshot drop is an unexplained context reduction, not a recorded compaction, so it is never recorded.
const BOUNDARY_TRIGGERS = new Map([["automatic_compaction", "automatic"], ["manual_compaction", "manual"]]);
const EMPTY = Object.freeze({ version: SESSION_EVENT_RECORD_VERSION, refills: Object.freeze([]), compactions: Object.freeze([]) });

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalTime(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function entry(at, agentId, field, value, allowed) {
  const time = canonicalTime(at);
  if (time === null || typeof agentId !== "string" || !SAFE_AGENT_ID.test(agentId) || !allowed.has(value)) return null;
  return { at: time, agentId, [field]: value };
}

function bounded(entries) {
  const unique = new Map();
  for (const item of entries) if (item) unique.set(`${item.agentId}\u0000${item.at}`, item);
  return [...unique.values()]
    .sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0))
    .slice(-SESSION_EVENT_RECORD_LIMIT);
}

function frozen(refills, compactions) {
  return Object.freeze({
    version: SESSION_EVENT_RECORD_VERSION,
    refills: Object.freeze(refills.map((item) => Object.freeze(item))),
    compactions: Object.freeze(compactions.map((item) => Object.freeze(item))),
  });
}

function exactKeys(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function normalizeSessionEventRecord(value) {
  if (!isPlainObject(value) || value.version !== SESSION_EVENT_RECORD_VERSION || !exactKeys(value, ["version", "refills", "compactions"])) return null;
  if (!Array.isArray(value.refills) || !Array.isArray(value.compactions)) return null;
  if (value.refills.length > SESSION_EVENT_RECORD_LIMIT || value.compactions.length > SESSION_EVENT_RECORD_LIMIT) return null;
  const refills = [];
  for (const item of value.refills) {
    const normalized = isPlainObject(item) && exactKeys(item, ["at", "agentId", "kind"]) ? entry(item.at, item.agentId, "kind", item.kind, REFILL_KINDS) : null;
    if (!normalized || normalized.at !== item.at) return null;
    refills.push(normalized);
  }
  const compactions = [];
  for (const item of value.compactions) {
    const normalized = isPlainObject(item) && exactKeys(item, ["at", "agentId", "trigger"]) ? entry(item.at, item.agentId, "trigger", item.trigger, COMPACTION_TRIGGERS) : null;
    if (!normalized || normalized.at !== item.at) return null;
    compactions.push(normalized);
  }
  return frozen(bounded(refills), bounded(compactions));
}

export function derivedSessionEventRecord({ cacheEvents, contextBoundaries } = {}) {
  const refills = [];
  if (cacheEvents?.status === "ready" && Array.isArray(cacheEvents.possibleFullRefills)) {
    for (const refill of cacheEvents.possibleFullRefills) {
      if (!Array.isArray(refill?.occurrences)) continue;
      for (const occurrence of refill.occurrences) {
        refills.push(entry(occurrence?.observedAt, refill.agentId, "kind", OCCURRENCE_KINDS.get(occurrence?.kind ?? undefined), REFILL_KINDS));
      }
    }
  }
  const compactions = [];
  for (const boundary of Array.isArray(contextBoundaries) ? contextBoundaries : []) {
    compactions.push(entry(boundary?.timestamp, boundary?.agentId, "trigger", BOUNDARY_TRIGGERS.get(boundary?.kind), COMPACTION_TRIGGERS));
  }
  return frozen(bounded(refills), bounded(compactions));
}

export function mergeSessionEventRecord(prior, next) {
  const left = prior || EMPTY;
  const right = next || EMPTY;
  const merged = frozen(bounded([...left.refills, ...right.refills]), bounded([...left.compactions, ...right.compactions]));
  return prior && JSON.stringify(merged) === JSON.stringify(prior) ? prior : merged;
}

export function sessionEventRecordIsEmpty(record) {
  return !record || (record.refills.length === 0 && record.compactions.length === 0);
}

function parseQualifiedSessionId(value) {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(":");
  if (separator < 1) return null;
  const providerId = value.slice(0, separator);
  const localSessionId = value.slice(separator + 1);
  if (providerId.length > 64 || localSessionId.length < 1 || localSessionId.length > 512) return null;
  return { providerId, localSessionId };
}

const DEFAULT_RECORDER_MAX_ENTRIES = 512;

export function createSessionEventRecorder({ store, maxEntries } = {}) {
  if (!store || typeof store.writeSessionEventRecord !== "function" || typeof store.loadSessionEventRecord !== "function") {
    throw new TypeError("Session event recorder requires a checkpoint store");
  }
  const bound = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_RECORDER_MAX_ENTRIES;
  const entries = new Map();
  const pending = new Map();
  const reading = new Map();

  function retain(qualifiedId, record) {
    entries.delete(qualifiedId);
    entries.set(qualifiedId, record);
    while (entries.size > bound) entries.delete(entries.keys().next().value);
  }

  function ensure(qualifiedId) {
    if (entries.has(qualifiedId)) return Promise.resolve(Boolean(entries.get(qualifiedId)));
    const parsed = parseQualifiedSessionId(qualifiedId);
    if (!parsed) return Promise.resolve(false);
    const inFlight = reading.get(qualifiedId);
    if (inFlight) return inFlight;
    const read = Promise.resolve()
      .then(() => store.loadSessionEventRecord(parsed.providerId, parsed.localSessionId))
      .catch(() => null)
      .then((record) => {
        if (!entries.has(qualifiedId)) retain(qualifiedId, record || null);
        return Boolean(entries.get(qualifiedId));
      })
      .finally(() => { if (reading.get(qualifiedId) === read) reading.delete(qualifiedId); });
    reading.set(qualifiedId, read);
    return read;
  }

  function record(qualifiedId, derived) {
    const parsed = parseQualifiedSessionId(qualifiedId);
    if (!parsed) return Promise.resolve(false);
    const chain = (pending.get(qualifiedId) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await ensure(qualifiedId);
        const previous = entries.get(qualifiedId) || null;
        const next = mergeSessionEventRecord(previous, normalizeSessionEventRecord(derived));
        if (next === previous || sessionEventRecordIsEmpty(next)) return false;
        await store.writeSessionEventRecord(parsed.providerId, parsed.localSessionId, next);
        retain(qualifiedId, next);
        return true;
      })
      .catch(() => false)
      .finally(() => { if (pending.get(qualifiedId) === chain) pending.delete(qualifiedId); });
    pending.set(qualifiedId, chain);
    return chain;
  }

  function recorded(qualifiedId) {
    if (!entries.has(qualifiedId)) return null;
    const held = entries.get(qualifiedId);
    retain(qualifiedId, held);
    return held;
  }

  function has(qualifiedId) {
    return entries.has(qualifiedId);
  }

  return Object.freeze({ ensure, record, recorded, has });
}

export function createSessionEventRecording({ store, isActive, commit } = {}) {
  const recorder = typeof store?.writeSessionEventRecord === "function" ? createSessionEventRecorder({ store }) : null;
  const recommit = (sessionId) => (changed) => { if (changed && isActive()) commit(sessionId); };
  return Object.freeze({
    // A record the recorder has not read yet is read off the request path, and the session's domains recommit when it exists.
    eventRecordForSession(sessionId) {
      if (!recorder) return null;
      if (!recorder.has(sessionId)) void recorder.ensure(sessionId).then(recommit(sessionId)).catch(() => {});
      return recorder.recorded(sessionId);
    },
    onEventRecord(sessionId, record) {
      if (!recorder || !isActive()) return;
      void recorder.record(sessionId, record).then(recommit(sessionId)).catch(() => {});
    },
  });
}
