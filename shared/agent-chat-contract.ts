// The Pomegr agent chat: a conversation with Aril, the task-board agent, held by the desktop app.
// The executable rules live in `desktop/runtime/agent-chat*.mjs`; this file is the browser-visible shape.

import type { TaskCheck, TaskEffort, TaskProvider } from "./task-contract";

export const AGENT_CHAT_AGENT_NAME = "Aril";

export type AgentChatProvider = TaskProvider;

// The fixed operations a client may ask for.
export type AgentChatOperationName = "list" | "read" | "send" | "stop" | "apply" | "dismiss" | "delete";
export const AGENT_CHAT_OPERATIONS: readonly AgentChatOperationName[] = ["list", "read", "send", "stop", "apply", "dismiss", "delete"];

// Why an operation was refused.
export type AgentChatError = "invalid" | "not_found" | "busy" | "limit" | "cli_missing" | "conflict" | "unavailable";
export const AGENT_CHAT_ERRORS: readonly AgentChatError[] = ["invalid", "not_found", "busy", "limit", "cli_missing", "conflict", "unavailable"];

// How an agent turn ended. `complete` is the only one with a full answer.
export type AgentChatTurnStatus = "complete" | "stopped" | "failed" | "timed_out" | "interrupted";
export const AGENT_CHAT_TURN_STATUSES: readonly AgentChatTurnStatus[] = ["complete", "stopped", "failed", "timed_out", "interrupted"];

// What the agent is doing right now, as one fixed label; never tool input or output.
export type AgentChatActivity = "starting" | "thinking" | "reading_files" | "reading_sessions" | "reading_usage" | "writing";
export const AGENT_CHAT_ACTIVITIES: readonly AgentChatActivity[] = ["starting", "thinking", "reading_files", "reading_sessions", "reading_usage", "writing"];

export type AgentChatRun = { provider: TaskProvider | null; model: string | null; effort: TaskEffort | null };
export type AgentChatCompleteWhen = { checks: TaskCheck[]; own: string | null };

export type AgentChatColumn = "Backlog" | "Ready" | "In progress" | "Review" | "Done";
export const AGENT_CHAT_COLUMNS: readonly AgentChatColumn[] = ["Backlog", "Ready", "In progress", "Review", "Done"];

// One board change the agent proposes. A feature is named by its title; the desktop resolves it when the owner approves.
// `run` and `completeWhen` hold only the parts the proposal sets: on an update the rest stays as stored.
export type AgentChatBoardOperation =
  | { op: "create_feature"; name: string }
  | { op: "create_task"; text: string; feature?: string; step?: number; run?: Partial<AgentChatRun>; completeWhen?: Partial<AgentChatCompleteWhen>; queue?: boolean }
  | { op: "update_task"; id: string; text?: string; feature?: string | null; run?: Partial<AgentChatRun>; completeWhen?: Partial<AgentChatCompleteWhen> }
  | { op: "delete_task"; id: string }
  | { op: "move_task"; id: string; column: AgentChatColumn; position?: number }
  | { op: "queue_task"; id: string }
  | { op: "unqueue_task"; id: string }
  | { op: "set_step"; id: string; step: number };

export type AgentChatBoardOperationName = AgentChatBoardOperation["op"];
export const AGENT_CHAT_BOARD_OPERATIONS: readonly AgentChatBoardOperationName[] = [
  "create_feature", "create_task", "update_task", "delete_task", "move_task", "queue_task", "unqueue_task", "set_step",
];

// The outcome of one approved operation. `skipped` is an operation after the first one that failed. A failure with a
// task ID is a task that was created and then could not be queued.
export type AgentChatOperationResult =
  | { ok: true; taskId?: string }
  | { ok: false; error: "invalid" | "not_found" | "limit" | "conflict" | "unsupported" | "unavailable" | "skipped"; taskId?: string };

// `pending` waits for the owner; `applied` ran whole; `partial` stopped at a failed operation; `dismissed` never ran.
export type AgentChatProposalState = "pending" | "applied" | "partial" | "dismissed";
export const AGENT_CHAT_PROPOSAL_STATES: readonly AgentChatProposalState[] = ["pending", "applied", "partial", "dismissed"];

export type AgentChatProposal = {
  id: string; // "p-<12 hex>"
  summary: string;
  operations: AgentChatBoardOperation[];
  state: AgentChatProposalState;
  results?: AgentChatOperationResult[]; // one per operation, once the proposal ran
};

export type AgentChatUserMessage = { id: string; role: "user"; text: string; at: string };
export type AgentChatAgentMessage = {
  id: string;
  role: "agent";
  text: string;
  at: string;
  provider: AgentChatProvider;
  model: string | null;
  status: AgentChatTurnStatus;
  proposal?: AgentChatProposal;
  // The agent wrote a proposal the desktop could not read, so nothing is offered.
  proposalUnreadable?: boolean;
};
export type AgentChatMessage = AgentChatUserMessage | AgentChatAgentMessage;

export type AgentChatConversationSummary = { id: string; title: string; updatedAt: string; messages: number };

export type AgentChatConversation = {
  id: string; // "chat-<12 hex>"
  title: string;
  provider: AgentChatProvider;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  messages: AgentChatMessage[];
};

// The answer being written, while a turn runs.
export type AgentChatTurn = { conversationId: string; startedAt: string; provider: AgentChatProvider; model: string | null; activity: AgentChatActivity; text: string };

export type AgentChatFailure = { ok: false; error: AgentChatError };
export type AgentChatListResult = { ok: true; conversations: AgentChatConversationSummary[]; running: string | null } | AgentChatFailure;
export type AgentChatReadResult = { ok: true; conversation: AgentChatConversation; turn: AgentChatTurn | null } | AgentChatFailure;
export type AgentChatSendResult = { ok: true; conversationId: string } | AgentChatFailure;
export type AgentChatDoneResult = { ok: true } | AgentChatFailure;

export const AGENT_CHAT_BOUNDS = {
  conversationsPerRepository: 50,
  messagesPerConversation: 200,
  messageLength: 4000,
  answerLength: 32_000,
  titleLength: 80,
  summaryLength: 300,
  operationsPerProposal: 40,
  // A request a paired device sends, in bytes.
  requestBytes: 17 * 1024,
} as const;

export const AGENT_CHAT_CONVERSATION_ID_PATTERN = /^chat-[0-9a-f]{12}$/u;
export const AGENT_CHAT_PROPOSAL_ID_PATTERN = /^p-[0-9a-f]{12}$/u;
