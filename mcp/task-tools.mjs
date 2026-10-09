import { z } from "zod";

export const TASK_ADD_PATH = "/api/agent/v1/tasks/add";
export const TASK_COMPLETE_PATH = "/api/agent/v1/tasks/complete";
export const TASK_BLOCK_PATH = "/api/agent/v1/tasks/block";
export const TASK_TOOL_INSTRUCTIONS = "Use add_task to put follow-up work on the current repository's Pomegr task board when the user asks for it; it only adds a task in the first column, it does not queue or start anything, and the repository is always the current session's. When Pomegr started this session for a task, call complete_task once the task is done, or block_task with a short reason when you cannot proceed; each session reports once, and only on its own task.";
export const TASK_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so no task was added.";
export const TASK_UNAVAILABLE_TEXT = "Pomegr is unavailable, so no task was added.";

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

/** Set by the Pomegr hook through `updatedInput`; the server refuses a reference that lacks the hook's proof. */
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
    done_when: z.array(z.enum(CHECKS)).max(5)
      .refine((items) => new Set(items).size === items.length, "Checks must be unique.")
      .optional().describe("Optional conditions Pomegr verifies before the task counts as done."),
    own_condition: z.string().trim().min(1).max(500).optional().describe("Optional free-text condition the agent judges itself."),
    feature: z.string().trim().min(1).max(80).optional().describe("Optional name of an existing feature on the board."),
  };
  return { ...shape, ...hookFields(hookBound) };
}

export function buildAddTaskBody(ref, input) {
  const body = { sessionRef: ref, text: input.text };
  if (input.provider !== undefined || input.model !== undefined || input.effort !== undefined) {
    body.run = { provider: input.provider ?? null, model: input.model ?? null, effort: input.effort ?? null };
  }
  if (input.done_when !== undefined || input.own_condition !== undefined) {
    body.doneWhen = { checks: input.done_when ?? [], own: input.own_condition ?? null };
  }
  if (input.feature !== undefined) body.feature = input.feature;
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
  unavailable: "Pomegr is unavailable, so nothing was reported.",
};
export const TASK_REPORT_UNBOUND_TEXT = "Pomegr could not bind this call to the current session, so nothing was reported.";

const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Codex names the calling thread in the `_meta` of every MCP tool call (`threadId`, and `thread_id` in its turn
 * metadata); the model cannot set either. Its launch environment does not reach a stdio MCP server. Returns
 * `codex:<thread>` or null when the metadata is missing, malformed, or disagrees with itself.
 */
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
    description: "Add a task to the current repository's Pomegr board, in the first column, not queued. It does not start any session. The repository and session are bound by the host; there is no repository or path input.",
    inputSchema: z.object(inputShape(hookBound)).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => {
    const ref = await resolveSession(input, extra, "add_task");
    if (typeof ref !== "string" || !ref) return result(TASK_UNBOUND_TEXT, true);
    let answer;
    try {
      answer = await post(TASK_ADD_PATH, buildAddTaskBody(ref, input));
    } catch {
      return result(TASK_UNAVAILABLE_TEXT, true);
    }
    if (answer && answer.ok === true && typeof answer.taskId === "string" && /^T-\d{1,9}$/u.test(answer.taskId)) {
      return result(`Task ${answer.taskId} added to the board, not queued.`, false);
    }
    const text = answer && answer.ok === false && typeof answer.reason === "string" && Object.hasOwn(REASON_TEXT, answer.reason)
      ? REASON_TEXT[answer.reason] : TASK_UNAVAILABLE_TEXT;
    return result(text, true);
  });

  // Both report tools act only on the task linked to the bound session; neither takes a task or repository input.
  const report = async (path, ref, body, done) => {
    if (typeof ref !== "string" || !ref) return result(TASK_REPORT_UNBOUND_TEXT, true);
    let answer;
    try {
      answer = await post(path, { sessionRef: ref, ...body });
    } catch {
      return result(REPORT_REASON_TEXT.unavailable, true);
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
    description: "Report that the task Pomegr started this session for is complete. Pomegr then verifies the conditions the user checked and marks the task done or in need of review. It takes no input: the session is bound by the host, and each session reports once.",
    inputSchema: z.object(hookFields(hookBound)).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => report(TASK_COMPLETE_PATH, await resolveSession(input, extra, "complete_task"), {}, (answer) => {
    if (answer.state === "done") return "Task reported complete. Pomegr marked it done.";
    if (answer.state !== "needs_review") return null;
    const failed = (Array.isArray(answer.results) ? answer.results : [])
      .filter((entry) => entry && entry.passed === false && Object.hasOwn(CHECK_LABELS, entry.check)).map((entry) => CHECK_LABELS[entry.check]);
    return `Task reported complete, but Pomegr could not confirm: ${failed.length > 0 ? failed.join(", ") : "a checked condition"}. The task now needs the user's review; do not report again.`;
  }));

  server.registerTool("block_task", {
    title: "Report the Pomegr task blocked",
    description: "Report that you cannot continue the task Pomegr started this session for, with a short reason the user will read. The task is marked blocked until the user resolves it. The session is bound by the host, and each session reports once.",
    inputSchema: z.object({
      reason: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u, "Use one line of plain text.")
        .describe("Why the task cannot continue, in one line of at most 200 characters. No secrets, commands, or output."),
      ...hookFields(hookBound),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, extra) => report(TASK_BLOCK_PATH, await resolveSession(input, extra, "block_task"), { reason: input.reason },
    (answer) => (answer.state === "blocked" ? "Task reported as blocked. The user will resolve it." : null)));
}
