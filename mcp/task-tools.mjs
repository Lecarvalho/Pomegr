import { z } from "zod";
import { isReworkReference, REWORK_CAUSES, reportReworkResults } from "../shared/task-rework-report.mjs";
import { AGENT_TASK_NO_ANSWER, AGENT_TASK_REVIEW_PATH } from "../shared/agent-query-transport.mjs";

const optionalReworks = z.array(z.object({
  ref: z.string().refine(isReworkReference, "Use T-n or #n."),
  cause: z.enum(REWORK_CAUSES),
}).strict()).min(1).max(5).optional();

export const TASK_ADD_PATH = "/api/agent/v1/tasks/add";
export const TASK_COMPLETE_PATH = "/api/agent/v1/tasks/complete";
export const TASK_BLOCK_PATH = "/api/agent/v1/tasks/block";
export const TASK_REMOVE_PATH = "/api/agent/v1/tasks/remove";
export const TASK_ASSIGN_PATH = "/api/agent/v1/tasks/assign";
export const TASK_UNASSIGN_PATH = "/api/agent/v1/tasks/unassign";
export const TASK_UPDATE_PATH = "/api/agent/v1/tasks/update";
export const TASK_GET_PATH = "/api/agent/v1/tasks/get";
export const TASK_LIST_PATH = "/api/agent/v1/tasks/list";
export const FEATURE_GET_PATH = "/api/agent/v1/tasks/feature-get";
export const FEATURE_CREATE_PATH = "/api/agent/v1/tasks/feature-create";
export const FEATURE_UPDATE_PATH = "/api/agent/v1/tasks/feature-update";
export const FEATURE_DELETE_PATH = "/api/agent/v1/tasks/feature-delete";
export const TASK_TOOL_INSTRUCTIONS = "Use add_task to put follow-up work on the current repository's Pomegr task board when the user asks for it; it only adds a task in the first column, it does not queue or start anything, and the repository is always the current session's. Use update_task to change a task of that board that has not started, such as to add a finding to its text, when the user asks for it or the work calls for it; the text you set replaces the stored text whole, so read the task with get_task first and set the whole text it should have. Use get_task to read one task of that board by its ID, and list_tasks to find tasks of the board by a part of their text, their state, their feature, or whether update_task can change them; both only read. Use remove_task only to delete a task this session added itself with add_task, such as a duplicate, while it has not started; it cannot be undone, and it never removes a task the user or another session added. When Pomegr started this session for a task, call complete_task when the task is complete, which puts the task in Review for the user, adding its attention line only when something in the finished work needs the user's attention, or block_task with a short reason when you cannot proceed; the latest report wins until the owner marks the task done, and only a session Pomegr started for the task or assigned to it may report. Use reworks to name 1-5 earlier tasks (T-n) or pull requests (#n) this task fixes or redoes, with a cause, only when this session knows it. A review session reports its verdict with report_review, never complete_task or block_task. A completion after a block moves the task to Review but keeps the owner-controlled queue hold. Use assign_task when the user asks this session to work on an existing board task it was not started for, such as to resume a task whose first session stopped, then report with complete_task or block_task, naming task_id if the session has more than one task; use unassign_task when the session stops working on that task. A feature groups tasks of the board and holds their shared context: a title, a description, and an app version. Use get_feature when a task of a feature needs that context; with no input it reads the feature of the task this session was started for. Use create_feature, update_feature, and delete_feature only when the user asks to change the board's features; delete_feature removes only a feature that has no task.";
export const TASK_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so no task was added.";
export const TASK_UNAVAILABLE_TEXT = "Pomegr is unavailable, so no task was added.";
export const TASK_NO_ANSWER_TEXT = "Pomegr did not answer in time, so it is unknown whether the task was added. It may have been: do not assume it failed. Calling add_task again with exactly the same text and feature within a few minutes is safe and returns the same task instead of a second one; do not add it again with different wording.";
export const TASK_REPORT_NO_ANSWER_TEXT = "Pomegr did not answer in time, so it is unknown whether the report was recorded. It may have been: do not assume it failed. Retry the same report only if it still describes the work: the latest report wins until the owner marks the task done. A completion after a block does not clear the owner-controlled hold.";
export const TASK_REMOVE_NO_ANSWER_TEXT = "Pomegr did not answer in time, so it is unknown whether the task was removed. It may have been: do not assume it failed. Calling remove_task once more with the same task ID is safe; if the answer is that no task was removed, the first call removed it or it could not be removed.";

export const TASK_ASSIGN_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so no task was assigned.";
export const TASK_UNASSIGN_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so no task was unassigned.";
export const TASK_ASSIGN_NO_ANSWER_TEXT = "Pomegr did not answer in time, so it is unknown whether the task was assigned. It may have been: do not assume it failed. Calling assign_task once more with the same task ID is safe, because assigning a task again changes nothing.";
export const TASK_UNASSIGN_NO_ANSWER_TEXT = "Pomegr did not answer in time, so it is unknown whether the task was unassigned. It may have been: do not assume it failed. Calling unassign_task once more with the same task ID is safe; if the answer is that this session is not assigned, the first call removed the assignment or there was none.";

// A refusal for a repository Git did not confirm says so, so that it is never read as an empty board.
const repositoryUnavailableText = (outcome) => `Git has not confirmed the current session's repository, so ${outcome}. It does not mean the board is empty: Pomegr did not read it.`;

const noAnswer = (error) => error instanceof Error && error.message === AGENT_TASK_NO_ANSWER;

const CHECKS = ["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed", "user_validated"];
const REASON_TEXT = {
  invalid: "Pomegr rejected the task as invalid, so no task was added.",
  session_not_found: "Pomegr does not know the current session yet, so no task was added.",
  repository_unavailable: repositoryUnavailableText("no task was added"),
  feature_not_found: "That feature does not exist on the board, so no task was added.",
  limit: "The board is full, so no task was added.",
  after_not_found: "A task in runs_after is not on the board, so no task was added.",
  unavailable: TASK_UNAVAILABLE_TEXT,
};

const modelSchema = z.string().max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\[[A-Za-z0-9._-]{1,16}\])?$/u, "Use a model identifier without paths, spaces, or markup.")
  .describe("Optional model identifier for the session that will run the task.");

function hookFields(hookBound) {
  return hookBound ? {
    session_ref: z.string().max(200).describe("Set by the Pomegr hook. Never supply this field.").optional(),
    session_proof: z.string().max(100).describe("Set by the Pomegr hook. Never supply this field.").optional(),
  } : {};
}

function inputShape(hookBound) {
  const shape = {
    text: z.string().trim().min(1).max(4000).describe("What the task asks an agent to do."),
    provider: z.enum(["claude", "codex"]).optional().describe("Optional provider that should run the task."),
    model: modelSchema.optional(),
    effort: z.enum(["low", "medium", "high", "xhigh"]).optional().describe("Optional effort level."),
    remote_control: z.boolean().optional().describe("Optional. True starts the task's Claude Code session with Remote Control on, so the user can also reach it from their phone. Claude Code only; not valid with the codex provider."),
    complete_when: z.array(z.enum(CHECKS)).max(CHECKS.length)
      .refine((items) => new Set(items).size === items.length, "Checks must be unique.")
      .optional().describe("Optional conditions Pomegr verifies when the agent reports the task complete. user_validated is not verified: the agent validates the work with the user before it reports."),
    own_condition: z.string().trim().min(1).max(500).optional().describe("Optional free-text condition the agent judges itself."),
    feature: z.string().trim().min(1).max(80).optional().describe("Optional name of an existing feature on the board."),
    runs_after: runsAfterSchema.min(1).optional()
      .describe("Optional IDs of up to 8 tasks of the same board, such as T-12, that must be Done or deleted before this task may start."),
  };
  return { ...shape, ...hookFields(hookBound) };
}

// A task runs after at most this many tasks of its board, the monitor's bound.
const RUNS_AFTER_LIMIT = 8;
const runsAfterSchema = z.array(z.string().regex(/^T-[1-9][0-9]{0,8}$/u, "Use task IDs such as T-12.")).max(RUNS_AFTER_LIMIT)
  .refine((items) => new Set(items).size === items.length, "Task IDs must be unique.");

export function buildAddTaskBody(ref, input) {
  const body = { sessionRef: ref, text: input.text };
  if (input.provider !== undefined || input.model !== undefined || input.effort !== undefined || input.remote_control === true) {
    body.run = { provider: input.provider ?? null, model: input.model ?? null, effort: input.effort ?? null };
    // Sent only when asked for, so a monitor from before the option still takes every other task.
    if (input.remote_control === true) body.run.remoteControl = true;
  }
  if (input.complete_when !== undefined || input.own_condition !== undefined) {
    body.completeWhen = { checks: input.complete_when ?? [], own: input.own_condition ?? null };
  }
  if (input.feature !== undefined) body.feature = input.feature;
  // Sent only when set, so a monitor from before the option still takes every other task.
  if (input.runs_after !== undefined) body.after = input.runs_after;
  return body;
}

// A field that is left out is not sent, so the stored value stays; an empty own condition clears it.
export function buildUpdateTaskBody(ref, input) {
  const body = { sessionRef: ref, taskId: input.task_id };
  if (input.text !== undefined) body.text = input.text;
  const run = {};
  for (const key of ["provider", "model", "effort"]) if (input[key] !== undefined) run[key] = input[key];
  if (Object.keys(run).length > 0) body.run = run;
  const completeWhen = {};
  if (input.complete_when !== undefined) completeWhen.checks = input.complete_when;
  if (input.own_condition !== undefined) completeWhen.own = clearable(input.own_condition);
  if (Object.keys(completeWhen).length > 0) body.completeWhen = completeWhen;
  if (input.runs_after !== undefined) body.after = input.runs_after;
  return body;
}

const CHECK_LABELS = {
  pr_open: "Pull request open",
  tree_clean: "Working tree clean",
  commit_on_branch: "Commit on task branch",
  pr_merged: "Pull request merged",
  ci_passed: "CI passed",
  user_validated: "Validated with the user",
};
const REPORT_REASON_TEXT = {
  invalid: "Pomegr rejected the report as invalid, so nothing was reported.",
  not_found: "No Pomegr task is linked to this session, or the task named is not one of its tasks, so nothing was reported.",
  task_required: "This session has more than one task, so nothing was reported. Call the tool again with task_id set to the task you are reporting on.",
  already_reported: "This task no longer accepts reports, so nothing changed. Tell the user what remains and ask them to review the task on the board.",
  stalled: "Pomegr marked this task Stalled, because it read this session as ended before any report, so nothing was reported. Only the user can change that, with Mark done or Requeue on the board. Tell the user what you finished, and do not report again.",
  unavailable: "Pomegr is unavailable, so nothing was reported.",
};
export const TASK_REPORT_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so nothing was reported.";
export const TASK_REVIEW_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so no verdict was recorded.";
export const TASK_REVIEW_NO_ANSWER_TEXT = "Pomegr did not answer in time, so it is unknown whether the verdict was recorded. It may have been: do not assume it failed. Retry the same verdict only if it still describes the review; an identical retry changes nothing.";
const REVIEW_REASON_TEXT = {
  invalid: REPORT_REASON_TEXT.invalid,
  not_found: "This session is not the reviewer of a task, or that task ID is not one it reviews.",
  not_reviewable: "The task is no longer in Review, so no verdict was recorded.",
  unavailable: REPORT_REASON_TEXT.unavailable,
};

export const TASK_REMOVE_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so no task was removed.";
const REMOVE_REASON_TEXT = {
  invalid: "Pomegr rejected the request as invalid, so no task was removed.",
  not_found: "No task was removed. This session can remove only a task it added itself that has not started.",
  repository_unavailable: repositoryUnavailableText("no task was removed"),
  unavailable: "Pomegr is unavailable, so no task was removed.",
};

const ASSIGN_REASON_TEXT = {
  invalid: "Pomegr rejected the request as invalid, so no task was assigned.",
  session_not_found: "Pomegr does not know the current session yet, so no task was assigned.",
  repository_unavailable: repositoryUnavailableText("no task was assigned"),
  not_found: "No task was assigned. A session can be assigned only to a task on its own repository's board.",
  conflict: "No task was assigned. A task that is done cannot be assigned, and this session already reports the task Pomegr started it for.",
  limit: "No task was assigned. A task holds at most 16 assigned sessions, and a session can be assigned to at most 16 tasks.",
  unavailable: "Pomegr is unavailable, so no task was assigned.",
};
const UNASSIGN_REASON_TEXT = {
  invalid: "Pomegr rejected the request as invalid, so no task was unassigned.",
  session_not_found: "Pomegr does not know the current session yet, so no task was unassigned.",
  repository_unavailable: repositoryUnavailableText("no task was unassigned"),
  not_found: "No task was unassigned. This session can unassign only a task it is assigned to.",
  unavailable: "Pomegr is unavailable, so no task was unassigned.",
};
const taskIdSchema = z.string().regex(/^T-[1-9][0-9]{0,8}$/u, "Use a task ID such as T-12.");

const ONE_LINE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
const TEXT_LINES = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]*$/u;

export const TASK_UPDATE_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so no task was changed.";
export const TASK_UPDATE_NO_ANSWER_TEXT = "Pomegr did not answer in time, so it is unknown whether the task was changed. It may have been: do not assume it failed. Calling update_task once more with exactly the same input is safe, because it sets the same values again.";
const UPDATE_REASON_TEXT = {
  invalid: "Pomegr rejected the request as invalid, so no task was changed.",
  session_not_found: "Pomegr does not know the current session yet, so no task was changed.",
  repository_unavailable: repositoryUnavailableText("no task was changed"),
  not_found: "No task was changed. A task can be changed only while it is on this session's board and has not started.",
  after_not_found: "A task in runs_after is not on the board, so no task was changed.",
  after_loop: "These tasks would wait for each other, so no task was changed.",
  unavailable: "Pomegr is unavailable, so no task was changed.",
};

export const FEATURE_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so no feature was read or changed.";
export const FEATURE_NO_ANSWER_TEXT = "Pomegr did not answer in time, so it is unknown whether the feature was changed. It may have been: do not assume it failed. Call get_feature to see how the feature stands before you try again.";
const FEATURE_REASON_TEXT = {
  invalid: "Pomegr rejected the request as invalid, so no feature was read or changed.",
  session_not_found: "Pomegr does not know the current session yet, so no feature was read or changed.",
  repository_unavailable: repositoryUnavailableText("no feature was read or changed"),
  task_required: "This session has more than one task, so no feature was read. Call get_feature again with task_id set to the task whose feature you want, or name the feature.",
  limit: "The board holds as many features as it can, so no feature was created.",
  unavailable: "Pomegr is unavailable, so no feature was read or changed.",
};
const FEATURE_NOT_FOUND_TEXT = {
  get_feature: "No such feature on the board. Without a feature, get_feature reads the feature of the task this session was started for or is assigned to, and that task has none; a task_id must name one of this session's tasks.",
  update_feature: "No such feature on the board, so nothing was changed.",
  delete_feature: "No such feature on the board, so nothing was deleted.",
};
const FEATURE_CONFLICT_TEXT = {
  create_feature: "A feature with that title already exists on the board, so no feature was created.",
  update_feature: "Another feature already has that title, so nothing was changed.",
  delete_feature: "The feature still has tasks, so it was not deleted. Only a feature with no task can be deleted.",
};

const optionalTaskId = taskIdSchema.optional().describe("Optional. ID of the task, such as T-12. Needed only when this session has more than one task: the one Pomegr started it for and tasks assigned to it.");

const featureReference = (optional) => {
  const schema = z.string().trim().min(1).max(80).regex(ONE_LINE, "Use one line of plain text.");
  return optional
    ? schema.optional().describe("Optional. The feature's ID, such as feat-0123456789ab, or its exact title. Leave it out to read the feature of the task this session was started for.")
    : schema.describe("The feature's ID, such as feat-0123456789ab, or its exact title.");
};
const featureTitle = z.string().trim().min(1).max(80).regex(ONE_LINE, "Use one line of plain text.");
const featureDescription = z.string().trim().max(2000).regex(TEXT_LINES, "Use plain text.");
const featureAppVersion = z.string().trim().max(40).regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$/u, "Use one line of plain text.");

// An empty string clears a description or an app version; an absent one is left as it is.
const clearable = (value) => (value === undefined ? undefined : value === "" ? null : value);

export function formatFeature(feature) {
  return [
    `Feature ${feature.id}`,
    `Title: ${feature.title}`,
    `App version: ${feature.appVersion ?? "not set"}`,
    ...(feature.description ? ["Description:", feature.description] : ["Description: not set"]),
  ].join("\n");
}

function servedFeature(feature) {
  return feature !== null && typeof feature === "object" && typeof feature.id === "string" && /^feat-[0-9a-f]{12}$/u.test(feature.id)
    && typeof feature.title === "string" && feature.title.length > 0
    && (feature.description === null || typeof feature.description === "string")
    && (feature.appVersion === null || typeof feature.appVersion === "string");
}
export const TASK_READ_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so no task was read.";
const READ_REASON_TEXT = {
  invalid: "Pomegr rejected the request as invalid, so no task was read.",
  session_not_found: "Pomegr does not know the current session yet, so no task was read.",
  repository_unavailable: repositoryUnavailableText("no task was read"),
  not_found: "No such task on this session's board.",
  unavailable: "Pomegr is unavailable, so no task was read.",
};
const TASK_STATES = ["not_queued", "queued", "scheduled", "needs_review", "stalled", "blocked", "done"];

// The served task of the agent task routes; any other answer reads as unavailable.
function servedTask(task) {
  return task !== null && typeof task === "object" && typeof task.id === "string" && /^T-[1-9][0-9]{0,8}$/u.test(task.id)
    && typeof task.text === "string" && typeof task.column === "string" && TASK_STATES.includes(task.state)
    && typeof task.editable === "boolean" && Array.isArray(task.completeWhen);
}

export function formatTask(task) {
  const run = [task.provider, task.model && `model ${task.model}`, task.effort && `effort ${task.effort}`].filter(Boolean).join(", ");
  const checks = task.completeWhen.filter((check) => Object.hasOwn(CHECK_LABELS, check)).map((check) => CHECK_LABELS[check]).join(", ");
  return [
    `Task ${task.id}`,
    `Column: ${task.column}`,
    `State: ${task.state}`,
    `Editable with update_task: ${task.editable ? "yes" : "no"}`,
    `Feature: ${task.feature ?? "none"}`,
    `Run on: ${run || "not set"}`,
    `Complete when: ${checks || "none"}`,
    `Own condition: ${task.ownCondition ?? "none"}`,
    // A monitor from before the field serves none, so the line is left out rather than read as no list.
    ...(Array.isArray(task.runsAfter) ? [`Runs after: ${task.runsAfter.length > 0 ? task.runsAfter.join(", ") : "none"}`] : []),
    task.textCut === true ? "Text (cut; call get_task for the whole text):" : "Text:",
    task.text,
  ].join("\n");
}

export function formatTaskList(answer) {
  const count = answer.tasks.length;
  const head = answer.matched === 0 ? "No task of the board matches."
    : answer.truncated === true ? `${answer.matched} tasks match; these are the first ${count}, in board order. Narrow the list with query, state, feature, or editable.`
      : `${answer.matched === 1 ? "1 task matches" : `${answer.matched} tasks match`}, in board order.`;
  return [head, ...answer.tasks.map(formatTask)].join("\n\n");
}

const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function resolveCodexCallSession(meta) {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return null;
  const thread = meta.threadId;
  if (typeof thread !== "string" || !SAFE_THREAD_ID.test(thread)) return null;
  const turn = meta["x-codex-turn-metadata"];
  const turnThread = turn !== null && typeof turn === "object" && !Array.isArray(turn) ? turn.thread_id : undefined;
  if (turnThread !== undefined && turnThread !== thread) return null;
  return `codex:${thread}`;
}

function result(text, isError) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] };
}

export function registerTaskTools(server, { resolveSession, post, hookBound = false }) {
  server.registerTool("add_task", {
    title: "Add a Pomegr task",
    description: "Add a task to the current repository's Pomegr board, in the first column, not queued. It does not start any session. Set runs_after to the tasks of the board it must wait for: it never starts until each is Done or deleted. Adding the same text to the same feature again within a few minutes returns the task already added instead of a second one. The repository and session are bound by the host; there is no repository or path input.",
    inputSchema: z.object(inputShape(hookBound)).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => {
    const ref = await resolveSession(input, extra, "add_task");
    if (typeof ref !== "string" || !ref) return result(TASK_UNBOUND_TEXT, true);
    let answer;
    try {
      answer = await post(TASK_ADD_PATH, buildAddTaskBody(ref, input));
    } catch (error) {
      return result(noAnswer(error) ? TASK_NO_ANSWER_TEXT : TASK_UNAVAILABLE_TEXT, true);
    }
    if (answer && answer.ok === true && typeof answer.taskId === "string" && /^T-\d{1,9}$/u.test(answer.taskId)) {
      return result(`Task ${answer.taskId} added to the board, not queued.`, false);
    }
    const text = answer && answer.ok === false && typeof answer.reason === "string" && Object.hasOwn(REASON_TEXT, answer.reason)
      ? REASON_TEXT[answer.reason] : TASK_UNAVAILABLE_TEXT;
    return result(text, true);
  });

  // Both reads are bound to the session's own board like get_feature; neither takes a repository, a path, or a session.
  const readTasks = async (tool, path, input, extra, body, done) => {
    const ref = await resolveSession(input, extra, tool);
    if (typeof ref !== "string" || !ref) return result(TASK_READ_UNBOUND_TEXT, true);
    let answer;
    try {
      answer = await post(path, { sessionRef: ref, ...body });
    } catch {
      return result(READ_REASON_TEXT.unavailable, true);
    }
    if (answer && answer.ok === true) {
      const text = done(answer);
      if (text) return result(text, false);
    }
    const text = answer && answer.ok === false && typeof answer.reason === "string" && Object.hasOwn(READ_REASON_TEXT, answer.reason)
      ? READ_REASON_TEXT[answer.reason] : READ_REASON_TEXT.unavailable;
    return result(text, true);
  };

  server.registerTool("get_task", {
    title: "Read a Pomegr task",
    description: "Read one task of the current repository's Pomegr board by its ID: its whole text, column, state, whether update_task can change it, feature, Run on (provider, model, and effort), Complete when, own condition, and the tasks it runs after. Read a task before you change it with update_task. It changes nothing. The repository and session are bound by the host; the only input is the task ID.",
    inputSchema: z.object({
      task_id: taskIdSchema.describe("ID of the task to read, such as T-12."),
      ...hookFields(hookBound),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => readTasks("get_task", TASK_GET_PATH, input, extra, { taskId: input.task_id },
    (answer) => (servedTask(answer.task) ? formatTask(answer.task) : null)));

  server.registerTool("list_tasks", {
    title: "List Pomegr tasks",
    description: "List the tasks of the current repository's Pomegr board, in board order, with the same fields as get_task. It returns at most 100 tasks, and cuts each text at 300 characters; read a cut task whole with get_task. Narrow the list with query (a part of the text or the own condition, any case), state, feature (its exact title), or editable (true for the tasks update_task can change). It changes nothing. The repository and session are bound by the host.",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(80).regex(ONE_LINE, "Use one line of plain text.").optional()
        .describe("Optional. Lists only the tasks whose text or own condition holds this, in any case."),
      state: z.enum(TASK_STATES).optional().describe("Optional. Lists only the tasks in this state."),
      feature: featureTitle.optional().describe("Optional. Lists only the tasks of the feature with this exact title."),
      editable: z.boolean().optional().describe("Optional. True lists only the tasks update_task can change, false only the others."),
      ...hookFields(hookBound),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => readTasks("list_tasks", TASK_LIST_PATH, input, extra,
    Object.fromEntries(["query", "state", "feature", "editable"].filter((key) => input[key] !== undefined).map((key) => [key, input[key]])),
    (answer) => (Array.isArray(answer.tasks) && Number.isInteger(answer.matched) && answer.tasks.every(servedTask) ? formatTaskList(answer) : null)));

  const UPDATE_FIELDS = ["text", "provider", "model", "effort", "complete_when", "own_condition", "runs_after"];
  const addShape = inputShape(false);
  server.registerTool("update_task", {
    title: "Update a Pomegr task",
    description: "Change a task on the current repository's Pomegr board: its text, Run on (provider and model), effort, Complete when, or the tasks it runs after. It works for any task of the board while the task has not started: not queued, queued, or scheduled, with no session and no report. A field you leave out stays as it is, and a field you set replaces the stored one whole. The text replaces the task's whole text, not appends to it: read the task with get_task first, then set the whole text the task should have. Where the task shows [image], an image stays attached; text you set without it keeps the image but loses its place in the text. It does not move, queue, or start the task. The repository and session are bound by the host; there is no repository or path input.",
    inputSchema: z.object({
      task_id: z.string().regex(/^T-[1-9][0-9]{0,8}$/u, "Use a task ID such as T-12.").describe("ID of the task to change, such as T-12."),
      text: addShape.text.optional().describe("Optional. The task's new text, which replaces the stored text whole."),
      provider: addShape.provider.describe("Optional new provider that should run the task. Without a model, the task takes that provider's default model."),
      model: addShape.model.describe("Optional new model identifier, for the provider you set or the one the task has."),
      effort: addShape.effort.describe("Optional new effort level."),
      complete_when: addShape.complete_when.describe("Optional new list of the conditions Pomegr verifies when the agent reports the task complete; an empty list clears it."),
      own_condition: z.string().trim().max(500).optional().describe("Optional new free-text condition the agent judges itself; an empty string clears it."),
      runs_after: runsAfterSchema.optional().describe("Optional new list of up to 8 tasks of the same board, such as T-12, that must be Done or deleted before this task may start. It replaces the stored list whole; an empty list clears it. A list that would make tasks wait for each other is refused."),
      ...hookFields(hookBound),
    }).strict().refine((value) => UPDATE_FIELDS.some((key) => value[key] !== undefined), "Set at least one field to change."),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => {
    const ref = await resolveSession(input, extra, "update_task");
    if (typeof ref !== "string" || !ref) return result(TASK_UPDATE_UNBOUND_TEXT, true);
    let answer;
    try {
      answer = await post(TASK_UPDATE_PATH, buildUpdateTaskBody(ref, input));
    } catch (error) {
      return result(noAnswer(error) ? TASK_UPDATE_NO_ANSWER_TEXT : UPDATE_REASON_TEXT.unavailable, true);
    }
    if (answer && answer.ok === true) return result(`Task ${input.task_id} updated.`, false);
    const text = answer && answer.ok === false && typeof answer.reason === "string" && Object.hasOwn(UPDATE_REASON_TEXT, answer.reason)
      ? UPDATE_REASON_TEXT[answer.reason] : UPDATE_REASON_TEXT.unavailable;
    return result(text, true);
  });

  server.registerTool("remove_task", {
    title: "Remove a Pomegr task",
    description: "Delete a task this session added itself with add_task, such as a duplicate. It works only while the task has not started: not queued, queued, or scheduled, with no session and no report. It cannot be undone, and the task number is not used again. A task the user or another session added is never removed. The repository and session are bound by the host; the only input is the task ID.",
    inputSchema: z.object({
      task_id: z.string().regex(/^T-[1-9][0-9]{0,8}$/u, "Use a task ID such as T-12.").describe("ID of the task to remove, such as T-12, as add_task returned it."),
      ...hookFields(hookBound),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => {
    const ref = await resolveSession(input, extra, "remove_task");
    if (typeof ref !== "string" || !ref) return result(TASK_REMOVE_UNBOUND_TEXT, true);
    let answer;
    try {
      answer = await post(TASK_REMOVE_PATH, { sessionRef: ref, taskId: input.task_id });
    } catch (error) {
      return result(noAnswer(error) ? TASK_REMOVE_NO_ANSWER_TEXT : REMOVE_REASON_TEXT.unavailable, true);
    }
    if (answer && answer.ok === true) return result(`Task ${input.task_id} removed from the board.`, false);
    const text = answer && answer.ok === false && typeof answer.reason === "string" && Object.hasOwn(REMOVE_REASON_TEXT, answer.reason)
      ? REMOVE_REASON_TEXT[answer.reason] : REMOVE_REASON_TEXT.unavailable;
    return result(text, true);
  });

  const assignment = (tool, path, unboundText, noAnswerText, reasons, done) => async (input, extra) => {
    const ref = await resolveSession(input, extra, tool);
    if (typeof ref !== "string" || !ref) return result(unboundText, true);
    let answer;
    try {
      answer = await post(path, { sessionRef: ref, taskId: input.task_id });
    } catch (error) {
      return result(noAnswer(error) ? noAnswerText : reasons.unavailable, true);
    }
    if (answer && answer.ok === true) return result(done(input.task_id), false);
    const text = answer && answer.ok === false && typeof answer.reason === "string" && Object.hasOwn(reasons, answer.reason)
      ? reasons[answer.reason] : reasons.unavailable;
    return result(text, true);
  };

  server.registerTool("assign_task", {
    title: "Assign a Pomegr task to this session",
    description: "Assign a task of the current repository's Pomegr board to this session, so this session can report it with complete_task or block_task and read its feature with get_feature. It works for any task of the board that is not done, including one that already has a session and one that has not started. It changes no state, column, or queue place and starts nothing. The latest report on a task wins until the owner marks it done. A session can be assigned to several tasks and a task can hold several sessions; assigning the same task again changes nothing. The repository and session are bound by the host; the only input is the task ID.",
    inputSchema: z.object({
      task_id: taskIdSchema.describe("ID of the task to assign to this session, such as T-12."),
      ...hookFields(hookBound),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, assignment("assign_task", TASK_ASSIGN_PATH, TASK_ASSIGN_UNBOUND_TEXT, TASK_ASSIGN_NO_ANSWER_TEXT, ASSIGN_REASON_TEXT,
    (taskId) => `Task ${taskId} assigned to this session. Report it with complete_task or block_task, naming task_id if this session has more than one task.`));

  server.registerTool("unassign_task", {
    title: "Unassign a Pomegr task from this session",
    description: "Remove this session's own assignment to a task, such as when the session stops working on it. It removes only this session's assignment: other sessions of the task, the task's state, and its column stay as they are. It does not touch the task Pomegr started this session for. The repository and session are bound by the host; the only input is the task ID.",
    inputSchema: z.object({
      task_id: taskIdSchema.describe("ID of the task to unassign from this session, such as T-12."),
      ...hookFields(hookBound),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, assignment("unassign_task", TASK_UNASSIGN_PATH, TASK_UNASSIGN_UNBOUND_TEXT, TASK_UNASSIGN_NO_ANSWER_TEXT, UNASSIGN_REASON_TEXT,
    (taskId) => `Task ${taskId} unassigned from this session.`));

  // Both report tools act on a task of the bound session: the one Pomegr started it for, or one assigned to it. They take no repository input.
  const report = async (path, ref, body, done) => {
    if (typeof ref !== "string" || !ref) return result(TASK_REPORT_UNBOUND_TEXT, true);
    let answer;
    try {
      answer = await post(path, { sessionRef: ref, ...body });
    } catch (error) {
      return result(noAnswer(error) ? TASK_REPORT_NO_ANSWER_TEXT : REPORT_REASON_TEXT.unavailable, true);
    }
    if (answer && answer.ok === true) {
      const text = done(answer);
      if (text) {
        const reworks = reportReworkResults(answer.reworks).map((entry) =>
          `${entry.ref} ${entry.status === "refused" ? `refused (${entry.reason})` : entry.status === "exists" ? "already existed" : "recorded"}`);
        return result(text + (reworks.length ? ` Reworks: ${reworks.join("; ")}.` : ""), false);
      }
    }
    const text = answer && answer.ok === false && typeof answer.reason === "string" && Object.hasOwn(REPORT_REASON_TEXT, answer.reason)
      ? REPORT_REASON_TEXT[answer.reason] : REPORT_REASON_TEXT.unavailable;
    return result(text, true);
  };

  server.registerTool("complete_task", {
    title: "Report the Pomegr task complete",
    description: "Report that the task Pomegr started this session for, or a task assigned to this session, is complete. Pomegr verifies the checked conditions and records each result. The task goes to Review; only the user marks it done. Set attention only when the work is finished but something needs the user's attention, such as a choice you made for them or a follow-up they must do; leave it out otherwise. An initial completion puts the task in Review and does not hold the queue; when the work that follows must not start, call block_task instead. A completion after a block records fresh check results and moves the task to Review. An earlier block still holds the queue until the owner chooses Mark done or Requeue. The session is bound by the host, and the latest report wins until the owner marks the task done. Name task_id only when this session has more than one task. The tool has no summary or result field: a plain completion is a call with no input. A denied call changed nothing, so one retry with only the allowed fields is safe. Use reworks to name 1-5 earlier tasks (T-n) or pull requests (#n) this task fixes or redoes, with a cause, only when this session knows it.",
    inputSchema: z.object({
      task_id: optionalTaskId,
      reworks: optionalReworks,
      attention: z.string().trim().min(1).max(200).regex(ONE_LINE, "Use one line of plain text.").optional()
        .describe("Optional. What in the finished work needs the user's attention, in one line of at most 200 characters. No secrets, commands, or output."),
      ...hookFields(hookBound),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => report(TASK_COMPLETE_PATH, await resolveSession(input, extra, "complete_task"), { ...(input.task_id === undefined ? {} : { taskId: input.task_id }), ...(input.attention === undefined ? {} : { attention: input.attention }), ...(input.reworks === undefined ? {} : { reworks: input.reworks }) }, (answer) => {
    // A monitor from before every report went to Review still answers `done`.
    if (answer.state === "done") return "Task reported complete. Pomegr marked it done.";
    if (!["needs_review", "blocked"].includes(answer.state)) return null;
    if (answer.state === "blocked" && !Array.isArray(answer.results)) return null;
    const open = (Array.isArray(answer.results) ? answer.results : []).filter((entry) => entry && entry.passed === false && Object.hasOwn(CHECK_LABELS, entry.check));
    // A monitor from before the two were told apart marks nothing `unavailable`.
    const labels = (unavailable) => open.filter((entry) => (entry.unavailable === true) === unavailable).map((entry) => CHECK_LABELS[entry.check]).join(", ");
    const failed = labels(false);
    const unverified = labels(true);
    const held = answer.ownerHold === true || answer.state === "blocked";
    const holdText = "The task is in Review. An earlier block still needs the user to choose Mark done or Requeue; the queue state is unchanged.";
    if (open.length === 0 && held) return `Task reported complete. ${holdText}`;
    if (open.length === 0) return input.attention !== undefined
      ? "Task reported complete. Pomegr put it in Review for the user's attention; the user marks it done."
      : "Task reported complete. Pomegr put it in Review; the user marks it done.";
    const parts = [failed && `these conditions did not pass: ${failed}`, unverified && `Pomegr could not verify: ${unverified} (it had no current evidence, which does not mean the condition failed)`].filter(Boolean);
    const ciText = open.some((entry) => entry.check === "ci_passed" && entry.unavailable === true)
      ? " CI needs a finished check result for this checkout's current commit; pending, missing, or mismatched evidence cannot verify it." : "";
    return `Task reported complete, but ${parts.join("; and ")}.${ciText} ${held ? holdText : "The task now needs the user's review."}`;
  }));

  server.registerTool("report_review", {
    title: "Report the Pomegr task review",
    description: "For a review session Pomegr started for a task in Review, report the verdict once after running the repository's checks: pass, or fail with one-line reasons stating met, unmet, or unknown for each repository rule that failed. The verdict changes no task state; only the user decides what happens next. It never edits the board. A denied call changed nothing.",
    inputSchema: z.object({
      verdict: z.enum(["pass", "fail"]),
      reasons: z.array(z.string().trim().min(1).max(200).regex(ONE_LINE, "Use one line of plain text.")).min(1).max(10).optional(),
      task_id: optionalTaskId,
      ...hookFields(hookBound),
    }).strict().refine((value) => value.verdict === "fail" ? value.reasons !== undefined : value.reasons === undefined,
      "Reasons are required for fail and must be omitted for pass."),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => {
    const ref = await resolveSession(input, extra, "report_review");
    if (typeof ref !== "string" || !ref) return result(TASK_REVIEW_UNBOUND_TEXT, true);
    let answer;
    try {
      answer = await post(AGENT_TASK_REVIEW_PATH, { sessionRef: ref, verdict: input.verdict,
        ...(input.reasons === undefined ? {} : { reasons: input.reasons }), ...(input.task_id === undefined ? {} : { taskId: input.task_id }) });
    } catch (error) {
      return result(noAnswer(error) ? TASK_REVIEW_NO_ANSWER_TEXT : REVIEW_REASON_TEXT.unavailable, true);
    }
    if (answer && answer.ok === true) return result(input.verdict === "pass"
      ? "Review reported: passed." : `Review reported: failed, with ${input.reasons.length} ${input.reasons.length === 1 ? "reason" : "reasons"}.`, false);
    const text = answer && answer.ok === false && typeof answer.reason === "string" && Object.hasOwn(REVIEW_REASON_TEXT, answer.reason)
      ? REVIEW_REASON_TEXT[answer.reason] : REVIEW_REASON_TEXT.unavailable;
    return result(text, true);
  });

  const feature = async (tool, path, input, extra, body, done) => {
    const ref = await resolveSession(input, extra, tool);
    if (typeof ref !== "string" || !ref) return result(FEATURE_UNBOUND_TEXT, true);
    let answer;
    try {
      answer = await post(path, { sessionRef: ref, ...body });
    } catch (error) {
      return result(noAnswer(error) && tool !== "get_feature" ? FEATURE_NO_ANSWER_TEXT : FEATURE_REASON_TEXT.unavailable, true);
    }
    if (answer && answer.ok === true) {
      const text = done(answer);
      if (text) return result(text, false);
    }
    const reason = answer && answer.ok === false && typeof answer.reason === "string" ? answer.reason : "unavailable";
    const text = reason === "not_found" ? FEATURE_NOT_FOUND_TEXT[tool] : reason === "conflict" ? FEATURE_CONFLICT_TEXT[tool]
      : Object.hasOwn(FEATURE_REASON_TEXT, reason) ? FEATURE_REASON_TEXT[reason] : undefined;
    return result(text ?? FEATURE_REASON_TEXT.unavailable, true);
  };
  const featureId = (answer) => (typeof answer.featureId === "string" && /^feat-[0-9a-f]{12}$/u.test(answer.featureId) ? answer.featureId : null);

  server.registerTool("get_feature", {
    title: "Read a Pomegr feature",
    description: "Read one feature of the current repository's Pomegr board: its ID, title, description, and app version. The description holds the context the feature's tasks share. With no feature it reads the feature of the task Pomegr started this session for or of a task assigned to it; name task_id only when this session has more than one task, and never together with feature. It changes nothing. The repository and session are bound by the host.",
    inputSchema: z.object({ feature: featureReference(true), task_id: optionalTaskId, ...hookFields(hookBound) }).strict()
      .refine((value) => value.feature === undefined || value.task_id === undefined, "Name a feature or a task_id, not both."),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => feature("get_feature", FEATURE_GET_PATH, input, extra, { ...(input.feature === undefined ? {} : { feature: input.feature }), ...(input.task_id === undefined ? {} : { taskId: input.task_id }) },
    (answer) => (servedFeature(answer.feature) ? formatFeature(answer.feature) : null)));

  server.registerTool("create_feature", {
    title: "Create a Pomegr feature",
    description: "Create a feature on the current repository's Pomegr board, with a title and optionally a description and an app version. Put in the description the context every task of the feature shares, so each task's own text stays short. It adds no task and starts nothing; attach a task with add_task and the feature's title. A title that already exists is refused. The repository and session are bound by the host.",
    inputSchema: z.object({
      title: featureTitle.describe("The feature's title, in one line of at most 80 characters. It must be unique on the board."),
      description: featureDescription.min(1).optional().describe("Optional. The context the feature's tasks share, at most 2000 characters. No secrets."),
      app_version: featureAppVersion.min(1).optional().describe("Optional. The app version the feature is planned for, such as 1.4.0, in one line of at most 40 characters."),
      ...hookFields(hookBound),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => feature("create_feature", FEATURE_CREATE_PATH, input, extra, {
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.app_version === undefined ? {} : { appVersion: input.app_version }),
  }, (answer) => (featureId(answer) ? `Feature ${featureId(answer)} created.` : null)));

  server.registerTool("update_feature", {
    title: "Update a Pomegr feature",
    description: "Change the title, description, or app version of one feature on the current repository's Pomegr board. A field you leave out stays as it is, and a field you set replaces the stored one whole; an empty description or app version clears it. It changes no task. The repository and session are bound by the host.",
    inputSchema: z.object({
      feature: featureReference(false),
      title: featureTitle.optional().describe("Optional new title, in one line of at most 80 characters. It must be unique on the board."),
      description: featureDescription.optional().describe("Optional new description, at most 2000 characters; an empty string clears it. No secrets."),
      app_version: featureAppVersion.optional().describe("Optional new app version, in one line of at most 40 characters; an empty string clears it."),
      ...hookFields(hookBound),
    }).strict().refine((value) => value.title !== undefined || value.description !== undefined || value.app_version !== undefined, "Set at least one of title, description, and app_version."),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => feature("update_feature", FEATURE_UPDATE_PATH, input, extra, {
    feature: input.feature,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: clearable(input.description) }),
    ...(input.app_version === undefined ? {} : { appVersion: clearable(input.app_version) }),
  }, (answer) => (featureId(answer) ? `Feature ${featureId(answer)} updated.` : null)));

  server.registerTool("delete_feature", {
    title: "Delete a Pomegr feature",
    description: "Delete one feature of the current repository's Pomegr board. It works only for a feature that has no task, so no task loses its feature. It cannot be undone. The repository and session are bound by the host.",
    inputSchema: z.object({ feature: featureReference(false), ...hookFields(hookBound) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => feature("delete_feature", FEATURE_DELETE_PATH, input, extra, { feature: input.feature }, () => "Feature deleted."));

  server.registerTool("block_task", {
    title: "Report the Pomegr task blocked",
    description: "Report that you cannot continue the task Pomegr started this session for, or a task assigned to this session, with a short reason the user will read. The task becomes Blocked by agent and holds the queue until the user resolves the hold. The session is bound by the host. The latest report wins until the owner marks the task done; a later completion does not clear the owner-controlled hold. Name task_id only when this session has more than one task. Use reworks to name 1-5 earlier tasks (T-n) or pull requests (#n) this task fixes or redoes, with a cause, only when this session knows it.",
    inputSchema: z.object({
      task_id: optionalTaskId,
      reworks: optionalReworks,
      reason: z.string().trim().min(1).max(200).regex(ONE_LINE, "Use one line of plain text.")
        .describe("Why the task cannot continue, in one line of at most 200 characters. No secrets, commands, or output."),
      ...hookFields(hookBound),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => report(TASK_BLOCK_PATH, await resolveSession(input, extra, "block_task"), { ...(input.task_id === undefined ? {} : { taskId: input.task_id }), reason: input.reason, ...(input.reworks === undefined ? {} : { reworks: input.reworks }) },
    (answer) => (answer.state === "blocked" ? "Task reported as blocked. The user will resolve it." : null)));
}
