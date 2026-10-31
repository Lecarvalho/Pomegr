import { vi } from "vitest";
import type { SessionSummary } from "../../shared/monitor-contract";
import { REPO_A, REPO_B, harness, setBridge, type FakeChat } from "./agent-chat-fixture";

// What the Home tests share: the Tasks home the page reads, the task logs, the boards a title is joined from, the sessions, and the two ways a client reaches the chat.
export const homeHarness = { taskHome: null as unknown, boards: new Map<string, unknown>() };

export const hoursAgo = (hours: number) => Date.now() - hours * 3_600_000;
type LogEntry = { id: number; task: string; kind: string; at: number; pullRequest: number | null };
export const logEntry = (id: number, task: string, kind: string, hours: number): LogEntry => ({ id, task, kind, at: hoursAgo(hours), pullRequest: null });
export const logs = new Map<string, LogEntry[]>();
export const answerLog = async (repositoryId: string) => ({ ok: true, log: { entries: logs.get(repositoryId) ?? [], more: false, arilCursor: 0 } });
export const taskLog = vi.fn(answerLog);

export const board = (repositoryId: string, overrides: Record<string, unknown> = {}) => ({
  repositoryId, readiness: "ready", counts: [0, 0, 0, 0, 0], openFeatures: 0, queue: { status: "idle", blockedBy: null, pauseReason: null }, updatedAt: new Date(hoursAgo(1)).toISOString(), ...overrides,
});
export const homeOf = (overrides: Record<string, unknown> = {}) => ({ version: 1, readiness: "ready", boards: [board(REPO_A, { counts: [0, 1, 0, 1, 0] }), board(REPO_B)], attention: [], attentionTotal: 0, ...overrides });

/** A live session that works, in the first repository, started twelve minutes ago. */
export const liveSession = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id, provider: "claude", source: "Claude Code", title: `Session ${id}`, project: "pomegr", createdAt: new Date(Date.now() - 12 * 60_000).toISOString(), updatedAt: new Date(Date.now() - 30_000).toISOString(),
  isLive: true, needsInput: false, activityStatus: "working", summaryReadiness: "ready", agentCount: 1, activeAgentCount: 1, latestContextTotal: null, progress: null, currentActivity: null, repositoryId: REPO_A, ...overrides,
});

/** The Tasks home with a paused queue, a task that needs review (its CI failed), a stalled task, and a blocked one; the logs that go with it. */
export function busyHome() {
  homeHarness.taskHome = homeOf({
    boards: [board(REPO_A, { counts: [1, 1, 0, 1, 0] }), board(REPO_B, { queue: { status: "paused", blockedBy: null, pauseReason: "start_failed" } })],
    attention: [
      { repositoryId: REPO_A, taskId: "T-41", title: "Retry the upload with backoff", state: "needs_review" },
      { repositoryId: REPO_A, taskId: "T-35", title: "Cut the upload work into tasks", state: "stalled" },
      { repositoryId: REPO_B, taskId: "T-9", title: "Rename the export action", state: "blocked" },
    ],
    attentionTotal: 3,
  });
  logs.set(REPO_A, [logEntry(1, "T-40", "started", 30), logEntry(2, "T-41", "started", 5), logEntry(3, "T-41", "review", 3), logEntry(4, "T-41", "checks_failed", 1), logEntry(5, "T-42", "merged", 2), logEntry(6, "T-43", "done", 1)]);
  logs.set(REPO_B, [logEntry(1, "T-9", "blocked", 2)]);
}

/** The state every Home test starts from. */
export function resetHome() {
  logs.clear();
  taskLog.mockReset();
  taskLog.mockImplementation(answerLog);
  homeHarness.taskHome = homeOf();
  homeHarness.boards = new Map();
}

/** The desktop app's bridge: the chat, its images, and the task log. */
export function desktopBridge(chat: FakeChat) {
  setBridge({ agentChat: chat.agentChat, agentChatImage: chat.agentChatImage, arilControl: chat.arilControl, taskAction: vi.fn(), taskLog });
}

/** A phone: no bridge, and the paired-device routes of the chat and the task log. */
export function pairPhone(chat: FakeChat) {
  setBridge(undefined);
  harness.mode = "lan";
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { operation?: string; payload?: Record<string, unknown>; repositoryId?: string };
    if (url === "/api/agent-chat") return new Response(JSON.stringify(await chat.agentChat(String(body.operation), body.payload ?? {})), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/tasks/log-read") return new Response(JSON.stringify(await taskLog(String(body.repositoryId))), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error("offline");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
