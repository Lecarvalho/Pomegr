import crypto from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizedRequestWork } from "./request-work.mjs";
import { normalizedWorkKind, toolWorkKind } from "./work-kind.mjs";

const MAX_SESSIONS = 24;
const MAX_RESIDENT = 1;
const PAGE_ROWS = 128;
const MAX_INDEX_RESIDENT = 4;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const REQUEST_ID = /^request-[a-f0-9]{16}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fileName(sessionId) {
  return `history-${crypto.createHash("sha256").update(sessionId).digest("hex")}.json`;
}
function admissionFileName(sessionId) {
  return `${crypto.createHash("sha256").update(sessionId).digest("hex")}.admissions.json`;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function safeInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function overviewTuple(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some((item) => safeInteger(item) === null)) return null;
  const tuple = value.slice();
  return Number.isSafeInteger(tuple.reduce((sum, item) => sum + item, 0)) ? tuple : null;
}
function requestOverview(value) {
  return [value.uncachedInputTokens, value.cacheWriteTokens, value.cacheReadTokens, value.outputTokens];
}
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
function validActivityContribution(value) {
  return isObject(value) && Number.isSafeInteger(value.epoch) && value.epoch >= 1
    && Number.isSafeInteger(value.sequence) && value.sequence >= 1 && Array.isArray(value.activity);
}
function validRequestContribution(value) {
  return validActivityContribution(value) && Array.isArray(value.requests);
}
function validAdmission(value) {
  return isObject(value) && Number.isSafeInteger(value.epoch) && value.epoch >= 1
    && Number.isSafeInteger(value.sequence) && value.sequence >= 1
    && Number.isSafeInteger(value.effectiveEpoch) && value.effectiveEpoch >= 1;
}
function admissionValue(value) {
  return validAdmission(value) ? { epoch: value.epoch, sequence: value.sequence, effectiveEpoch: value.effectiveEpoch } : null;
}
function newerContribution(left, right) {
  return left.epoch > right.epoch || left.epoch === right.epoch && left.sequence > right.sequence;
}
function mergePendingContribution(current, next) {
  if (!newerContribution(next, current)) return current;
  if (next.epoch !== current.epoch) return next;
  const activity = new Map();
  for (const item of current.activity) if (item && typeof item.id === "string") activity.set(item.id, item);
  for (const item of next.activity) if (item && typeof item.id === "string") activity.set(item.id, item);
  return { ...next, activity: [...activity.values()] };
}
function sameServedHistory(left, right) {
  return JSON.stringify({ complete: left?.complete === true, activityReady: left?.activityReady !== false,
    requestsReady: left?.requestsReady === true, nextNumber: left?.nextNumber || 1, requests: left?.requests || [], activity: left?.activity || [] })
    === JSON.stringify({ complete: right?.complete === true, activityReady: right?.activityReady !== false,
      requestsReady: right?.requestsReady === true, nextNumber: right?.nextNumber || 1, requests: right?.requests || [], activity: right?.activity || [] });
}

/** Persisted, browser-safe history only. Provider IDs, paths, and raw records never enter this store. */
export class SessionHistoryStore {
  #records = new Map(); #touch = new Map(); #indexCache = new Map(); #indexBytes = 0; #writes = new Map();
  #historyRevision = 0; #revisionSubscribers = new Set(); #activityAdmissions = new Map(); #requestAdmissions = new Map(); #generationLeases = new Map();
  #pendingContributions = new Map(); #pendingRequests = new Map(); #admissionTouch = new Map(); #admissionClock = 0;
  #committedHistory = new Map();
  #admissionRuntime = crypto.randomBytes(16).toString("hex");
  constructor({ directory = null, maxSessions = MAX_SESSIONS, maxResident = MAX_RESIDENT,
    maxIndexResident = MAX_INDEX_RESIDENT, maxIndexBytes = MAX_INDEX_BYTES } = {}) {
    this.directory = directory;
    // This bounds private source-admission bookkeeping only. Normalized history
    // remains available through its durable manifest and page generations.
    this.maxSessions = Number.isSafeInteger(maxSessions) ? Math.max(1, Math.min(MAX_SESSIONS, maxSessions)) : MAX_SESSIONS;
    this.maxResident = maxResident;
    this.maxIndexResident = Number.isSafeInteger(maxIndexResident) ? Math.max(0, Math.min(MAX_INDEX_RESIDENT, maxIndexResident)) : MAX_INDEX_RESIDENT;
    this.maxIndexBytes = Number.isSafeInteger(maxIndexBytes) ? Math.max(0, Math.min(MAX_INDEX_BYTES, maxIndexBytes)) : MAX_INDEX_BYTES;
  }
  #serialized(sessionId, task) {
    const previous = this.#writes.get(sessionId) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.#writes.set(sessionId, next);
    return next.finally(() => { if (this.#writes.get(sessionId) === next) this.#writes.delete(sessionId); });
  }
  #touchAdmission(sessionId) {
    this.#admissionTouch.set(sessionId, ++this.#admissionClock);
    while (this.#admissionTouch.size > this.maxSessions) {
      const oldest = [...this.#admissionTouch.entries()].sort((left, right) => left[1] - right[1])[0]?.[0];
      if (!oldest) break;
      this.#admissionTouch.delete(oldest);
      this.#activityAdmissions.delete(oldest);
      this.#requestAdmissions.delete(oldest);
    }
  }
  #admission(domain, sessionId) {
    const value = (domain === "activity" ? this.#activityAdmissions : this.#requestAdmissions).get(sessionId) || null;
    if (value) this.#touchAdmission(sessionId);
    return value;
  }
  #setAdmission(domain, sessionId, value) {
    const admission = admissionValue(value);
    if (!admission) return;
    (domain === "activity" ? this.#activityAdmissions : this.#requestAdmissions).set(sessionId, admission);
    this.#touchAdmission(sessionId);
  }
  async #storedAdmissions(sessionId) {
    if (!this.directory) return null;
    try {
      const value = JSON.parse(await readFile(path.join(this.directory, admissionFileName(sessionId)), "utf8"));
      return isObject(value) && value.version === 1 && value.runtime === this.#admissionRuntime ? value : null;
    } catch { return null; }
  }
  async #restoreAdmissions(sessionId) {
    if (this.#activityAdmissions.has(sessionId) || this.#requestAdmissions.has(sessionId) || !this.directory) return;
    const value = await this.#storedAdmissions(sessionId);
    if (!value) return;
    if (validAdmission(value.activity)) this.#setAdmission("activity", sessionId, value.activity);
    if (validAdmission(value.requests)) this.#setAdmission("requests", sessionId, value.requests);
  }
  async #writeAdmissions(sessionId, overrides = {}) {
    if (!this.directory) return;
    let activity = admissionValue(overrides.activity || this.#activityAdmissions.get(sessionId));
    let requests = admissionValue(overrides.requests || this.#requestAdmissions.get(sessionId));
    if (!activity || !requests) {
      const previous = await this.#storedAdmissions(sessionId);
      if (!activity) activity = admissionValue(previous?.activity);
      if (!requests) requests = admissionValue(previous?.requests);
    }
    if (!activity && !requests) return;
    await mkdir(this.directory, { recursive: true });
    const destination = path.join(this.directory, admissionFileName(sessionId));
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, runtime: this.#admissionRuntime, activity, requests }), "utf8");
    await rename(temporary, destination);
  }
  #notifyHistoryRevision() {
    this.#historyRevision += 1;
    const event = Object.freeze({ domain: "history", revision: this.#historyRevision });
    for (const subscriber of this.#revisionSubscribers) {
      try { subscriber(event); } catch { /* notification listeners cannot interrupt publication */ }
    }
  }
  historyRevision() { return this.#historyRevision; }
  subscribeRevisionEvents(subscriber) {
    if (typeof subscriber !== "function") throw new TypeError("History revision subscriber must be a function");
    this.#revisionSubscribers.add(subscriber);
    subscriber(Object.freeze({ domain: "history", revision: this.#historyRevision }));
    return () => this.#revisionSubscribers.delete(subscriber);
  }
  async publish(sessionId, candidate, { activityFence = null } = {}) {
    if (typeof sessionId !== "string" || sessionId.length < 3 || sessionId.length > 640) return null;
    return this.#serialized(sessionId, () => this.#publish(sessionId, candidate, activityFence));
  }
  #markCommitted(sessionId) {
    this.#committedHistory.delete(sessionId);
    this.#committedHistory.set(sessionId, true);
    while (this.#committedHistory.size > 128) this.#committedHistory.delete(this.#committedHistory.keys().next().value);
  }
  #forgetCommitted(sessionId) { this.#committedHistory.delete(sessionId); }
  async publishOutcome(sessionId, candidate, { activityFence = null } = {}) {
    if (typeof sessionId !== "string" || sessionId.length < 3 || sessionId.length > 640) return { record: null, accepted: false, reason: "invalid" };
    return this.#serialized(sessionId, () => this.#publish(sessionId, candidate, activityFence, true));
  }
  async #publish(sessionId, candidate, activityFence, includeOutcome = false) {
    const outcome = (record, accepted, reason) => includeOutcome ? Object.freeze({ record, accepted, reason }) : record;
    // Never replace a usable committed revision with incomplete acquisition.
    if (!candidate || candidate.complete !== true) return outcome(await this.#load(sessionId), false, "incomplete");
    const current = await this.#load(sessionId);
    if (isObject(activityFence) && current && (
      current.activityEpoch !== activityFence.epoch || current.activitySequence !== activityFence.sequence
      || current.requestEpoch !== activityFence.requestEpoch || current.requestSequence !== activityFence.requestSequence
      || current.revision !== activityFence.revision
    )) return outcome(current, false, "stale_fence");
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
    const priorVersions = current?.activityVersions && isObject(current.activityVersions) ? current.activityVersions : {};
    if (Number.isSafeInteger(activityFence) && activityFence >= 0) {
      for (const item of current?.activity || []) {
        if ((priorVersions[item.id] || 0) > activityFence) activities.set(item.id, item);
      }
    }
    const resolvedActivity = [...activities.values()].map((item) => ({
      ...item, requestNumber: item.requestId ? (requests.get(item.requestId)?.number || null) : null,
    }));
    const activityVersions = Object.fromEntries(resolvedActivity.map((item) => [item.id, priorVersions[item.id] || 0]));
    const record = { version: 1, sessionId, revision: (current?.revision || 0) + 1, complete: true, activityReady: true, requestsReady: true,
      activityEpoch: current?.activityEpoch || 0, activitySequence: current?.activitySequence || 0, activityVersions,
      requestEpoch: current?.requestEpoch || 0, requestSequence: current?.requestSequence || 0,
      nextNumber, numberRegistry, requests: sortRequests([...requests.values()]), activity: sortRows(resolvedActivity, "timestamp") };
    if (current && sameServedHistory(current, record)) {
      if (!this.directory || await this.#hasOverviewIndex(sessionId, current)) {
        if (this.directory) this.#markCommitted(sessionId);
        return outcome(current, true, "accepted");
      }
      // A legacy generation is immutable. Publish the migrated index under a
      // fresh revision so readers holding the old manifest never race a block
      // rewrite at the same generation path.
      await this.#write(record);
      this.#forgetIndex(sessionId);
      this.#remember(sessionId, record);
      return outcome(record, true, "accepted");
    }
    await this.#write(record); this.#forgetIndex(sessionId); this.#remember(sessionId, record); this.#notifyHistoryRevision(); return outcome(record, true, "accepted");
  }
  hasCommitted(sessionId) { return this.directory ? this.#committedHistory.has(sessionId) : this.#records.has(sessionId); }
  /**
   * Commit a source-complete Activity contribution without waiting for request
   * correlation. Epoch/sequence are monitor-private, monotonic source-domain
   * tokens; a late or replaced source can never regress the served rows.
   */
  async publishActivityContribution(sessionId, contribution) {
    if (typeof sessionId !== "string" || sessionId.length < 3 || sessionId.length > 640) return null;
    if (!validActivityContribution(contribution)) return this.#serialized(sessionId, () => this.#load(sessionId));
    let pending = this.#pendingContributions.get(sessionId);
    if (!pending) {
      let resolve; let reject;
      pending = { contribution, active: false, promise: new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; }), resolve, reject };
      this.#pendingContributions.set(sessionId, pending);
    } else if (newerContribution(contribution, pending.contribution)) {
        pending.contribution = mergePendingContribution(pending.contribution, contribution);
    }
    if (!pending.active) { pending.active = true; queueMicrotask(() => { void this.#flushActivityContributions(sessionId, pending); }); }
    return pending.promise;
  }
  async #flushActivityContributions(sessionId, pending) {
    let processed = null; let result = null;
    try {
      while (processed !== pending.contribution) {
        processed = pending.contribution;
        result = await this.#serialized(sessionId, () => this.#publishActivityContribution(sessionId, processed));
      }
      pending.resolve(result);
    } catch (error) {
      pending.reject(error);
    } finally {
      pending.active = false;
      if (this.#pendingContributions.get(sessionId) === pending) this.#pendingContributions.delete(sessionId);
    }
  }
  async publishRequestContribution(sessionId, contribution) {
    if (typeof sessionId !== "string" || sessionId.length < 3 || sessionId.length > 640) return null;
    if (!validRequestContribution(contribution)) return this.#serialized(sessionId, () => this.#load(sessionId));
    let pending = this.#pendingRequests.get(sessionId);
    if (!pending) {
      let resolve; let reject;
      pending = { contribution, active: false, promise: new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; }), resolve, reject };
      this.#pendingRequests.set(sessionId, pending);
    } else if (newerContribution(contribution, pending.contribution)) {
        pending.contribution = mergePendingContribution(pending.contribution, contribution);
        pending.contribution.requests = contribution.requests;
    }
    if (!pending.active) { pending.active = true; queueMicrotask(() => { void this.#flushRequestContributions(sessionId, pending); }); }
    return pending.promise;
  }
  async #flushRequestContributions(sessionId, pending) {
    let processed = null; let result = null;
    try {
      while (processed !== pending.contribution) {
        processed = pending.contribution;
        result = await this.#serialized(sessionId, () => this.#publishRequestContribution(sessionId, processed));
      }
      pending.resolve(result);
    } catch (error) {
      pending.reject(error);
    } finally {
      pending.active = false;
      if (this.#pendingRequests.get(sessionId) === pending) this.#pendingRequests.delete(sessionId);
    }
  }
  async activityFence(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length < 3 || sessionId.length > 640) return 0;
    // An observer can publish Activity without awaiting the durable commit. A
    // subsequent replay waits for that queued write before capturing its fence.
    await (this.#writes.get(sessionId) || Promise.resolve()).catch(() => {});
    const record = await this.#load(sessionId);
    return Object.freeze({ epoch: record?.activityEpoch || 0, sequence: record?.activitySequence || 0,
      requestEpoch: record?.requestEpoch || 0, requestSequence: record?.requestSequence || 0, revision: record?.revision || 0 });
  }
  async #publishActivityContribution(sessionId, contribution) {
    if (!validActivityContribution(contribution)) return this.#load(sessionId);
    const current = await this.#load(sessionId);
    const priorAdmission = this.#admission("activity", sessionId);
    if (priorAdmission && (!newerContribution(contribution, priorAdmission))) return current;
    const effectiveEpoch = priorAdmission
      ? contribution.epoch === priorAdmission.epoch ? priorAdmission.effectiveEpoch : priorAdmission.effectiveEpoch + 1
      : Math.max((current?.activityEpoch || 0) + 1, contribution.epoch);
    const nextAdmission = { epoch: contribution.epoch, sequence: contribution.sequence, effectiveEpoch };
    const requests = new Map((current?.requests || []).map((item) => [item.id, item]));
    const priorActivities = new Map((current?.activity || []).map((item) => [item.id, item]));
    const activities = new Map(priorActivities);
    const activityVersions = { ...(current?.activityVersions && isObject(current.activityVersions) ? current.activityVersions : {}) };
    for (const raw of contribution.activity) {
      const normal = safeActivity({ ...raw, requestId: null }, requests);
      if (normal) {
        const previous = activities.get(normal.id);
        const requestId = previous?.requestId && requests.has(previous.requestId) ? previous.requestId : null;
        activities.set(normal.id, {
          ...normal,
          durationMs: normal.durationMs ?? previous?.durationMs ?? null,
          status: normal.status ?? previous?.status ?? null,
          requestId,
          requestNumber: requestId ? (requests.get(requestId)?.number || null) : null,
        });
        activityVersions[normal.id] = contribution.sequence;
      }
    }
    const record = {
      version: 1, sessionId, revision: (current?.revision || 0) + 1, complete: current?.complete === true, activityReady: true,
      activityEpoch: effectiveEpoch, activitySequence: contribution.sequence, activityVersions,
      requestsReady: current?.requestsReady === true, requestEpoch: current?.requestEpoch || 0, requestSequence: current?.requestSequence || 0,
      nextNumber: current?.nextNumber || 1, numberRegistry: current?.numberRegistry || Object.fromEntries((current?.requests || []).map((item) => [item.id, item.number])),
      requests: sortRequests(current?.requests || []), activity: sortRows([...activities.values()], "timestamp"),
    };
    if (current && sameServedHistory(current, record)) {
      // Watermarks are runtime admission state. Advancing an identical source
      // record must not rewrite a page generation or churn browser revisions.
      const retained = { ...current, activityEpoch: effectiveEpoch, activitySequence: contribution.sequence, activityVersions };
      await this.#writeAdmissions(sessionId, { activity: nextAdmission });
      this.#remember(sessionId, retained);
      this.#setAdmission("activity", sessionId, nextAdmission);
      return retained;
    }
    await this.#write(record); await this.#writeAdmissions(sessionId, { activity: nextAdmission });
    this.#forgetIndex(sessionId); this.#remember(sessionId, record);
    this.#setAdmission("activity", sessionId, nextAdmission);
    this.#notifyHistoryRevision(); return record;
  }
  async #publishRequestContribution(sessionId, contribution) {
    if (!validRequestContribution(contribution)) return this.#load(sessionId);
    const current = await this.#load(sessionId);
    const priorAdmission = this.#admission("requests", sessionId);
    if (priorAdmission && !newerContribution(contribution, priorAdmission)) return current;
    const effectiveEpoch = priorAdmission
      ? contribution.epoch === priorAdmission.epoch ? priorAdmission.effectiveEpoch : priorAdmission.effectiveEpoch + 1
      : Math.max((current?.requestEpoch || 0) + 1, contribution.epoch);
    const nextAdmission = { epoch: contribution.epoch, sequence: contribution.sequence, effectiveEpoch };
    const priorNumbers = new Map(Object.entries(current?.numberRegistry || {}).filter((entry) => Number.isSafeInteger(entry[1])));
    for (const item of current?.requests || []) priorNumbers.set(item.id, item.number);
    let nextNumber = current?.nextNumber || 1;
    const requests = new Map((current?.requests || []).map((item) => [item.id, item]));
    for (const raw of contribution.requests) {
      const normal = safeRequest(raw); if (!normal) continue;
      const number = priorNumbers.get(normal.id) || nextNumber;
      if (!priorNumbers.has(normal.id)) nextNumber += 1;
      requests.set(normal.id, { ...normal, number });
    }
    nextNumber = Math.max(nextNumber, ...[...requests.values()].map((item) => item.number + 1));
    const numberRegistry = Object.fromEntries(priorNumbers);
    for (const item of requests.values()) numberRegistry[item.id] = item.number;
    const activityVersions = { ...(current?.activityVersions && isObject(current.activityVersions) ? current.activityVersions : {}) };
    const activities = new Map((current?.activity || []).map((item) => [item.id, item]));
    for (const raw of contribution.activity) {
      const normal = safeActivity(raw, requests); if (!normal) continue;
      const previous = activities.get(normal.id);
      const requestId = normal.requestId && requests.has(normal.requestId) ? normal.requestId
        : previous?.requestId && requests.has(previous.requestId) ? previous.requestId : null;
      activities.set(normal.id, {
        ...normal,
        durationMs: normal.durationMs ?? previous?.durationMs ?? null,
        status: normal.status ?? previous?.status ?? null,
        requestId,
        requestNumber: requestId ? (requests.get(requestId)?.number || null) : null,
      });
    }
    const record = {
      version: 1, sessionId, revision: (current?.revision || 0) + 1, complete: current?.complete === true,
      activityReady: current?.activityReady !== false, requestsReady: true,
      activityEpoch: current?.activityEpoch || 0, activitySequence: current?.activitySequence || 0, activityVersions,
      requestEpoch: effectiveEpoch, requestSequence: contribution.sequence,
      nextNumber, numberRegistry, requests: sortRequests([...requests.values()]), activity: sortRows([...activities.values()], "timestamp"),
    };
    if (current && sameServedHistory(current, record)) {
      await this.#writeAdmissions(sessionId, { requests: nextAdmission });
      this.#setAdmission("requests", sessionId, nextAdmission);
      this.#remember(sessionId, { ...current, requestEpoch: effectiveEpoch, requestSequence: contribution.sequence, numberRegistry });
      return current;
    }
    await this.#write(record); await this.#writeAdmissions(sessionId, { requests: nextAdmission });
    this.#forgetIndex(sessionId); this.#remember(sessionId, record);
    this.#setAdmission("requests", sessionId, nextAdmission);
    this.#notifyHistoryRevision(); return record;
  }
  async read(sessionId, query = {}) {
    // Serving deliberately consumes only a compact committed index and the
    // selected data blocks. Full normalized arrays are materialized only by
    // background publication/replacement, never a GET.
    if (this.directory) return (await this.#readIndexed(sessionId, query)) || { status: "unavailable", kind: query.kind === "requests" ? "requests" : "activity", revision: "0", total: 0, offset: 0, items: [], linkedCount: 0, ...(query.kind === "requests" ? { overview: null } : {}) };
    const record = await this.#load(sessionId); const kind = query.kind === "requests" ? "requests" : "activity";
    if (!record) return { status: "unavailable", kind, revision: "0", total: 0, offset: 0, items: [], linkedCount: 0, ...(kind === "requests" ? { overview: null } : {}) };
    if (kind === "requests" && record.requestsReady === false || kind === "activity" && record.activityReady === false) {
      return { status: "loading", kind, revision: String(record.revision), total: 0, offset: 0, items: [], linkedCount: 0, ...(kind === "requests" ? { overview: null } : {}) };
    }
    let rows = kind === "activity" ? [...record.activity].reverse() : record[kind]; const scope = query.scope || "all";
    if (scope === "primary") rows = rows.filter((item) => item.agentId === "primary");
    else if (scope === "subagents") rows = rows.filter((item) => item.agentId && item.agentId !== "primary");
    else if (scope !== "all" && safeAgent(scope)) rows = rows.filter((item) => item.agentId === scope);
    if (kind === "activity" && REQUEST_ID.test(query.filterRequestId || "")) rows = rows.filter((item) => item.requestId === query.filterRequestId);
    const total = rows.length; const maximum = kind === "activity" ? 8 : 60;
    const limit = Math.max(1, Math.min(maximum, Number.parseInt(query.limit, 10) || maximum));
    let offset = kind === "activity" && (query.offset === "latest" || query.offset === "last")
      ? Math.floor(Math.max(0, total - 1) / limit) * limit
      : query.offset === "latest" ? Math.max(0, total - limit)
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
    const overview = kind === "requests" && query.overview !== "0" ? rows.map(requestOverview) : null;
    return { status: "ready", kind, revision: String(record.revision), total, offset, items, linkedCount,
      ...(kind === "requests" && query.overview !== "0" ? { overview } : {}) };
  }
  async #load(sessionId) {
    if (this.#records.has(sessionId)) {
      this.#touch.set(sessionId, Date.now());
      await this.#restoreAdmissions(sessionId);
      return this.#records.get(sessionId);
    }
    if (!this.directory) return null;
    const index = await this.#readIndex(sessionId);
    if (index?.snapshotVersion === 1) {
      if (!isObject(index) || index.version !== 2 || index.sessionId !== sessionId
        || !Number.isSafeInteger(index.revision) || index.revision < 1) return null;
      try {
        const key = crypto.createHash("sha256").update(sessionId).digest("hex");
        const value = JSON.parse(await readFile(path.join(this.directory, `${key}-${index.revision}`, "snapshot.json"), "utf8"));
        const record = this.#normalizeRecord(value, sessionId);
        if (record) await this.#restoreAdmissions(sessionId);
        return record;
      } catch { return null; }
    }
    try {
      const record = this.#normalizeRecord(JSON.parse(await readFile(path.join(this.directory, fileName(sessionId)), "utf8")), sessionId);
      if (record) await this.#restoreAdmissions(sessionId);
      return record;
    }
    catch { return null; }
  }
  #normalizeRecord(value, sessionId) {
      if (!this.#validRecord(value, sessionId)) return null;
      const requests = new Map(value.requests.map((raw) => {
        const item = safeRequest(raw); return [item.id, { ...item, number: raw.number }];
      }));
      const normalized = { version: 1, sessionId, revision: value.revision, complete: value.complete === true,
      activityReady: value.activityReady !== false, requestsReady: value.requestsReady === true || value.requestsReady === undefined && value.complete === true,
        activityEpoch: Number.isSafeInteger(value.activityEpoch) ? value.activityEpoch : 0,
        activitySequence: Number.isSafeInteger(value.activitySequence) ? value.activitySequence : 0,
        requestEpoch: Number.isSafeInteger(value.requestEpoch) ? value.requestEpoch : 0,
        requestSequence: Number.isSafeInteger(value.requestSequence) ? value.requestSequence : 0,
        activityVersions: isObject(value.activityVersions) ? value.activityVersions : {}, nextNumber: value.nextNumber,
        numberRegistry: isObject(value.numberRegistry) ? value.numberRegistry : Object.fromEntries([...requests.values()].map((item) => [item.id, item.number])),
        requests: sortRequests([...requests.values()]), activity: sortRows(value.activity.map((item) => safeActivity(item, requests)), "timestamp") };
      this.#remember(sessionId, normalized); return normalized;
  }
  #remember(sessionId, value) { this.#records.set(sessionId, value); this.#touch.set(sessionId, Date.now());
    while (this.#records.size > this.maxResident) { const oldest = [...this.#touch.entries()].sort((a,b) => a[1]-b[1])[0]?.[0]; if (!oldest) break; this.#records.delete(oldest); this.#touch.delete(oldest); }
  }
  #validRecord(value, sessionId) {
    if (!isObject(value) || value.version !== 1 || value.sessionId !== sessionId || !Number.isSafeInteger(value.revision)
      || !Number.isSafeInteger(value.nextNumber) || !Array.isArray(value.requests) || !Array.isArray(value.activity)) return false;
    const requests = new Map();
    for (const raw of value.requests) { const item = safeRequest(raw); if (!item || !Number.isSafeInteger(raw.number) || raw.number < 1 || requests.has(item.id)) return false; requests.set(item.id, { ...item, number: raw.number }); }
    if (value.activityReady !== undefined && typeof value.activityReady !== "boolean") return false;
    if (value.requestsReady !== undefined && typeof value.requestsReady !== "boolean") return false;
    if (value.activityEpoch !== undefined && (!Number.isSafeInteger(value.activityEpoch) || value.activityEpoch < 0)) return false;
    if (value.activitySequence !== undefined && (!Number.isSafeInteger(value.activitySequence) || value.activitySequence < 0)) return false;
    if (value.requestEpoch !== undefined && (!Number.isSafeInteger(value.requestEpoch) || value.requestEpoch < 0)) return false;
    if (value.requestSequence !== undefined && (!Number.isSafeInteger(value.requestSequence) || value.requestSequence < 0)) return false;
    if (value.activityVersions !== undefined && (!isObject(value.activityVersions)
      || Object.values(value.activityVersions).some((version) => !Number.isSafeInteger(version) || version < 0))) return false;
    return value.activity.every((item) => Boolean(safeActivity(item, requests)));
  }
  async #write(record) {
    if (!this.directory) return;
    await mkdir(this.directory, { recursive: true });
    const key = crypto.createHash("sha256").update(record.sessionId).digest("hex");
    const destination = path.join(this.directory, `${key}.index.json`);
    try {
      const prior = JSON.parse(await readFile(destination, "utf8"));
      if (Number.isSafeInteger(prior?.revision) && prior.revision >= record.revision) throw new Error("History publication is stale");
    } catch (error) {
      if (error?.message === "History publication is stale") throw error;
    }
    const generation = `${key}-${record.revision}`;
    const generationDir = path.join(this.directory, generation);
    await mkdir(generationDir, { recursive: true });
    const index = { version: 2, snapshotVersion: 1, sessionId: record.sessionId, revision: record.revision, complete: record.complete, activityReady: record.activityReady !== false, requestsReady: record.requestsReady === true,
      nextNumber: record.nextNumber, requests: [], activity: [] };
    for (const kind of ["requests", "activity"]) {
      const rows = record[kind];
      for (let page = 0; page * PAGE_ROWS < rows.length; page += 1) {
        const block = rows.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS);
        await writeFile(path.join(generationDir, `${kind}-${page}.json`), JSON.stringify(block), "utf8");
        for (let slot = 0; slot < block.length; slot += 1) {
          const item = block[slot]; index[kind].push(kind === "requests"
            ? { id: item.id, agentId: item.agentId, number: item.number, overview: requestOverview(item), page, slot }
            : { id: item.id, agentId: item.agentId, requestId: item.requestId, page, slot });
        }
      }
    }
    await writeFile(path.join(generationDir, "snapshot.json"), JSON.stringify(record), "utf8");
    // The manifest is the serving commit point. Never replace the legacy
    // recovery snapshot before a new generation is visible through it.
    const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify(index), "utf8"); await rename(temp, destination); this.#markCommitted(record.sessionId);
    const legacy = path.join(this.directory, fileName(record.sessionId)); const legacyTemp = `${legacy}.${process.pid}.${Date.now()}.tmp`;
    try { await writeFile(legacyTemp, JSON.stringify(record), "utf8"); await rename(legacyTemp, legacy); } catch { try { await rm(legacyTemp, { force: true }); } catch {} }
    // Publication is complete before pruning. Retain the immediately previous
    // generation for readers that obtained its manifest just before the swap.
    void this.#pruneGenerations(key, record.revision);
  }
  async #pruneGenerations(key, cutoffRevision) {
    let names; try { names = await readdir(this.directory, { withFileTypes: true }); } catch { return; }
    const root = path.resolve(this.directory); const prefix = `${key}-`;
    await Promise.allSettled(names.filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix)).map(async (entry) => {
      const revision = Number(entry.name.slice(prefix.length));
      // An older asynchronous prune cannot remove a newer publication. Keep
      // the current and immediately preceding generation without requiring a
      // reader to win a lease race between manifest and page-block reads.
      if (!Number.isSafeInteger(revision) || revision >= cutoffRevision - 1 || (this.#generationLeases.get(entry.name) || 0) > 0) return;
      const target = path.resolve(root, entry.name);
      // Never recursively remove an unresolved or escaping path on Windows.
      if (!target.startsWith(`${root}${path.sep}`)) return;
      await rm(target, { recursive: true, force: true });
    }));
  }
  #forgetIndex(sessionId) {
    const cached = this.#indexCache.get(sessionId);
    if (cached) this.#indexBytes -= cached.bytes;
    this.#indexCache.delete(sessionId);
  }
  #rememberIndex(sessionId, value, metadata, bytes) {
    this.#forgetIndex(sessionId);
    if (bytes > this.maxIndexBytes || this.maxIndexResident < 1) return;
    this.#indexCache.set(sessionId, { value, metadata, bytes, touchedAt: Date.now() });
    this.#indexBytes += bytes;
    while (this.#indexCache.size > this.maxIndexResident || this.#indexBytes > this.maxIndexBytes) {
      const oldest = [...this.#indexCache.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0]?.[0];
      if (!oldest) break;
      this.#forgetIndex(oldest);
    }
  }
  async #readIndex(sessionId) {
    const indexPath = path.join(this.directory, `${crypto.createHash("sha256").update(sessionId).digest("hex")}.index.json`);
    let before;
    try { before = await stat(indexPath, { bigint: true }); } catch { this.#forgetIndex(sessionId); this.#forgetCommitted(sessionId); return null; }
    const metadata = `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
    const cached = this.#indexCache.get(sessionId);
    if (cached && cached.metadata === metadata) {
      cached.touchedAt = Date.now();
      this.#markCommitted(sessionId);
      return cached.value;
    }
    let source;
    try { source = await readFile(indexPath, "utf8"); } catch { this.#forgetIndex(sessionId); this.#forgetCommitted(sessionId); return null; }
    let after;
    try { after = await stat(indexPath, { bigint: true }); } catch { this.#forgetIndex(sessionId); this.#forgetCommitted(sessionId); return null; }
    if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== metadata) {
      this.#forgetIndex(sessionId); this.#forgetCommitted(sessionId); return null;
    }
    try {
      const value = JSON.parse(source);
      this.#rememberIndex(sessionId, value, metadata, Buffer.byteLength(source, "utf8"));
      this.#markCommitted(sessionId);
      return value;
    } catch { this.#forgetIndex(sessionId); this.#forgetCommitted(sessionId); return null; }
  }
  async #hasOverviewIndex(sessionId, record) {
    const key = crypto.createHash("sha256").update(sessionId).digest("hex");
    try {
      const index = JSON.parse(await readFile(path.join(this.directory, `${key}.index.json`), "utf8"));
      if (!isObject(index) || index.version !== 2 || index.sessionId !== sessionId || index.revision !== record.revision || !Array.isArray(index.requests) || index.requests.length !== record.requests.length) return false;
      return index.requests.every((item, position) => item?.id === record.requests[position]?.id && overviewTuple(item.overview) !== null);
    } catch { return false; }
  }
  async #readIndexed(sessionId, query) {
    const key = crypto.createHash("sha256").update(sessionId).digest("hex");
    const index = await this.#readIndex(sessionId);
    if (!index) return null;
    const kind = query.kind === "requests" ? "requests" : "activity";
    if (!isObject(index) || index.version !== 2 || index.sessionId !== sessionId || !Number.isSafeInteger(index.revision) || index.revision < 1 || !Array.isArray(index[kind]) || !Array.isArray(index.activity) || !Array.isArray(index.requests)) { this.#forgetCommitted(sessionId); return null; }
    if (kind === "requests" && index.requestsReady === false || kind === "activity" && index.activityReady === false) {
      return { status: "loading", kind, revision: String(index.revision), total: 0, offset: 0, items: [], linkedCount: 0, ...(kind === "requests" ? { overview: null } : {}) };
    }
    const generation = `${key}-${index.revision}`;
    this.#generationLeases.set(generation, (this.#generationLeases.get(generation) || 0) + 1);
    try {
    const scope = query.scope || "all";
    let refs = index[kind].filter((item) => isObject(item) && typeof item.id === "string" && Number.isSafeInteger(item.page) && Number.isSafeInteger(item.slot) && scopeMatches(item, scope));
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
    if (items.some((item) => item === null) || items.length !== selected.length) { this.#forgetCommitted(sessionId); return null; }
    const requestedId = query.requestId || query.filterRequestId;
    const linkedCount = REQUEST_ID.test(requestedId || "") ? (kind === "requests" ? index.activity.filter((item) => item.requestId === requestedId && scopeMatches(item, scope)).length : refs.filter((item) => item.requestId === requestedId).length) : 0;
    const overview = kind === "requests" && query.overview !== "0"
      ? (refs.every((item) => overviewTuple(item.overview) !== null) ? refs.map((item) => overviewTuple(item.overview)) : null)
      : null;
    return { status: "ready", kind, revision: String(index.revision), total, offset, items, linkedCount,
      ...(kind === "requests" && query.overview !== "0" ? { overview } : {}) };
    } finally {
      const remaining = (this.#generationLeases.get(generation) || 1) - 1;
      if (remaining > 0) this.#generationLeases.set(generation, remaining);
      else this.#generationLeases.delete(generation);
    }
  }
}

function scopeMatches(item, scope) {
  return scope === "all" || !scope || (scope === "primary" && item.agentId === "primary")
    || (scope === "subagents" && item.agentId && item.agentId !== "primary") || item.agentId === scope;
}
