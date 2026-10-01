import crypto from "node:crypto";
import { mkdir, opendir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSafeRecordedRepositoryPath, normalizeRepositorySnapshot } from "../../repository/repository-snapshot.mjs";

export const SESSION_OBSERVATION_CHECKPOINT_VERSION = 1;

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_REPOSITORY_SNAPSHOT_BYTES = 64 * 1024;
// Sidecars outlive their checkpoint: a checkpoint is rebuilt from its transcript, a recorded
// repository snapshot cannot be. They are bounded on their own, oldest first.
const DEFAULT_MAX_REPOSITORY_SNAPSHOTS = 2_000;
const ORPHAN_TEMP_GRACE_MS = 60 * 60 * 1000;
const MAX_COLLECTION_ENTRIES = 4_096;
const DEFAULT_PRIVACY_SENTINELS = Object.freeze([
  "MUST_NOT_LEAK",
  "PRIVATE_",
  "OAUTH_",
  "ENV_SECRET",
  "AUTH_FILE",
]);
const FORBIDDEN_KEY = /(?:prompt|response|reasoning|command|patch|stdout|stderr|tool.?result|oauth|credential|authorization|transcript|diagnostic|fragment|raw)/i;
// These contract-defined normalized fields happen to contain terms rejected by
// the generic raw-content guard. Keep the exception set exact and narrow: the
// provider contract still validates their bounded primitive/enum values.
const ALLOWED_NORMALIZED_KEYS = new Set([
  "cacheMissDiagnosticState",
  "reasoningOutput",
  "transcriptAvailable",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertBounded(value, { depth = 0, maxDepth = 20 } = {}) {
  if (typeof value === "string") {
    if (value.length > 20_000) throw new TypeError("checkpoint strings must be bounded");
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (depth >= maxDepth || (!Array.isArray(value) && !isPlainObject(value))) throw new TypeError("checkpoint value is invalid");
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  let count = 0;
  for (const [key, child] of entries) {
    count += 1;
    if (count > MAX_COLLECTION_ENTRIES || (typeof key === "string" && (key.length > 160
      || (!ALLOWED_NORMALIZED_KEYS.has(key) && FORBIDDEN_KEY.test(key))))) {
      throw new TypeError("checkpoint collection is invalid");
    }
    assertBounded(child, { depth: depth + 1, maxDepth });
  }
}

function assertIdentity(payload) {
  if (typeof payload.providerId !== "string" || payload.providerId.length < 1 || payload.providerId.length > 64) {
    throw new TypeError("checkpoint provider identity is invalid");
  }
  if (typeof payload.localSessionId !== "string" || payload.localSessionId.length < 1 || payload.localSessionId.length > 512) {
    throw new TypeError("checkpoint session identity is invalid");
  }
}

// Shape-only: this never resolves against a real filesystem root, so it
// rejects every forbidden spelling (absolute, drive, UNC/device, traversal,
// backslashes, control characters, private-root segments) independent of
// repositoryRelativePath, which validates against an actual session cwd.
// Shared with repository-snapshot.mjs's recorded repository files so the
// two checkpoint-adjacent sidecars apply one identical path rule.
function assertSafeFileChangePath(value, label) {
  if (!isSafeRecordedRepositoryPath(value)) throw new TypeError(`checkpoint ${label} is invalid`);
}

function assertFileChanges(evidence) {
  const toolCalls = Array.isArray(evidence?.toolCalls) ? evidence.toolCalls : [];
  for (const toolCall of toolCalls) {
    const fileChanges = toolCall?.fileChanges;
    if (fileChanges === null || fileChanges === undefined) continue;
    if (!Array.isArray(fileChanges)) throw new TypeError("checkpoint file change evidence is invalid");
    for (const change of fileChanges) {
      if (change?.repositoryId !== undefined && (typeof change.repositoryId !== "string" || !/^repo-[a-f0-9]{24}$/.test(change.repositoryId))) {
        throw new TypeError("checkpoint file change repository is invalid");
      }
      assertSafeFileChangePath(change?.path, "file change path");
      if (change?.kind === "moved") assertSafeFileChangePath(change?.previousPath, "file change previous path");
      else if (change?.previousPath !== null && change?.previousPath !== undefined) {
        throw new TypeError("checkpoint file change previous path is invalid");
      }
    }
  }
}

function assertPrivacy(payload, sentinels) {
  const serialized = JSON.stringify(payload);
  for (const sentinel of sentinels) {
    if (serialized.includes(sentinel)) throw new TypeError("checkpoint privacy validation failed");
  }
  assertBounded(payload);
}

function sourceForCheckpoint(source) {
  if (source === null || source === undefined) return null;
  if (!isPlainObject(source)) throw new TypeError("checkpoint source is invalid");
  const fingerprint = source.fingerprint ?? null;
  const completeOffset = source.completeOffset ?? null;
  if (fingerprint !== null && (typeof fingerprint !== "string" || fingerprint.length > 256)) {
    throw new TypeError("checkpoint fingerprint is invalid");
  }
  if (completeOffset !== null && (!Number.isSafeInteger(completeOffset) || completeOffset < 0)) {
    throw new TypeError("checkpoint complete offset is invalid");
  }
  return { fingerprint, completeOffset };
}

function payloadFromSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) {
    throw new TypeError("checkpoint snapshot is invalid");
  }
  const payload = {
    version: SESSION_OBSERVATION_CHECKPOINT_VERSION,
    providerId: snapshot.providerId,
    localSessionId: snapshot.localSessionId,
    source: sourceForCheckpoint(snapshot.source),
    evidence: snapshot.evidence,
    readiness: snapshot.readiness,
    revision: snapshot.revision,
    observedAt: snapshot.observedAt,
  };
  assertCheckpointPayload(payload);
  return payload;
}

function identityHash(providerId, localSessionId) {
  return crypto.createHash("sha256").update(`${providerId}\u0000${localSessionId}`).digest("hex");
}

export function checkpointFilename(providerId, localSessionId) {
  return `checkpoint-${identityHash(providerId, localSessionId)}.json`;
}

/** The repository-snapshot sidecar shares its checkpoint's identity hash, never its filename. */
export function repositorySnapshotFilename(providerId, localSessionId) {
  return `repository-${identityHash(providerId, localSessionId)}.json`;
}

/** Validate the versioned, bounded and privacy-filtered L2 schema. */
export function assertCheckpointPayload(payload, privacySentinels = DEFAULT_PRIVACY_SENTINELS) {
  if (!isPlainObject(payload) || payload.version !== SESSION_OBSERVATION_CHECKPOINT_VERSION) {
    throw new TypeError("checkpoint version is unsupported");
  }
  const keys = Object.keys(payload).sort();
  const expected = ["evidence", "localSessionId", "observedAt", "providerId", "readiness", "revision", "source", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("checkpoint schema is invalid");
  }
  assertIdentity(payload);
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 1 || !Number.isFinite(Date.parse(payload.observedAt || ""))) {
    throw new TypeError("checkpoint metadata is invalid");
  }
  sourceForCheckpoint(payload.source);
  if (!isPlainObject(payload.readiness) || payload.evidence === undefined) throw new TypeError("checkpoint evidence is invalid");
  assertFileChanges(payload.evidence);
  assertPrivacy(payload, privacySentinels);
  return payload;
}

/**
 * L2 persistence for complete L1 observations. It never accepts raw records or
 * public response state, so restart recovery must re-project public state locally.
 */
export class SessionObservationCheckpointStore {
  constructor({
    directory,
    validateCandidate = () => true,
    upgradeEvidence = null,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRepositorySnapshots = DEFAULT_MAX_REPOSITORY_SNAPSHOTS,
    privacySentinels = DEFAULT_PRIVACY_SENTINELS,
    tempGraceMs = ORPHAN_TEMP_GRACE_MS,
  } = {}) {
    if (typeof directory !== "string" || directory.length === 0 || typeof validateCandidate !== "function") {
      throw new TypeError("checkpoint directory and validation hook are required");
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError("checkpoint limits must be positive safe integers");
    }
    if (!Number.isSafeInteger(maxRepositorySnapshots) || maxRepositorySnapshots < 1) {
      throw new TypeError("repository snapshot limit must be a positive safe integer");
    }
    this.directory = directory;
    this.validateCandidate = validateCandidate;
    // Restore-time normalization of evidence recorded before a later field existed
    // (see withLegacyRepositoryAttribution); never applied to writes.
    this.upgradeEvidence = typeof upgradeEvidence === "function" ? upgradeEvidence : null;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.maxRepositorySnapshots = maxRepositorySnapshots;
    this.privacySentinels = Object.freeze([...privacySentinels]);
    this.tempGraceMs = Number.isSafeInteger(tempGraceMs) && tempGraceMs >= 0 ? tempGraceMs : ORPHAN_TEMP_GRACE_MS;
    this.inventory = new Map();
    this.ownedTemps = new Set();
    this.fileLocks = new Map();
    this.writeGeneration = 0;
    this.maintenance = { cursor: null, inventory: new Map(), sidecars: new Map(), removals: [], cycle: 0, startedGeneration: 0 };
    this.qa = { writes: 0, writtenBytes: 0, loads: 0, restored: 0, singleLoads: 0, singleRestored: 0, skipped: 0, ignored: 0, pruned: 0,
      maintenanceEntries: 0, maintenanceDeletes: 0, maintenanceCycles: 0 };
  }

  async write(snapshot) {
    const payload = payloadFromSnapshot(snapshot);
    assertCheckpointPayload(payload, this.privacySentinels);
    if (this.validateCandidate({
      providerId: payload.providerId,
      localSessionId: payload.localSessionId,
      source: payload.source,
      evidence: payload.evidence,
      readiness: payload.readiness,
      revision: payload.revision,
      observedAt: payload.observedAt,
    }) === false) {
      throw new TypeError("checkpoint candidate was rejected");
    }
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > this.maxBytes) throw new TypeError("checkpoint exceeds byte budget");
    await mkdir(this.directory, { recursive: true });
    const filename = checkpointFilename(payload.providerId, payload.localSessionId);
    const target = path.join(this.directory, filename);
    const temporary = path.join(this.directory, `.${filename}.${crypto.randomUUID()}.tmp`);
    let committed = false;
    this.ownedTemps.add(temporary);
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
      await this.#withFileLock(filename, async () => {
        await rename(temporary, target);
        const info = await stat(target);
        this.inventory.set(filename, { size: info.size, modified: info.mtimeMs, valid: true, generation: ++this.writeGeneration });
      });
      committed = true;
    } finally {
      this.ownedTemps.delete(temporary);
      if (!committed) await unlink(temporary).catch(() => {});
    }
    const bytes = Buffer.byteLength(serialized);
    // Writes update only their own known inventory entry.  Capacity eviction,
    // corruption reconciliation and orphan cleanup are maintenance work.
    this.qa.writes += 1;
    this.qa.writtenBytes += bytes;
    return Object.freeze({ filename, bytes });
  }

  /**
   * Write one bounded historical repository snapshot sidecar for a checkpointed
   * session, atomically like `write`. The sidecar is validated independently
   * (contract shape, byte budget, privacy sentinels) and never touches the
   * checkpoint payload itself. It outlives an evicted checkpoint; maintenance
   * removes it only under the sidecars' own bound.
   */
  async writeRepositorySnapshot(providerId, localSessionId, snapshot) {
    const normalized = normalizeRepositorySnapshot(snapshot);
    if (!normalized) throw new TypeError("repository snapshot is invalid");
    assertIdentity({ providerId, localSessionId });
    const payload = { version: SESSION_OBSERVATION_CHECKPOINT_VERSION, providerId, localSessionId, snapshot: normalized };
    assertPrivacy(payload, this.privacySentinels);
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > MAX_REPOSITORY_SNAPSHOT_BYTES) throw new TypeError("repository snapshot exceeds byte budget");
    await mkdir(this.directory, { recursive: true });
    const filename = repositorySnapshotFilename(providerId, localSessionId);
    const target = path.join(this.directory, filename);
    const temporary = path.join(this.directory, `.${filename}.${crypto.randomUUID()}.tmp`);
    let committed = false;
    this.ownedTemps.add(temporary);
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
      await this.#withFileLock(filename, () => rename(temporary, target));
      committed = true;
    } finally {
      this.ownedTemps.delete(temporary);
      if (!committed) await unlink(temporary).catch(() => {});
    }
    return Object.freeze({ filename, bytes: Buffer.byteLength(serialized) });
  }

  /**
   * Read valid repository-snapshot sidecars on startup; invalid ones are silently ignored.
   * `withCheckpoint` reads only the sidecars whose checkpoint is on disk: the set the bulk
   * checkpoint restore projects, so startup cost follows the checkpoint bound rather than
   * every retained sidecar. Any other session reads its own file through
   * `loadRepositorySnapshot`.
   */
  async loadRepositorySnapshots({ withCheckpoint = false } = {}) {
    const records = [];
    const checkpoints = withCheckpoint ? new Set(await this.#filenames()) : null;
    for (const filename of await this.#repositorySnapshotFilenames()) {
      if (checkpoints && !checkpoints.has(filename.replace(/^repository-/, "checkpoint-"))) continue;
      const record = await this.#readRepositorySnapshot(filename);
      if (record) records.push(record);
    }
    return Object.freeze(records);
  }

  /** Read one session's sidecar by its identity-keyed filename, without a directory scan. */
  async loadRepositorySnapshot(providerId, localSessionId) {
    assertIdentity({ providerId, localSessionId });
    const record = await this.#readRepositorySnapshot(repositorySnapshotFilename(providerId, localSessionId));
    return record && record.providerId === providerId && record.localSessionId === localSessionId ? record.snapshot : null;
  }

  async #readRepositorySnapshot(filename) {
    try {
      const payload = JSON.parse(await readFile(path.join(this.directory, filename), "utf8"));
      if (!isPlainObject(payload) || payload.version !== SESSION_OBSERVATION_CHECKPOINT_VERSION) return null;
      assertIdentity(payload);
      const snapshot = normalizeRepositorySnapshot(payload.snapshot);
      if (!snapshot) return null;
      assertPrivacy(payload, this.privacySentinels);
      return Object.freeze({ providerId: payload.providerId, localSessionId: payload.localSessionId, snapshot });
    } catch {
      // An absent, unreadable or invalid sidecar contributes nothing.
      return null;
    }
  }

  /**
   * Read compatible records on startup. The caller supplies projection because
   * public response state is intentionally not stored in the checkpoint.
   */
  async load({ projectState = ({ evidence }) => evidence, includeRecord = () => true } = {}) {
    if (typeof projectState !== "function" || typeof includeRecord !== "function") {
      throw new TypeError("checkpoint load hooks must be functions");
    }
    const records = [];
    let ignored = 0;
    let skipped = 0;
    for (const filename of await this.#filenames()) {
      const payload = await this.#readPayload(filename);
      if (!payload) {
        ignored += 1;
        continue;
      }
      if (!includeRecord(payload)) {
        skipped += 1;
        continue;
      }
      try {
        records.push(this.#restoreCandidate(payload, projectState));
      } catch {
        ignored += 1;
      }
    }
    // Startup may enumerate valid checkpoints to restore durable evidence, but
    // never turns that path into a cleanup scan.  Orphan temps are left for
    // bounded maintenance after live observation has priority.
    this.qa.loads += 1;
    this.qa.restored += records.length;
    this.qa.skipped += skipped;
    this.qa.ignored += ignored;
    return Object.freeze({ records: Object.freeze(records), skipped, ignored });
  }

  /**
   * Read one session's checkpoint by its identity-keyed filename, with the same
   * payload, upgrade and candidate validation as `load`. It never enumerates the
   * directory. Returns null when the file is absent, invalid or rejected.
   */
  async loadOne(providerId, localSessionId, { projectState = ({ evidence }) => evidence } = {}) {
    if (typeof projectState !== "function") throw new TypeError("checkpoint load hooks must be functions");
    assertIdentity({ providerId, localSessionId });
    this.qa.singleLoads += 1;
    const payload = await this.#readPayload(checkpointFilename(providerId, localSessionId));
    if (!payload || payload.providerId !== providerId || payload.localSessionId !== localSessionId) return null;
    try {
      const candidate = this.#restoreCandidate(payload, projectState);
      this.qa.singleRestored += 1;
      return candidate;
    } catch {
      this.qa.ignored += 1;
      return null;
    }
  }

  #restoreCandidate(payload, projectState) {
    const evidence = this.upgradeEvidence ? this.upgradeEvidence(payload.providerId, payload.evidence) : payload.evidence;
    const restored = evidence === payload.evidence ? payload : { ...payload, evidence };
    const candidate = {
      providerId: restored.providerId,
      localSessionId: restored.localSessionId,
      source: restored.source,
      evidence: restored.evidence,
      readiness: restored.readiness,
      revision: restored.revision,
      observedAt: restored.observedAt,
      publicState: projectState(restored),
    };
    if (this.validateCandidate(candidate) === false) throw new TypeError("candidate rejected");
    return Object.freeze(candidate);
  }

  async prune({ preserveFilename = null } = {}) {
    const files = [];
    for (const filename of await this.#filenames()) {
      try {
        const [info, payload] = await Promise.all([stat(path.join(this.directory, filename)), this.#readPayload(filename)]);
        files.push({ filename, size: info.size, modified: info.mtimeMs, invalid: !payload });
      } catch {
        // An interrupted or externally removed Pomegr checkpoint is simply ignored.
      }
    }
    files.sort((left, right) => Number(right.invalid) - Number(left.invalid)
      || left.modified - right.modified || left.filename.localeCompare(right.filename));
    let bytes = files.reduce((total, file) => total + file.size, 0);
    let retained = files.length;
    const removed = [];
    for (const file of files) {
      if (!file.invalid && retained <= this.maxEntries && bytes <= this.maxBytes) break;
      if (file.filename === preserveFilename) continue;
      try {
        await unlink(path.join(this.directory, file.filename));
        retained -= 1;
        bytes -= file.size;
        removed.push(file.filename);
      } catch {
        // A concurrent Pomegr writer may have already replaced this file.
      }
    }
    this.qa.pruned += removed.length;
    await this.#pruneRepositorySnapshots();
    return Object.freeze({ entries: retained, bytes, removed: Object.freeze(removed) });
  }

  /**
   * Process at most `budget` directory entries or pending deletes.  The
   * persistent opendir cursor means a directory with thousands of abandoned
   * temp files cannot block startup or a live checkpoint commit.
   */
  async maintenanceStep({ budget = 32, shouldYield = () => false } = {}) {
    budget = Number.isSafeInteger(budget) && budget > 0 ? budget : 32;
    if (typeof shouldYield !== "function") throw new TypeError("checkpoint maintenance yield hook is invalid");
    let processed = 0;
    let deleted = 0;
    const state = this.maintenance;
    while (processed < budget && state.removals.length && !shouldYield()) {
      const removal = state.removals.shift();
      const filename = removal.filename;
      processed += 1;
      const target = path.join(this.directory, filename);
      try { await this.#withFileLock(filename, async () => {
        if (this.ownedTemps.has(target)) return;
        if (removal.generation !== undefined && (this.inventory.get(filename)?.generation || 0) !== removal.generation) return;
        if (removal.modified !== null) {
          const current = await stat(target);
          if (current.mtimeMs !== removal.modified || (removal.size !== null && current.size !== removal.size)) return;
        }
        await unlink(target); deleted += 1; this.inventory.delete(filename);
      }); } catch { /* retry only on a later reconcile */ }
    }
    if (processed >= budget || shouldYield()) return this.#maintenanceResult(processed, deleted);
    if (!state.cursor) {
      try { state.cursor = await opendir(this.directory); state.inventory = new Map(); state.sidecars = new Map(); state.startedGeneration = this.writeGeneration; state.cycle += 1; this.qa.maintenanceCycles += 1; }
      catch (error) { if (error?.code === "ENOENT") return this.#maintenanceResult(processed, deleted); throw error; }
    }
    while (processed < budget && state.cursor && !shouldYield()) {
      const entry = await state.cursor.read();
      if (!entry) {
        await state.cursor.close().catch(() => {});
        state.cursor = null;
        for (const [filename, info] of this.inventory) if (info.generation > state.startedGeneration) state.inventory.set(filename, info);
        this.inventory = state.inventory;
        state.removals.push(...this.#plannedEvictions());
        // A checkpoint eviction never takes its sidecar: the checkpoint is rebuilt from the
        // transcript on the next hydration, the recorded repository state cannot be. Sidecars
        // leave only under their own bound, and a rewrite after planning is rechecked above.
        const excess = state.sidecars.size - this.maxRepositorySnapshots;
        if (excess > 0) {
          const oldest = [...state.sidecars].sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]));
          for (const [filename, modified] of oldest.slice(0, excess)) state.removals.push({ filename, modified, size: null });
        }
        break;
      }
      processed += 1;
      const filename = entry.name;
      if (!entry.isFile()) continue;
      if (/^checkpoint-[a-f0-9]{64}\.json$/u.test(filename)) {
        try {
          const info = await stat(path.join(this.directory, filename));
          const known = this.inventory.get(filename);
          const payload = known?.valid && known.size === info.size && known.modified === info.mtimeMs
            ? true : await this.#readPayload(filename);
          if (payload) state.inventory.set(filename, { size: info.size, modified: info.mtimeMs, valid: true, generation: known?.generation || 0 });
          else state.removals.push({ filename, modified: info.mtimeMs, size: info.size, generation: known?.generation || 0 });
        } catch { /* a concurrent replacement is reconciled next cycle */ }
      } else if (/^repository-[a-f0-9]{64}\.json$/u.test(filename)) {
        try { state.sidecars.set(filename, (await stat(path.join(this.directory, filename))).mtimeMs); } catch { /* retry later */ }
      } else if (/^\.(?:checkpoint|repository)-[a-f0-9]{64}\.json\.[a-f0-9-]+\.tmp$/u.test(filename)) {
        // Only our exact atomic-write naming convention is eligible, and only
        // after a conservative age grace. Never remove arbitrary dot files.
        try {
          const info = await stat(path.join(this.directory, filename));
          if (!this.ownedTemps.has(path.join(this.directory, filename)) && Date.now() - info.mtimeMs >= this.tempGraceMs) {
            state.removals.push({ filename, modified: info.mtimeMs, size: info.size });
          }
        } catch { /* retry later */ }
      }
    }
    return this.#maintenanceResult(processed, deleted);
  }

  #plannedEvictions() {
    const files = [...this.inventory.entries()].map(([filename, info]) => ({ filename, ...info }));
    files.sort((left, right) => left.modified - right.modified || left.filename.localeCompare(right.filename));
    let bytes = files.reduce((total, file) => total + file.size, 0);
    let entries = files.length;
    const removed = [];
    for (const file of files) {
      if (entries <= this.maxEntries && bytes <= this.maxBytes) break;
      removed.push({ filename: file.filename, modified: file.modified, size: file.size, generation: file.generation || 0 }); entries -= 1; bytes -= file.size;
    }
    return removed;
  }

  #maintenanceResult(processed, deleted) {
    this.qa.maintenanceEntries += processed;
    this.qa.maintenanceDeletes += deleted;
    return Object.freeze({ processed, deleted, pending: this.maintenance.removals.length,
      scanning: this.maintenance.cursor ? 1 : 0, entries: this.inventory.size });
  }

  #withFileLock(filename, task) {
    const key = /[a-f0-9]{64}/u.exec(filename)?.[0] || filename;
    const previous = this.fileLocks.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(task);
    this.fileLocks.set(key, pending);
    return pending.finally(() => { if (this.fileLocks.get(key) === pending) this.fileLocks.delete(key); });
  }

  async closeMaintenance() {
    if (this.maintenance.cursor) await this.maintenance.cursor.close().catch(() => {});
    this.maintenance.cursor = null;
    this.maintenance.removals = [];
  }

  /** Monitor-private bounded counters; never serialized to browser responses. */
  stats() {
    return Object.freeze({ ...this.qa, maxEntries: this.maxEntries, maxBytes: this.maxBytes });
  }

  async #filenames() {
    return this.#matchingFilenames(/^checkpoint-[a-f0-9]{64}\.json$/u);
  }

  async #repositorySnapshotFilenames() {
    return this.#matchingFilenames(/^repository-[a-f0-9]{64}\.json$/u);
  }

  async #matchingFilenames(pattern) {
    let directory;
    try {
      directory = await opendir(this.directory);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const names = [];
    try {
      for (let entry = await directory.read(); entry; entry = await directory.read()) {
        if (entry.isFile() && pattern.test(entry.name)) names.push(entry.name);
      }
    } finally { await directory.close().catch(() => {}); }
    return names.sort();
  }

  /**
   * A repository-snapshot sidecar is removed when it is invalid, or when it is among the oldest
   * beyond the sidecars' own bound. It is never removed with its checkpoint: an evicted
   * checkpoint is rebuilt from its transcript, a recorded repository snapshot cannot be.
   */
  async #pruneRepositorySnapshots() {
    const valid = [];
    for (const filename of await this.#repositorySnapshotFilenames()) {
      const filePath = path.join(this.directory, filename);
      let remove;
      try {
        const payload = JSON.parse(await readFile(filePath, "utf8"));
        remove = !(isPlainObject(payload) && payload.version === SESSION_OBSERVATION_CHECKPOINT_VERSION
          && Boolean(normalizeRepositorySnapshot(payload.snapshot)));
      } catch (error) {
        remove = error?.code !== "ENOENT";
      }
      if (remove) {
        try { await unlink(filePath); } catch { /* A concurrent writer may have already removed it. */ }
        continue;
      }
      try { valid.push({ filePath, filename, modified: (await stat(filePath)).mtimeMs }); } catch { /* removed meanwhile */ }
    }
    valid.sort((left, right) => left.modified - right.modified || left.filename.localeCompare(right.filename));
    for (const { filePath } of valid.slice(0, Math.max(0, valid.length - this.maxRepositorySnapshots))) {
      try { await unlink(filePath); } catch { /* A concurrent writer may have already removed it. */ }
    }
  }

  async #readPayload(filename) {
    try {
      const payload = JSON.parse(await readFile(path.join(this.directory, filename), "utf8"));
      return assertCheckpointPayload(payload, this.privacySentinels);
    } catch {
      return null;
    }
  }
}
