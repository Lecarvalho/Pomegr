import { act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { Task, TaskBoard } from "../../shared/task-contract";

// A fake of the desktop's chat: the same operations and answers as `desktop/runtime/agent-chat.mjs`, kept in memory.

export const REPO_A = `repo-${"a".repeat(24)}`;
export const REPO_B = `repo-${"b".repeat(24)}`;
export const chatId = (number: number) => `chat-${String(number).padStart(12, "0")}`;
export const PROPOSAL_ID = "p-0123456789ab";
export const AT = "2026-10-11T10:00:00.000Z";

type Json = Record<string, unknown>;
type StoredConversation = { id: string; title: string; provider: "claude" | "codex"; model: string | null; createdAt: string; updatedAt: string; messages: Json[] };
type Turn = { repositoryId: string; conversationId: string; startedAt: string; provider: string; model: string | null; activity: string; text: string };

export const userMessage = (text: string, id = "m-1"): Json => ({ id, role: "user", text, at: AT });
export const agentMessage = (text: string, overrides: Json = {}, id = "m-2"): Json => ({ id, role: "agent", text, at: AT, provider: "claude", model: null, status: "complete", ...overrides });

export function conversationOf(number: number, messages: Json[], overrides: Partial<StoredConversation> = {}): StoredConversation {
  return { id: chatId(number), title: `Conversation ${number}`, provider: "claude", model: null, createdAt: AT, updatedAt: `2026-10-11T10:0${number}:00.000Z`, messages, ...overrides };
}

/** The eight board operations, in the order the panel draws them. */
export const EIGHT_OPERATIONS: Json[] = [
  { op: "create_feature", name: "Upload reliability" },
  { op: "create_task", text: "Add retry with backoff to the upload client\nCover the 5xx and timeout cases.", feature: "Upload reliability", run: { provider: "claude", model: "model-large", effort: "high" }, completeWhen: { checks: ["pr_open", "ci_passed"], own: null }, queue: true },
  { op: "update_task", id: "T-12", text: "Show the retry count in the upload log", run: { effort: "high" }, feature: "Upload reliability" },
  { op: "delete_task", id: "T-14" },
  { op: "move_task", id: "T-15", column: "Review", position: 0 },
  { op: "queue_task", id: "T-16" },
  { op: "unqueue_task", id: "T-17" },
  { op: "group_tasks", ids: ["T-18", "T-19", "T-20"] },
];

export const proposalOf = (operations: Json[] = EIGHT_OPERATIONS, state = "pending", extra: Json = {}): Json => ({ id: PROPOSAL_ID, summary: "Cut the upload work into tasks.", operations, state, ...extra });

export class FakeChat {
  private readonly byRepository = new Map<string, Map<string, StoredConversation>>();
  private counter = 100;
  private minutes = 0;
  turn: Turn | null = null;
  /** The next `send` answers this refusal. */
  refuse: string | null = null;
  /** What the desktop's manual start answers to an applied start proposal. */
  startStatus = "started";
  /** What the monitor answers to an applied queue proposal: the status the queue then has, or a fixed error. */
  queueAnswer: { status: string } | { error: string } = { status: "running" };
  /** The next `send` answers only when this resolves. */
  hold: Promise<void> | null = null;
  /** True makes an answered proposal start Aril's follow-up, as the desktop does: a turn with no message of the owner. */
  followUps = false;
  readonly agentChat = vi.fn((operation: string, payload: Json) => this.handle(operation, payload));
  /** The bytes of each image the desktop holds, by ID. */
  readonly images = new Map<string, { type: string; bytes: Uint8Array }>();
  private imageCounter = 0;
  /** The next `add` answers this refusal. */
  refuseImage: "invalid" | "not_found" | "unavailable" | null = null;
  /** The next `add` answers only when this resolves. */
  holdImage: Promise<void> | null = null;
  readonly agentChatImage = vi.fn((operation: string, payload: Json) => this.handleImage(operation, payload));

  /** Keeps bytes under an ID without an `add`, as if an earlier message had sent them. */
  storeImage(id: string, bytes: Uint8Array, type = "png") {
    this.images.set(id, { type, bytes });
    return { id, type, bytes: bytes.byteLength };
  }

  private async handleImage(operation: string, payload: Json): Promise<Json> {
    if (operation === "add") {
      if (this.holdImage) await this.holdImage;
      if (this.refuseImage) return { ok: false, error: this.refuseImage };
      const bytes = payload.bytes as Uint8Array;
      this.imageCounter += 1;
      const id = `img-${this.imageCounter.toString(16).padStart(12, "0")}`;
      const type = bytes[0] === 0xff ? "jpeg" : bytes[0] === 0x47 ? "gif" : "png";
      return { ok: true, image: this.storeImage(id, bytes, type) };
    }
    if (operation === "read") {
      const stored = this.images.get(String(payload.imageId));
      const conversation = this.conversation(String(payload.repositoryId), String(payload.conversationId));
      const named = conversation?.messages.some((message) => message.role === "user" && ((message.images as Json[] | undefined) ?? []).some((image) => image.id === payload.imageId));
      return stored && named ? { ok: true, type: stored.type, bytes: stored.bytes } : { ok: false, error: "not_found" };
    }
    return { ok: false, error: "invalid" };
  }

  seed(repositoryId: string, ...conversations: StoredConversation[]) {
    const map = this.byRepository.get(repositoryId) ?? new Map<string, StoredConversation>();
    for (const conversation of conversations) map.set(conversation.id, structuredClone(conversation));
    this.byRepository.set(repositoryId, map);
  }

  conversation(repositoryId: string, id: string): StoredConversation | undefined {
    return this.byRepository.get(repositoryId)?.get(id);
  }

  calls(operation: string) {
    return this.agentChat.mock.calls.filter(([name]) => name === operation).map(([, payload]) => payload);
  }

  /** Writes the answer being written and ends nothing. */
  write(text: string, activity = "writing") {
    if (this.turn) Object.assign(this.turn, { text, activity });
  }

  /** A later instant each time, as the desktop stamps each stored change. */
  private stamp() {
    this.minutes += 1;
    return `2026-10-11T11:${String(this.minutes).padStart(2, "0")}:00.000Z`;
  }

  /** Sends a message the way another device does: the desktop stores it and starts a turn, and this client is not asked. */
  async sendElsewhere(repositoryId: string, conversationId: string | null, text: string) {
    return this.handle("send", { repositoryId, conversationId, text, provider: "claude", model: null });
  }

  /** Ends the running turn the way the desktop does: it stores Aril's message. */
  finish(text: string, status = "complete", extra: Json = {}) {
    const turn = this.turn;
    if (!turn) return;
    const conversation = this.conversation(turn.repositoryId, turn.conversationId);
    conversation?.messages.push(agentMessage(text, { provider: turn.provider, model: turn.model, status, ...extra }, `m-${conversation.messages.length + 1}`));
    if (conversation) conversation.updatedAt = this.stamp();
    this.turn = null;
  }

  private answered(repositoryId: string, stored: StoredConversation): Json {
    if (this.followUps) this.turn = { repositoryId, conversationId: stored.id, startedAt: AT, provider: stored.provider, model: stored.model, activity: "starting", text: "" };
    return { ok: true };
  }

  private summaries(repositoryId: string) {
    return [...(this.byRepository.get(repositoryId)?.values() ?? [])]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((conversation) => ({ id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt, messages: conversation.messages.length }));
  }

  private async handle(operation: string, payload: Json): Promise<Json> {
    const repositoryId = String(payload.repositoryId);
    const conversationId = payload.conversationId === null || payload.conversationId === undefined ? null : String(payload.conversationId);
    const stored = conversationId === null ? undefined : this.conversation(repositoryId, conversationId);
    switch (operation) {
      case "list":
        return { ok: true, conversations: this.summaries(repositoryId), running: this.turn?.repositoryId === repositoryId ? this.turn.conversationId : null };
      case "read": {
        if (!stored) return { ok: false, error: "not_found" };
        const running = this.turn?.repositoryId === repositoryId && this.turn.conversationId === stored.id ? this.turn : null;
        return { ok: true, conversation: structuredClone(stored), turn: running ? { conversationId: running.conversationId, startedAt: running.startedAt, provider: running.provider, model: running.model, activity: running.activity, text: running.text } : null };
      }
      case "send": {
        if (this.hold) await this.hold;
        if (this.refuse) return { ok: false, error: this.refuse };
        const map = this.byRepository.get(repositoryId) ?? new Map<string, StoredConversation>();
        this.byRepository.set(repositoryId, map);
        const text = String(payload.text);
        const imageIds = Array.isArray(payload.images) ? payload.images.map(String) : [];
        if (imageIds.some((id) => !this.images.has(id))) return { ok: false, error: "invalid" };
        const target = stored ?? conversationOf(this.counter += 1, [], { title: text.slice(0, 80), provider: payload.provider as "claude" | "codex", model: (payload.model as string | null) ?? null });
        map.set(target.id, target);
        const images = imageIds.map((id) => ({ id, type: this.images.get(id)!.type, bytes: this.images.get(id)!.bytes.byteLength }));
        target.messages.push({ ...userMessage(text, `m-${target.messages.length + 1}`), ...(images.length > 0 ? { images } : {}) });
        target.updatedAt = this.stamp();
        this.turn = { repositoryId, conversationId: target.id, startedAt: AT, provider: String(payload.provider), model: (payload.model as string | null) ?? null, activity: "thinking", text: "" };
        return { ok: true, conversationId: target.id };
      }
      case "stop": {
        if (!this.turn) return { ok: false, error: "not_found" };
        this.finish(this.turn.text, "stopped");
        return { ok: true };
      }
      case "apply":
      case "dismiss": {
        const message = stored?.messages.find((candidate) => (candidate.proposal as Json | undefined)?.id === payload.proposalId);
        const proposal = message?.proposal as Json | undefined;
        if (!stored || !proposal) return { ok: false, error: "not_found" };
        if (proposal.state !== "pending" || this.refuse === "conflict") return { ok: false, error: "conflict" };
        const operations = proposal.operations as Json[];
        // A start is answered by the dispatcher: only a launch settles it, and a held or failed one stays pending.
        if (operation === "apply" && operations.length === 1 && operations[0].op === "start_session") {
          if (this.refuse === "desktop_only") return { ok: false, error: "desktop_only" };
          if (this.startStatus === "started") Object.assign(proposal, { state: "applied", results: [{ ok: true, start: "started" }] });
          else if (this.startStatus !== "cancelled") Object.assign(proposal, { state: "pending", results: [{ ok: false, error: "not_started", start: this.startStatus }] });
          return this.answered(repositoryId, stored);
        }
        // A queue change is answered by the monitor: only an accepted one settles it, and a refused one stays pending.
        if (operation === "apply" && operations.length === 1 && operations[0].op === "set_queue") {
          if ("error" in this.queueAnswer) Object.assign(proposal, { state: "pending", results: [{ ok: false, error: this.queueAnswer.error }] });
          else Object.assign(proposal, { state: "applied", results: [{ ok: true, queue: operations[0].on !== true ? "off" : this.queueAnswer.status === "blocked" ? "blocked" : "on" }] });
          return this.answered(repositoryId, stored);
        }
        if (operation === "apply") Object.assign(proposal, { state: "applied", results: operations.map((entry) => (entry.op === "create_task" ? { ok: true, taskId: "T-19" } : { ok: true })) });
        else proposal.state = "dismissed";
        return this.answered(repositoryId, stored);
      }
      case "delete":
        if (!stored) return { ok: false, error: "not_found" };
        this.byRepository.get(repositoryId)?.delete(stored.id);
        return { ok: true };
      default:
        return { ok: false, error: "invalid" };
    }
  }
}

// ---- What the modules the chat reads are mocked with. Each test file mocks them through this one object. ----

export const STORAGE_KEY = "pomegr.agentChat.repository";
const COLUMNS = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));

function task(id: string, text: string): Task {
  return {
    id, text, columnId: "col-1", position: 0, featureId: null, group: null, run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null, createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z",
  };
}

export function boardOf(): TaskBoard {
  return {
    version: 1, readiness: "ready", repositoryId: REPO_A, columns: COLUMNS, features: [],
    tasks: [task("T-12", "Log upload retries" + String.fromCharCode(10) + "Include the attempt number."), task("T-14", "Remove the legacy uploader")],
    queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] }, runModels: { codex: [{ id: "model-code", label: null }] },
  };
}

export const harness = {
  pathname: "/sessions",
  mode: "local" as "unknown" | "local" | "lan",
  board: boardOf(),
  refresh: vi.fn(async () => {}),
  inventory: null as unknown,
  agents: { data: { runs: [{ source: "Claude Code", model: "model-large" }] }, loading: false, refreshing: false, connected: true, checkedAt: null },
  chat: new FakeChat(),
};

export function setInventory(repositories: [string, string][], loading = false) {
  harness.inventory = {
    snapshot: { revision: 1, readiness: "ready", repositories: repositories.map(([id, displayName]) => ({ id, name: displayName, displayName })) },
    loading, connected: true, refresh: vi.fn(async () => {}),
  };
}

export function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}

/** One desktop client of one repository, with the polling clock under the test's control. */
export function installHarness(): FakeChat {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  harness.pathname = "/sessions";
  harness.mode = "local";
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  harness.chat = new FakeChat();
  setBridge({ agentChat: harness.chat.agentChat, agentChatImage: harness.chat.agentChatImage });
  setInventory([[REPO_A, "pomegr"]]);
  harness.board = boardOf();
  harness.refresh.mockClear();
  return harness.chat;
}

export function removeHarness() {
  vi.useRealTimers();
  setBridge(undefined);
  vi.unstubAllGlobals();
}

/** Lets the chat's asynchronous steps (the list, then the read) and then the given polling time run. */
export async function settle(milliseconds = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
  for (let round = 0; round < 4; round += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

export const newUser = () => userEvent.setup({ delay: null });
