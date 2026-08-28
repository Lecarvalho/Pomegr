import { classifyExecutionFailure } from "./execution-failures.mjs";
import { executionWorkKind } from "./work-kind.mjs";

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_LABEL_LENGTH = 160;
const MAX_TASKS = 30;

function safeId(value) {
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

function safeTimestamp(value) {
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function safeLabel(value) {
  if (typeof value !== "string") return "Shell command";
  const label = value.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
  return label || "Shell command";
}

function notificationFrom(value) {
  if (typeof value !== "string" || !value.includes("<task-notification>")) return null;
  const field = (name) => value.match(new RegExp(`<${name}>([^<]+)</${name}>`))?.[1]?.trim() || "";
  const summary = field("summary");
  const exitCodeMatch = summary.match(/exit code\s+(-?\d+)/i);
  return {
    backgroundId: safeId(field("task-id")),
    toolUseId: safeId(field("tool-use-id")),
    status: field("status").toLowerCase(),
    exitCode: exitCodeMatch ? Number(exitCodeMatch[1]) : null,
    failureCause: classifyExecutionFailure(summary, {
      failed: Boolean(exitCodeMatch && Number(exitCodeMatch[1]) !== 0) || ["failed", "error"].includes(field("status").toLowerCase()),
      exitCode: exitCodeMatch ? Number(exitCodeMatch[1]) : null,
    }),
  };
}

function completionStatus(notification) {
  if (notification.exitCode !== null && notification.exitCode !== 0) return "failed";
  if (["failed", "error"].includes(notification.status)) return "failed";
  if (["killed", "cancelled", "canceled", "stopped", "interrupted"].includes(notification.status)) return "stopped";
  return "completed";
}

function toolParts(record) {
  return Array.isArray(record?.message?.content) ? record.message.content : [];
}

function newerSignal(first, second) {
  if (!first) return second || null;
  if (!second) return first;
  const firstTime = new Date(first.reportedAt || 0).getTime();
  const secondTime = new Date(second.reportedAt || 0).getTime();
  return secondTime >= firstTime ? second : first;
}

export function buildExecutionTasks(records, { historical = false, sessionUpdatedAt = null, taskSignals = new Map() } = {}) {
  const tasks = new Map();
  const toolUseIdByBackgroundId = new Map();

  for (const record of records) {
    const timestamp = safeTimestamp(record?.timestamp || record?.message?.timestamp);

    for (const part of toolParts(record)) {
      if (record?.type === "assistant" && part?.type === "tool_use" && part?.name === "Bash") {
        const id = safeId(part.id);
        if (!id || !timestamp) continue;
        tasks.set(id, {
          id,
          label: safeLabel(part.input?.description),
          kind: "shell",
          workKind: executionWorkKind(part.input?.command),
          status: "running",
          background: part.input?.run_in_background === true,
          backgroundId: null,
          startedAt: timestamp,
          finishedAt: null,
          exitCode: null,
          failureCause: null,
          signal: null,
        });
        continue;
      }

      if (record?.type !== "user" || part?.type !== "tool_result") continue;
      const id = safeId(part.tool_use_id);
      const task = id ? tasks.get(id) : null;
      if (!task || !timestamp) continue;
      const backgroundId = safeId(record.toolUseResult?.backgroundTaskId);
      if (backgroundId) {
        task.background = true;
        task.backgroundId = backgroundId;
        toolUseIdByBackgroundId.set(backgroundId, id);
        continue;
      }
      task.status = record.toolUseResult?.interrupted ? "stopped" : part.is_error ? "failed" : "completed";
      task.finishedAt = timestamp;
      task.failureCause = classifyExecutionFailure([
        part.content,
        record.toolUseResult?.stderr,
        record.toolUseResult?.error,
        record.toolUseResult?.message,
      ], { failed: task.status === "failed" });
    }

    const notificationText = record?.type === "queue-operation"
      ? record.content
      : record?.type === "user" && record?.origin?.kind === "task-notification" && record?.promptSource === "system"
        ? record.message?.content
        : null;
    const notification = notificationFrom(notificationText);
    if (!notification || !timestamp) continue;
    const id = notification.toolUseId || toolUseIdByBackgroundId.get(notification.backgroundId);
    const task = id ? tasks.get(id) : null;
    if (!task) continue;
    if (notification.backgroundId) {
      task.background = true;
      task.backgroundId = notification.backgroundId;
      toolUseIdByBackgroundId.set(notification.backgroundId, task.id);
    }
    task.status = completionStatus(notification);
    task.finishedAt = timestamp;
    task.exitCode = notification.exitCode;
    task.failureCause = task.status === "failed" ? notification.failureCause : null;
  }

  const historicalFinishedAt = safeTimestamp(sessionUpdatedAt);
  for (const task of tasks.values()) {
    task.signal = newerSignal(taskSignals.get(task.id), task.backgroundId ? taskSignals.get(task.backgroundId) : null);
    if (historical && task.status === "running") {
      task.status = "stopped";
      task.finishedAt = historicalFinishedAt || task.startedAt;
    }
  }

  return [...tasks.values()]
    .sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return new Date(b.finishedAt || b.startedAt).getTime() - new Date(a.finishedAt || a.startedAt).getTime();
    })
    .slice(0, MAX_TASKS);
}
