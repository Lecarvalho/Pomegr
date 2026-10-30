// Pure task records: field validation, bounds, and the TaskBoard projection from stored rows.

import { normalizedRequestModel } from "../normalize/request-snapshots.mjs";
import { dispatchStanding } from "./task-dispatch-standing.mjs";
import { orderQueue, taskIsDue } from "./task-queue.mjs";

export const TASK_BOUNDS = Object.freeze({
  tasksPerRepository: 500,
  featuresPerRepository: 50,
  textLength: 4000,
  ownConditionLength: 500,
  featureNameLength: 80,
  featureDescriptionLength: 2000,
  featureAppVersionLength: 40,
  blockReasonLength: 200,
  modelIdentifierLength: 120,
  imagesPerTask: 4,
  imageBytes: 5 * 1024 * 1024,
  afterPerTask: 8,
});
export const TASK_IMAGE_MARKER = /\[image:(img-[0-9a-f]{12})\]/gu;

export function plainTaskText(text) {
  return typeof text === "string" ? text.replace(TASK_IMAGE_MARKER, "[image]") : text;
}

// The image formats a task may hold; the store decides the type from the bytes (task-images.mjs).
export const TASK_IMAGE_TYPES = Object.freeze(["png", "jpeg", "gif", "webp"]);
export const STORED_COLUMN_READ_BOUNDS = Object.freeze({ columns: 12, nameLength: 40 });
export const TASK_SCHEDULE_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;
const SCHEDULE_PAST_TOLERANCE_MS = 60_000;
export const TASK_CHECKS = Object.freeze(["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed", "user_validated"]);
export const TASK_STATES = Object.freeze(["not_queued", "queued", "scheduled", "needs_review", "stalled", "blocked", "done"]);
export const TASK_PROVIDERS = Object.freeze(["claude", "codex"]);
export const TASK_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"]);
export const TASK_QUEUE_STATUSES = Object.freeze(["idle", "running", "blocked", "paused"]);
export const TASK_QUEUE_PAUSE_REASONS = Object.freeze(["cli_missing", "plugin_missing", "unsupported_platform", "start_failed", "session_not_linked", "worktree_dirty", "environment_invalid"]);
export const DEFAULT_TASK_COLUMNS = Object.freeze(["Backlog", "Ready", "In progress", "Review", "Done"]);
export const TASK_COLUMN_ROLES = Object.freeze(["in_progress", "review", "done"]);
export const DEFAULT_TASK_COLUMN_ROLES = Object.freeze([null, null, "in_progress", "review", "done"]);
export const TASK_ACTIONS = Object.freeze([
  "create", "update", "delete", "move",
  "feature_create", "feature_update", "feature_delete", "queue_add", "queue_remove", "queue_group", "queue_ungroup", "queue_settings", "resolve_done", "resolve_requeue",
  "session_assign", "session_unassign", "after_set", "rework_declare", "rework_remove",
  "aril_settings_set", "aril_memory_set", "grant_start", "grant_stop",
]);

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
export const COLUMN_ID = /^col-[0-9a-f]{12}$/u;
export const FEATURE_ID = /^feat-[0-9a-f]{12}$/u;
export const TASK_GROUP_ID = /^grp-[0-9a-f]{12}$/u;
export const TASK_GROUP_MOVES = Object.freeze(["block", "leave"]);
const IMAGE_ID = /^img-[0-9a-f]{12}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export function isRepositoryId(value) {
  return typeof value === "string" && REPOSITORY_ID.test(value);
}

export function isTaskSessionId(value) {
  return typeof value === "string" && SESSION_ID.test(value);
}

export function taskIdFromNumber(number) {
  return Number.isSafeInteger(number) && number >= 1 && number <= 999_999_999 ? `T-${number}` : undefined;
}

export function isTaskId(value) {
  return typeof value === "string" && TASK_ID.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function boundedText(value, maximum, { multiline }) {
  if (typeof value !== "string" || !value.isWellFormed()) return undefined;
  const text = value.trim();
  if (!text || text.length > maximum || (multiline ? TEXT_CONTROL : LINE_CONTROL).test(text)) return undefined;
  return text;
}

function optionalText(value, maximum, options) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return boundedText(value, maximum, options);
}

export function normalizeTaskText(value) {
  return boundedText(value, TASK_BOUNDS.textLength, { multiline: true });
}

export function normalizeOwnCondition(value) {
  return optionalText(value, TASK_BOUNDS.ownConditionLength, { multiline: true });
}

export function normalizeColumnName(value) {
  return boundedText(value, STORED_COLUMN_READ_BOUNDS.nameLength, { multiline: false });
}

export function normalizeFeatureName(value) {
  return boundedText(value, TASK_BOUNDS.featureNameLength, { multiline: false });
}

// A feature's description, or null when it has none.
export function normalizeFeatureDescription(value) {
  return optionalText(value, TASK_BOUNDS.featureDescriptionLength, { multiline: true });
}

// The app version a feature is planned for, as one free line; never compared or parsed.
export function normalizeFeatureAppVersion(value) {
  return optionalText(value, TASK_BOUNDS.featureAppVersionLength, { multiline: false });
}

export function normalizeBlockReason(value) {
  return optionalText(value, TASK_BOUNDS.blockReasonLength, { multiline: false });
}

// A provider model identifier, validated like the request model identifier; never a path, markup, or prose.
export function normalizeModelIdentifier(value) {
  if (value === undefined || value === null || value === "") return null;
  return normalizedRequestModel(value) ?? undefined;
}

function enumValue(value, allowed) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && allowed.includes(value) ? value : undefined;
}

// The planned main-agent settings.
export function normalizeRun(value) {
  if (value === undefined || value === null) return { provider: null, model: null, effort: null, remoteControl: false };
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["provider", "model", "effort", "remoteControl", "keepWorktree"])) return undefined;
  const provider = enumValue(value.provider, TASK_PROVIDERS);
  const model = normalizeModelIdentifier(value.model);
  const effort = enumValue(value.effort, TASK_EFFORTS);
  const remoteControl = value.remoteControl ?? false;
  const keepWorktree = value.keepWorktree ?? false;
  if (provider === undefined || model === undefined || effort === undefined || typeof remoteControl !== "boolean" || typeof keepWorktree !== "boolean") return undefined;
  if (remoteControl && provider === "codex") return undefined;
  // `keepWorktree` is on the run only when it is on: removing the worktree of a done task is the default.
  return model !== null && provider === null ? undefined : { provider, model, effort, remoteControl, ...(keepWorktree ? { keepWorktree: true } : {}) };
}

export function normalizeChecks(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > TASK_CHECKS.length) return undefined;
  if (!value.every((check) => typeof check === "string" && TASK_CHECKS.includes(check)) || new Set(value).size !== value.length) return undefined;
  return TASK_CHECKS.filter((check) => value.includes(check));
}

export function normalizeCompleteWhen(value) {
  if (value === undefined || value === null) return { checks: [], own: null };
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["checks", "own"])) return undefined;
  const checks = normalizeChecks(value.checks);
  const own = normalizeOwnCondition(value.own);
  return checks === undefined || own === undefined ? undefined : { checks, own };
}

export function normalizeTaskInput(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["text", "run", "completeWhen"])) return undefined;
  const text = normalizeTaskText(value.text);
  const run = normalizeRun(value.run);
  const completeWhen = normalizeCompleteWhen(value.completeWhen);
  return text === undefined || run === undefined || completeWhen === undefined ? undefined : { text, run, completeWhen };
}

const PROMOTE_TITLE_LENGTH = 200;
// A body longer than any task could hold is refused before it is measured.
const PROMOTE_BODY_READ_LENGTH = 1_000_000;

export function normalizePromotePayload(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== 3 || !hasOnlyKeys(value, ["number", "title", "body"])) return undefined;
  const { number, title, body } = value;
  if (!Number.isSafeInteger(number) || number < 1 || number > 999_999_999) return undefined;
  if (typeof title !== "string" || !title.isWellFormed() || title !== title.trim() || title.length === 0
    || title.length > PROMOTE_TITLE_LENGTH || LINE_CONTROL.test(title)) return undefined;
  if (typeof body !== "string" || !body.isWellFormed() || body.length > PROMOTE_BODY_READ_LENGTH || TEXT_CONTROL.test(body)) return undefined;
  return { number, title, body: body.trim() };
}

export function normalizeRecordIssuePayload(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || !hasOnlyKeys(value, ["id", "number"])) return undefined;
  const taskNumber = isTaskId(value.id) ? Number(value.id.slice(2)) : undefined;
  const { number } = value;
  if (taskNumber === undefined || !Number.isSafeInteger(number) || number < 1 || number > 999_999_999) return undefined;
  return { taskNumber, issueNumber: number };
}

export function composePromotedText({ title, body }) {
  return body === "" ? title : `${title}\n\n${body}`;
}

function taskNumberFromId(value) {
  return isTaskId(value) ? Number(value.slice(2)) : undefined;
}

function placementFields(value) {
  const { featureId } = value;
  if (featureId !== undefined && featureId !== null && (typeof featureId !== "string" || !FEATURE_ID.test(featureId))) return null;
  return { featureId };
}

export function normalizeCreatePayload(value) {
  if (!isPlainObject(value)) return undefined;
  const rest = { ...value };
  delete rest.featureId;
  const input = normalizeTaskInput(rest);
  const placement = placementFields(value);
  if (input === undefined || placement === null) return undefined;
  return { ...input, featureId: placement.featureId ?? null };
}

// `update` edits one task.
export function normalizeUpdatePayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "text", "run", "completeWhen", "featureId"])) return undefined;
  const number = taskNumberFromId(value.id);
  if (number === undefined) return undefined;
  const update = { number };
  if (value.text !== undefined) update.text = normalizeTaskText(value.text);
  if (value.run !== undefined) update.run = normalizeRun(value.run);
  if (value.completeWhen !== undefined) update.completeWhen = normalizeCompleteWhen(value.completeWhen);
  const placement = placementFields(value);
  if (placement === null) return undefined;
  if (placement.featureId !== undefined) update.featureId = placement.featureId;
  const fields = Object.keys(update).filter((key) => key !== "number");
  return fields.length === 0 || fields.some((key) => update[key] === undefined) ? undefined : update;
}

// `feature_create` carries a title and, optionally, a description and an app version.
export function normalizeFeatureCreatePayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["name", "description", "appVersion"])) return undefined;
  const name = normalizeFeatureName(value.name);
  const description = normalizeFeatureDescription(value.description);
  const appVersion = normalizeFeatureAppVersion(value.appVersion);
  return name === undefined || description === undefined || appVersion === undefined ? undefined : { name, description, appVersion };
}

// `feature_update`: an ID and at least one field; an absent field stays, a null description or app version clears it,
// and `done` marks the feature done or reopens it.
export function normalizeFeatureUpdatePayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "name", "description", "appVersion", "done"])) return undefined;
  if (typeof value.id !== "string" || !FEATURE_ID.test(value.id)) return undefined;
  const update = { feature: { id: value.id } };
  if (value.name !== undefined) update.name = normalizeFeatureName(value.name);
  if (value.description !== undefined) update.description = normalizeFeatureDescription(value.description);
  if (value.appVersion !== undefined) update.appVersion = normalizeFeatureAppVersion(value.appVersion);
  if (value.done !== undefined) update.done = typeof value.done === "boolean" ? value.done : undefined;
  const fields = Object.keys(update).filter((key) => key !== "feature");
  return fields.length === 0 || fields.some((key) => update[key] === undefined) ? undefined : update;
}

// `feature_delete`: the feature's ID alone.
export function normalizeFeatureDeletePayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id"])) return undefined;
  return typeof value.id === "string" && FEATURE_ID.test(value.id) ? { feature: { id: value.id } } : undefined;
}

// A feature named by its ID or by its exact title.
export function normalizeFeatureReference(value) {
  if (typeof value === "string" && FEATURE_ID.test(value)) return { id: value };
  const name = normalizeFeatureName(value);
  return name === undefined ? undefined : { name };
}

// The agent's `create_feature`: a title, and optionally a description and an app version.
export function normalizeAgentFeatureCreatePayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["title", "description", "appVersion"])) return undefined;
  const name = normalizeFeatureName(value.title);
  const description = normalizeFeatureDescription(value.description);
  const appVersion = normalizeFeatureAppVersion(value.appVersion);
  return name === undefined || description === undefined || appVersion === undefined ? undefined : { name, description, appVersion };
}

// The agent's `update_feature`: a present field replaces the stored one, and a null description or app version clears it.
export function normalizeAgentFeatureUpdatePayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["feature", "title", "description", "appVersion"])) return undefined;
  const feature = normalizeFeatureReference(value.feature);
  if (feature === undefined) return undefined;
  const update = { feature };
  if (value.title !== undefined) update.name = normalizeFeatureName(value.title);
  if (value.description !== undefined) update.description = normalizeFeatureDescription(value.description);
  if (value.appVersion !== undefined) update.appVersion = normalizeFeatureAppVersion(value.appVersion);
  const fields = Object.keys(update).filter((key) => key !== "feature");
  return fields.length === 0 || fields.some((key) => update[key] === undefined) ? undefined : update;
}

export function normalizeAgentFeatureDeletePayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["feature"])) return undefined;
  const feature = normalizeFeatureReference(value.feature);
  return feature === undefined ? undefined : { feature };
}

export function normalizeDeletePayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id"])) return undefined;
  const number = taskNumberFromId(value.id);
  return number === undefined ? undefined : { number };
}

export function normalizeQueueTaskPayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id"])) return undefined;
  const number = taskNumberFromId(value.id);
  return number === undefined ? undefined : { number };
}

function instantOf(value) {
  if (typeof value !== "string" || value.length !== 24) return undefined;
  const time = Date.parse(value);
  return Number.isSafeInteger(time) && new Date(time).toISOString() === value ? time : undefined;
}

// A time the user sets now: not behind the clock (beyond a small tolerance) and inside the horizon.
const settableAt = (time, at) => time >= at - SCHEDULE_PAST_TOLERANCE_MS && time <= at + TASK_SCHEDULE_HORIZON_MS;

// `queue_add` carries `{ id }`, `{ id, at }` for a start time, or `{ id, group: "block" }` to queue the task's whole group.
export function normalizeQueueAddPayload(value, now) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "at", "group"])) return undefined;
  const number = taskNumberFromId(value.id);
  if (number === undefined) return undefined;
  if (value.group !== undefined) return value.group === "block" && value.at === undefined ? { number, at: null, block: true } : undefined;
  if (value.at === undefined || value.at === null) return { number, at: null };
  const at = instantOf(value.at);
  return at === undefined || !settableAt(at, now) ? undefined : { number, at };
}

// The `schedule` of `queue_settings`: exactly `{ startAt, stopAfter }`, each an instant or null.
export function normalizeQueueSchedule(value, stored, now) {
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || !hasOnlyKeys(value, ["startAt", "stopAfter"])
    || value.startAt === undefined || value.stopAfter === undefined) return undefined;
  const one = (raw, kept) => {
    if (raw === null) return null;
    const time = instantOf(raw);
    return time === undefined || (time !== kept && !settableAt(time, now)) ? undefined : time;
  };
  const startAt = one(value.startAt, stored?.startAt ?? null);
  const stopAfter = one(value.stopAfter, stored?.stopAfter ?? null);
  if (startAt === undefined || stopAfter === undefined) return undefined;
  return startAt !== null && stopAfter !== null && stopAfter <= startAt ? undefined : { startAt, stopAfter };
}

// `queue_group` and `queue_ungroup` carry exactly `{ ids }`: distinct task IDs, as task numbers in the order given.
export function normalizeTaskIdList(value, least, most) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["ids"]) || !Array.isArray(value.ids) || value.ids.length < least || value.ids.length > most) return undefined;
  const numbers = value.ids.map(taskNumberFromId);
  return numbers.includes(undefined) || new Set(numbers).size !== numbers.length ? undefined : numbers;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function columnIdOf(value) {
  return typeof value === "string" && COLUMN_ID.test(value) ? value : undefined;
}

export function normalizeMovePayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "columnId", "position", "group"])) return undefined;
  const number = taskNumberFromId(value.id);
  const columnId = columnIdOf(value.columnId);
  const position = nonNegativeInteger(value.position);
  // `group` says what a grouped card does: "block" moves its whole group, "leave" takes the card out of it.
  const group = value.group === undefined ? null : enumValue(value.group, TASK_GROUP_MOVES);
  return number === undefined || columnId === undefined || position === undefined || group === undefined ? undefined : { number, columnId, position: position + 0, group };
}

function isoTime(value) {
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function optionalIsoTime(value) {
  return value === null || value === undefined ? null : isoTime(value);
}

function parsedJsonArray(value) {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeReport(row) {
  if (row.report_at === null || row.report_at === undefined) return row.report_results == null && row.report_block_reason == null ? null : undefined;
  const at = isoTime(row.report_at);
  const parsed = parsedJsonArray(row.report_results);
  const blockReason = normalizeBlockReason(row.report_block_reason);
  const attention = normalizeBlockReason(row.report_attention) ?? null;
  if (at === undefined || parsed === undefined || blockReason === undefined || parsed.length > TASK_CHECKS.length) return undefined;
  const results = [];
  for (const item of parsed) {
    if (!isPlainObject(item) || !hasOnlyKeys(item, ["check", "passed", "unavailable"]) || typeof item.passed !== "boolean"
      || typeof item.check !== "string" || !TASK_CHECKS.includes(item.check)) return undefined;
    // `unavailable` marks a condition Pomegr could not verify; it never accompanies a pass.
    if (Object.hasOwn(item, "unavailable") && (item.unavailable !== true || item.passed)) return undefined;
    results.push({ check: item.check, passed: item.passed, ...(item.unavailable === true ? { unavailable: true } : {}) });
  }
  return { at, results, blockReason, attention };
}

// A task's stored image list as `{ id, type, bytes }[]`.
export function normalizeStoredImages(value) {
  const images = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    if (images.length >= TASK_BOUNDS.imagesPerTask) break;
    if (!isPlainObject(entry) || typeof entry.id !== "string" || !IMAGE_ID.test(entry.id) || seen.has(entry.id)
      || !TASK_IMAGE_TYPES.includes(entry.type) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > TASK_BOUNDS.imageBytes) continue;
    seen.add(entry.id);
    images.push({ id: entry.id, type: entry.type, bytes: entry.bytes });
  }
  return images;
}

export function normalizeStoredTask(row) {
  if (!isPlainObject(row)) return undefined;
  const id = taskIdFromNumber(row.number);
  const text = normalizeTaskText(row.text);
  const position = nonNegativeInteger(row.position);
  const run = normalizeRun({ provider: row.run_provider, model: row.run_model, effort: row.run_effort, remoteControl: row.run_remote_control === true && row.run_provider !== "codex", keepWorktree: row.run_keep_worktree === true });
  const storedChecks = parsedJsonArray(row.checks);
  const checks = storedChecks === undefined ? undefined : normalizeChecks(storedChecks);
  const own = normalizeOwnCondition(row.own_condition);
  const scheduledAt = optionalIsoTime(row.scheduled_at);
  const report = normalizeReport(row);
  const createdAt = isoTime(row.created_at);
  const updatedAt = isoTime(row.updated_at);
  const featureId = row.feature_id ?? null;
  // The store attaches the stored group (task-groups.mjs); `projectBoard` keeps it only while the group counts.
  const group = typeof row.group === "string" && TASK_GROUP_ID.test(row.group) ? row.group : null;
  // The store attaches what the task runs after (task-after.mjs); `projectBoard` keeps the tasks that are on the board.
  const after = (Array.isArray(row.after) ? row.after : []).filter((number) => Number.isSafeInteger(number) && number >= 1).map(taskIdFromNumber);
  const sessionId = row.session_id ?? null;
  const issueNumber = row.source_issue ?? null;
  const source = Number.isSafeInteger(issueNumber) && issueNumber >= 1 && issueNumber <= 999_999_999 ? { kind: "github_issue", number: issueNumber } : null;
  if ([id, text, position, run, checks, own, scheduledAt, report, createdAt, updatedAt].includes(undefined)) return undefined;
  if (typeof row.column_id !== "string" || !COLUMN_ID.test(row.column_id)) return undefined;
  if (!TASK_STATES.includes(row.state)) return undefined;
  if (featureId !== null && (typeof featureId !== "string" || !FEATURE_ID.test(featureId))) return undefined;
  if (sessionId !== null && (typeof sessionId !== "string" || !SESSION_ID.test(sessionId))) return undefined;
  // The store attaches the assigned sessions (task-assignments.mjs). The session Pomegr started is never listed twice.
  const assigned = (Array.isArray(row.assigned_sessions) ? row.assigned_sessions : [])
    .filter((entry) => typeof entry === "string" && SESSION_ID.test(entry) && entry !== sessionId)
    .map((entry) => ({ id: entry, title: null, state: "unknown", observedModel: null, observedEffort: null }));
  return {
    id, text, columnId: row.column_id, position, featureId, group, ...(after.length > 0 ? { after } : {}), run,
    completeWhen: { checks, own },
    state: row.state,
    scheduledAt,
    session: sessionId === null ? null : { id: sessionId, title: null, state: "unknown", observedModel: null, observedEffort: null },
    ...(assigned.length > 0 ? { assigned } : {}),
    source,
    // The store attaches the task's image list (task-images.mjs): identifiers, fixed types, and sizes, never bytes.
    images: normalizeStoredImages(row.images),
    report, createdAt, updatedAt,
  };
}

export function normalizeStoredColumn(row) {
  if (!isPlainObject(row) || typeof row.id !== "string" || !COLUMN_ID.test(row.id)) return undefined;
  const name = normalizeColumnName(row.name);
  const position = nonNegativeInteger(row.position);
  // The store reads the role from `meta` (task-columns.mjs); a row without one has no role.
  const role = enumValue(row.role, TASK_COLUMN_ROLES);
  return name === undefined || position === undefined || role === undefined ? undefined : { id: row.id, name, position, role };
}

export function normalizeStoredFeature(row) {
  if (!isPlainObject(row) || typeof row.id !== "string" || !FEATURE_ID.test(row.id)) return undefined;
  const name = normalizeFeatureName(row.name);
  return name === undefined ? undefined : { id: row.id, name, done: row.done === true };
}

export function emptyBoard(repositoryId, readiness) {
  return { version: 1, readiness, repositoryId, columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] } };
}

export const IN_FLIGHT_STATES = Object.freeze(["not_queued", "queued", "scheduled"]);

export function rowInFlight(row, at) {
  const linked = (row.session_id ?? null) !== null;
  if (linked && IN_FLIGHT_STATES.includes(row.state)) return true;
  return at !== undefined && dispatchStanding(row.dispatch_token, at) === "live";
}

// A membership of a parallel group counts for a task in the queue, waiting or in flight, and for a planned task: one
// that is not queued, has not started, and whose card is in Backlog or Ready (a column with no role).
export function groupMemberCounts(row, inUnroledColumn) {
  if (row.state === "queued" || row.state === "scheduled") return true;
  return row.state === "not_queued" && (row.session_id ?? null) === null && inUnroledColumn === true;
}

// A task has started once a session is linked, a dispatch is live, or it holds an outcome. Only a requeue makes it editable again.
export function rowStarted(row, at) {
  return (row.session_id ?? null) !== null || !IN_FLIGHT_STATES.includes(row.state) || dispatchStanding(row.dispatch_token, at) === "live";
}

// Builds the browser board from one repository's stored rows.
export function projectBoard(repositoryId, { repository, columns, features, tasks }, { at } = {}) {
  if (!isRepositoryId(repositoryId) || !isPlainObject(repository)) return undefined;
  if (columns.length > STORED_COLUMN_READ_BOUNDS.columns || features.length > TASK_BOUNDS.featuresPerRepository
    || tasks.length > TASK_BOUNDS.tasksPerRepository) return undefined;
  const status = repository.queue_status;
  const storedBlockedBy = repository.queue_blocked_by ?? null;
  const pauseReason = status === "paused" && TASK_QUEUE_PAUSE_REASONS.includes(repository.pause_reason) ? repository.pause_reason : null;
  if (!TASK_QUEUE_STATUSES.includes(status) || (storedBlockedBy !== null && !isTaskId(storedBlockedBy))) return undefined;

  const projectedColumns = columns.map(normalizeStoredColumn);
  const projectedFeatures = features.map(normalizeStoredFeature);
  const projectedTasks = tasks.map(normalizeStoredTask);
  if ([...projectedColumns, ...projectedFeatures, ...projectedTasks].includes(undefined)) return undefined;

  const columnOrder = new Map(projectedColumns.toSorted((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map((column, index) => [column.id, index]));
  const featureIds = new Set(projectedFeatures.map((feature) => feature.id));
  if (projectedTasks.some((task) => !columnOrder.has(task.columnId) || (task.featureId !== null && !featureIds.has(task.featureId)))) return undefined;

  // A task that is gone is never served as a task ID.
  const blockedBy = projectedTasks.some((task) => task.id === storedBlockedBy) ? storedBlockedBy : null;

  // A task runs after the tasks that are on the board; one that is gone holds nothing.
  const states = new Map(projectedTasks.map((task) => [task.id, task.state]));
  for (const task of projectedTasks) {
    if (task.after === undefined) continue;
    const kept = task.after.filter((id) => states.has(id));
    if (kept.length > 0) task.after = kept;
    else delete task.after;
  }
  // The queue order carries task IDs only. A task that waits for an unfinished task it runs after is not in it.
  const { order } = orderQueue(
    projectedTasks.map((task, index) => ({
      id: task.id, group: task.group, state: task.state, queuePosition: task.position,
      due: task.state === "scheduled" && at !== undefined && taskIsDue(tasks[index].scheduled_at ?? null, at),
      inFlight: rowInFlight(tasks[index], at),
      waitsFor: (task.after ?? []).filter((id) => states.get(id) !== "done"),
    })),
  );
  // A task keeps its group only while two or more of its members count: in the queue, or planned (task-groups.mjs).
  const unrolled = new Set(projectedColumns.filter((column) => column.role === null).map((column) => column.id));
  const counts = (task, index) => groupMemberCounts(tasks[index], unrolled.has(task.columnId));
  const sizes = new Map();
  projectedTasks.forEach((task, index) => { if (task.group !== null && counts(task, index)) sizes.set(task.group, (sizes.get(task.group) ?? 0) + 1); });
  projectedTasks.forEach((task, index) => { if (task.group !== null && (!counts(task, index) || sizes.get(task.group) < 2)) task.group = null; });
  const startAt = optionalIsoTime(repository.start_at) ?? null;
  const stopAfter = optionalIsoTime(repository.stop_after) ?? null;
  return {
    version: 1,
    readiness: "ready",
    repositoryId,
    columns: projectedColumns.toSorted((a, b) => columnOrder.get(a.id) - columnOrder.get(b.id)),
    features: projectedFeatures.map((feature) => ({ id: feature.id, name: feature.name, done: feature.done })),
    tasks: projectedTasks.toSorted((a, b) => columnOrder.get(a.columnId) - columnOrder.get(b.columnId) || a.position - b.position || taskNumber(a) - taskNumber(b)),
    queue: { status, blockedBy, pauseReason, order, ...(startAt === null && stopAfter === null ? {} : { schedule: { startAt, stopAfter } }) },
  };
}

function taskNumber(task) {
  return Number(task.id.slice(2));
}
