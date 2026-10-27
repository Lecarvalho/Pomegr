import { ARIL_FOLLOW_UP_KIND, arilFollowUpPolicy, normalizeArilFollowUpData } from "../../shared/aril-follow-up.mjs";

// One occurrence per follow-up the desktop settled: its repository, grant, and task-log position, never a path or text.
const KEY = /^repo-[a-f0-9]{24}:[1-9][0-9]{0,14}:[0-9]{1,15}(?::end)?$/u;
const iso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function isArilFollowUpKey(value) { return typeof value === "string" && KEY.test(value); }

export function deriveArilFollowUps(input) {
  const items = [];
  for (const value of Array.isArray(input?.followUps) ? input.followUps.slice(0, 16) : []) {
    if (!value || typeof value !== "object" || !isArilFollowUpKey(value.key) || !iso(value.at)) continue;
    const { repositoryId, conversationId, messageId, items: entries, more, ended } = value;
    const data = normalizeArilFollowUpData(ARIL_FOLLOW_UP_KIND, null, { repositoryId, conversationId, messageId, items: entries, more, ended });
    if (data && value.key.startsWith(`${data.repositoryId}:`)) items.push({ kind: ARIL_FOLLOW_UP_KIND, key: value.key, provider: null, active: true, at: value.at, data });
  }
  return { state: null, items };
}

export const ARIL_FOLLOW_UP_NOTIFICATION_RULE = Object.freeze({
  kind: ARIL_FOLLOW_UP_KIND, source: "arilFollowUps", capability: "grant_task_log", scope: "repository",
  identity: "task_log_position", freshness: "settled_follow_up", transition: "follow_up_written",
  resolution: "occurrence", retentionDays: 30, ...arilFollowUpPolicy(), delivery: "native_eligible", occurrence: true,
  kinds: Object.freeze([ARIL_FOLLOW_UP_KIND]), derive: deriveArilFollowUps,
});
