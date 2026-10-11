import { z } from "zod";

import { AGENT_TASK_NO_ANSWER } from "../shared/agent-query-transport.mjs";

export const TASK_ADD_PATH = "/api/agent/v1/tasks/add";
export const TASK_COMPLETE_PATH = "/api/agent/v1/tasks/complete";
export const TASK_BLOCK_PATH = "/api/agent/v1/tasks/block";
export const TASK_REMOVE_PATH = "/api/agent/v1/tasks/remove";
export const TASK_UPDATE_PATH = "/api/agent/v1/tasks/update";
export const FEATURE_GET_PATH = "/api/agent/v1/tasks/feature-get";
export const FEATURE_CREATE_PATH = "/api/agent/v1/tasks/feature-create";
export const FEATURE_UPDATE_PATH = "/api/agent/v1/tasks/feature-update";
export const FEATURE_DELETE_PATH = "/api/agent/v1/tasks/feature-delete";
export const TASK_TOOL_INSTRUCTIONS = "Use add_task to put follow-up work on the current repository's Pomegr task board when the user asks for it; it only adds a task in the first column, it does not queue or start anything, and the repository is always the current session's. Use update_task to change a task of that board that has not started, such as to add a finding to its text, when the user asks for it or the work calls for it; the text you set replaces the stored text whole and no tool reads a task's text back, so set it only when you hold the full text the task should have. Use remove_task only to delete a task this session added itself with add_task, such as a duplicate, while it has not started; it cannot be undone, and it never removes a task the user or another session added. When Pomegr started this session for a task, call complete_task once the task is complete, which puts it in Review for the user, adding its attention line only when something in the finished work needs the user's attention, or block_task with a short reason when you cannot proceed; each session reports once, and only on its own task. A feature groups tasks of the board and holds their shared context: a title, a description, and an app version. Use get_feature when a task of a feature needs that context; with no input it reads the feature of the task this session was started for. Use create_feature, update_feature, and delete_feature only when the user asks to change the board's features; delete_feature removes only a feature that has no task.";
export const TASK_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so no task was added.";
export const TASK_UNAVAILABLE_TEXT = "Pomegr is unavailable, so no task was added.";
export const TASK_NO_ANSWER_TEXT = "Pomegr did not answer in time, so it is unknown whether the task was added. It may have been: do not assume it failed. Calling add_task again with exactly the same text and feature within a few minutes is safe and returns the same task instead of a second one; do not add it again with different wording.";
export const TASK_REPORT_NO_ANSWER_TEXT = "Pomegr did not answer in time, so it is unknown whether the report was recorded. It may have been: do not assume it failed. Calling the same tool once more is safe, because a task takes one report; if the answer is that this session already reported, the first report stands.";
export const TASK_REMOVE_NO_ANSWER_TEXT = "Pomegr did not answer in time, so it is unknown whether the task was removed. It may have been: do not assume it failed. Calling remove_task once more with the same task ID is safe; if the answer is that no task was removed, the first call removed it or it could not be removed.";

const noAnswer = (error) => error instanceof Error && error.message === AGENT_TASK_NO_ANSWER;

const CHECKS = ["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed"];
const REASON_TEXT = {
  invalid: "Pomegr rejected the task as invalid, so no task was added.",
  session_not_found: "Pomegr does not know the current session yet, so no task was added.",
  repository_unavailable: "Pomegr could not resolve the current session's repository, so no task was added.",
  feature_not_found: "That feature does not exist on the board, so no task was added.",
  limit: "The board is full, so no task was added.",
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
    complete_when: z.array(z.enum(CHECKS)).max(5)
      .refine((items) => new Set(items).size === items.length, "Checks must be unique.")
      .optional().describe("Optional conditions Pomegr verifies when the agent reports the task complete."),
    own_condition: z.string().trim().min(1).max(500).optional().describe("Optional free-text condition the agent judges itself."),
    feature: z.string().trim().min(1).max(80).optional().describe("Optional name of an existing feature on the board."),
  };
  return { ...shape, ...hookFields(hookBound) };
}

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
  return body;
}

const CHECK_LABELS = {
  pr_open: "Pull request open",
  tree_clean: "Working tree clean",
  commit_on_branch: "Commit on task branch",
  pr_merged: "Pull request merged",
  ci_passed: "CI passed",
};
const REPORT_REASON_TEXT = {
  invalid: "Pomegr rejected the report as invalid, so nothing was reported.",
  not_found: "No Pomegr task is linked to this session, so nothing was reported.",
  already_reported: "This session already reported on its task, so nothing changed.",
  stalled: "Pomegr marked this task Stalled, because it read this session as ended before any report, so nothing was reported. Only the user can change that, with Mark done or Requeue on the board. Tell the user what you finished, and do not report again.",
  unavailable: "Pomegr is unavailable, so nothing was reported.",
};
export const TASK_REPORT_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so nothing was reported.";

export const TASK_REMOVE_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so no task was removed.";
const REMOVE_REASON_TEXT = {
  invalid: "Pomegr rejected the request as invalid, so no task was removed.",
  not_found: "No task was removed. This session can remove only a task it added itself that has not started.",
  unavailable: "Pomegr is unavailable, so no task was removed.",
};

const ONE_LINE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
const TEXT_LINES = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]*$/u;

export const TASK_UPDATE_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so no task was changed.";
export const TASK_UPDATE_NO_ANSWER_TEXT = "Pomegr did not answer in time, so it is unknown whether the task was changed. It may have been: do not assume it failed. Calling update_task once more with exactly the same input is safe, because it sets the same values again.";
const UPDATE_REASON_TEXT = {
  invalid: "Pomegr rejected the request as invalid, so no task was changed.",
  session_not_found: "Pomegr does not know the current session yet, so no task was changed.",
  repository_unavailable: "Pomegr could not resolve the current session's repository, so no task was changed.",
  not_found: "No task was changed. A task can be changed only while it is on this session's board and has not started.",
  unavailable: "Pomegr is unavailable, so no task was changed.",
};

export const FEATURE_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so no feature was read or changed.";
export const FEATURE_NO_ANSWER_TEXT = "Pomegr did not answer in time, so it is unknown whether the feature was changed. It may have been: do not assume it failed. Call get_feature to see how the feature stands before you try again.";
const FEATURE_REASON_TEXT = {
  invalid: "Pomegr rejected the request as invalid, so no feature was read or changed.",
  session_not_found: "Pomegr does not know the current session yet, so no feature was read or changed.",
  repository_unavailable: "Pomegr could not resolve the current session's repository, so no feature was read or changed.",
  limit: "The board holds as many features as it can, so no feature was created.",
  unavailable: "Pomegr is unavailable, so no feature was read or changed.",
};
const FEATURE_NOT_FOUND_TEXT = {
  get_feature: "No such feature on the board. Without an input, get_feature reads the feature of the task this session was started for, and this session has none.",
  update_feature: "No such feature on the board, so nothing was changed.",
  delete_feature: "No such feature on the board, so nothing was deleted.",
};
const FEATURE_CONFLICT_TEXT = {
  create_feature: "A feature with that title already exists on the board, so no feature was created.",
  update_feature: "Another feature already has that title, so nothing was changed.",
  delete_feature: "The feature still has tasks, so it was not deleted. Only a feature with no task can be deleted.",
};

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
    description: "Add a task to the current repository's Pomegr board, in the first column, not queued. It does not start any session. Adding the same text to the same feature again within a few minutes returns the task already added instead of a second one. The repository and session are bound by the host; there is no repository or path input.",
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

  const UPDATE_FIELDS = ["text", "provider", "model", "effort", "complete_when", "own_condition"];
  const addShape = inputShape(false);
  server.registerTool("update_task", {
    title: "Update a Pomegr task",
    description: "Change a task on the current repository's Pomegr board: its text, Run on (provider and model), effort, or Complete when. It works for any task of the board while the task has not started: not queued, queued, or scheduled, with no session and no report. A field you leave out stays as it is, and a field you set replaces the stored one whole. The text replaces the task's whole text and Pomegr never returns a task's text, so set it only when you hold the full text the task should have. It does not move, queue, or start the task. The repository and session are bound by the host; there is no repository or path input.",
    inputSchema: z.object({
      task_id: z.string().regex(/^T-[1-9][0-9]{0,8}$/u, "Use a task ID such as T-12.").describe("ID of the task to change, such as T-12."),
      text: addShape.text.optional().describe("Optional. The task's new text, which replaces the stored text whole."),
      provider: addShape.provider.describe("Optional new provider that should run the task. Without a model, the task takes that provider's default model."),
      model: addShape.model.describe("Optional new model identifier, for the provider you set or the one the task has."),
      effort: addShape.effort.describe("Optional new effort level."),
      complete_when: addShape.complete_when.describe("Optional new list of the conditions Pomegr verifies when the agent reports the task complete; an empty list clears it."),
      own_condition: z.string().trim().max(500).optional().describe("Optional new free-text condition the agent judges itself; an empty string clears it."),
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

  // Both report tools act only on the task linked to the bound session; neither takes a task or repository input.
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
      if (text) return result(text, false);
    }
    const text = answer && answer.ok === false && typeof answer.reason === "string" && Object.hasOwn(REPORT_REASON_TEXT, answer.reason)
      ? REPORT_REASON_TEXT[answer.reason] : REPORT_REASON_TEXT.unavailable;
    return result(text, true);
  };

  server.registerTool("complete_task", {
    title: "Report the Pomegr task complete",
    description: "Report that the task Pomegr started this session for is complete. Pomegr then verifies the conditions the user checked and puts the task in Review with each result; only the user marks it done. Set attention only when the work is finished but something needs the user's attention, such as a choice you made for them or a follow-up they must do; leave it out otherwise. A task in Review does not hold the queue; when the work that follows must not start, call block_task instead. The session is bound by the host, and each session reports once.",
    inputSchema: z.object({
      attention: z.string().trim().min(1).max(200).regex(ONE_LINE, "Use one line of plain text.").optional()
        .describe("Optional. What in the finished work needs the user's attention, in one line of at most 200 characters. No secrets, commands, or output."),
      ...hookFields(hookBound),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => report(TASK_COMPLETE_PATH, await resolveSession(input, extra, "complete_task"), input.attention === undefined ? {} : { attention: input.attention }, (answer) => {
    // A monitor from before every report went to Review still answers `done`.
    if (answer.state === "done") return "Task reported complete. Pomegr marked it done.";
    if (answer.state !== "needs_review") return null;
    const failed = (Array.isArray(answer.results) ? answer.results : [])
      .filter((entry) => entry && entry.passed === false && Object.hasOwn(CHECK_LABELS, entry.check)).map((entry) => CHECK_LABELS[entry.check]);
    if (failed.length === 0) return input.attention !== undefined
      ? "Task reported complete. Pomegr put it in Review for the user's attention; do not report again."
      : "Task reported complete. Pomegr put it in Review; the user marks it done. Do not report again.";
    return `Task reported complete, but Pomegr could not confirm: ${failed.length > 0 ? failed.join(", ") : "a checked condition"}. The task now needs the user's review; do not report again.`;
  }));

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
    description: "Read one feature of the current repository's Pomegr board: its ID, title, description, and app version. The description holds the context the feature's tasks share. With no input it reads the feature of the task Pomegr started this session for. It changes nothing. The repository and session are bound by the host.",
    inputSchema: z.object({ feature: featureReference(true), ...hookFields(hookBound) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => feature("get_feature", FEATURE_GET_PATH, input, extra, input.feature === undefined ? {} : { feature: input.feature },
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
    description: "Delete one feature of the current repository's Pomegr board. It works only for a feature that has no task, so no task loses its feature or its step. It cannot be undone. The repository and session are bound by the host.",
    inputSchema: z.object({ feature: featureReference(false), ...hookFields(hookBound) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => feature("delete_feature", FEATURE_DELETE_PATH, input, extra, { feature: input.feature }, () => "Feature deleted."));

  server.registerTool("block_task", {
    title: "Report the Pomegr task blocked",
    description: "Report that you cannot continue the task Pomegr started this session for, with a short reason the user will read. The task is marked blocked until the user resolves it. The session is bound by the host, and each session reports once.",
    inputSchema: z.object({
      reason: z.string().trim().min(1).max(200).regex(ONE_LINE, "Use one line of plain text.")
        .describe("Why the task cannot continue, in one line of at most 200 characters. No secrets, commands, or output."),
      ...hookFields(hookBound),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => report(TASK_BLOCK_PATH, await resolveSession(input, extra, "block_task"), { reason: input.reason },
    (answer) => (answer.state === "blocked" ? "Task reported as blocked. The user will resolve it." : null)));
}
