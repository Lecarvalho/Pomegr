import { ARIL_FOLLOW_UP_ITEMS, ARIL_FOLLOW_UP_LOG_KINDS } from "../../shared/aril-follow-up.mjs";
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { readAril } from "./task-aril-settings.mjs";
import { TASK_LOG_KINDS } from "./task-log.mjs";
import { isRepositoryId } from "./task-record.mjs";

// Entries that arrive this close together are one follow-up: a merge, its branch delete, and the next start are one line.
export const FOLLOW_UP_QUIET_MS = 45_000;
// A steady stream still reports at this pace.
export const FOLLOW_UP_MAX_WAIT_MS = 180_000;
const PAGE = 50;
const KINDS = ARIL_FOLLOW_UP_LOG_KINDS.filter((kind) => TASK_LOG_KINDS.includes(kind));
const KIND_LIST = KINDS.map((kind) => `'${kind}'`).join(", ");
const CONSUMER = "followups";
const endKey = (repositoryId) => `grant_follow_up_end:${repositoryId}`;
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const latestGrant = (database, repositoryId) => preparedStatement(database,
  "SELECT id, started_at, ended_at, end_reason FROM aril_grants WHERE repository_id = ? ORDER BY id DESC LIMIT 1").get(repositoryId);
const latestLogId = (database, repositoryId) => preparedStatement(database,
  "SELECT COALESCE(MAX(id), 0) AS id FROM task_log WHERE repository_id = ?").get(repositoryId).id;
const cursorOf = (database, repositoryId) => preparedStatement(database,
  "SELECT last_id FROM task_log_cursors WHERE repository_id = ? AND consumer = ?").get(repositoryId, CONSUMER)?.last_id;
const saveCursor = (database, repositoryId, through) => preparedStatement(database, `INSERT INTO task_log_cursors (repository_id, consumer, last_id) VALUES (?, ?, ?)
  ON CONFLICT(repository_id, consumer) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`).run(repositoryId, CONSUMER, through);
const endReported = (database, repositoryId, grant) => preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(endKey(repositoryId))?.value === String(grant.id);
const reportEnd = (database, repositoryId, grant) => preparedStatement(database,
  "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(endKey(repositoryId), String(grant.id));
const endedReason = (grant) => grant.end_reason === "starts_used" ? "tasks_used" : grant.end_reason;

/** Starts a grant's follow-ups at the log's end, so a new grant reports only what it does. The caller owns the transaction. */
export function startGrantFollowUps(database, repositoryId) {
  saveCursor(database, repositoryId, latestLogId(database, repositoryId));
}

// The grant's own entries after the cursor, through `through` when given: only those written while it ran.
function pendingEntries(database, repositoryId, grant, after, through = null) {
  return preparedStatement(database, `SELECT id, number, kind, at, reason FROM task_log
    WHERE repository_id = ? AND id > ? AND (? IS NULL OR id <= ?) AND at >= ? AND (? IS NULL OR at <= ?) AND kind IN (${KIND_LIST}) ORDER BY id LIMIT ?`)
    .all(repositoryId, after, through, through, grant.started_at, grant.ended_at, grant.ended_at, PAGE);
}

const item = ({ number, kind, reason }) => number === 0 ? { kind, task: null, provider: reason } : { kind, task: `T-${number}`, provider: null };
const facts = (entries) => ({ items: entries.slice(0, ARIL_FOLLOW_UP_ITEMS).map(item), more: Math.max(0, entries.length - ARIL_FOLLOW_UP_ITEMS) });

/**
 * The follow-ups ready to send: for each repository, the latest grant's entries after the follow-up cursor once no new
 * entry arrived for the quiet period (or the oldest waited the longest), and the grant's end once. A repository seen
 * for the first time starts at the log's end, so no follow-up reports what happened before it.
 */
function nextFollowUps({ database, transaction, now }) {
  return transaction(() => {
    const at = now(), batches = [];
    for (const { repository_id: repositoryId } of preparedStatement(database, "SELECT DISTINCT repository_id FROM aril_grants ORDER BY repository_id").all()) {
      const grant = latestGrant(database, repositoryId);
      const cursor = cursorOf(database, repositoryId);
      if (cursor === undefined) {
        startGrantFollowUps(database, repositoryId);
        if (grant.ended_at !== null) reportEnd(database, repositoryId, grant);
        continue;
      }
      const entries = pendingEntries(database, repositoryId, grant, cursor);
      const ended = grant.ended_at !== null && !endReported(database, repositoryId, grant) ? endedReason(grant) : null;
      const settled = entries.length > 0 && (at - entries.at(-1).at >= FOLLOW_UP_QUIET_MS || at - entries[0].at >= FOLLOW_UP_MAX_WAIT_MS || entries.length === PAGE);
      if (ended === null && !settled) continue;
      batches.push({ repositoryId, grant: grant.id, through: entries.at(-1)?.id ?? cursor, followUps: readAril(database, repositoryId).settings.followUps === true,
        ...facts(entries), ended });
      if (batches.length >= 16) break;
    }
    return { ok: true, batches };
  });
}

/**
 * Settles one follow-up the desktop sent or skipped: the cursor moves to `through` and the end is reported once. With
 * follow-ups on, it answers the facts the desktop wrote, so the notification says the same line as the chat.
 */
function ackFollowUp({ database, transaction, repositoryId, payload, now }) {
  if (!isRepositoryId(repositoryId) || !exact(payload, ["grant", "through", "ended"]) || !Number.isSafeInteger(payload.grant)
    || !Number.isSafeInteger(payload.through) || payload.through < 0) return { ok: false, error: "invalid" };
  return transaction(() => {
    const grant = latestGrant(database, repositoryId), cursor = cursorOf(database, repositoryId);
    if (!grant || grant.id !== payload.grant || cursor === undefined || payload.through < cursor || payload.through > latestLogId(database, repositoryId)
      || (payload.ended !== null && (grant.ended_at === null || payload.ended !== endedReason(grant) || endReported(database, repositoryId, grant)))) return { ok: false, error: "not_eligible" };
    const entries = pendingEntries(database, repositoryId, grant, cursor, payload.through);
    saveCursor(database, repositoryId, payload.through);
    if (payload.ended !== null) reportEnd(database, repositoryId, grant);
    const followUp = readAril(database, repositoryId).settings.followUps === true && (entries.length > 0 || payload.ended !== null)
      ? { repositoryId, key: `${repositoryId}:${grant.id}:${payload.through}${entries.length === 0 ? ":end" : ""}`, ...facts(entries), ended: payload.ended, at: new Date(now()).toISOString() } : null;
    return { ok: true, followUp };
  });
}

export const followUpOperations = (dispatch, now) => ({
  nextFollowUps: () => dispatch(nextFollowUps, { now }),
  ackFollowUp: (repositoryId, payload) => dispatch(ackFollowUp, { repositoryId, payload, now }),
});
