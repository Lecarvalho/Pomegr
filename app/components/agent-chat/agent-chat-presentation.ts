import {
  AGENT_CHAT_BOUNDS, AGENT_CHAT_CONVERSATION_ID_PATTERN, AGENT_CHAT_MESSAGE_ID_PATTERN,
  type AgentChatActivity, type AgentChatBoardOperation, type AgentChatError, type AgentChatMessage,
  type AgentChatOperationResult, type AgentChatProposal, type AgentChatProposalState, type AgentChatProvider, type AgentChatQueueResult, type AgentChatStartFailure,
  type AgentChatPrepareStep, type AgentChatRouteReason, type AgentChatTiming, type AgentChatTurnStatus,
} from "../../../shared/agent-chat-contract";
import { plainTaskText, type Task, type TaskEffort } from "../../../shared/task-contract";
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

export function errorCopy(error: AgentChatError, context: { provider: AgentChatProvider }): string {
  switch (error) {
    case "busy": return "Aril is already answering. Wait for it to finish.";
    case "cli_missing": return `${PROVIDER_LABELS[context.provider]} is not installed on this computer.`;
    case "not_found": return "That message is no longer there.";
    case "conflict": return "That proposal was already answered.";
    // A thread is never full. Only a named conversation that is full answers `limit`, and the panel never names one.
    case "invalid":
    case "limit": return "That message could not be sent.";
    case "unavailable": return "Aril could not be reached. Try again.";
    case "desktop_only": return "This proposal can be applied only in the Pomegr desktop app.";
  }
}

/** "provider · model", and " · Effort" when an effort is stored. A record without a model reads "default model". */
export function agentCaption(message: { provider: AgentChatProvider; model: string | null; effort?: TaskEffort | null }): string {
  const parts = [PROVIDER_LABELS[message.provider], message.model ?? "default model"];
  if (message.effort) parts.push(EFFORT_LABELS[message.effort]);
  return parts.join(" · ");
}

export function firstLine(text: string): string {
  return plainTaskText(text).split(/\r?\n/u).find((line) => line.trim() !== "")?.trim() ?? "";
}

const COUNT = new Intl.NumberFormat("en-US");
export const formatCount = (value: number) => COUNT.format(value);

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const FULL_TIME = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

const sameLocalDay = (left: Date, right: Date) => left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();

/** The time of a message in the owner's local time: "HH:MM" today, "Mon D, HH:MM" on an earlier day, and null for a value that is no time. */
export function formatMessageTime(at: string, now: Date | number = Date.now()): string | null {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return null;
  const moment = new Date(time);
  return sameLocalDay(moment, new Date(now)) ? CLOCK.format(moment) : DATE.format(moment);
}

/** The whole local date and time of a message, for its tooltip. */
export function fullMessageTime(at: string): string | null {
  const time = Date.parse(at);
  return Number.isFinite(time) ? FULL_TIME.format(time) : null;
}

/** The words of the quiet line where the thread was summarized for Aril. */
export const SUMMARIZED_LINE = "Earlier messages summarized for Aril";

const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(1)}s`;

/**
 * What a measured answer's time shows besides the date: "Started 1.2s · first words 6.8s · done 11.4s", and "Started 0.1s (warm)" when a
 * warm run answered. A step the run never reached is left out. Null when there is no timing. Numbers and fixed words only: no text of the
 * answer or the prompt is ever placed in it.
 */
export function timingLine(timing: AgentChatTiming | undefined | null): string | null {
  if (!timing) return null;
  const steps = [timing.eventMs === null ? null : `Started ${seconds(timing.eventMs)}${timing.warm ? " (warm)" : ""}`, timing.textMs === null ? null : `first words ${seconds(timing.textMs)}`, `done ${seconds(timing.doneMs)}`];
  return steps.filter((step): step is string => step !== null).join(" · ");
}

// The words for the steps of a turn's preparation, chosen by a fixed step. The total is not a step: the line says it first.
const PREPARE_LABELS: Record<Exclude<AgentChatPrepareStep, "total">, string> = {
  board: "board", root: "repository", runs: "runs", taskLog: "task log", github: "GitHub", workflow: "workflow files", worktrees: "worktrees",
  instructions: "instructions", context: "conversation", environment: "environment", store: "saving", declare: "run declaration", server: "task reader",
};
// A step shorter than this is not worth naming as the slow one.
const PREPARE_SLOWEST_MS = 100;

/**
 * What a measured answer's tooltip says about the time before its run started: "Prepared in 3.2s (slowest: GitHub 2.9s)". The slowest
 * step is named only when it took at least a tenth of a second. Null when the answer has no preparation. Numbers and fixed words only.
 */
export function prepareLine(timing: AgentChatTiming | undefined | null): string | null {
  const prepare = timing?.prepare;
  if (!prepare) return null;
  let slowest: { step: keyof typeof PREPARE_LABELS; ms: number } | null = null;
  for (const step of Object.keys(PREPARE_LABELS) as (keyof typeof PREPARE_LABELS)[]) {
    const ms = prepare[step];
    if (ms !== undefined && (slowest === null || ms > slowest.ms)) slowest = { step, ms };
  }
  const named = slowest !== null && slowest.ms >= PREPARE_SLOWEST_MS ? ` (slowest: ${PREPARE_LABELS[slowest.step]} ${seconds(slowest.ms)})` : "";
  return `Prepared in ${seconds(prepare.total)}${named}`;
}

// What the tooltip says when the run kept the owner's effort although a Jev key was set. Chosen by a fixed reason, never by error text.
const ROUTE_KEPT: Record<AgentChatRouteReason, string> = {
  kept: "Jev agreed", timeout: "Jev did not answer in time", error: "Jev was not reachable", invalid: "Jev's answer was not usable", images: "a message with images is not sent to Jev",
};

/**
 * What a measured answer's tooltip says about the effort it ran with when a Jev key was set: "Effort low, chosen by Jev in 0.4s", or "Effort
 * high, your choice (Jev did not answer in time)". Null when there is no routing. Numbers and fixed words only.
 */
export function routeLine(timing: AgentChatTiming | undefined | null): string | null {
  const route = timing?.route;
  if (!route) return null;
  if (route.by === "jev") return `Effort ${route.effort}, chosen by Jev in ${seconds(route.ms)}`;
  const time = route.ms === undefined ? "" : ` in ${seconds(route.ms)}`;
  return `Effort ${route.effort ?? "default"}, your choice (${ROUTE_KEPT[route.reason]}${route.reason === "kept" ? time : ""})`;
}

/** The tooltip of an answer's time: the whole local date and time, and under it what the answer's timing says: its effort routing, its preparation, then its run. */
export function answerTimeTitle(at: string, timing?: AgentChatTiming | null): string | null {
  const full = fullMessageTime(at);
  return full === null ? null : [full, routeLine(timing), prepareLine(timing), timingLine(timing)].filter((line): line is string => line !== null).join("\n");
}

/** Whether the pending message of the owner is already the last stored message, so it is not drawn twice. */
export function pendingIsStored(messages: readonly AgentChatMessage[], pending: string | null): boolean {
  const last = messages.at(-1);
  return pending !== null && last?.role === "user" && last.text === pending.trim();
}

// ---- Search ----

export const SEARCH_LABEL = "Search messages";
export const SEARCH_PLACEHOLDER = "Search messages…";
export const SEARCH_HINT = "Search the messages of this repository.";
export const SEARCH_NONE = "No messages match.";
export const SEARCH_FAILED = "Search could not be reached. Try again.";
export const SEARCH_ROLE_LABELS: Record<AgentChatMessage["role"], string> = { user: "You", agent: "Aril" };

// Lower case without changing a length, as the desktop folds the text it searches, so an index in one is an index in the other.
const foldCase = (value: string) => value.replace(/[\s\S]/gu, (character) => { const lower = character.toLowerCase(); return lower.length === character.length ? lower : character; });

/** An excerpt split around the first place the query occurs in it, whatever its case, or null when it does not occur. */
export function splitMatch(snippet: string, query: string): { before: string; match: string; after: string } | null {
  const needle = foldCase(query.trim());
  const index = needle === "" ? -1 : foldCase(snippet).indexOf(needle);
  return index < 0 ? null : { before: snippet.slice(0, index), match: snippet.slice(index, index + needle.length), after: snippet.slice(index + needle.length) };
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

// A grant follow-up's link: the Tasks page of its repository, with the conversation and message to open in the chat.
export type AgentChatLink = { repositoryId: string; conversationId: string | null; messageId: string | null };
export const AGENT_CHAT_OPEN_EVENT = "pomegr:open-aril-chat";

export function agentChatLink(pathname: string, search: string): AgentChatLink | null {
  if (pathname !== "/tasks") return null;
  const params = new URLSearchParams(search);
  const repositoryId = repositoryRouteId(params.get("repository"));
  const aril = params.get("aril");
  const message = params.get("message");
  if (!repositoryId || aril === null) return null;
  if (aril === "open") return message === null ? { repositoryId, conversationId: null, messageId: null } : null;
  return AGENT_CHAT_CONVERSATION_ID_PATTERN.test(aril) && message !== null && AGENT_CHAT_MESSAGE_ID_PATTERN.test(message) ? { repositoryId, conversationId: aril, messageId: message } : null;
}

/** Opens the chat at a follow-up from inside the app, as the follow-up's link does when the page loads. */
export function openAgentChatLink(href: string): void {
  try {
    const url = new URL(href, window.location.origin);
    const link = agentChatLink(url.pathname, url.search);
    if (link) window.dispatchEvent(new CustomEvent<AgentChatLink>(AGENT_CHAT_OPEN_EVENT, { detail: link }));
  } catch { /* A link outside the contract opens nothing. */ }
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
  /** The images the operation puts on its task, drawn under the details. */
  images?: string[];
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

// "T-4", "T-4 and T-5", or "T-4, T-5, and T-9", as title parts.
function idList(ids: readonly string[]): Array<string | { id: string }> {
  return ids.flatMap((id, index) => {
    const part = { id };
    if (index === 0) return [part];
    if (ids.length === 2) return [" and ", part];
    return [index === ids.length - 1 ? ", and " : ", ", part];
  });
}
const imageCount = (count: number) => (count === 1 ? "1 image" : `${count} images`);

export function describeOperation(operation: AgentChatBoardOperation, tasks: readonly BoardTask[]): OperationRow {
  const current = (id: string) => {
    const task = tasks.find((candidate) => candidate.id === id);
    return task ? { value: firstLine(task.text), whole: plainTaskText(task.text), muted: true } : undefined;
  };
  switch (operation.op) {
    case "create_feature":
      return { title: ["Create feature"], text: { value: operation.name, whole: operation.name, muted: false }, details: [] };
    case "update_feature": {
      const details = [operation.name !== undefined ? `New title: ${operation.name}` : null, operation.done === true ? "Mark done" : operation.done === false ? "Reopen" : null].filter(Boolean) as string[];
      return { title: ["Update feature"], text: { value: operation.feature, whole: operation.feature, muted: true }, details };
    }
    case "delete_feature":
      return { title: ["Delete feature"], text: { value: operation.feature, whole: operation.feature, muted: true }, details: [], warning: "Cannot be undone" };
    case "create_task": {
      const place = operation.feature ? `in ${operation.feature}` : "";
      const details = [place, operation.position !== undefined ? `position ${operation.position + 1}` : null, runParts(operation.run, true).join(" · "), checkParts(operation.completeWhen), operation.images ? `with ${imageCount(operation.images.length)}` : null, operation.queue === true ? "then add to queue" : null].filter(Boolean) as string[];
      // Where the new card lands, when the proposal places it: below a task, or in a column.
      const title: OperationTitlePart[] = operation.placeAfter ? ["Create task below ", { id: operation.placeAfter }] : [operation.column ? `Create task in ${operation.column}` : "Create task"];
      return { title, text: { value: firstLine(operation.text), whole: plainTaskText(operation.text), muted: false }, details: details.length > 0 ? [details.join(" · ")] : [], ...(operation.images ? { images: operation.images } : {}) };
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
    case "group_tasks":
      return { title: ["Run ", ...idList(operation.ids), " in parallel"], details: [] };
    case "ungroup_tasks":
      return { title: ["Take ", ...idList(operation.ids), operation.ids.length === 1 ? " out of its parallel group" : " out of their parallel groups"], details: [] };
    case "set_after":
      return operation.after.length === 0
        ? { title: [{ id: operation.id }, " no longer runs after another task"], text: current(operation.id), details: [] }
        : { title: [{ id: operation.id }, " runs after ", ...idList(operation.after)], text: current(operation.id), details: ["It starts only when every one of them is Done or deleted."] };
    case "attach_images":
      return { title: [`Attach ${imageCount(operation.images.length)} to `, { id: operation.id }], text: current(operation.id), details: [], images: operation.images };
    case "start_session":
      return { title: ["Start a session for ", { id: operation.id }], text: current(operation.id), details: [] };
    case "remove_worktree":
      return { title: ["Remove worktree for ", { id: operation.id }], details: [operation.branch ? "Also delete its task branch when safe." : "Keep its task branch."] };
    case "set_queue":
      return { title: [operation.on ? "Turn the queue on" : "Turn the queue off"], details: [] };
    case "set_aril_settings":
      return { title: ["Set Aril settings"], details: Object.entries(operation.settings).map(([key, value]) => `${key}: ${JSON.stringify(value)}`) };
    case "add_memory":
      return { title: ["Add Aril memory"], details: [operation.text] };
    case "update_memory":
      return { title: [`Update Aril memory ${operation.id}`], details: [operation.text] };
    case "remove_memory":
      return { title: [`Remove Aril memory ${operation.id}`], details: [] };
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
  not_started: "Not started",
  dirty: "Worktree kept: uncommitted changes",
  unique_commits: "Worktree kept: commits exist nowhere else",
  in_use: "Worktree kept: task or review is running",
  failed: "Worktree removal failed",
};

// An image that was not put on a task that is already on the board. The task keeps what it had.
const IMAGE_FAILURE_LINES: Partial<Record<keyof typeof FAILURE_WORDS, string>> = {
  limit: `Not attached. A task holds at most ${AGENT_CHAT_BOUNDS.imagesPerMessage} images.`,
  conflict: "Not attached. This task has started, so it takes no image.",
  not_found: "Not attached. The image is no longer on this computer.",
  invalid: "Not attached. The image could not be read.",
  unavailable: "Not attached. Pomegr did not answer.",
};
const IMAGE_NOT_ATTACHED = "Not attached.";

export const START_LAUNCHED = "Session started in a new terminal window.";

// A start that launched nothing. The words are in the past: they tell what the attempt met, not what holds now.
const START_FAILURE_LINES: Record<AgentChatStartFailure, string> = {
  unsupported_platform: "Not started. Starting sessions is available on Windows only.",
  cli_missing: "Not started. The provider's command-line tool was not found on this computer.",
  plugin_missing: "Not started. Install or update the Pomegr plugin in this repository to start sessions.",
  not_startable: "Not started. This task could not be started: it has a session, an outcome, or a start already under way.",
  gate_held: "Not started. A start gate held this task.",
  unsupported_provider: "Not started. Sessions cannot be started on this provider.",
  not_found: "Not started. This task no longer exists.",
  busy: "Not started. Another session was being started.",
  invalid: "Not started. The session could not be started.",
  unavailable: "Not started. The session could not be started.",
  failed: "Not started. The session could not be started.",
  worktree_dirty: "Not started. This task's worktree had uncommitted changes, and Pomegr never removes them.",
  tree_dirty: "Not started. This repository had uncommitted changes. Commit or discard them, or open the task to start it in a separate worktree.",
  environment_invalid: "Not started. The Windows environment was too large for a session, or had a variable name a session cannot take.",
};

/** The task a proposal asks to start a session for, or null for a proposal of board changes. */
export function startProposalTask(proposal: Pick<AgentChatProposal, "operations">): string | null {
  const [first] = proposal.operations;
  return proposal.operations.length === 1 && first.op === "start_session" ? first.id : null;
}

/** Whether a proposal only asks to remove task worktrees: it is applied in the desktop window alone. */
export function worktreeProposal(proposal: Pick<AgentChatProposal, "operations">): boolean {
  return proposal.operations.length > 0 && proposal.operations.every((operation) => operation.op === "remove_worktree");
}

/** Whether a proposal edits a feature already on the board: only the desktop window edits features, so it is applied there alone. */
export function featureEditProposal(proposal: Pick<AgentChatProposal, "operations">): boolean {
  return proposal.operations.some((operation) => operation.op === "update_feature" || operation.op === "delete_feature");
}

/** The queue state a proposal asks for (`true` is on), or null when it is not a queue proposal. */
export function queueProposalState(proposal: Pick<AgentChatProposal, "operations">): boolean | null {
  const [first] = proposal.operations;
  return proposal.operations.length === 1 && first.op === "set_queue" ? first.on : null;
}

// What an accepted queue change left. A held queue is on and starts nothing, so it is not drawn as a success.
const QUEUE_RESULT_LINES: Record<AgentChatQueueResult, OperationOutcome> = {
  on: { text: "Queue turned on.", tone: "ok" },
  blocked: { text: "Queue turned on. A stalled or blocked task holds it, so nothing starts until you resolve that task.", tone: "muted" },
  off: { text: "Queue turned off.", tone: "ok" },
};
export const QUEUE_REFUSED = "Queue not changed. Pomegr refused this change.";
export const QUEUE_UNANSWERED = "Queue not changed. Pomegr did not answer. Try again.";

export function operationOutcome(operation: AgentChatBoardOperation, result: AgentChatOperationResult): OperationOutcome {
  if ("worktree" in result) return { text: result.ok ? "Worktree removed" : FAILURE_WORDS[result.error], tone: result.ok ? "ok" : "error" };
  if ("queue" in result) return QUEUE_RESULT_LINES[result.queue] ?? QUEUE_RESULT_LINES.on;
  if (operation.op === "set_queue" && !result.ok) return { text: result.error === "unavailable" ? QUEUE_UNANSWERED : QUEUE_REFUSED, tone: "error" };
  if ("start" in result) return result.ok ? { text: START_LAUNCHED, tone: "ok" } : { text: START_FAILURE_LINES[result.start] ?? START_FAILURE_LINES.failed, tone: "error" };
  if (result.ok) return { text: operation.op === "create_task" && result.taskId ? `Created ${result.taskId}` : "Done", tone: "ok" };
  if (result.part === "images") return { text: result.taskId ? `Created ${result.taskId}, but its images could not be attached` : IMAGE_FAILURE_LINES[result.error] ?? IMAGE_NOT_ATTACHED, tone: "error" };
  if (result.taskId) return { text: `Created ${result.taskId}, but it could not be ${result.part === "placement" ? "placed" : "queued"}`, tone: "error" };
  return { text: FAILURE_WORDS[result.error] ?? FAILURE_WORDS.unavailable, tone: result.error === "skipped" ? "muted" : "error" };
}

export const PROPOSAL_CHIPS: Record<Exclude<AgentChatProposalState, "pending">, { label: string; tone: "positive" | "warning" | "neutral" }> = {
  applied: { label: "Applied", tone: "positive" },
  partial: { label: "Partly applied", tone: "warning" },
  dismissed: { label: "Dismissed", tone: "neutral" },
};

export const START_CHIP = { label: "Session started", tone: "positive" } as const;

export function proposalChip(proposal: AgentChatProposal): { label: string; tone: "positive" | "warning" | "neutral" } | null {
  if (proposal.state === "pending") return null;
  return proposal.state === "applied" && startProposalTask(proposal) !== null ? START_CHIP : PROPOSAL_CHIPS[proposal.state];
}

export const PROPOSAL_PENDING_NOTE = "Nothing changes until you apply.";
export const PROPOSAL_DELETE_NOTE = "Nothing changes until you apply. Deleting cannot be undone.";
export const START_PENDING_NOTE = "Nothing starts until you select Start session and confirm in the desktop dialog. Pomegr then checks the start gates and opens a terminal on this computer.";
export const START_ELSEWHERE_NOTE = "Aril's start can be applied only in the Pomegr desktop app. To start from this device, open the task and select Start session.";

export const WORKTREE_PENDING_NOTE = "Nothing is removed until you apply. Pomegr keeps any worktree with uncommitted changes or commits that exist nowhere else.";
export const WORKTREE_ELSEWHERE_NOTE = "Aril's worktree removal can be applied only in the Pomegr desktop app.";
export const FEATURE_ELSEWHERE_NOTE = "This proposal changes a feature, so it can be applied only in the Pomegr desktop app.";

export const QUEUE_ON_NOTE = "Nothing changes until you select Turn queue on. Pomegr may then start queued tasks by itself on the computer that runs Pomegr, in Ready order, as each passes the start gates.";
export const QUEUE_OFF_NOTE = "Nothing changes until you select Turn queue off. No new task starts then, and running sessions continue.";

/** The words of the card's region, by what the proposal asks for. */
export function proposalLabel(proposal: AgentChatProposal): string {
  if (startProposalTask(proposal) !== null) return "Proposed session start";
  if (worktreeProposal(proposal)) return "Proposed worktree removal";
  return queueProposalState(proposal) !== null ? "Proposed queue change" : "Proposed board changes";
}

/** The card's one Primary, or null where the proposal cannot be applied: a session start, a worktree removal, or a feature edit outside the desktop window. */
export function proposalPrimary(proposal: AgentChatProposal, startHere = false): string | null {
  if (startProposalTask(proposal) !== null) return startHere ? "Start session" : null;
  if (worktreeProposal(proposal)) return startHere ? (proposal.operations.length === 1 ? "Remove worktree" : "Remove worktrees") : null;
  if (featureEditProposal(proposal) && !startHere) return null;
  const queueOn = queueProposalState(proposal);
  return queueOn === null ? "Apply changes" : queueOn ? "Turn queue on" : "Turn queue off";
}

/** `startHere` is true in the desktop window, the one place where a start, a worktree removal, or a feature edit can be applied. */
export function proposalNote(proposal: AgentChatProposal, startHere = false): string {
  if (startProposalTask(proposal) !== null) return startHere ? START_PENDING_NOTE : START_ELSEWHERE_NOTE;
  if (worktreeProposal(proposal)) return startHere ? WORKTREE_PENDING_NOTE : WORKTREE_ELSEWHERE_NOTE;
  if (featureEditProposal(proposal) && !startHere) return FEATURE_ELSEWHERE_NOTE;
  const queueOn = queueProposalState(proposal);
  if (queueOn !== null) return queueOn ? QUEUE_ON_NOTE : QUEUE_OFF_NOTE;
  return proposal.operations.some((operation) => operation.op === "delete_task" || operation.op === "delete_feature") ? PROPOSAL_DELETE_NOTE : PROPOSAL_PENDING_NOTE;
}
