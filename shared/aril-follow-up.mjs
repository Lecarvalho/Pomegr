// Aril's grant follow-ups: one short line built from fixed words and task-log facts, never provider or task text.
// The desktop writes it into the repository's Aril chat, and the same line is the notification's body.

export const ARIL_FOLLOW_UP_KIND = "aril_follow_up";
// The grant task-log entries a follow-up reports. `grant_done` is reported once the task log records it.
export const ARIL_FOLLOW_UP_LOG_KINDS = Object.freeze(["grant_start", "grant_review", "review_passed", "review_failed", "sent_back",
  "grant_merge", "grant_merge_auto", "grant_merge_refused", "grant_branch_deleted", "grant_branch_delete_refused", "grant_done",
  "grant_usage_hold", "grant_usage_resume"]);
export const ARIL_FOLLOW_UP_END_REASONS = Object.freeze(["stopped", "expired", "tasks_used", "start_failed", "app_restart"]);
export const ARIL_FOLLOW_UP_ITEMS = 8;
export const ARIL_FOLLOW_UP_TEXT_LIMIT = 200;

const SHOWN = 3;
const TASK = /^T-[1-9][0-9]{0,8}$/u;
const REPOSITORY = /^repo-[a-f0-9]{24}$/u;
const CONVERSATION = /^chat-[0-9a-f]{12}$/u;
const MESSAGE = /^m-[1-9][0-9]{0,5}$/u;
const USAGE = new Set(["grant_usage_hold", "grant_usage_resume"]);
const PROVIDER = Object.freeze({ claude: "Claude", codex: "Codex" });
const ENDED = Object.freeze({ stopped: "you stopped it", expired: "its time ran out", tasks_used: "it used all its tasks",
  start_failed: "a start failed", app_restart: "the app restarted" });
const PHRASE = Object.freeze({
  grant_start: (task) => `started ${task}`,
  grant_review: (task) => `started a review of ${task}`,
  review_passed: (task) => `${task} passed review`,
  review_failed: (task) => `${task} failed review`,
  sent_back: (task) => `sent ${task} back to its builder`,
  grant_merge: (task) => `merged ${task}`,
  grant_merge_auto: (task) => `turned on auto-merge for ${task}`,
  grant_merge_refused: (task) => `could not merge ${task}`,
  grant_branch_deleted: (task) => `deleted the branch of ${task}`,
  grant_branch_delete_refused: (task) => `could not delete the branch of ${task}`,
  grant_done: (task) => `marked ${task} Done`,
  grant_usage_hold: (_, provider) => `held new ${PROVIDER[provider]} starts at the usage limit`,
  grant_usage_resume: (_, provider) => `resumed ${PROVIDER[provider]} starts`,
});

const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function isArilFollowUpKind(kind) { return kind === ARIL_FOLLOW_UP_KIND; }
export function arilFollowUpPolicy() { return { category: "aril", severity: "info", priority: 50, action: "open_aril_chat" }; }

/** One reported entry: a task entry names its task, a usage entry its provider. */
export function normalizeArilFollowUpItem(item) {
  if (!exact(item, ["kind", "task", "provider"]) || !ARIL_FOLLOW_UP_LOG_KINDS.includes(item.kind)) return null;
  if (USAGE.has(item.kind)) return item.task === null && Object.hasOwn(PROVIDER, item.provider) ? { kind: item.kind, task: null, provider: item.provider } : null;
  return typeof item.task === "string" && TASK.test(item.task) && item.provider === null ? { kind: item.kind, task: item.task, provider: null } : null;
}

// A shared public-data allowlist: the repository, the chat message it opens, and fixed facts.
export function normalizeArilFollowUpData(kind, provider, data) {
  if (!isArilFollowUpKind(kind) || provider !== null || !exact(data, ["repositoryId", "conversationId", "messageId", "items", "more", "ended"])
    || typeof data.repositoryId !== "string" || !REPOSITORY.test(data.repositoryId)) return null;
  const located = data.conversationId === null ? data.messageId === null
    : typeof data.conversationId === "string" && CONVERSATION.test(data.conversationId) && typeof data.messageId === "string" && MESSAGE.test(data.messageId);
  if (!located || !Array.isArray(data.items) || data.items.length > ARIL_FOLLOW_UP_ITEMS
    || !Number.isSafeInteger(data.more) || data.more < 0 || data.more > 1000 || (data.more > 0 && data.items.length < ARIL_FOLLOW_UP_ITEMS)
    || !(data.ended === null || ARIL_FOLLOW_UP_END_REASONS.includes(data.ended))) return null;
  const items = data.items.map(normalizeArilFollowUpItem);
  if (items.some((item) => item === null) || (items.length === 0 && data.ended === null)) return null;
  return { repositoryId: data.repositoryId, conversationId: data.conversationId, messageId: data.messageId, items, more: data.more, ended: data.ended };
}

const list = (parts) => parts.length < 3 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
const sentence = (text) => `${text[0].toUpperCase()}${text.slice(1)}.`;

// The tasks the owner must look at: a refused merge or branch delete, or a failed review the burst did not send back.
function needsOwner(items) {
  const tasks = [];
  items.forEach((item, index) => {
    const failed = item.kind === "review_failed" && !items.slice(index + 1).some((later) => later.task === item.task && later.kind === "sent_back");
    if ((failed || item.kind === "grant_merge_refused" || item.kind === "grant_branch_delete_refused") && !tasks.includes(item.task)) tasks.push(item.task);
  });
  return tasks;
}

function heldProviders(items) {
  const held = new Map();
  for (const item of items) if (USAGE.has(item.kind)) held.set(item.provider, item.kind === "grant_usage_hold");
  return [...held].filter(([, isHeld]) => isHeld).map(([provider]) => PROVIDER[provider]);
}

/** One or two sentences: what happened, then what needs the owner or what comes next. */
export function arilFollowUpText({ items, more, ended }) {
  const parts = [];
  if (items.length > 0) {
    const phrases = items.slice(0, SHOWN).map((item) => PHRASE[item.kind](item.task, item.provider));
    const rest = items.length - SHOWN + more;
    if (rest > 0) phrases.push(`${rest} more ${rest === 1 ? "update" : "updates"}`);
    parts.push(sentence(list(phrases)));
  }
  const owner = needsOwner(items);
  const waiting = owner.length > 0 ? `${list(owner.slice(0, SHOWN))}${owner.length > SHOWN ? " and others" : ""} ${owner.length === 1 ? "needs" : "need"} you` : null;
  const held = heldProviders(items);
  if (ended !== null) parts.push(sentence(`the grant ended because ${ENDED[ended]}${waiting ? `, and ${waiting}` : ""}`));
  else if (waiting) parts.push(sentence(waiting));
  else if (held.length > 0) parts.push(sentence(`new ${list(held)} starts wait until usage is below the limit`));
  else parts.push("Nothing needs you yet.");
  const text = parts.join(" ");
  return text.length <= ARIL_FOLLOW_UP_TEXT_LIMIT ? text : `${text.slice(0, ARIL_FOLLOW_UP_TEXT_LIMIT - 1).replace(/[\s.,;:]+\S*$/u, "")}…`;
}

/** The fixed local route that opens the repository's Aril chat at the follow-up. */
export function arilFollowUpTarget(data) {
  const query = new URLSearchParams({ repository: data.repositoryId, aril: data.conversationId ?? "open" });
  if (data.messageId !== null) query.set("message", data.messageId);
  return `/tasks?${query}`;
}

export function arilFollowUpPayload(record) {
  const data = normalizeArilFollowUpData(record?.kind, record?.provider, record?.data);
  return data ? { title: "Aril", body: arilFollowUpText(data) } : null;
}
