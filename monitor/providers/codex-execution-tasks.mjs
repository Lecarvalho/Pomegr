import fs from "node:fs";
import { codexTimestamp } from "./codex-session-metadata.mjs";

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_LABEL_LENGTH = 160;
const MAX_TASKS = 30;

function safeId(value) {
  const normalized = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof normalized === "string" && SAFE_ID.test(normalized) ? normalized : null;
}

function safeLabel(value) {
  if (typeof value !== "string") return "Shell command";
  const label = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
  return label || "Shell command";
}

function safeExitCode(value) {
  return Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647 ? value : null;
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function timestampValue(value) {
  const milliseconds = Date.parse(value || "");
  return Number.isFinite(milliseconds) ? milliseconds : Number.NEGATIVE_INFINITY;
}

function finishedTimestamp(startedAt, timestamp, durationMs) {
  const observed = codexTimestamp(timestamp);
  if (observed) return observed;
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  const started = timestampValue(startedAt);
  const finished = started + durationMs;
  return Number.isFinite(started) && Number.isFinite(new Date(finished).getTime()) ? new Date(finished).toISOString() : null;
}

function normalizedStatus(value, exitCode = null, interrupted = false, fallback = "running") {
  const status = String(value ?? "").toLowerCase().replace(/[_ -]/g, "");
  if (interrupted || ["declined", "cancelled", "canceled", "interrupted", "killed", "stopped"].includes(status)) return "stopped";
  if (["failed", "failure", "error", "errored"].includes(status)) return "failed";
  if (exitCode !== null && exitCode !== 0) return "failed";
  if (["completed", "complete", "success", "succeeded"].includes(status)) return "completed";
  if (["inprogress", "running", "pending", "started"].includes(status)) return "running";
  return fallback;
}

function commandFunctionName(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ["shellcommand", "execcommand", "commandexecution"].includes(normalized);
}

function commandIdentity(value) {
  return safeId(value?.call_id ?? value?.callId ?? value?.id ?? value?.itemId ?? value?.item_id);
}

function commandMetadata(value, input = value) {
  const backgroundId = safeId(
    value?.processId ?? value?.process_id ?? value?.backgroundId ?? value?.background_id
      ?? input?.processId ?? input?.process_id ?? input?.backgroundId ?? input?.background_id,
  );
  return {
    label: safeLabel(value?.description ?? input?.description),
    background: Boolean(
      backgroundId
      || value?.background === true
      || value?.runInBackground === true
      || value?.run_in_background === true
      || input?.background === true
      || input?.runInBackground === true
      || input?.run_in_background === true,
    ),
    backgroundId,
  };
}

function makeTask({ id, timestamp, status = "running", label, background = false, backgroundId = null, exitCode = null, finishedAt = null }) {
  const taskId = safeId(id);
  const startedAt = codexTimestamp(timestamp);
  if (!taskId || !startedAt) return null;
  const normalizedExitCode = safeExitCode(exitCode);
  const normalizedTaskStatus = normalizedStatus(status, normalizedExitCode);
  return {
    id: taskId,
    label: safeLabel(label),
    kind: "shell",
    status: normalizedTaskStatus,
    background: background === true || Boolean(backgroundId),
    backgroundId: safeId(backgroundId),
    startedAt,
    finishedAt: normalizedTaskStatus === "running" ? null : codexTimestamp(finishedAt) || startedAt,
    exitCode: normalizedExitCode,
    signal: null,
  };
}

function statusRank(status) {
  if (status === "stopped") return 4;
  if (status === "failed") return 3;
  if (status === "completed") return 2;
  return 1;
}

function mergeTask(previous, next) {
  if (!previous) return { ...next };
  const nextStartedEarlier = timestampValue(next.startedAt) < timestampValue(previous.startedAt);
  const previousSpecificLabel = previous.label !== "Shell command";
  const nextSpecificLabel = next.label !== "Shell command";
  const nextStatusWins = statusRank(next.status) > statusRank(previous.status)
    || (statusRank(next.status) === statusRank(previous.status)
      && timestampValue(next.finishedAt || next.startedAt) >= timestampValue(previous.finishedAt || previous.startedAt));
  return {
    ...previous,
    label: nextSpecificLabel || !previousSpecificLabel ? next.label : previous.label,
    status: nextStatusWins ? next.status : previous.status,
    background: previous.background || next.background,
    backgroundId: next.backgroundId || previous.backgroundId,
    startedAt: nextStartedEarlier ? next.startedAt : previous.startedAt,
    finishedAt: nextStatusWins ? next.finishedAt : previous.finishedAt,
    exitCode: nextStatusWins && next.exitCode !== null ? next.exitCode : previous.exitCode,
  };
}

function newerSignal(first, second) {
  if (!first) return second || null;
  if (!second) return first;
  return timestampValue(second.reportedAt) >= timestampValue(first.reportedAt) ? second : first;
}

export function mergeCodexExecutionTasks(taskGroups, { historical = false, sessionUpdatedAt = null, taskSignals = new Map() } = {}) {
  const tasks = new Map();
  for (const task of taskGroups.flat()) {
    if (!task) continue;
    tasks.set(task.id, mergeTask(tasks.get(task.id), task));
  }

  const historicalFinishedAt = codexTimestamp(sessionUpdatedAt);
  for (const task of tasks.values()) {
    task.signal = newerSignal(taskSignals.get(task.id), task.backgroundId ? taskSignals.get(task.backgroundId) : null);
    if (historical && task.status === "running") {
      task.status = "stopped";
      task.finishedAt = historicalFinishedAt || task.startedAt;
    }
  }

  return [...tasks.values()]
    .sort((left, right) => {
      if (left.status === "running" && right.status !== "running") return -1;
      if (right.status === "running" && left.status !== "running") return 1;
      return timestampValue(right.finishedAt || right.startedAt) - timestampValue(left.finishedAt || left.startedAt)
        || left.id.localeCompare(right.id);
    })
    .slice(0, MAX_TASKS);
}

function canonicalTask(item, turn, options) {
  if (item?.type !== "commandExecution") return null;
  const turnStartedAt = codexTimestamp(turn?.startedAt) || options.fallbackTimestamp;
  const turnCompletedAt = codexTimestamp(turn?.completedAt);
  const durationMs = Number.isFinite(item.durationMs) && item.durationMs >= 0 ? item.durationMs : null;
  const derivedStartedMilliseconds = turnCompletedAt && durationMs !== null
    ? Math.max(timestampValue(turnStartedAt), timestampValue(turnCompletedAt) - durationMs)
    : Number.NaN;
  const derivedStartedAt = Number.isFinite(new Date(derivedStartedMilliseconds).getTime())
    ? new Date(derivedStartedMilliseconds).toISOString()
    : null;
  const startedAt = derivedStartedAt || turnStartedAt;
  const exitCode = safeExitCode(item.exitCode);
  const status = normalizedStatus(item.status, exitCode, false, turn?.status === "completed" ? "completed" : "running");
  const metadata = commandMetadata(item);
  return makeTask({
    id: item.id,
    timestamp: startedAt,
    status,
    ...metadata,
    exitCode,
    finishedAt: status === "running" ? null : finishedTimestamp(startedAt, turn?.completedAt, durationMs),
  });
}

export function parseCodexCanonicalExecutionTasks(turns, options = {}) {
  const tasks = [];
  for (const turn of Array.isArray(turns) ? turns : []) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) tasks.push(canonicalTask(item, turn, options));
  }
  return mergeCodexExecutionTasks([tasks], options);
}

function taskFromItem(item, timestamp, completed, fallbackTimestamp) {
  if (item?.type !== "commandExecution") return null;
  const exitCode = safeExitCode(item.exitCode);
  const status = normalizedStatus(item.status, exitCode, false, completed ? "completed" : "running");
  return makeTask({
    id: item.id,
    timestamp: timestamp || fallbackTimestamp,
    status,
    ...commandMetadata(item),
    exitCode,
    finishedAt: status === "running" ? null : timestamp || fallbackTimestamp,
  });
}

function completionUpdate(payload, timestamp, fallbackTimestamp) {
  const id = commandIdentity(payload);
  const exitCode = safeExitCode(payload?.exitCode ?? payload?.exit_code);
  const interrupted = payload?.interrupted === true;
  const failed = payload?.is_error === true || payload?.isError === true || payload?.success === false;
  const status = normalizedStatus(failed ? "failed" : payload?.status, exitCode, interrupted, "completed");
  return makeTask({
    id,
    timestamp: timestamp || fallbackTimestamp,
    status,
    ...commandMetadata(payload),
    exitCode,
    finishedAt: timestamp || fallbackTimestamp,
  });
}

export function parseCodexExecutionTaskRecords(records, options = {}) {
  const tasks = new Map();
  const commandCallIds = new Set();
  const fallbackTimestamp = codexTimestamp(options.fallbackTimestamp);
  const add = (task) => {
    if (task) tasks.set(task.id, mergeTask(tasks.get(task.id), task));
  };

  for (const record of Array.isArray(records) ? records : []) {
    const timestamp = codexTimestamp(record?.timestamp ?? record?.payload?.timestamp) || fallbackTimestamp;
    const payload = record?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const recordType = String(record.type || "").toLowerCase().replace(/[^a-z0-9]/g, "");

    if (["itemstarted", "itemcompleted"].includes(recordType)) {
      add(taskFromItem(payload.item, timestamp, recordType === "itemcompleted", fallbackTimestamp));
      continue;
    }

    if (record.type === "response_item") {
      if (payload.type === "function_call" && commandFunctionName(payload.name)) {
        const id = commandIdentity(payload);
        const input = parseObject(payload.arguments) || {};
        const metadata = commandMetadata(payload, input);
        const task = makeTask({ id, timestamp, status: "running", ...metadata });
        if (task) {
          commandCallIds.add(task.id);
          add(task);
        }
        continue;
      }
      if (payload.type === "function_call_output") {
        const id = commandIdentity(payload);
        if (id && commandCallIds.has(id)) add(completionUpdate(payload, timestamp, fallbackTimestamp));
        continue;
      }
      if (payload.type === "local_shell_call") {
        add(completionUpdate(payload, timestamp, fallbackTimestamp));
      }
      continue;
    }

    if (record.type !== "event_msg") continue;
    const eventType = String(payload.type || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (eventType === "execcommandbegin") {
      const id = commandIdentity(payload);
      const task = makeTask({ id, timestamp, status: "running", ...commandMetadata(payload) });
      if (task) {
        commandCallIds.add(task.id);
        add(task);
      }
    } else if (eventType === "execcommandend") {
      const id = commandIdentity(payload);
      if (id && commandCallIds.has(id)) add(completionUpdate(payload, timestamp, fallbackTimestamp));
    }
  }

  return mergeCodexExecutionTasks([[...tasks.values()]], options);
}

export function readCodexExecutionTaskRollout(file, options = {}) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
    } catch {
      // Malformed and truncated lines do not invalidate recognized execution tasks.
    }
  }
  return parseCodexExecutionTaskRecords(records, options);
}
