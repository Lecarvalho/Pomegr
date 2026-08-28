const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value, maximum, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function isoTimestamp(value) {
  const timestamp = value ?? new Date().toISOString();
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError("observedAt must be an ISO timestamp");
  }
  return timestamp;
}

function cloneAndFreeze(value, stack = new WeakSet(), clones = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError("observation values must be JSON-like objects");
  }
  if (stack.has(value)) throw new TypeError("observation values cannot contain cycles");
  if (clones.has(value)) return clones.get(value);
  stack.add(value);
  const clone = Array.isArray(value) ? [] : {};
  clones.set(value, clone);
  for (const [key, child] of Object.entries(value)) clone[key] = cloneAndFreeze(child, stack, clones);
  stack.delete(value);
  return Object.freeze(clone);
}

function normalizeSource(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw new TypeError("source must be an object");
  const fingerprint = value.fingerprint ?? null;
  const completeOffset = value.completeOffset ?? null;
  if (fingerprint !== null) boundedString(fingerprint, 256, "source fingerprint");
  if (completeOffset !== null && (!Number.isSafeInteger(completeOffset) || completeOffset < 0)) {
    throw new TypeError("source completeOffset must be a non-negative safe integer");
  }
  return Object.freeze({ fingerprint, completeOffset });
}

function qualifiedId(providerId, localSessionId) {
  return `${providerId}:${localSessionId}`;
}

/**
 * Runtime-authoritative L1 cache for provider-normalized observations. This module
 * deliberately has no knowledge of provider source formats or browser contracts.
 */
export class SessionObservationStore {
  #entries = new Map();
  #touches = new Map();
  #pinned = new Set();
  #bytes = 0;

  constructor({
    validateCandidate = () => true,
    serialize = JSON.stringify,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxBytes = DEFAULT_MAX_BYTES,
    now = () => Date.now(),
  } = {}) {
    if (typeof validateCandidate !== "function" || typeof serialize !== "function" || typeof now !== "function") {
      throw new TypeError("store hooks must be functions");
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError("store limits must be positive safe integers");
    }
    this.validateCandidate = validateCandidate;
    this.serialize = serialize;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.now = now;
  }

  /**
   * Atomically publish a complete normalized candidate. Validation failure leaves
   * the current revision (the last known-good value) completely untouched.
   */
  publish(candidate) {
    return this.#commit(candidate);
  }

  /** Restore a validated L2 checkpoint while preserving its committed revision. */
  restore(candidate) {
    return this.#commit(candidate, { preserveRevision: true });
  }

  get(providerId, localSessionId) {
    const id = qualifiedId(providerId, localSessionId);
    return this.#get(id);
  }

  getByQualifiedId(id) {
    if (typeof id !== "string") return null;
    return this.#get(id);
  }

  getSerialized(providerId, localSessionId) {
    return this.get(providerId, localSessionId)?.serializedState ?? null;
  }

  setPinned(providerId, localSessionId, pinned = true) {
    const id = qualifiedId(providerId, localSessionId);
    if (pinned) this.#pinned.add(id);
    else this.#pinned.delete(id);
    this.#evict();
  }

  entries() {
    return [...this.#entries.values()];
  }

  stats() {
    return Object.freeze({
      entries: this.#entries.size,
      bytes: this.#bytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      pinnedEntries: [...this.#pinned].filter((id) => this.#entries.has(id)).length,
    });
  }

  #get(id) {
    const snapshot = this.#entries.get(id) ?? null;
    if (snapshot) this.#touches.set(id, this.now());
    return snapshot;
  }

  #commit(candidate, { preserveRevision = false } = {}) {
    let normalized;
    try {
      normalized = this.#normalizeCandidate(candidate, preserveRevision);
      const validation = this.validateCandidate(Object.freeze({
        providerId: normalized.providerId,
        localSessionId: normalized.localSessionId,
        evidence: normalized.evidence,
        readiness: normalized.readiness,
        publicState: normalized.publicState,
        observedAt: normalized.observedAt,
        source: normalized.source,
      }));
      if (validation === false) return Object.freeze({ accepted: false, snapshot: null, reason: "rejected" });
    } catch {
      return Object.freeze({ accepted: false, snapshot: null, reason: "rejected" });
    }

    const previous = this.#entries.get(normalized.qualifiedId);
    if (!preserveRevision && previous
      && previous.serializedState === normalized.serializedState
      && JSON.stringify(previous.evidence) === JSON.stringify(normalized.evidence)
      && JSON.stringify(previous.readiness) === JSON.stringify(normalized.readiness)
      && JSON.stringify(previous.source) === JSON.stringify(normalized.source)) {
      if (candidate.pinned === true) this.#pinned.add(normalized.qualifiedId);
      return Object.freeze({ accepted: true, snapshot: previous, reason: null, unchanged: true });
    }
    const revision = preserveRevision ? normalized.revision : (previous?.revision ?? 0) + 1;
    if (previous && preserveRevision && revision < previous.revision) {
      return Object.freeze({ accepted: false, snapshot: null, reason: "rejected" });
    }
    const snapshot = Object.freeze({
      ...normalized,
      revision,
      sizeBytes: Buffer.byteLength(normalized.serializedState),
    });
    if (snapshot.sizeBytes > this.maxBytes) return Object.freeze({ accepted: false, snapshot: null, reason: "rejected" });

    // Copy-on-write makes one complete revision visible at a time to all readers.
    const entries = new Map(this.#entries);
    const touches = new Map(this.#touches);
    entries.set(snapshot.qualifiedId, snapshot);
    if (candidate.pinned === true) this.#pinned.add(snapshot.qualifiedId);
    touches.set(snapshot.qualifiedId, this.now());
    this.#prune(entries, touches, snapshot.qualifiedId);
    this.#entries = entries;
    this.#touches = touches;
    this.#bytes = [...entries.values()].reduce((total, entry) => total + entry.sizeBytes, 0);
    return Object.freeze({ accepted: true, snapshot, reason: null });
  }

  #normalizeCandidate(candidate, preserveRevision) {
    if (!isPlainObject(candidate)) throw new TypeError("candidate must be an object");
    const providerId = boundedString(candidate.providerId, 64, "providerId");
    const localSessionId = boundedString(candidate.localSessionId, 512, "localSessionId");
    if (!isPlainObject(candidate.readiness) || candidate.evidence === undefined || candidate.publicState === undefined) {
      throw new TypeError("candidate must include evidence, readiness, and publicState");
    }
    const publicState = cloneAndFreeze(candidate.publicState);
    const serializedState = this.serialize(publicState);
    if (typeof serializedState !== "string") throw new TypeError("serialize must return a string");
    const normalized = {
      qualifiedId: qualifiedId(providerId, localSessionId),
      providerId,
      localSessionId,
      evidence: cloneAndFreeze(candidate.evidence),
      readiness: cloneAndFreeze(candidate.readiness),
      publicState,
      serializedState,
      observedAt: isoTimestamp(candidate.observedAt),
      source: normalizeSource(candidate.source),
    };
    if (preserveRevision) {
      if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 1) throw new TypeError("revision is invalid");
      normalized.revision = candidate.revision;
    }
    return normalized;
  }

  #evict() {
    const entries = new Map(this.#entries);
    const touches = new Map(this.#touches);
    this.#prune(entries, touches, null);
    this.#entries = entries;
    this.#touches = touches;
    this.#bytes = [...entries.values()].reduce((total, entry) => total + entry.sizeBytes, 0);
  }

  #prune(entries, touches, protectedId) {
    const totalBytes = () => [...entries.values()].reduce((total, entry) => total + entry.sizeBytes, 0);
    while (entries.size > this.maxEntries || totalBytes() > this.maxBytes) {
      const evictable = [...entries.keys()]
        .filter((id) => id !== protectedId && !this.#pinned.has(id))
        .sort((left, right) => (touches.get(left) ?? 0) - (touches.get(right) ?? 0) || left.localeCompare(right));
      const id = evictable[0];
      if (!id) break;
      entries.delete(id);
      touches.delete(id);
    }
  }
}

export function qualifyObservationId(providerId, localSessionId) {
  return qualifiedId(providerId, localSessionId);
}
