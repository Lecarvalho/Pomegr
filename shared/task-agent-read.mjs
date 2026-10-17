// The single bounded served-task projection used by coding sessions and agent chat.
const AGENT_TASK_ID_PATTERN = /^T-[1-9][0-9]{0,8}$/u;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export const AGENT_TASK_READ_BOUNDS = Object.freeze({ listTasks: 100, listTextLength: 300, queryLength: 80 });
// The record's bounds and fixed values (server/tasks/task-record.mjs), held again here: serving does not import tasks/.
const TEXT_LIMIT = 4000;
const OWN_CONDITION_LIMIT = 500;
const MODEL_LIMIT = 120;
const FEATURE_TITLE_LIMIT = 80;
const COLUMN_NAME_LIMIT = 40;
const RUNS_AFTER_LIMIT = 8;
const CHECKS = Object.freeze(["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed", "user_validated"]);
const STATES = Object.freeze(["not_queued", "queued", "scheduled", "needs_review", "stalled", "blocked", "done"]);
const PROVIDERS = Object.freeze(["claude", "codex"]);
const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"]);

const boundedText = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit;
const nullableEnum = (value, allowed) => value === null || allowed.includes(value);

// The served task: these thirteen fields, each inside its bound, or null. With `cut` a text over the list's length is
// cut and says so. Never a report, an attention line, a block reason, a session, an image, who added the task, a path,
// a token, or a repository, column, or feature ID.
export function servedAgentTask(entry, { cut = false } = {}) {
  if (!isPlainObject(entry) || typeof entry.id !== "string" || !AGENT_TASK_ID_PATTERN.test(entry.id) || !boundedText(entry.text, TEXT_LIMIT)
    || !(entry.ownCondition === null || boundedText(entry.ownCondition, OWN_CONDITION_LIMIT))
    || !Array.isArray(entry.completeWhen) || !entry.completeWhen.every((check) => CHECKS.includes(check))
    || !nullableEnum(entry.provider, PROVIDERS) || !nullableEnum(entry.effort, EFFORTS)
    || !(entry.model === null || boundedText(entry.model, MODEL_LIMIT))
    || !(entry.feature === null || boundedText(entry.feature, FEATURE_TITLE_LIMIT))
    || !boundedText(entry.column, COLUMN_NAME_LIMIT) || !STATES.includes(entry.state) || typeof entry.editable !== "boolean"
    || !Array.isArray(entry.runsAfter) || entry.runsAfter.length > RUNS_AFTER_LIMIT
    || !entry.runsAfter.every((id) => typeof id === "string" && AGENT_TASK_ID_PATTERN.test(id))) return null;
  const limit = AGENT_TASK_READ_BOUNDS.listTextLength;
  const textCut = cut && entry.text.length > limit;
  return {
    id: entry.id,
    text: textCut ? `${entry.text.slice(0, limit - 1)}…` : entry.text,
    textCut,
    ownCondition: entry.ownCondition,
    completeWhen: CHECKS.filter((check) => entry.completeWhen.includes(check)),
    provider: entry.provider, model: entry.model, effort: entry.effort,
    feature: entry.feature, column: entry.column, state: entry.state, editable: entry.editable,
    runsAfter: [...entry.runsAfter],
  };
}


// Chat may add just these two already snapshot-visible report fields.
export function servedChatTask(entry) {
  const task = servedAgentTask(entry);
  const report = entry?.report;
  const line = (value) => value === null || (typeof value === "string" && value.length <= 200 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value));
  if (!task || !isPlainObject(report) || !line(report.block_reason) || !line(report.attention)) return null;
  return { ...task, report: { block_reason: report.block_reason, attention: report.attention } };
}
