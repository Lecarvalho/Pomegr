// The task log since Aril's last answer, read from the monitor's bounded answer: fixed kinds, task IDs, and counts only.

const TASK_LOG_KINDS = new Set(["started", "assigned", "review", "blocked", "requeued", "done", "stalled", "recovered", "checks_passed", "checks_failed", "merged", "review_started", "review_passed", "review_failed", "grant_start", "grant_review", "sent_back", "grant_merge", "grant_merge_refused", "grant_merge_auto", "grant_branch_deleted", "grant_branch_delete_refused", "grant_task_written", "grant_done", "rework", "grant_usage_hold", "grant_usage_resume"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The entries after Aril's cursor, and whether older ones were left out; null for an answer outside the contract. */
export function chatTaskLog(answer) {
  const log = answer?.log;
  if (answer?.ok !== true || !isPlainObject(log) || !Array.isArray(log.entries)
    || !isPlainObject(log.cursors) || !Number.isSafeInteger(log.cursors.aril) || log.cursors.aril < 0
    || typeof log.more !== "boolean" || !Number.isSafeInteger(log.latestId) || log.latestId < 0) return null;
  const entries = log.entries.flatMap((entry) => {
    if (!isPlainObject(entry) || !Number.isSafeInteger(entry.id) || !TASK_LOG_KINDS.has(entry.kind)
      || !Number.isSafeInteger(entry.at) || !Number.isFinite(new Date(entry.at).getTime())
      || (entry.pullRequest !== null && !Number.isSafeInteger(entry.pullRequest))) return [];
    const usageTransition = entry.kind === "grant_usage_hold" || entry.kind === "grant_usage_resume";
    if (usageTransition) return entry.task === null && entry.pullRequest === null && (entry.reason === "claude" || entry.reason === "codex")
      ? [{ id: entry.id, task: null, kind: entry.kind, at: entry.at, pullRequest: null, reason: entry.reason }] : [];
    if (entry.kind === "rework" && typeof entry.task === "string" && /^#[1-9]\d*$/u.test(entry.task) && Number.isSafeInteger(Number(entry.task.slice(1))) && !Object.hasOwn(entry, "reason"))
      return [{ id: entry.id, task: entry.task, kind: entry.kind, at: entry.at, pullRequest: entry.pullRequest }];
    return typeof entry.task === "string" && /^T-\d+$/u.test(entry.task) && !Object.hasOwn(entry, "reason")
      ? [{ id: entry.id, task: entry.task, kind: entry.kind, at: entry.at, pullRequest: entry.pullRequest }] : [];
  });
  const omitted = log.more && entries.length > 0 && Math.min(...entries.map((entry) => entry.id)) > log.cursors.aril + 1;
  return { entries: entries.filter((entry) => entry.id > log.cursors.aril), omitted };
}
