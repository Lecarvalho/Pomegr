// Private desktop authority. A corrupt/newer journal is never overwritten.
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const PILOT_REPOSITORY = /^repo-[a-f0-9]{24}$/u;
export const PILOT_TASK = /^T-[1-9][0-9]{0,8}$/u;
export const PILOT_ID = /^pilot-[0-9a-f]{24}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:+\-[\]]{0,119}$/u;
const STATUSES = new Set(["active", "paused", "revoked", "expired", "finished", "needs_you"]);
const ACTIONS = new Set(["inference", "start", "wait", "needs_you", "finish"]);
const RECEIPT_STATUSES = new Set(["pending", "complete", "started", "blocked", "uncertain", "interrupted", "busy", "failed"]);
export const PILOT_HISTORY_LIMIT = 50;
export const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const bounded = (value, limit, empty = false) => typeof value === "string" && value.length <= limit && (empty || value.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
export const instant = (value) => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
export const runChoice = (value) => plain(value) && Object.keys(value).every((key) => ["provider", "model"].includes(key)) && ["claude", "codex"].includes(value.provider) && (value.model === null || (typeof value.model === "string" && MODEL.test(value.model)));
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const exact = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const clone = (value) => structuredClone(value);

export function normalizePilotGrant(value) {
  const keys = ["id", "revision", "repositoryId", "goal", "taskIds", "expiresAt", "status", "roundLimit", "startLimit", "concurrency", "minIntervalMinutes", "allowedRuns", "inference", "roundsUsed", "startsUsed", "nextWakeAt", "waiting", "receipts", "summary", "lastFingerprint", "lastRoundAt", "resetRequired", "wakeConsumed", "waitDeadline"];
  if (!plain(value) || !exact(value, keys) || !PILOT_ID.test(value.id) || !PILOT_REPOSITORY.test(value.repositoryId)
    || !integer(value.revision, 1, Number.MAX_SAFE_INTEGER) || !bounded(value.goal, 2000) || !instant(value.expiresAt) || !STATUSES.has(value.status)
    || !Array.isArray(value.taskIds) || !integer(value.taskIds.length, 1, 32) || value.taskIds.some((id) => typeof id !== "string" || !PILOT_TASK.test(id)) || new Set(value.taskIds).size !== value.taskIds.length
    || !integer(value.roundLimit, 1, 100) || !integer(value.startLimit, 1, 32) || !integer(value.concurrency, 1, Math.min(4, value.startLimit)) || !integer(value.minIntervalMinutes, 5, 1440)
    || !Array.isArray(value.allowedRuns) || !integer(value.allowedRuns.length, 1, 32) || !value.allowedRuns.every(runChoice) || !runChoice(value.inference)
    || !integer(value.roundsUsed, 0, value.roundLimit) || !integer(value.startsUsed, 0, value.startLimit)
    || !(value.nextWakeAt === null || instant(value.nextWakeAt)) || !(value.lastRoundAt === null || instant(value.lastRoundAt))
    || !(value.waiting === null || bounded(value.waiting, 500)) || !bounded(value.summary, 500, true)
    || !(value.lastFingerprint === null || /^[a-f0-9]{64}$/u.test(value.lastFingerprint))
    || !(value.wakeConsumed === null || instant(value.wakeConsumed))
    || !(value.waitDeadline === null || instant(value.waitDeadline))
    || !plain(value.resetRequired) || !exact(value.resetRequired, ["claude", "codex"]) || Object.values(value.resetRequired).some((at) => !instant(at))
    || !Array.isArray(value.receipts) || value.receipts.length > 256) return null;
  for (const receipt of value.receipts) {
    if (!plain(receipt) || !exact(receipt, ["at", "taskId", "action", "status", "provider", "model", "reason", "evidenceRevision"])
      || !instant(receipt.at) || !(receipt.taskId === null || value.taskIds.includes(receipt.taskId)) || !ACTIONS.has(receipt.action) || !RECEIPT_STATUSES.has(receipt.status)
      || !(receipt.provider === null || ["claude", "codex"].includes(receipt.provider)) || !runChoice({ provider: receipt.provider ?? "claude", model: receipt.model })
      || !bounded(receipt.reason, 500, true) || !/^[a-f0-9]{64}$/u.test(receipt.evidenceRevision)) return null;
    if (receipt.action === "start" ? receipt.taskId === null || receipt.provider === null || !["pending", "started", "blocked", "uncertain"].includes(receipt.status)
      : receipt.taskId !== null || (receipt.action === "inference" ? receipt.provider === null || !["pending", "complete", "interrupted", "failed", "busy"].includes(receipt.status) : receipt.status !== "complete" || receipt.provider !== null || receipt.model !== null)) return null;
  }
  if (value.startsUsed !== value.receipts.filter((row) => row.action === "start").length
    || value.roundsUsed !== value.receipts.filter((row) => row.action === "inference").length) return null;
  return clone(value);
}

export function pilotProjection(grant) {
  if (!grant) return null;
  const { lastFingerprint: _fingerprint, lastRoundAt: _lastRound, resetRequired: _resets, wakeConsumed: _wake, waitDeadline: _deadline, ...visible } = clone(grant);
  return visible;
}

export function createArilPilotStore({ directory, filesystem = fs } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new TypeError("Invalid pilot directory");
  const target = path.join(directory, "authority-v1.json");
  let state = null;
  let unavailable = false;
  let chain = Promise.resolve();
  async function load() {
    if (unavailable) return null;
    if (state) return state;
    try {
      if ((await filesystem.stat(target)).size > 32 * 1024 * 1024) throw new Error("invalid");
      const parsed = JSON.parse(await filesystem.readFile(target, "utf8"));
      if (!plain(parsed) || !exact(parsed, ["version", "grants"]) || parsed.version !== 1 || !Array.isArray(parsed.grants) || parsed.grants.length > PILOT_HISTORY_LIMIT) throw new Error("invalid");
      const grants = parsed.grants.map(normalizePilotGrant);
      if (grants.some((grant) => !grant) || new Set(grants.map((grant) => grant.id)).size !== grants.length || grants.filter((grant) => !["expired", "finished", "revoked"].includes(grant.status)).length > 1) throw new Error("invalid");
      state = { version: 1, grants };
    } catch (error) {
      if (error?.code === "ENOENT") state = { version: 1, grants: [] };
      else unavailable = true;
    }
    return state;
  }
  return Object.freeze({
    async read() { await chain; const loaded = await load(); return loaded ? clone(loaded) : null; },
    // The callback is synchronous. Every authorization change and checkpoint shares this serialization.
    update(change) {
      const operation = chain.then(async () => {
        const current = await load();
        if (!current) return { ok: false, error: "unavailable" };
        const next = clone(current);
        const result = change(next);
        if (result?.ok === false) return result;
        if (next.grants.length > PILOT_HISTORY_LIMIT || next.grants.some((grant) => !normalizePilotGrant(grant)) || next.grants.filter((grant) => !["expired", "finished", "revoked"].includes(grant.status)).length > 1) return { ok: false, error: "invalid" };
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await filesystem.mkdir(directory, { recursive: true });
          const handle = await filesystem.open(temporary, "wx", 0o600);
          try { await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
          await filesystem.rename(temporary, target);
          state = next;
          return { ok: true, ...result };
        } catch {
          await filesystem.unlink(temporary).catch(() => {});
          // A failed write must never leave an in-memory authority different from disk.
          return { ok: false, error: "unavailable" };
        }
      });
      chain = operation.then(() => {}, () => {});
      return operation;
    },
  });
}
