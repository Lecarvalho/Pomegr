// The board changes the chat agent proposes: read from its answer, validated here, and applied only after the owner approves.

export const PROPOSAL_FENCE = "pomegr-board";
export const PROPOSAL_OPERATION_LIMIT = 40;
export const PROPOSAL_SUMMARY_LIMIT = 300;
export const BOARD_OPERATIONS = Object.freeze([
  "create_feature", "update_feature", "delete_feature", "create_task", "update_task", "delete_task", "move_task", "queue_task", "unqueue_task", "group_tasks", "ungroup_tasks", "set_after", "attach_images", "start_session", "set_queue", "set_aril_settings", "add_memory", "update_memory", "remove_memory", "remove_worktree", "declare_rework",
]);
// The operations that edit a feature already on the board. Only the desktop window applies them, as only it edits features.
export const FEATURE_EDIT_OPERATIONS = Object.freeze(["update_feature", "delete_feature"]);
export const ARIL_OPERATIONS = Object.freeze(["set_aril_settings"]);
// Memory was once changed by a proposal with Apply. Aril now keeps it current by itself (agent-chat-memory.mjs), and a new answer with one of
// these is outside the contract. A saved conversation may still hold one, and it reads back as it was written; its Apply no longer does anything.
export const LEGACY_MEMORY_OPERATIONS = Object.freeze(["add_memory", "update_memory", "remove_memory"]);
export const WORKTREE_RESULTS = Object.freeze(["removed", "not_found", "dirty", "unique_commits", "in_use", "failed"]);
// The one operation that puts images the owner sent in the chat on a task that is already on the board.
export const IMAGE_OPERATION = "attach_images";
// The one operation that is not a board change: it asks the desktop to start a session for a task, and stands alone in its proposal.
export const START_OPERATION = "start_session";
// The one operation that turns the repository's queue on or off. It names the state the owner asked for, never a toggle,
// and it stands alone in its proposal too.
export const QUEUE_OPERATION = "set_queue";
// What an approved queue change left: on, on and held by a task that needs the owner, or off.
export const QUEUE_RESULTS = Object.freeze(["on", "blocked", "off"]);
// Why an approved start did not launch a session: the fixed statuses of a manual start, without `started` and `cancelled`.
export const START_FAILURES = Object.freeze([
  "unsupported_platform", "cli_missing", "plugin_missing", "not_startable", "gate_held", "unsupported_provider", "not_found", "busy",
  "invalid", "unavailable", "failed", "worktree_dirty", "tree_dirty", "environment_invalid",
]);
export const BOARD_COLUMNS = Object.freeze(["Backlog", "Ready", "In progress", "Review", "Done"]);

const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const IMAGE_ID = /^img-[0-9a-f]{12}$/u;
// What one message of the owner, and one task, may hold.
export const IMAGES_PER_OPERATION = 4;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,119}$/u;
const ONE_LINE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
const TEXT_LINES = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]*$/u;
const PROVIDERS = new Set(["claude", "codex"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const CHECKS = Object.freeze(["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed", "user_validated"]);
const TEXT_LIMIT = 4000;
const OWN_LIMIT = 500;
const FEATURE_LIMIT = 80;
const GROUP_LIMIT = 16;
const POSITION_LIMIT = 100_000;
const BLOCK_LIMIT_BYTES = 256 * 1024;
const ACTION_ERRORS = new Set(["invalid", "not_found", "limit", "conflict", "unsupported"]);
const FENCE = new RegExp(`(^|\\n)\`\`\`${PROPOSAL_FENCE}[^\\n]*\\n([\\s\\S]*?)\\n?\`\`\`[ \\t]*\\r?(?=\\n|$)`, "gu");
const OPEN_FENCE = new RegExp(`(^|\\n)\`\`\`${PROPOSAL_FENCE}[\\s\\S]*$`, "u");

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A list of image IDs as a message or an operation names them: one to four, each once. Null when it is anything else. */
export function chatImageIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > IMAGES_PER_OPERATION) return null;
  if (!value.every((id) => typeof id === "string" && IMAGE_ID.test(id)) || new Set(value).size !== value.length) return null;
  return [...value];
}

const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const taskId = (value) => (typeof value === "string" && TASK_ID.test(value) ? value : null);

// Mirror phase 3a's field replacement and bounds; the monitor checks feature and task membership when applied.
const exact = (value, keys) => isPlainObject(value) && only(value, keys) && Object.keys(value).length === keys.length;
const arilLine = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max && ONE_LINE.test(value);
const ARIL_LIMITS = { hours: [1, 72], tasks: [1, 100], tasksAtATime: [1, 10], sendBacks: [0, 10], usagePercent: [1, 100] };
const ARIL_MODEL = /^(?![A-Za-z]:)[A-Za-z0-9][A-Za-z0-9._:@+\[\]-]{0,119}$/u;

function arilRule(rule) {
  if (!exact(rule, ["kind", "value"])) return false;
  const { kind, value } = rule;
  if (kind === "tag") return arilLine(value, 40) && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]*$/u.test(value) && value.toLowerCase() !== "image";
  if (kind === "text") return arilLine(value, 80);
  if (kind === "feature") return typeof value === "string";
  if (kind === "plan") return typeof value === "string" && value.length >= 1 && value.length <= 200
    && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md$/u.test(value)
    && !value.split("/").some((segment) => segment === "." || segment === "..");
  return kind === "tasks" && Array.isArray(value) && value.length >= 1 && value.length <= 50 && value.every((id) => taskId(id));
}

function arilSettings(input) {
  if (!isPlainObject(input) || !only(input, ["actions", "mergeMethod", "mergeMode", "deleteBranch", "limits", "workRules", "reviewer", "followUps"])) return null;
  const settings = { ...input };
  for (const [field, value] of Object.entries(input)) {
    if (field === "actions" && (!exact(value, ["start", "review", "sendBack", "merge", "writeTasks", "markDone"]) || !Object.values(value).every((v) => typeof v === "boolean"))) return null;
    if (field === "mergeMethod" && value !== null && !["squash", "merge", "rebase"].includes(value)) return null;
    if (field === "mergeMode" && ![null, "direct", "auto"].includes(value)) return null;
    if (field === "deleteBranch" && ![null, true, false].includes(value)) return null;
    if (field === "followUps" && typeof value !== "boolean") return null;
    if (field === "limits" && (!exact(value, Object.keys(ARIL_LIMITS)) || !Object.entries(value).every(([key, v]) => v === null
      || (Number.isInteger(v) && v >= ARIL_LIMITS[key][0] && v <= ARIL_LIMITS[key][1])))) return null;
    if (field === "workRules" && (!Array.isArray(value) || value.length > 20 || !value.every(arilRule))) return null;
    if (field === "reviewer") {
      if (!exact(value, ["provider", "model", "differentFromBuilder"]) || ![null, "claude", "codex"].includes(value.provider) || typeof value.differentFromBuilder !== "boolean") return null;
      const model = value.model === null || value.model === "" ? null : typeof value.model === "string" ? value.model.trim() : undefined;
      if (model !== null && (typeof model !== "string" || !ARIL_MODEL.test(model))) return null;
      settings.reviewer = { ...value, model };
    }
  }
  return settings;
}

function boundedLine(value, limit) {
  if (typeof value !== "string") return null;
  const line = value.trim();
  return line.length > 0 && line.length <= limit && ONE_LINE.test(line) ? line : null;
}

function taskText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= TEXT_LIMIT && TEXT_LINES.test(text) ? text : null;
}

// The run a proposal names: only the parts it sets. A model belongs to its provider.
function runPart(source) {
  const run = {};
  if (Object.hasOwn(source, "provider")) {
    if (!(source.provider === null || PROVIDERS.has(source.provider))) return null;
    run.provider = source.provider;
  }
  if (Object.hasOwn(source, "model")) {
    if (!(source.model === null || (typeof source.model === "string" && MODEL.test(source.model)))) return null;
    run.model = source.model;
  }
  if (Object.hasOwn(source, "effort")) {
    if (!(source.effort === null || EFFORTS.has(source.effort))) return null;
    run.effort = source.effort;
  }
  if (run.provider === null && typeof run.model === "string") return null;
  return run;
}

function completeWhenPart(source) {
  const completeWhen = {};
  if (Object.hasOwn(source, "complete_when")) {
    const checks = source.complete_when;
    if (!Array.isArray(checks) || checks.length > CHECKS.length || new Set(checks).size !== checks.length || !checks.every((check) => CHECKS.includes(check))) return null;
    completeWhen.checks = CHECKS.filter((check) => checks.includes(check));
  }
  if (Object.hasOwn(source, "own_condition")) {
    const own = source.own_condition;
    if (own === null || own === "") completeWhen.own = null;
    else {
      const line = typeof own === "string" ? own.trim() : "";
      if (!line || line.length > OWN_LIMIT || !TEXT_LINES.test(line)) return null;
      completeWhen.own = line;
    }
  }
  return completeWhen;
}

const TASK_FIELDS = ["provider", "model", "effort", "complete_when", "own_condition"];

// The run and complete-when parts of one task operation, or null when a part is malformed.
function taskParts(source) {
  const run = runPart(source);
  const completeWhen = completeWhenPart(source);
  if (run === null || completeWhen === null) return null;
  return { ...(Object.keys(run).length > 0 ? { run } : {}), ...(Object.keys(completeWhen).length > 0 ? { completeWhen } : {}) };
}

// The distinct task IDs of a group operation, in the order written, or null when the list is outside `min` to `GROUP_LIMIT`.
// A task runs after at most this many tasks, the monitor's bound.
const AFTER_LIMIT = 8;

function taskIds(value, min) {
  if (!Array.isArray(value) || value.length < min || value.length > GROUP_LIMIT) return null;
  const ids = value.map(taskId);
  return ids.every(Boolean) && new Set(ids).size === ids.length ? ids : null;
}

const boardColumn = (value) => (typeof value === "string" ? BOARD_COLUMNS.find((name) => name.toLowerCase() === value.trim().toLowerCase()) ?? null : null);

// A card's place in its column, counted from 0: undefined when it is not set, null when it is malformed.
function cardPosition(value) {
  if (value === undefined || value === null) return undefined;
  return Number.isInteger(value) && value >= 0 && value <= POSITION_LIMIT ? value : null;
}

// Where a new task lands: a column with an optional position, or right after a task of the snapshot. Without either it
// lands at the end of Backlog. The two forms never mix, and a position needs its column. Null when it is malformed.
function placement(source) {
  const column = source.column === undefined || source.column === null ? undefined : boardColumn(source.column);
  const position = cardPosition(source.position);
  const after = source.place_after === undefined || source.place_after === null ? undefined : taskId(source.place_after);
  if (column === null || position === null || after === null) return null;
  if (after !== undefined) return column === undefined && position === undefined ? { placeAfter: after } : null;
  if (column === undefined) return position === undefined ? {} : null;
  return position === undefined ? { column } : { column, position };
}

/** One operation as the agent wrote it, normalized to the stored shape; null when it is outside the contract. */
export function normalizeOperation(source, { grantWrite = false, stored = false } = {}) {
  if (!isPlainObject(source) || typeof source.op !== "string" || !BOARD_OPERATIONS.includes(source.op)) return null;
  const { op } = source;
  if (grantWrite && (op !== "create_task" || !only(source, ["op", "text", "complete_when", "own_condition", "runs_after"]))) return null;
  if (op === "declare_rework") {
    const ref = (value) => typeof value === "string" && /^(?:T-|#)[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value.replace(/^(?:T-|#)/u, "")));
    return exact(source, ["op", "fix", "reworks", "cause"]) && ref(source.fix) && ref(source.reworks) && source.fix !== source.reworks
      && ["missed_wiring", "spec_gap", "wrong_behavior", "stale_instructions", "latent", "other"].includes(source.cause) ? { ...source } : null;
  }
  if (op === "set_aril_settings") {
    const settings = arilSettings(source.settings);
    return only(source, ["op", "settings"]) && settings ? { op, settings } : null;
  }
  if (LEGACY_MEMORY_OPERATIONS.includes(op)) {
    if (!stored) return null;
    const hasId = op !== "add_memory";
    const hasText = op !== "remove_memory";
    if (!only(source, ["op", ...(hasId ? ["id"] : []), ...(hasText ? ["text"] : [])])
      || (hasId && (!Number.isSafeInteger(source.id) || source.id < 1)) || (hasText && !arilLine(source.text, 300))) return null;
    return { op, ...(hasId ? { id: source.id } : {}), ...(hasText ? { text: source.text } : {}) };
  }
  if (op === "create_feature") {
    const name = boundedLine(source.name, FEATURE_LIMIT);
    return only(source, ["op", "name"]) && name ? { op, name } : null;
  }
  if (op === "update_feature") {
    // A new title, done or reopened, or both; at least one of them.
    const feature = boundedLine(source.feature, FEATURE_LIMIT);
    if (!only(source, ["op", "feature", "name", "done"]) || !feature) return null;
    const operation = { op, feature };
    if (source.name !== undefined) {
      const name = boundedLine(source.name, FEATURE_LIMIT);
      if (!name) return null;
      operation.name = name;
    }
    if (source.done !== undefined) {
      if (typeof source.done !== "boolean") return null;
      operation.done = source.done;
    }
    return Object.keys(operation).length > 2 ? operation : null;
  }
  if (op === "delete_feature") {
    const feature = boundedLine(source.feature, FEATURE_LIMIT);
    return only(source, ["op", "feature"]) && feature ? { op, feature } : null;
  }
  if (op === "create_task") {
    if (!only(source, ["op", "text", "feature", "queue", "images", "column", "position", "place_after", ...TASK_FIELDS, ...(grantWrite ? ["runs_after"] : [])])) return null;
    const text = taskText(source.text);
    const parts = taskParts(source);
    const place = placement(source);
    if (!text || !parts || !place) return null;
    const operation = { op, text, ...parts, ...place };
    if (Object.hasOwn(source, "runs_after")) {
      const after = source.runs_after;
      if (!Array.isArray(after) || after.length > AFTER_LIMIT || new Set(after).size !== after.length
        || !after.every((id) => taskId(id) || (typeof id === "string" && /^#[1-5]$/u.test(id)))) return null;
      operation.after = [...after];
    }
    if (source.feature !== undefined && source.feature !== null) {
      const feature = boundedLine(source.feature, FEATURE_LIMIT);
      if (!feature) return null;
      operation.feature = feature;
    }
    if (source.queue !== undefined && typeof source.queue !== "boolean") return null;
    if (source.queue === true) operation.queue = true;
    if (source.images !== undefined && source.images !== null) {
      const images = chatImageIds(source.images);
      if (!images) return null;
      operation.images = images;
    }
    return operation;
  }
  if (op === QUEUE_OPERATION) return only(source, ["op", "on"]) && typeof source.on === "boolean" ? { op, on: source.on } : null;
  if (op === "group_tasks" || op === "ungroup_tasks") {
    const ids = taskIds(source.ids, op === "group_tasks" ? 2 : 1);
    return only(source, ["op", "ids"]) && ids ? { op, ids } : null;
  }
  const id = taskId(source.id);
  if (!id) return null;
  if (op === "remove_worktree") return only(source, ["op", "id", "branch"]) && typeof source.branch === "boolean" ? { op, id, branch: source.branch } : null;
  if (op === "set_after") {
    // An empty list clears what the task runs after.
    const after = Array.isArray(source.after) && source.after.length === 0 ? [] : taskIds(source.after, 1);
    return only(source, ["op", "id", "after"]) && after && after.length <= AFTER_LIMIT && !after.includes(id) ? { op, id, after } : null;
  }
  if (op === "update_task") {
    if (!only(source, ["op", "id", "text", "feature", ...TASK_FIELDS])) return null;
    const parts = taskParts(source);
    if (!parts) return null;
    const operation = { op, id, ...parts };
    if (source.text !== undefined) {
      const text = taskText(source.text);
      if (!text) return null;
      operation.text = text;
    }
    if (source.feature !== undefined) {
      const feature = source.feature === null ? null : boundedLine(source.feature, FEATURE_LIMIT);
      if (source.feature !== null && !feature) return null;
      operation.feature = feature;
    }
    return Object.keys(operation).length > 2 ? operation : null;
  }
  if (op === "move_task") {
    if (!only(source, ["op", "id", "column", "position"])) return null;
    const column = boardColumn(source.column);
    const position = cardPosition(source.position);
    if (!column || position === null) return null;
    return position === undefined ? { op, id, column } : { op, id, column, position };
  }
  if (op === IMAGE_OPERATION) {
    const images = chatImageIds(source.images);
    return only(source, ["op", "id", "images"]) && images ? { op, id, images } : null;
  }
  // delete_task, queue_task, unqueue_task, start_session
  return only(source, ["op", "id"]) ? { op, id } : null;
}

/** A proposal body `{ summary, operations }`, normalized; null when any part is outside the contract. */
export function normalizeProposal(source, options = {}) {
  if (!isPlainObject(source) || !only(source, ["summary", "operations"]) || !Array.isArray(source.operations)) return null;
  if (source.operations.length === 0 || source.operations.length > PROPOSAL_OPERATION_LIMIT) return null;
  if (options.grantWrite && source.operations.length > 5) return null;
  const summary = boundedLine(source.summary, PROPOSAL_SUMMARY_LIMIT);
  if (!summary) return null;
  const operations = [];
  for (const entry of source.operations) {
    const operation = normalizeOperation(entry, options);
    if (!operation) return null;
    operations.push(operation);
  }
  // A start is answered on its own, so the owner approves one session for one named task and nothing else. A queue
  // change is too: turning the queue on lets Pomegr start tasks by itself, so it is never approved beside a board change.
  const pending = operations.filter(({ op }) => op !== "declare_rework");
  if (operations.length - pending.length > 5) return null;
  if (pending.length > 1 && pending.some((operation) => [START_OPERATION, QUEUE_OPERATION, "set_aril_settings"].includes(operation.op))) return null;
  if (pending.some(({ op }) => op === "remove_worktree") && (pending.length > 30 || !pending.every(({ op }) => op === "remove_worktree"))) return null;
  return { summary, operations };
}

/** Every image a proposal names, each once. They are images the owner sent in the conversation, or the proposal is not offered. */
export function proposalImages(proposal) {
  const ids = new Set();
  for (const operation of Array.isArray(proposal?.operations) ? proposal.operations : []) {
    for (const id of Array.isArray(operation?.images) ? operation.images : []) ids.add(id);
  }
  return [...ids];
}

/** The queue state a proposal asks for (`true` is on), or null when it is not a queue proposal. */
export function queueProposalState(proposal) {
  const operations = Array.isArray(proposal?.operations) ? proposal.operations : [];
  return operations.length === 1 && operations[0]?.op === QUEUE_OPERATION && typeof operations[0].on === "boolean" ? operations[0].on : null;
}

/** The task a proposal asks to start a session for, or null when it is a proposal of board changes. */
export function startProposalTask(proposal) {
  const operations = Array.isArray(proposal?.operations) ? proposal.operations : [];
  return operations.length === 1 && operations[0]?.op === START_OPERATION ? taskId(operations[0].id) : null;
}

/**
 * Splits an agent answer into the text to show and the proposal it carries.
 * `unreadable` is true when the answer holds a proposal block that is malformed, repeated, or outside the contract.
 */
export function extractProposal(answer, options = {}) {
  if (typeof answer !== "string") return { text: "", proposal: null, unreadable: false };
  const bodies = [];
  let text = answer.replace(FENCE, (_match, lead, body) => { bodies.push(body); return lead; });
  // A block the agent never closed is not shown as text either.
  const open = OPEN_FENCE.test(text);
  if (open) text = text.replace(OPEN_FENCE, "");
  text = text.replace(/\n{3,}/gu, "\n\n").trim();
  if (bodies.length === 0) return { text, proposal: null, unreadable: open };
  if (bodies.length > 1 || open || Buffer.byteLength(bodies[0], "utf8") > BLOCK_LIMIT_BYTES) return { text, proposal: null, unreadable: true };
  let parsed;
  try { parsed = JSON.parse(bodies[0]); } catch { return { text, proposal: null, unreadable: true }; }
  const proposal = normalizeProposal(parsed, options);
  return proposal ? { text, proposal, unreadable: false } : { text, proposal: null, unreadable: true };
}

/** The text of an answer still being written, without a proposal block that has begun. */
export function visibleAnswer(partial) {
  if (typeof partial !== "string") return "";
  return partial.replace(FENCE, (_match, lead) => lead).replace(OPEN_FENCE, "").replace(/\n{3,}/gu, "\n\n").trimEnd();
}

// Record only the validated declarations at answer time; the remaining operations still wait for Apply.
export async function recordRework(read, post, answerLimit) {
  const declarations = read.proposal?.operations.filter(({ op }) => op === "declare_rework") ?? [];
  if (!declarations.length) return read;
  const lines = [];
  for (const { fix, reworks, cause } of declarations) {
    let result;
    try { result = await post({ fix, reworks, cause }); } catch { /* Fixed refusal, without a retry or monitor text. */ }
    const link = `${fix} reworks ${reworks}`, label = `${link} · ${cause.replaceAll("_", " ")}`;
    const error = ["invalid", "not_found", "limit"].includes(result?.error) ? result.error : "unavailable";
    lines.push(result?.ok === true && result.status === "recorded" ? `Recorded: ${label}`
      : result?.ok === true && result.status === "exists" ? `Already recorded: ${link}` : `Not recorded: ${label} · ${error}`);
  }
  const recorded = lines.join("\n"), operations = read.proposal.operations.filter(({ op }) => op !== "declare_rework");
  return { ...read, text: [read.text.slice(0, answerLimit - recorded.length - 2).trimEnd(), recorded].filter(Boolean).join("\n\n"),
    proposal: operations.length ? { ...read.proposal, operations } : null };
}

// The parts of a monitor board the applier needs; anything malformed reads as absent.
function boardFacts(board) {
  const facts = { features: [], columns: [], tasks: new Map() };
  if (!isPlainObject(board)) return facts;
  for (const feature of Array.isArray(board.features) ? board.features : []) {
    if (isPlainObject(feature) && typeof feature.id === "string" && typeof feature.name === "string") facts.features.push({ id: feature.id, name: feature.name, done: feature.done === true });
  }
  for (const column of Array.isArray(board.columns) ? board.columns : []) {
    if (isPlainObject(column) && typeof column.id === "string" && typeof column.name === "string") facts.columns.push({ id: column.id, name: column.name });
  }
  for (const task of Array.isArray(board.tasks) ? board.tasks : []) {
    if (isPlainObject(task) && typeof task.id === "string" && TASK_ID.test(task.id)) facts.tasks.set(task.id, task);
  }
  return facts;
}

const failure = (error) => ({ ok: false, error });
const actionError = (answer) => failure(typeof answer?.error === "string" && ACTION_ERRORS.has(answer.error) ? answer.error : "unavailable");

function fullRun(current, part) {
  const stored = isPlainObject(current) ? current : {};
  const run = {
    provider: Object.hasOwn(part, "provider") ? part.provider : stored.provider ?? null,
    model: Object.hasOwn(part, "model") ? part.model : stored.model ?? null,
    effort: Object.hasOwn(part, "effort") ? part.effort : stored.effort ?? null,
  };
  // A model belongs to its provider: another provider without a model of its own starts on that provider's default.
  if (Object.hasOwn(part, "provider") && !Object.hasOwn(part, "model") && part.provider !== stored.provider) run.model = null;
  if (stored.remoteControl === true && run.provider !== "codex") run.remoteControl = true;
  if (stored.keepWorktree === true) run.keepWorktree = true;
  return run;
}

function fullCompleteWhen(current, part) {
  const stored = isPlainObject(current) ? current : {};
  return {
    checks: Object.hasOwn(part, "checks") ? part.checks : Array.isArray(stored.checks) ? stored.checks.filter((check) => CHECKS.includes(check)) : [],
    own: Object.hasOwn(part, "own") ? part.own : typeof stored.own === "string" ? stored.own : null,
  };
}

/**
 * Runs an approved proposal, one fixed task action per operation, in order. It stops at the first operation that
 * fails; the ones after it answer `skipped`. `post(action, payload)` is the desktop's own task-action request and
 * answers `{ ok: true, board?, taskId? }` or `{ ok: false, error }`. `attach(taskId, imageId)` is the desktop's own
 * image request: it stores one image the owner sent in the conversation on that task, and answers the same way.
 */
export async function applyOperations(operations, { post, board, attach }) {
  let facts = boardFacts(board);
  const results = [];
  const act = async (action, payload) => {
    let answer;
    try { answer = await post(action, payload); } catch { answer = null; }
    if (!isPlainObject(answer) || answer.ok !== true) return { answer: actionError(answer) };
    if (isPlainObject(answer.board)) facts = boardFacts(answer.board);
    return { answer: { ok: true }, taskId: taskId(answer.taskId) };
  };
  // The move that places a new task: the column it names, or the column of the task it follows, one place below that
  // task. The position is counted without the new card, as the move counts it.
  const placeTarget = (operation, createdId) => {
    if (operation.column !== undefined) {
      const column = facts.columns.find((candidate) => candidate.name === operation.column);
      return column ? { columnId: column.id, position: operation.position ?? POSITION_LIMIT } : null;
    }
    const anchor = facts.tasks.get(operation.placeAfter);
    if (!anchor || anchor.id === createdId || !facts.columns.some((column) => column.id === anchor.columnId)) return null;
    const order = [...facts.tasks.values()]
      .filter((task) => task.columnId === anchor.columnId && task.id !== createdId)
      .sort((left, right) => (Number(left.position) || 0) - (Number(right.position) || 0));
    return { columnId: anchor.columnId, position: order.findIndex((task) => task.id === anchor.id) + 1 };
  };
  const openFeature = (name) => facts.features.find((feature) => feature.name === name && !feature.done) ?? null;
  // A feature edit names a feature of that title whether it is done or not, so a done feature can be reopened.
  const namedFeature = (name) => facts.features.find((feature) => feature.name === name) ?? null;
  // Each image in order, stopping at the first one the task did not take. An image the task already holds is the outcome asked for.
  const attachAll = async (id, images, held = []) => {
    for (const imageId of images) {
      if (held.includes(imageId)) continue;
      let answer;
      try { answer = typeof attach === "function" ? await attach(id, imageId) : null; } catch { answer = null; }
      if (!isPlainObject(answer) || answer.ok !== true) return actionError(answer);
    }
    return { ok: true };
  };

  for (const operation of operations) {
    if (results.some((result) => result.ok !== true)) { results.push(failure("skipped")); continue; }
    const { op } = operation;
    // A start is never a task action, and a queue change has its own one request. The chat never sends either here.
    if (op === START_OPERATION || op === QUEUE_OPERATION || op === "remove_worktree" || op === "declare_rework") { results.push(failure("unsupported")); continue; }
    // A memory proposal saved before Aril kept its memory by itself: it changes nothing now.
    if (LEGACY_MEMORY_OPERATIONS.includes(op)) { results.push(failure("unsupported")); continue; }
    if (op === "set_aril_settings") {
      results.push((await act("aril_settings_set", { settings: operation.settings })).answer);
      continue;
    }
    if (op === "create_feature") {
      // A feature that is already there is the outcome the operation asked for.
      results.push(openFeature(operation.name) ? { ok: true } : (await act("feature_create", { name: operation.name })).answer);
      continue;
    }
    if (op === "update_feature") {
      // The desktop's own feature edit: a title another feature has answers `conflict`, and marking done or reopening
      // moves, unqueues, and deletes no task.
      const feature = namedFeature(operation.feature);
      if (!feature) { results.push(failure("not_found")); continue; }
      const payload = { id: feature.id };
      if (operation.name !== undefined) payload.name = operation.name;
      if (operation.done !== undefined) payload.done = operation.done;
      results.push((await act("feature_update", payload)).answer);
      continue;
    }
    if (op === "delete_feature") {
      // Only a feature with no task, a done task included: the desktop's delete would otherwise take the feature off its tasks.
      const feature = namedFeature(operation.feature);
      if (!feature) { results.push(failure("not_found")); continue; }
      if ([...facts.tasks.values()].some((task) => task.featureId === feature.id)) { results.push(failure("conflict")); continue; }
      results.push((await act("feature_delete", { id: feature.id })).answer);
      continue;
    }
    if (op === "create_task") {
      const payload = { text: operation.text };
      if (operation.run) payload.run = fullRun(null, operation.run);
      if (operation.completeWhen) payload.completeWhen = fullCompleteWhen(null, operation.completeWhen);
      if (operation.feature !== undefined) {
        const feature = openFeature(operation.feature);
        if (!feature) { results.push(failure("not_found")); continue; }
        payload.featureId = feature.id;
      }
      const created = await act("create", payload);
      if (created.answer.ok !== true || !created.taskId) { results.push(created.answer.ok === true ? failure("unavailable") : created.answer); continue; }
      if (operation.images) {
        const attached = await attachAll(created.taskId, operation.images);
        if (attached.ok !== true) { results.push({ ...attached, taskId: created.taskId, part: "images" }); continue; }
      }
      // The placement is the ordinary move, on the board the create answered. It never queues: a card placed in Ready
      // waits there unqueued, unless the operation also asks for the queue, which comes after the move.
      if (operation.column !== undefined || operation.placeAfter !== undefined) {
        const target = placeTarget(operation, created.taskId);
        const placed = target ? await act("move", { id: created.taskId, ...target }) : { answer: failure("not_found") };
        if (placed.answer.ok !== true) { results.push({ ...placed.answer, taskId: created.taskId, part: "placement" }); continue; }
      }
      if (operation.queue === true) {
        const queued = await act("queue_add", { id: created.taskId });
        if (queued.answer.ok !== true) { results.push({ ...queued.answer, taskId: created.taskId }); continue; }
      }
      results.push({ ok: true, taskId: created.taskId });
      continue;
    }
    if (op === "group_tasks" || op === "ungroup_tasks") {
      if (!operation.ids.every((id) => facts.tasks.has(id))) { results.push(failure("not_found")); continue; }
      results.push((await act(op === "group_tasks" ? "queue_group" : "queue_ungroup", { ids: operation.ids })).answer);
      continue;
    }
    if (op === "set_after") {
      if (![operation.id, ...operation.after].every((id) => facts.tasks.has(id))) { results.push(failure("not_found")); continue; }
      results.push((await act("after_set", { id: operation.id, after: operation.after })).answer);
      continue;
    }
    const task = facts.tasks.get(operation.id);
    if (!task) { results.push(failure("not_found")); continue; }
    if (op === "update_task") {
      const payload = { id: operation.id };
      if (operation.text !== undefined) payload.text = operation.text;
      if (operation.run) payload.run = fullRun(task.run, operation.run);
      if (operation.completeWhen) payload.completeWhen = fullCompleteWhen(task.completeWhen, operation.completeWhen);
      if (operation.feature === null) { if (task.featureId !== null && task.featureId !== undefined) payload.featureId = null; }
      else if (operation.feature !== undefined) {
        const feature = openFeature(operation.feature) ?? facts.features.find((candidate) => candidate.name === operation.feature && candidate.id === task.featureId);
        if (!feature) { results.push(failure("not_found")); continue; }
        if (feature.id !== task.featureId) payload.featureId = feature.id;
      }
      // Every field already holds what the operation asks for.
      results.push(Object.keys(payload).length === 1 ? { ok: true } : (await act("update", payload)).answer);
      continue;
    }
    if (op === IMAGE_OPERATION) {
      const held = (Array.isArray(task.images) ? task.images : []).map((image) => image?.id).filter((id) => typeof id === "string");
      const attached = await attachAll(operation.id, operation.images, held);
      results.push(attached.ok === true ? attached : { ...attached, part: "images" });
      continue;
    }
    if (op === "move_task") {
      const column = facts.columns.find((candidate) => candidate.name === operation.column);
      if (!column) { results.push(failure("not_found")); continue; }
      results.push((await act("move", { id: operation.id, columnId: column.id, position: operation.position ?? POSITION_LIMIT })).answer);
      continue;
    }
    const action = op === "delete_task" ? "delete" : op === "queue_task" ? "queue_add" : "queue_remove";
    results.push((await act(action, { id: operation.id })).answer);
  }
  return results;
}
