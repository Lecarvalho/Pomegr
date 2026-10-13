// The board changes the chat agent proposes: read from its answer, validated here, and applied only after the owner approves.

export const PROPOSAL_FENCE = "pomegr-board";
export const PROPOSAL_OPERATION_LIMIT = 40;
export const PROPOSAL_SUMMARY_LIMIT = 300;
export const BOARD_OPERATIONS = Object.freeze([
  "create_feature", "create_task", "update_task", "delete_task", "move_task", "queue_task", "unqueue_task", "set_step", "start_session", "set_queue",
]);
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
  "invalid", "unavailable", "failed", "worktree_dirty", "tree_dirty",
]);
export const BOARD_COLUMNS = Object.freeze(["Backlog", "Ready", "In progress", "Review", "Done"]);

const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,119}$/u;
const ONE_LINE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
const TEXT_LINES = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]*$/u;
const PROVIDERS = new Set(["claude", "codex"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const CHECKS = Object.freeze(["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed", "user_validated"]);
const TEXT_LIMIT = 4000;
const OWN_LIMIT = 500;
const FEATURE_LIMIT = 80;
const STEP_LIMIT = 500;
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

const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const taskId = (value) => (typeof value === "string" && TASK_ID.test(value) ? value : null);

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

function step(value) {
  return Number.isInteger(value) && value >= 1 && value <= STEP_LIMIT ? value : null;
}

/** One operation as the agent wrote it, normalized to the stored shape; null when it is outside the contract. */
export function normalizeOperation(source) {
  if (!isPlainObject(source) || typeof source.op !== "string" || !BOARD_OPERATIONS.includes(source.op)) return null;
  const { op } = source;
  if (op === "create_feature") {
    const name = boundedLine(source.name, FEATURE_LIMIT);
    return only(source, ["op", "name"]) && name ? { op, name } : null;
  }
  if (op === "create_task") {
    if (!only(source, ["op", "text", "feature", "step", "queue", ...TASK_FIELDS])) return null;
    const text = taskText(source.text);
    const parts = taskParts(source);
    if (!text || !parts) return null;
    const operation = { op, text, ...parts };
    if (source.feature !== undefined && source.feature !== null) {
      const feature = boundedLine(source.feature, FEATURE_LIMIT);
      if (!feature) return null;
      operation.feature = feature;
    }
    if (source.step !== undefined && source.step !== null) {
      const at = step(source.step);
      if (at === null || operation.feature === undefined) return null;
      operation.step = at;
    }
    if (source.queue !== undefined && typeof source.queue !== "boolean") return null;
    if (source.queue === true) operation.queue = true;
    return operation;
  }
  if (op === QUEUE_OPERATION) return only(source, ["op", "on"]) && typeof source.on === "boolean" ? { op, on: source.on } : null;
  const id = taskId(source.id);
  if (!id) return null;
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
    if (!only(source, ["op", "id", "column", "position"]) || typeof source.column !== "string") return null;
    const column = BOARD_COLUMNS.find((name) => name.toLowerCase() === source.column.trim().toLowerCase());
    if (!column) return null;
    if (source.position === undefined || source.position === null) return { op, id, column };
    return Number.isInteger(source.position) && source.position >= 0 && source.position <= POSITION_LIMIT ? { op, id, column, position: source.position } : null;
  }
  if (op === "set_step") {
    const at = step(source.step);
    return only(source, ["op", "id", "step"]) && at !== null ? { op, id, step: at } : null;
  }
  // delete_task, queue_task, unqueue_task, start_session
  return only(source, ["op", "id"]) ? { op, id } : null;
}

/** A proposal body `{ summary, operations }`, normalized; null when any part is outside the contract. */
export function normalizeProposal(source) {
  if (!isPlainObject(source) || !only(source, ["summary", "operations"]) || !Array.isArray(source.operations)) return null;
  if (source.operations.length === 0 || source.operations.length > PROPOSAL_OPERATION_LIMIT) return null;
  const summary = boundedLine(source.summary, PROPOSAL_SUMMARY_LIMIT);
  if (!summary) return null;
  const operations = [];
  for (const entry of source.operations) {
    const operation = normalizeOperation(entry);
    if (!operation) return null;
    operations.push(operation);
  }
  // A start is answered on its own, so the owner approves one session for one named task and nothing else. A queue
  // change is too: turning the queue on lets Pomegr start tasks by itself, so it is never approved beside a board change.
  if (operations.length > 1 && operations.some((operation) => operation.op === START_OPERATION || operation.op === QUEUE_OPERATION)) return null;
  return { summary, operations };
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
export function extractProposal(answer) {
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
  const proposal = normalizeProposal(parsed);
  return proposal ? { text, proposal, unreadable: false } : { text, proposal: null, unreadable: true };
}

/** The text of an answer still being written, without a proposal block that has begun. */
export function visibleAnswer(partial) {
  if (typeof partial !== "string") return "";
  return partial.replace(FENCE, (_match, lead) => lead).replace(OPEN_FENCE, "").replace(/\n{3,}/gu, "\n\n").trimEnd();
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
 * answers `{ ok: true, board?, taskId? }` or `{ ok: false, error }`.
 */
export async function applyOperations(operations, { post, board }) {
  let facts = boardFacts(board);
  const results = [];
  const act = async (action, payload) => {
    let answer;
    try { answer = await post(action, payload); } catch { answer = null; }
    if (!isPlainObject(answer) || answer.ok !== true) return { answer: actionError(answer) };
    if (isPlainObject(answer.board)) facts = boardFacts(answer.board);
    return { answer: { ok: true }, taskId: taskId(answer.taskId) };
  };
  const openFeature = (name) => facts.features.find((feature) => feature.name === name && !feature.done) ?? null;

  for (const operation of operations) {
    if (results.some((result) => result.ok !== true)) { results.push(failure("skipped")); continue; }
    const { op } = operation;
    // A start is never a task action, and a queue change has its own one request. The chat never sends either here.
    if (op === START_OPERATION || op === QUEUE_OPERATION) { results.push(failure("unsupported")); continue; }
    if (op === "create_feature") {
      // A feature that is already there is the outcome the operation asked for.
      results.push(openFeature(operation.name) ? { ok: true } : (await act("feature_create", { name: operation.name })).answer);
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
        if (operation.step !== undefined) payload.step = operation.step;
      }
      const created = await act("create", payload);
      if (created.answer.ok !== true || !created.taskId) { results.push(created.answer.ok === true ? failure("unavailable") : created.answer); continue; }
      if (operation.queue === true) {
        const queued = await act("queue_add", { id: created.taskId });
        if (queued.answer.ok !== true) { results.push({ ...queued.answer, taskId: created.taskId }); continue; }
      }
      results.push({ ok: true, taskId: created.taskId });
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
    if (op === "move_task") {
      const column = facts.columns.find((candidate) => candidate.name === operation.column);
      if (!column) { results.push(failure("not_found")); continue; }
      results.push((await act("move", { id: operation.id, columnId: column.id, position: operation.position ?? POSITION_LIMIT })).answer);
      continue;
    }
    if (op === "set_step") { results.push((await act("queue_reorder", { id: operation.id, step: operation.step })).answer); continue; }
    const action = op === "delete_task" ? "delete" : op === "queue_task" ? "queue_add" : "queue_remove";
    results.push((await act(action, { id: operation.id })).answer);
  }
  return results;
}
