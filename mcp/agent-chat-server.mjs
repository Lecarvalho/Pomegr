import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { formatTaskList } from "./task-tools.mjs";
import { registerAgentQueryTools } from "./agent-query-tools.mjs";
import { createAgentQueryReader, defaultAgentQueryDataRoot } from "../shared/agent-query-transport.mjs";
import { AGENT_TASK_READ_BOUNDS, servedAgentTask, servedChatTask } from "../shared/task-agent-read.mjs";

export const CHAT_TASK_UNAVAILABLE = "Pomegr task unavailable on this chat's board.";

// The capability is supplied only in this MCP child's configuration. It names a turn, never a caller-selected board.
function createChatTaskTransport(environment, fetchFn, byteLimit) {
  const origin = environment.POMEGR_CHAT_TASK_ORIGIN;
  const key = environment.POMEGR_CHAT_TASK_KEY;
  return async (path) => {
    if (typeof origin !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(origin)
      || typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(key)) return null;
    const response = await fetchFn(`${origin}${path}`, {
      method: "GET", headers: { "x-pomegr-chat-task-key": key }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > byteLimit) return null;
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
}

export function createChatTaskReader(environment = process.env, fetchFn = fetch) {
  const read = createChatTaskTransport(environment, fetchFn, 32 * 1024);
  return async (taskId) => {
    const answer = await read(`/task?${new URLSearchParams({ task_id: taskId })}`);
    return answer?.ok === true ? answer.task : null;
  };
}

export function createChatTaskLister(environment = process.env, fetchFn = fetch) {
  const read = createChatTaskTransport(environment, fetchFn, 512 * 1024);
  return async (filters = {}) => {
    const search = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined).map(([name, value]) => [name, String(value)])));
    const answer = await read(`/tasks?${search}`);
    return answer?.ok === true ? answer : null;
  };
}

export const AGENT_CHAT_MCP_INSTRUCTIONS = "These are Pomegr's read-only observation tools for the Pomegr agent chat. Nothing here changes a session, a task, or the board. Alongside the seven observation tools, get_task reads one task of this chat's repository by task_id; use it when a needed snapshot task has text_cut, instead of guessing from the preview. list_tasks reads the bounded tasks of this chat's repository and supports the same filters as coding sessions. Neither tool takes a repository or path input. This chat is not an observed session, so there is no current session: list_sessions finds exact session references, and every session tool needs one in session_ref (the board snapshot gives a task's session reference). Use get_session_report for one bounded Markdown report of a session's retained normalized evidence. Use get_usage_limits and get_provider_health when capacity or provider condition changes the advice. Results are observations that can be stale or unavailable; public provider status does not prove impact or causation.";

/** Seven observation tools and two repository-bound task reads; no signal, write, or feature tool. */
export function buildAgentChatMcpServer(options = {}) {
  const server = new McpServer({ name: "pomegr", version: "1.0.0" }, { instructions: AGENT_CHAT_MCP_INSTRUCTIONS });
  const query = options.query ?? createAgentQueryReader({ dataRoot: options.dataRoot ?? defaultAgentQueryDataRoot() });
  // No host session is bound, so a session tool without an explicit reference answers unavailable.
  registerAgentQueryTools(server, { query, currentSessionRef: null });
  const readTask = options.readTask ?? createChatTaskReader(options.environment);
  const listTasks = options.listTasks ?? createChatTaskLister(options.environment);
  const inputSchema = z.object({ task_id: z.string().regex(/^T-[1-9][0-9]{0,8}$/u).describe("Task ID on this chat's board, such as T-12.") }).strict();
  server.registerTool("get_task", {
    title: "Read a task on this chat's board",
    description: "Read one task's whole text and conditions on this chat's repository board. Use it when a needed snapshot task has text_cut. Reads only; no repository or path input.",
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try {
      const parsed = inputSchema.safeParse(input);
      if (parsed.success) {
        const entry = await readTask(parsed.data.task_id);
        const task = entry?.textCut === false ? servedChatTask(entry) : null;
        if (task?.id === parsed.data.task_id && task.textCut === false) return { content: [{ type: "text", text: JSON.stringify(task) }], structuredContent: task };
      }
    } catch { /* no input, transport, or monitor details leave the tool */ }
    return { content: [{ type: "text", text: CHAT_TASK_UNAVAILABLE }], isError: true };
  });
  const listSchema = z.object({
    query: z.string().trim().min(1).max(AGENT_TASK_READ_BOUNDS.queryLength).regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u).optional(),
    state: z.enum(["not_queued", "queued", "scheduled", "needs_review", "stalled", "blocked", "done"]).optional(),
    feature: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u).optional(),
    editable: z.boolean().optional(),
  }).strict();
  server.registerTool("list_tasks", {
    title: "List tasks on this chat's board",
    description: `List this chat's repository tasks, in board order. At most ${AGENT_TASK_READ_BOUNDS.listTasks} tasks are returned, with text cut at ${AGENT_TASK_READ_BOUNDS.listTextLength} characters. Use query, state, feature, or editable to narrow the list. Reads only; no repository or path input.`,
    inputSchema: listSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try {
      const parsed = listSchema.safeParse(input);
      if (parsed.success) {
        const answer = await listTasks(parsed.data);
        if (Array.isArray(answer?.tasks) && answer.tasks.length <= AGENT_TASK_READ_BOUNDS.listTasks
          && Number.isSafeInteger(answer.matched) && answer.matched >= answer.tasks.length && typeof answer.truncated === "boolean"
          && answer.truncated === (answer.matched > answer.tasks.length)) {
          const tasks = answer.tasks.map((task) => task && typeof task.textCut === "boolean"
            && typeof task.text === "string" && task.text.length <= AGENT_TASK_READ_BOUNDS.listTextLength
            && (!task.textCut || task.text.length === AGENT_TASK_READ_BOUNDS.listTextLength)
            ? servedAgentTask(task) : null);
          if (!tasks.includes(null)) {
            const output = { tasks: answer.tasks.map((task, index) => ({ ...tasks[index], textCut: answer.tasks[index].textCut === true })), matched: answer.matched, truncated: answer.truncated };
            return { content: [{ type: "text", text: formatTaskList(output) }], structuredContent: output };
          }
        }
      }
    } catch { /* no input, transport, or monitor details leave the tool */ }
    return { content: [{ type: "text", text: CHAT_TASK_UNAVAILABLE }], isError: true };
  });
  return server;
}
