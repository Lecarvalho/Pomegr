// The Pomegr agent chat: a conversation with Aril, the task-board agent, held by the desktop app.
// The executable rules live in `desktop/runtime/agent-chat*.mjs`; this file is the browser-visible shape.

import type { ArilSettings, TaskCheck, TaskEffort, TaskImageType, TaskProvider } from "./task-contract";

export const AGENT_CHAT_AGENT_NAME = "Aril";

export type AgentChatProvider = TaskProvider;

// One image the owner sent to the agent: an opaque ID, its fixed type, and its size in bytes. Never the bytes or a path.
export type AgentChatImage = { id: string; type: TaskImageType; bytes: number };

// The fixed image operations, on a channel of their own: `add` keeps an image for a message that is not sent yet,
// and `read` answers the bytes of an image that a message of a conversation names.
export type AgentChatImageOperationName = "add" | "read";
export const AGENT_CHAT_IMAGE_OPERATIONS: readonly AgentChatImageOperationName[] = ["add", "read"];
export type AgentChatImageError = "invalid" | "not_found" | "unavailable";

// The fixed operations a client may ask for.
export type AgentChatOperationName = "list" | "read" | "send" | "stop" | "apply" | "dismiss" | "delete";
export const AGENT_CHAT_OPERATIONS: readonly AgentChatOperationName[] = ["list", "read", "send", "stop", "apply", "dismiss", "delete"];

// Why an operation was refused.
// `desktop_only` refuses a non-desktop session start or worktree removal, or a paired settings/memory Apply without pairedDevices enabled.
export type AgentChatError = "invalid" | "not_found" | "busy" | "limit" | "cli_missing" | "conflict" | "unavailable" | "desktop_only";
export const AGENT_CHAT_ERRORS: readonly AgentChatError[] = ["invalid", "not_found", "busy", "limit", "cli_missing", "conflict", "unavailable", "desktop_only"];

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
// `start_session` is no board change: it asks the desktop to start a session for that task, and it is the only
// operation of its proposal. `set_queue` asks for the repository's queue to be on or off, as a state and never a toggle,
// and it is the only operation of its proposal too. `images` names images the owner sent in the same conversation:
// on `create_task` they go on the new task, and `attach_images` puts them on a task that has not started.
// A `create_task` may place the new card: in `column` at `position` (last without one), or right after the task
// `placeAfter` names, in that task's column. Without either it lands at the end of Backlog. A placement never queues.
export type AgentChatBoardOperation =
  | { op: "create_feature"; name: string }
  | { op: "create_task"; text: string; feature?: string; run?: Partial<AgentChatRun>; completeWhen?: Partial<AgentChatCompleteWhen>; queue?: boolean; images?: string[]; column?: AgentChatColumn; position?: number; placeAfter?: string; after?: string[] }
  | { op: "update_task"; id: string; text?: string; feature?: string | null; run?: Partial<AgentChatRun>; completeWhen?: Partial<AgentChatCompleteWhen> }
  | { op: "delete_task"; id: string }
  | { op: "move_task"; id: string; column: AgentChatColumn; position?: number }
  | { op: "queue_task"; id: string }
  | { op: "unqueue_task"; id: string }
  | { op: "group_tasks"; ids: string[] }
  | { op: "ungroup_tasks"; ids: string[] }
  | { op: "set_after"; id: string; after: string[] }
  | { op: "attach_images"; id: string; images: string[] }
  | { op: "start_session"; id: string }
  | { op: "remove_worktree"; id: string; branch: boolean }
  | { op: "set_queue"; on: boolean }
  | { op: "set_aril_settings"; settings: Partial<Omit<ArilSettings, "pairedDevices">> }
  | { op: "add_memory"; text: string }
  | { op: "update_memory"; id: number; text: string }
  | { op: "remove_memory"; id: number };

export type AgentChatBoardOperationName = AgentChatBoardOperation["op"];
export const AGENT_CHAT_BOARD_OPERATIONS: readonly AgentChatBoardOperationName[] = [
  "create_feature", "create_task", "update_task", "delete_task", "move_task", "queue_task", "unqueue_task", "group_tasks", "ungroup_tasks", "set_after", "attach_images", "start_session", "set_queue", "set_aril_settings", "add_memory", "update_memory", "remove_memory", "remove_worktree",
];

// What an approved queue change left: on, on and held by a stalled or blocked task, or off.
export type AgentChatQueueResult = "on" | "blocked" | "off";
export const AGENT_CHAT_QUEUE_RESULTS: readonly AgentChatQueueResult[] = ["on", "blocked", "off"];

// Why an approved session start launched nothing: the fixed statuses of a manual start, without `started` and `cancelled`.
export type AgentChatStartFailure = "unsupported_platform" | "cli_missing" | "plugin_missing" | "not_startable" | "gate_held" | "unsupported_provider"
  | "not_found" | "busy" | "invalid" | "unavailable" | "failed" | "worktree_dirty" | "tree_dirty";
export const AGENT_CHAT_START_FAILURES: readonly AgentChatStartFailure[] = [
  "unsupported_platform", "cli_missing", "plugin_missing", "not_startable", "gate_held", "unsupported_provider", "not_found", "busy",
  "invalid", "unavailable", "failed", "worktree_dirty", "tree_dirty",
];

// What became of one approved worktree removal: removed, or the fixed reason the worktree is still on disk.
export type AgentChatWorktreeResult = "removed" | "not_found" | "dirty" | "unique_commits" | "in_use" | "failed";
export const AGENT_CHAT_WORKTREE_RESULTS: readonly AgentChatWorktreeResult[] = ["removed", "not_found", "dirty", "unique_commits", "in_use", "failed"];

// The outcome of one approved operation. `skipped` is an operation after the first one that failed. A failure with a
// task ID is a task that was created and then could not be placed (`part: "placement"`) or queued. A result with `start` is the outcome of a session
// start: the launch, or `not_started` with the status that held or failed it. A result with `worktree` is a worktree removal. A result with `queue` is a queue change
// the monitor accepted; one it refused is an ordinary failure. A failure with `part: "images"` stopped at an image:
// the task is there, created or not, and an image was not put on it.
export type AgentChatActionFailure = "invalid" | "not_found" | "limit" | "conflict" | "unsupported" | "unavailable" | "skipped";
export type AgentChatOperationResult =
  | { ok: true; worktree: "removed" }
  | { ok: false; worktree: Exclude<AgentChatWorktreeResult, "removed">; error: Exclude<AgentChatWorktreeResult, "removed"> }
  | { ok: true; queue: AgentChatQueueResult }
  | { ok: true; taskId?: string }
  | { ok: false; error: AgentChatActionFailure; taskId?: string; part?: "images" | "placement" }
  | { ok: true; start: "started" }
  | { ok: false; error: "not_started"; start: AgentChatStartFailure };

// `pending` waits for the owner; `applied` ran whole; `partial` stopped at a failed operation; `dismissed` never ran.
// A session start is `applied` only when the session launched. One that was held or failed stays `pending` with its
// result, so the owner may apply it again. A queue change is the same: `applied` only when the monitor accepted it.
export type AgentChatProposalState = "pending" | "applied" | "partial" | "dismissed";
export const AGENT_CHAT_PROPOSAL_STATES: readonly AgentChatProposalState[] = ["pending", "applied", "partial", "dismissed"];

export type AgentChatProposal = {
  id: string; // "p-<12 hex>"
  summary: string;
  operations: AgentChatBoardOperation[];
  state: AgentChatProposalState;
  appliedBy?: "grant";
  results?: AgentChatOperationResult[]; // one per operation, once the proposal ran or its start was tried
};

export type AgentChatUserMessage = { id: string; role: "user"; text: string; at: string; images?: AgentChatImage[] };
export type AgentChatAgentMessage = {
  id: string;
  role: "agent";
  text: string;
  at: string;
  provider: AgentChatProvider;
  model: string | null;
  status: AgentChatTurnStatus;
  proposal?: AgentChatProposal;
  // The agent wrote a proposal the desktop could not read or permit in this follow-up, so nothing is offered.
  proposalUnreadable?: boolean;
  // The ID of the proposal this answer follows up: the desktop asked for it after the owner applied or dismissed that
  // proposal, with no message of the owner before it. After an applied or partial outcome it may carry
  // another board proposal that waits for the owner; never start_session, set_queue, settings, or memory operations.
  followUp?: string;
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
export type AgentChatImageAddResult = { ok: true; image: AgentChatImage } | { ok: false; error: AgentChatImageError };

export const AGENT_CHAT_BOUNDS = {
  conversationsPerRepository: 50,
  messagesPerConversation: 200,
  messageLength: 4000,
  answerLength: 32_000,
  titleLength: 80,
  summaryLength: 300,
  operationsPerProposal: 40,
  // The images of one message, of one conversation, and the size of one image in bytes.
  imagesPerMessage: 4,
  imagesPerConversation: 40,
  imageBytes: 5 * 1024 * 1024,
  // A request a paired device sends, in bytes.
  requestBytes: 17 * 1024,
} as const;

export const AGENT_CHAT_CONVERSATION_ID_PATTERN = /^chat-[0-9a-f]{12}$/u;
export const AGENT_CHAT_PROPOSAL_ID_PATTERN = /^p-[0-9a-f]{12}$/u;
export const AGENT_CHAT_IMAGE_ID_PATTERN = /^img-[0-9a-f]{12}$/u;
