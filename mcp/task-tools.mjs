import { z } from "zod";

export const TASK_ADD_PATH = "/api/agent/v1/tasks/add";
export const TASK_TOOL_INSTRUCTIONS = "Use add_task to put follow-up work on the current repository's Pomegr task board when the user asks for it; it only adds a task in the first column, it does not queue or start anything, and the repository is always the current session's.";
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
  if (hookBound) {
    shape.session_ref = z.string().max(200)
      .describe("Set by the Pomegr hook. Never supply this field.").optional();
  }
  return shape;
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

function result(text, isError) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] };
}

export function registerTaskTools(server, { resolveSession, post, hookBound = false }) {
  server.registerTool("add_task", {
    title: "Add a Pomegr task",
    description: "Add a task to the current repository's Pomegr board, in the first column, not queued. It does not start any session. The repository and session are bound by the host; there is no repository or path input.",
    inputSchema: z.object(inputShape(hookBound)).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    const ref = resolveSession(input);
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
}
