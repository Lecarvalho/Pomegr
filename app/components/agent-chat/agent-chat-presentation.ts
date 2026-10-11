import {
  AGENT_CHAT_BOUNDS,
  type AgentChatActivity, type AgentChatBoardOperation, type AgentChatConversationSummary, type AgentChatError, type AgentChatMessage,
  type AgentChatOperationResult, type AgentChatProposal, type AgentChatProposalState, type AgentChatProvider, type AgentChatTurnStatus,
} from "../../../shared/agent-chat-contract";
import { plainTaskText, type Task } from "../../../shared/task-contract";
import { repositoryRouteId } from "../repositories/repository-route";
import { CHECK_SHORT_LABELS, EFFORT_LABELS, PROVIDER_LABELS } from "../tasks/task-fields";

// Fixed copy and small pure rules of the Aril chat panel. A word here is chosen by a fixed value; no answer text,
// provider message, or error text is ever placed into a label.

export const REPOSITORY_STORAGE_KEY = "pomegr.agentChat.repository";
export const COUNTER_SHOWN_FROM = 3_600;
export const MESSAGE_LIMIT = AGENT_CHAT_BOUNDS.messageLength;

export const ACTIVITY_LABELS: Record<AgentChatActivity, string> = {
  starting: "Starting…",
  thinking: "Thinking…",
  reading_files: "Reading repository files…",
  reading_sessions: "Reading sessions…",
  reading_usage: "Reading usage limits…",
  writing: "Writing…",
};

export const STATUS_NOTES: Record<Exclude<AgentChatTurnStatus, "complete">, string> = {
  stopped: "Stopped.",
  failed: "Aril could not finish this answer. Check that the provider's CLI is installed, signed in, and up to date.",
  timed_out: "This answer took too long and was stopped.",
  interrupted: "Pomegr closed before this answer was finished.",
};

export const SUGGESTIONS: readonly string[] = [
  "Break this feature into tasks: ",
  "Which task should run first, and why?",
  "Is any task too big for one session?",
  "Which model fits this kind of task: ",
];

export const UNREADABLE_PROPOSAL = "Aril wrote a proposal that Pomegr could not read, so there is nothing to apply. Ask for it again.";

export function errorCopy(error: AgentChatError, context: { provider: AgentChatProvider; conversationOpen: boolean }): string {
  switch (error) {
    case "busy": return "Aril is already answering. Wait for it to finish.";
    case "cli_missing": return `${PROVIDER_LABELS[context.provider]} is not installed on this computer.`;
    case "limit": return context.conversationOpen
      ? "This conversation is full. Start a new one."
      : `This repository holds ${AGENT_CHAT_BOUNDS.conversationsPerRepository} conversations. Delete one to start another.`;
    case "not_found": return "That conversation is no longer there.";
    case "conflict": return "That proposal was already answered.";
    case "invalid": return "That message could not be sent.";
    case "unavailable": return "Aril could not be reached. Try again.";
  }
}

export function agentCaption(message: { provider: AgentChatProvider; model: string | null }): string {
  return `${PROVIDER_LABELS[message.provider]} · ${message.model ?? "default model"}`;
}

export function firstLine(text: string): string {
  return plainTaskText(text).split(/\r?\n/u).find((line) => line.trim() !== "")?.trim() ?? "";
}

const COUNT = new Intl.NumberFormat("en-US");
export const formatCount = (value: number) => COUNT.format(value);

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function conversationMeta(summary: Pick<AgentChatConversationSummary, "messages" | "updatedAt">): string {
  const time = Date.parse(summary.updatedAt);
  const count = `${formatCount(summary.messages)} ${summary.messages === 1 ? "message" : "messages"}`;
  return Number.isFinite(time) ? `${count} · ${DATE.format(time)}` : count;
}

/** Whether the pending message of the owner is already the last stored message, so it is not drawn twice. */
export function pendingIsStored(messages: readonly AgentChatMessage[], pending: string | null): boolean {
  const last = messages.at(-1);
  return pending !== null && last?.role === "user" && last.text === pending.trim();
}

// ---- Repository ----

/** The repository a route is about, when the inventory lists it. */
export function repositoryFromRoute(pathname: string, search: string, known: readonly string[]): string | null {
  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) {
    const id = repositoryRouteId(new URLSearchParams(search).get("repository"));
    if (id && known.includes(id)) return id;
  }
  const match = /^\/repositories\/(repo-[a-f0-9]{24})(?:\/|$)/u.exec(pathname);
  return match && known.includes(match[1]) ? match[1] : null;
}

/** The route's repository, else the last one used, else the first listed. */
export function chooseRepository(known: readonly string[], route: string | null, stored: string | null): string | null {
  if (route) return route;
  if (stored && known.includes(stored)) return stored;
  return known[0] ?? null;
}

export function readStoredRepository(): string | null {
  try {
    return repositoryRouteId(window.localStorage.getItem(REPOSITORY_STORAGE_KEY)) ?? null;
  } catch {
    return null;
  }
}

export function storeRepository(repositoryId: string): void {
  try {
    if (repositoryRouteId(repositoryId)) window.localStorage.setItem(REPOSITORY_STORAGE_KEY, repositoryId);
  } catch { /* A repository that cannot be remembered is chosen again next time. */ }
}

// ---- Proposal rows ----

export type OperationTitlePart = string | { id: string };
export type OperationRow = {
  title: OperationTitlePart[];
  /** A first line of task text, clamped to two lines; the whole text is its tooltip. */
  text?: { value: string; whole: string; muted: boolean };
  details: string[];
  warning?: string;
};

type BoardTask = Pick<Task, "id" | "text">;

function runParts(run: { provider?: AgentChatProvider | null; model?: string | null; effort?: string | null } | undefined, forNew: boolean): string[] {
  if (!run) return [];
  const parts: string[] = [];
  if (run.provider) parts.push(PROVIDER_LABELS[run.provider]);
  if (typeof run.model === "string") parts.push(run.model);
  else if (run.provider && (run.model === null || forNew)) parts.push("default model");
  if (run.effort && run.effort in EFFORT_LABELS) parts.push(EFFORT_LABELS[run.effort as keyof typeof EFFORT_LABELS].toLowerCase());
  return parts;
}

function checkParts(completeWhen: { checks?: readonly (keyof typeof CHECK_SHORT_LABELS)[]; own?: string | null } | undefined): string | null {
  if (!completeWhen) return null;
  const names = [...(completeWhen.checks ?? []).map((check) => CHECK_SHORT_LABELS[check] ?? check), ...(completeWhen.own ? ["own condition"] : [])];
  return names.length > 0 ? `Complete when: ${names.join(", ")}` : null;
}

function changedFields(operation: Extract<AgentChatBoardOperation, { op: "update_task" }>): string[] {
  const fields: string[] = [];
  if (operation.text !== undefined) fields.push("text");
  if (operation.run?.provider !== undefined || operation.run?.model !== undefined) fields.push("run on");
  if (operation.run?.effort !== undefined) fields.push("effort");
  if (operation.completeWhen?.checks !== undefined || operation.completeWhen?.own !== undefined) fields.push("complete when");
  if (operation.feature !== undefined) fields.push("feature");
  return fields;
}

export function describeOperation(operation: AgentChatBoardOperation, tasks: readonly BoardTask[]): OperationRow {
  const current = (id: string) => {
    const task = tasks.find((candidate) => candidate.id === id);
    return task ? { value: firstLine(task.text), whole: plainTaskText(task.text), muted: true } : undefined;
  };
  switch (operation.op) {
    case "create_feature":
      return { title: ["Create feature"], text: { value: operation.name, whole: operation.name, muted: false }, details: [] };
    case "create_task": {
      const place = [operation.feature ? `in ${operation.feature}` : null, operation.step !== undefined ? `step ${operation.step}` : null].filter(Boolean).join(" · ");
      const details = [place, runParts(operation.run, true).join(" · "), checkParts(operation.completeWhen), operation.queue === true ? "then add to queue" : null].filter(Boolean) as string[];
      return { title: ["Create task"], text: { value: firstLine(operation.text), whole: plainTaskText(operation.text), muted: false }, details: details.length > 0 ? [details.join(" · ")] : [] };
    }
    case "update_task": {
      const details: string[] = [];
      const fields = changedFields(operation);
      if (fields.length > 0) details.push(`Changes ${fields.join(", ")}`);
      if (operation.text !== undefined) details.push(`New text: ${firstLine(operation.text)}`);
      return { title: ["Update ", { id: operation.id }], text: current(operation.id), details };
    }
    case "delete_task":
      return { title: ["Delete ", { id: operation.id }], text: current(operation.id), details: [], warning: "Cannot be undone" };
    case "move_task":
      return { title: ["Move ", { id: operation.id }, ` to ${operation.column}`], details: operation.position !== undefined ? [`position ${operation.position + 1}`] : [] };
    case "queue_task":
      return { title: ["Add ", { id: operation.id }, " to queue"], details: [] };
    case "unqueue_task":
      return { title: ["Remove ", { id: operation.id }, " from queue"], details: [] };
    case "set_step":
      return { title: ["Move ", { id: operation.id }, ` to step ${operation.step}`], details: [] };
  }
}

export type OperationOutcome = { text: string; tone: "ok" | "error" | "muted" };

const FAILURE_WORDS: Record<Extract<AgentChatOperationResult, { ok: false }>["error"], string> = {
  invalid: "Not valid",
  not_found: "Not found",
  limit: "Board is full",
  conflict: "No longer possible",
  unsupported: "Not supported",
  unavailable: "Pomegr did not answer",
  skipped: "Not run",
};

export function operationOutcome(operation: AgentChatBoardOperation, result: AgentChatOperationResult): OperationOutcome {
  if (result.ok) return { text: operation.op === "create_task" && result.taskId ? `Created ${result.taskId}` : "Done", tone: "ok" };
  if (result.taskId) return { text: `Created ${result.taskId}, but it could not be queued`, tone: "error" };
  return { text: FAILURE_WORDS[result.error] ?? FAILURE_WORDS.unavailable, tone: result.error === "skipped" ? "muted" : "error" };
}

export const PROPOSAL_CHIPS: Record<Exclude<AgentChatProposalState, "pending">, { label: string; tone: "positive" | "warning" | "neutral" }> = {
  applied: { label: "Applied", tone: "positive" },
  partial: { label: "Partly applied", tone: "warning" },
  dismissed: { label: "Dismissed", tone: "neutral" },
};

export const PROPOSAL_PENDING_NOTE = "Nothing changes until you apply.";
export const PROPOSAL_DELETE_NOTE = "Nothing changes until you apply. Deleting cannot be undone.";

export function proposalNote(proposal: AgentChatProposal): string {
  return proposal.operations.some((operation) => operation.op === "delete_task") ? PROPOSAL_DELETE_NOTE : PROPOSAL_PENDING_NOTE;
}
