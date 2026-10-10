// Pure task records: field validation, bounds, and the TaskBoard projection from stored rows.
// No store, route, or Git access. Validators return the normalized value, or `undefined` for
// invalid input; `null` is returned only where the contract allows it (an absent optional
// field). Callers never see user-authored content that failed a bound.
//
// The shapes mirror shared/task-contract.ts, a TypeScript module the monitor cannot import.
// tests/server/tasks/task-record.test.mjs pins every constant below to that contract.

import { normalizedRequestModel } from "../normalize/request-snapshots.mjs";
import { dispatchStanding } from "./task-dispatch-standing.mjs";
import { orderQueue, taskIsDue } from "./task-queue.mjs";

export const TASK_BOUNDS = Object.freeze({
  tasksPerRepository: 500,
  featuresPerRepository: 50,
  textLength: 4000,
  ownConditionLength: 500,
  featureNameLength: 80,
  blockReasonLength: 200,
  modelIdentifierLength: 120,
});
// What an older store may hold in columns, read before the board is brought to the fixed five (task-columns.mjs).
// Not a bound a user meets: a store over them stays unavailable and unwritten.
export const STORED_COLUMN_READ_BOUNDS = Object.freeze({ columns: 12, nameLength: 40 });
/** A start or stop time may lie at most this far ahead, and a new one at most `SCHEDULE_PAST_TOLERANCE_MS` behind the clock. */
export const TASK_SCHEDULE_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;
const SCHEDULE_PAST_TOLERANCE_MS = 60_000;
export const TASK_CHECKS = Object.freeze(["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed"]);
export const TASK_STATES = Object.freeze(["not_queued", "queued", "scheduled", "needs_review", "stalled", "blocked", "done"]);
export const TASK_PROVIDERS = Object.freeze(["claude", "codex"]);
export const TASK_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"]);
export const TASK_QUEUE_STATUSES = Object.freeze(["idle", "running", "blocked", "paused"]);
export const TASK_QUEUE_PAUSE_REASONS = Object.freeze(["cli_missing", "plugin_missing", "unsupported_platform", "start_failed", "session_not_linked", "worktree_dirty"]);
export const DEFAULT_TASK_COLUMNS = Object.freeze(["Backlog", "Ready", "In progress", "Review", "Done"]);
/** The role one of the fixed columns holds: where a card goes when its session links, needs review, or is done (task-columns.mjs). */
export const TASK_COLUMN_ROLES = Object.freeze(["in_progress", "review", "done"]);
/** The roles the default columns are seeded with, in the order of `DEFAULT_TASK_COLUMNS`. */
export const DEFAULT_TASK_COLUMN_ROLES = Object.freeze([null, null, "in_progress", "review", "done"]);
// The fixed action list shared by the route (which rejects any other name) and the store (which
// answers `unsupported` for a listed action whose part has not landed).
export const TASK_ACTIONS = Object.freeze([
  "create", "update", "delete", "move",
  "feature_create", "queue_add", "queue_remove", "queue_reorder", "queue_settings", "resolve_done", "resolve_requeue",
]);

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
export const COLUMN_ID = /^col-[0-9a-f]{12}$/u;
export const FEATURE_ID = /^feat-[0-9a-f]{12}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
// Free text may span lines and tabs; every other control character is rejected.
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export function isRepositoryId(value) {
  return typeof value === "string" && REPOSITORY_ID.test(value);
}

/** A normalized session ID the store may link to a task (`claude:<id>`); the same pattern a stored link must satisfy. */
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

/** Optional text: absent or blank is null, anything over a bound is invalid. */
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

export function normalizeBlockReason(value) {
  return optionalText(value, TASK_BOUNDS.blockReasonLength, { multiline: false });
}

/** A provider model identifier, validated like the request model identifier; never a path, markup, or prose. */
export function normalizeModelIdentifier(value) {
  if (value === undefined || value === null || value === "") return null;
  return normalizedRequestModel(value) ?? undefined;
}

function enumValue(value, allowed) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && allowed.includes(value) ? value : undefined;
}

/**
 * The planned main-agent settings. Every part is optional; an unknown key is invalid. A model
 * names one provider's model, so a model without its provider is invalid.
 */
export function normalizeRun(value) {
  if (value === undefined || value === null) return { provider: null, model: null, effort: null };
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["provider", "model", "effort"])) return undefined;
  const provider = enumValue(value.provider, TASK_PROVIDERS);
  const model = normalizeModelIdentifier(value.model);
  const effort = enumValue(value.effort, TASK_EFFORTS);
  if (provider === undefined || model === undefined || effort === undefined) return undefined;
  return model !== null && provider === null ? undefined : { provider, model, effort };
}

/** Checks are unique and known; the result is in the fixed contract order. */
export function normalizeChecks(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > TASK_CHECKS.length) return undefined;
  if (!value.every((check) => typeof check === "string" && TASK_CHECKS.includes(check)) || new Set(value).size !== value.length) return undefined;
  return TASK_CHECKS.filter((check) => value.includes(check));
}

export function normalizeDoneWhen(value) {
  if (value === undefined || value === null) return { checks: [], own: null };
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["checks", "own"])) return undefined;
  const checks = normalizeChecks(value.checks);
  const own = normalizeOwnCondition(value.own);
  return checks === undefined || own === undefined ? undefined : { checks, own };
}

/** The user-authored fields of a new or edited task; nothing else is accepted. */
export function normalizeTaskInput(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["text", "run", "doneWhen"])) return undefined;
  const text = normalizeTaskText(value.text);
  const run = normalizeRun(value.run);
  const doneWhen = normalizeDoneWhen(value.doneWhen);
  return text === undefined || run === undefined || doneWhen === undefined ? undefined : { text, run, doneWhen };
}

const PROMOTE_TITLE_LENGTH = 200;
// A body longer than any task could hold is refused before it is measured.
const PROMOTE_BODY_READ_LENGTH = 1_000_000;

/**
 * `promote_issue` is a store action only; no route or desktop channel carries it. It holds exactly the issue
 * `number`, its bounded one-line `title`, and the already stripped `body`. Returns `{ number, title, body }`, or
 * undefined when invalid. Whether the composed text fits the task bound is the store's to judge (`limit`).
 */
export function normalizePromotePayload(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== 3 || !hasOnlyKeys(value, ["number", "title", "body"])) return undefined;
  const { number, title, body } = value;
  if (!Number.isSafeInteger(number) || number < 1 || number > 999_999_999) return undefined;
  if (typeof title !== "string" || !title.isWellFormed() || title !== title.trim() || title.length === 0
    || title.length > PROMOTE_TITLE_LENGTH || LINE_CONTROL.test(title)) return undefined;
  if (typeof body !== "string" || !body.isWellFormed() || body.length > PROMOTE_BODY_READ_LENGTH || TEXT_CONTROL.test(body)) return undefined;
  return { number, title, body: body.trim() };
}

/**
 * `record_issue` is a store action only. It holds exactly a task `id` and the `number` of the issue GitHub created for
 * it. Returns `{ taskNumber, issueNumber }`, or undefined when invalid.
 */
export function normalizeRecordIssuePayload(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || !hasOnlyKeys(value, ["id", "number"])) return undefined;
  const taskNumber = isTaskId(value.id) ? Number(value.id.slice(2)) : undefined;
  const { number } = value;
  if (taskNumber === undefined || !Number.isSafeInteger(number) || number < 1 || number > 999_999_999) return undefined;
  return { taskNumber, issueNumber: number };
}

/** The text a promoted task stores: the title alone for an empty body, else the title, a blank line, and the body. */
export function composePromotedText({ title, body }) {
  return body === "" ? title : `${title}\n\n${body}`;
}

/** The number of a validated `T-<n>` task ID, or undefined. */
function taskNumberFromId(value) {
  return isTaskId(value) ? Number(value.slice(2)) : undefined;
}

/**
 * The optional feature placement keys of `create` and `update`. `featureId` is a feature ID or null,
 * `step` an integer of at least 1 or null; an absent key stays undefined. Returns the pair, or null
 * when a present value is outside that shape.
 */
function placementFields(value) {
  const { featureId, step } = value;
  if (featureId !== undefined && featureId !== null && (typeof featureId !== "string" || !FEATURE_ID.test(featureId))) return null;
  if (step !== undefined && step !== null && (!Number.isSafeInteger(step) || step < 1)) return null;
  return { featureId, step };
}

/**
 * `create` carries the task text and, optionally, the planned run, the done-when conditions, and a
 * feature with a step. Returns `{ text, run, doneWhen, featureId, step }` with every absent part at its
 * empty value (a null `step` in a feature means the new last step), or undefined when invalid.
 */
export function normalizeCreatePayload(value) {
  if (!isPlainObject(value)) return undefined;
  const rest = { ...value };
  delete rest.featureId;
  delete rest.step;
  const input = normalizeTaskInput(rest);
  const placement = placementFields(value);
  if (input === undefined || placement === null) return undefined;
  const featureId = placement.featureId ?? null;
  const step = placement.step ?? null;
  return featureId === null && step !== null ? undefined : { ...input, featureId, step };
}

/**
 * `update` edits one task. `text`, `run`, `doneWhen`, `featureId`, and `step` are each optional, at
 * least one is required, and a field that is present replaces the stored one whole: a null `run` or
 * `doneWhen` clears it, a null `featureId` detaches the task, and an absent field is left as stored.
 * Returns `{ number }` plus only the fields that were present, or undefined when invalid.
 */
export function normalizeUpdatePayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "text", "run", "doneWhen", "featureId", "step"])) return undefined;
  const number = taskNumberFromId(value.id);
  if (number === undefined) return undefined;
  const update = { number };
  if (value.text !== undefined) update.text = normalizeTaskText(value.text);
  if (value.run !== undefined) update.run = normalizeRun(value.run);
  if (value.doneWhen !== undefined) update.doneWhen = normalizeDoneWhen(value.doneWhen);
  const placement = placementFields(value);
  if (placement === null) return undefined;
  // A detach carries no step; whether a lone step fits the stored task is the store's to judge.
  if (placement.featureId === null && placement.step !== undefined && placement.step !== null) return undefined;
  if (placement.featureId !== undefined) update.featureId = placement.featureId;
  if (placement.step !== undefined) update.step = placement.step;
  const fields = Object.keys(update).filter((key) => key !== "number");
  return fields.length === 0 || fields.some((key) => update[key] === undefined) ? undefined : update;
}

/** `feature_create` carries only the name. Returns `{ name }`, or undefined when invalid. */
export function normalizeFeatureCreatePayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["name"])) return undefined;
  const name = normalizeFeatureName(value.name);
  return name === undefined ? undefined : { name };
}

/** `delete` names one task. Returns `{ number }`, or undefined when invalid. */
export function normalizeDeletePayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id"])) return undefined;
  const number = taskNumberFromId(value.id);
  return number === undefined ? undefined : { number };
}

/** `queue_remove` names one task. Returns `{ number }`, or undefined when invalid. */
export function normalizeQueueTaskPayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id"])) return undefined;
  const number = taskNumberFromId(value.id);
  return number === undefined ? undefined : { number };
}

/** An instant as the contract writes it (`2026-10-09T02:00:00.000Z`), in epoch milliseconds, or undefined. */
function instantOf(value) {
  if (typeof value !== "string" || value.length !== 24) return undefined;
  const time = Date.parse(value);
  return Number.isSafeInteger(time) && new Date(time).toISOString() === value ? time : undefined;
}

/** A time the user sets now: not behind the clock (beyond a small tolerance) and inside the horizon. */
const settableAt = (time, at) => time >= at - SCHEDULE_PAST_TOLERANCE_MS && time <= at + TASK_SCHEDULE_HORIZON_MS;

/**
 * `queue_add` names one task and, optionally, its own start time: `at` is an instant, or absent or null for none.
 * `now` is the clock in epoch milliseconds. Returns `{ number, at }` with `at` in epoch milliseconds or null, or
 * undefined when invalid; a time behind the clock or past the horizon is invalid.
 */
export function normalizeQueueAddPayload(value, now) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "at"])) return undefined;
  const number = taskNumberFromId(value.id);
  if (number === undefined) return undefined;
  if (value.at === undefined || value.at === null) return { number, at: null };
  const at = instantOf(value.at);
  return at === undefined || !settableAt(at, now) ? undefined : { number, at };
}

/**
 * The `schedule` of `queue_settings`: exactly `{ startAt, stopAfter }`, each an instant or null. A time that changes
 * must be settable now; one that is sent back as stored (`stored`, epoch milliseconds or null) is kept even when it
 * has passed, so the other one can still be edited. A stop time must come after the start time. Returns both in
 * epoch milliseconds or null, or undefined when invalid.
 */
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

/**
 * `queue_reorder` moves one queued task of a feature to a step. Both keys are required and `step` is an
 * integer of at least 1; whether the step exists is the store's to judge. Returns `{ number, step }`,
 * or undefined when invalid.
 */
export function normalizeQueueReorderPayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "step"])) return undefined;
  const number = taskNumberFromId(value.id);
  return number === undefined || !Number.isSafeInteger(value.step) || value.step < 1 ? undefined : { number, step: value.step };
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function columnIdOf(value) {
  return typeof value === "string" && COLUMN_ID.test(value) ? value : undefined;
}

/**
 * `move` puts one task at a 0-based index of a column, counted after the task leaves its old place;
 * the store clamps an index past the end to an append. Returns `{ number, columnId, position }`, or
 * undefined when invalid. Every key is required and no other key is accepted.
 */
export function normalizeMovePayload(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "columnId", "position"])) return undefined;
  const number = taskNumberFromId(value.id);
  const columnId = columnIdOf(value.columnId);
  const position = nonNegativeInteger(value.position);
  return number === undefined || columnId === undefined || position === undefined ? undefined : { number, columnId, position: position + 0 };
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
  if (at === undefined || parsed === undefined || blockReason === undefined || parsed.length > TASK_CHECKS.length) return undefined;
  const results = [];
  for (const item of parsed) {
    if (!isPlainObject(item) || !hasOnlyKeys(item, ["check", "passed"]) || typeof item.passed !== "boolean"
      || typeof item.check !== "string" || !TASK_CHECKS.includes(item.check)) return undefined;
    results.push({ check: item.check, passed: item.passed });
  }
  return { at, results, blockReason };
}

/** Projects one stored `tasks` row; undefined when any stored field is outside the contract. */
export function normalizeStoredTask(row) {
  if (!isPlainObject(row)) return undefined;
  const id = taskIdFromNumber(row.number);
  const text = normalizeTaskText(row.text);
  const position = nonNegativeInteger(row.position);
  const run = normalizeRun({ provider: row.run_provider, model: row.run_model, effort: row.run_effort });
  const storedChecks = parsedJsonArray(row.checks);
  const checks = storedChecks === undefined ? undefined : normalizeChecks(storedChecks);
  const own = normalizeOwnCondition(row.own_condition);
  const scheduledAt = optionalIsoTime(row.scheduled_at);
  const report = normalizeReport(row);
  const createdAt = isoTime(row.created_at);
  const updatedAt = isoTime(row.updated_at);
  const featureId = row.feature_id ?? null;
  const step = row.step ?? null;
  const sessionId = row.session_id ?? null;
  // The store attaches the issue number a promoted task came from (task-source.mjs); a value outside the contract is no source.
  const issueNumber = row.source_issue ?? null;
  const source = Number.isSafeInteger(issueNumber) && issueNumber >= 1 && issueNumber <= 999_999_999 ? { kind: "github_issue", number: issueNumber } : null;
  if ([id, text, position, run, checks, own, scheduledAt, report, createdAt, updatedAt].includes(undefined)) return undefined;
  if (typeof row.column_id !== "string" || !COLUMN_ID.test(row.column_id)) return undefined;
  if (!TASK_STATES.includes(row.state)) return undefined;
  // A task is in a feature at a step, or in neither.
  if (featureId === null ? step !== null : typeof featureId !== "string" || !FEATURE_ID.test(featureId) || !Number.isSafeInteger(step) || step < 1) return undefined;
  if (sessionId !== null && (typeof sessionId !== "string" || !SESSION_ID.test(sessionId))) return undefined;
  return {
    id, text, columnId: row.column_id, position, featureId, step, run,
    doneWhen: { checks, own },
    state: row.state,
    scheduledAt,
    // A linked session's title, state, and model are borrowed from committed observation by
    // `fillTaskSessions` (task-board.mjs); until it supplies them they are unknown, never guessed.
    session: sessionId === null ? null : { id: sessionId, title: null, state: "unknown", observedModel: null },
    source,
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
  return name === undefined ? undefined : { id: row.id, name };
}

/** A board with no content, for unavailable and loading answers. */
export function emptyBoard(repositoryId, readiness) {
  return { version: 1, readiness, repositoryId, columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] } };
}

/**
 * States a task can still be in while no outcome is recorded for its dispatch: its session is working on it, or has yet
 * to link. A session may only report on a task in one of them; an outcome (done, needs review, blocked, stalled) is final.
 */
export const IN_FLIGHT_STATES = Object.freeze(["not_queued", "queued", "scheduled"]);

/**
 * The one rule for a task that already started: its session is linked and has not reported, or its start is
 * still inside the ten minutes it waits for the session to link. `at` is the clock in epoch milliseconds. Without it a
 * dispatch cannot be judged live, so only a linked row counts as in flight (a live dispatch with no session
 * yet is then missed, never a task wrongly held).
 */
export function rowInFlight(row, at) {
  const linked = (row.session_id ?? null) !== null;
  if (linked && IN_FLIGHT_STATES.includes(row.state)) return true;
  return at !== undefined && dispatchStanding(row.dispatch_token, at) === "live";
}

/**
 * Builds the browser board from one repository's stored rows. Returns undefined when any row is
 * outside the contract or the rows disagree with each other, so a damaged store is reported as
 * unavailable instead of served partially. `at` is the clock in epoch milliseconds: with it, a scheduled task
 * whose time has come is in the queue order; without it no scheduled task is.
 */
export function projectBoard(repositoryId, { repository, columns, features, tasks }, { at } = {}) {
  if (!isRepositoryId(repositoryId) || !isPlainObject(repository)) return undefined;
  if (columns.length > STORED_COLUMN_READ_BOUNDS.columns || features.length > TASK_BOUNDS.featuresPerRepository
    || tasks.length > TASK_BOUNDS.tasksPerRepository) return undefined;
  const status = repository.queue_status;
  const blockedBy = repository.queue_blocked_by ?? null;
  // The reason is kept beside the repository row (the store reads it from `meta`) and means something only while paused.
  const pauseReason = status === "paused" && TASK_QUEUE_PAUSE_REASONS.includes(repository.pause_reason) ? repository.pause_reason : null;
  if (!TASK_QUEUE_STATUSES.includes(status) || (blockedBy !== null && !isTaskId(blockedBy))) return undefined;

  const projectedColumns = columns.map(normalizeStoredColumn);
  const projectedFeatures = features.map(normalizeStoredFeature);
  const projectedTasks = tasks.map(normalizeStoredTask);
  if ([...projectedColumns, ...projectedFeatures, ...projectedTasks].includes(undefined)) return undefined;

  const columnOrder = new Map(projectedColumns.toSorted((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map((column, index) => [column.id, index]));
  const featureIds = new Set(projectedFeatures.map((feature) => feature.id));
  if (projectedTasks.some((task) => !columnOrder.has(task.columnId) || (task.featureId !== null && !featureIds.has(task.featureId)))) return undefined;

  const doneByFeature = new Map();
  for (const task of projectedTasks) {
    if (task.featureId !== null) doneByFeature.set(task.featureId, (doneByFeature.get(task.featureId) ?? true) && task.state === "done");
  }
  // The queue order carries task IDs only. A single task's place is the place of its card: the store keeps every
  // waiting card in Ready (`settleReadyColumn`), so the card position orders them.
  const { order } = orderQueue(
    projectedTasks.map((task, index) => ({
      id: task.id, featureId: task.featureId, step: task.step, state: task.state, queuePosition: task.position,
      due: task.state === "scheduled" && at !== undefined && taskIsDue(tasks[index].scheduled_at ?? null, at),
      inFlight: rowInFlight(tasks[index], at),
    })),
    projectedFeatures,
  );
  const startAt = optionalIsoTime(repository.start_at) ?? null;
  const stopAfter = optionalIsoTime(repository.stop_after) ?? null;
  return {
    version: 1,
    readiness: "ready",
    repositoryId,
    columns: projectedColumns.toSorted((a, b) => columnOrder.get(a.id) - columnOrder.get(b.id)),
    // A feature is done when it has tasks and every one of them is done.
    features: projectedFeatures.map((feature) => ({ id: feature.id, name: feature.name, done: doneByFeature.get(feature.id) === true })),
    tasks: projectedTasks.toSorted((a, b) => columnOrder.get(a.columnId) - columnOrder.get(b.columnId) || a.position - b.position || taskNumber(a) - taskNumber(b)),
    // The queue's own times are kept beside the repository row like the pause reason; one that is not a time reads as
    // not set, and a queue with neither carries no schedule.
    queue: { status, blockedBy, pauseReason, order, ...(startAt === null && stopAfter === null ? {} : { schedule: { startAt, stopAfter } }) },
  };
}

function taskNumber(task) {
  return Number(task.id.slice(2));
}
