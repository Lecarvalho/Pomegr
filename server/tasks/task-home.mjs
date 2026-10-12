// The Tasks home: one summary of every stored board, built from projected boards only.

import { plainTaskText } from "./task-record.mjs";

export const TASK_HOME_BOARD_LIMIT = 200;
export const TASK_HOME_ATTENTION_LIMIT = 50;
export const TASK_HOME_TITLE_LENGTH = 160;
// The outcomes that wait for the owner.
export const TASK_HOME_ATTENTION_STATES = Object.freeze(["needs_review", "stalled", "blocked"]);
const BOARD_COLUMN_COUNT = 5;

const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

// One bounded line: the session title when the session has one, otherwise the first line of the task text.
function attentionTitle(task) {
  const sessionTitle = typeof task.session?.title === "string" ? task.session.title.trim() : "";
  const firstLine = plainTaskText(typeof task.text === "string" ? task.text : "").split(/\r?\n/u).map((line) => line.replace(LINE_CONTROL, " ").trim())
    .find((line) => line.length > 0) ?? "";
  const line = sessionTitle || firstLine;
  return line.length > TASK_HOME_TITLE_LENGTH ? `${line.slice(0, TASK_HOME_TITLE_LENGTH - 1)}…` : line;
}

const instant = (value) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);

function summarizeBoard(repositoryId, board) {
  const unavailable = { repositoryId, readiness: "unavailable", counts: [], openFeatures: 0, queue: { status: "idle", blockedBy: null, pauseReason: null }, updatedAt: null };
  if (board === null || typeof board !== "object" || !Array.isArray(board.columns) || !Array.isArray(board.tasks) || !Array.isArray(board.features)
    || board.columns.length !== BOARD_COLUMN_COUNT) return unavailable;
  const columns = [...board.columns].sort((left, right) => left.position - right.position);
  const counts = columns.map((column) => board.tasks.filter((task) => task.columnId === column.id).length);
  let newest = null;
  for (const task of board.tasks) {
    const at = instant(task.updatedAt);
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return {
    repositoryId, readiness: "ready", counts,
    openFeatures: board.features.filter((feature) => feature.done !== true).length,
    queue: { status: board.queue?.status ?? "idle", blockedBy: board.queue?.blockedBy ?? null, pauseReason: board.queue?.pauseReason ?? null },
    updatedAt: newest === null ? null : new Date(newest).toISOString(),
  };
}

// `entries` is `{ repositoryId, board }` per stored repository; a board that did not project is `null`.
export function summarizeTaskHome(entries) {
  const boards = [];
  const waiting = [];
  for (const { repositoryId, board } of entries.slice(0, TASK_HOME_BOARD_LIMIT)) {
    const summary = summarizeBoard(repositoryId, board);
    boards.push(summary);
    if (summary.readiness !== "ready") continue;
    for (const task of board.tasks) {
      if (!TASK_HOME_ATTENTION_STATES.includes(task.state)) continue;
      waiting.push({ at: instant(task.updatedAt) ?? 0, item: { repositoryId, taskId: task.id, title: attentionTitle(task), state: task.state } });
    }
  }
  // Newest first; the sort is stable, so equal times keep board and task order.
  waiting.sort((left, right) => right.at - left.at);
  return { boards, attention: waiting.slice(0, TASK_HOME_ATTENTION_LIMIT).map(({ item }) => item), attentionTotal: waiting.length };
}
