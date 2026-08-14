import fs from "node:fs";
import { codexTimestamp } from "./codex-session-metadata.mjs";
import { classifyExecutionFailure, safeExecutionFailureCause } from "../execution-failures.mjs";

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

function normalizedFunctionName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function quotedLiteral(source, start) {
  const quote = source[start];
  if (!["\"", "'", "`"].includes(quote)) return "";
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === quote) return value;
    if (character === "\\" && index + 1 < source.length) {
      value += source[index + 1];
      index += 1;
    } else {
      value += character;
    }
  }
  return "";
}

function safeCommandDescription(command) {
  const value = String(command || "").toLowerCase();
  if (!value) return "Shell command";
  if (/restart-pomegr/.test(value)) return "Restart Pomegr";
  if (/\b(?:npm(?:\.cmd)?\s+(?:run\s+)?test|node\s+--test|vitest)\b/.test(value)) return "Run tests";
  if (/\b(?:npm(?:\.cmd)?\s+run\s+build|vinext\s+build)\b/.test(value)) return "Build project";
  if (/\b(?:npm(?:\.cmd)?\s+run\s+lint|eslint)\b/.test(value)) return "Run lint";
  if (/\b(?:tsc|npm(?:\.cmd)?\s+run\s+typecheck)\b/.test(value)) return "Type-check project";
  if (/\b(?:npm(?:\.cmd)?\s+(?:ci|install)|pnpm\s+install|yarn\s+install)\b/.test(value)) return "Install dependencies";
  if (/\bgit(?:\.exe)?\b[^\r\n]{0,160}\bstatus\b/.test(value)) return "Inspect Git status";
  if (/\bgit(?:\.exe)?\b[^\r\n]{0,160}\bdiff\b/.test(value)) return "Inspect Git changes";
  if (/\bgit(?:\.exe)?\b[^\r\n]{0,160}\b(?:log|show)\b/.test(value)) return "Inspect Git history";
  if (/\bgit(?:\.exe)?\b[^\r\n]{0,160}\b(?:branch|rev-parse)\b/.test(value)) return "Inspect Git branch";
  if (/\bgit(?:\.exe)?\b[^\r\n]{0,160}\bremote\b/.test(value)) return "Inspect Git remotes";
  if (/\bgit(?:\.exe)?\b[^\r\n]{0,160}\bfetch\b/.test(value)) return "Refresh Git metadata";
  if (/\bgit(?:\.exe)?\b[^\r\n]{0,160}\badd\b/.test(value)) return "Stage changes";
  if (/\bgit(?:\.exe)?\b[^\r\n]{0,160}\bcommit\b/.test(value)) return "Commit changes";
  if (/\bgit(?:\.exe)?\b[^\r\n]{0,160}\bpush\b/.test(value)) return "Push branch";
  if (/\bgit(?:\.exe)?\b[^\r\n]{0,160}\bpull\b/.test(value)) return "Update branch";
  if (/\bgh(?:\.exe)?\s+pr\s+create\b/.test(value)) return "Create pull request";
  if (/\bgh(?:\.exe)?\s+pr\s+(?:view|list|status|checks|diff)\b/.test(value)) return "Inspect pull requests";
  if (/\bgh(?:\.exe)?\s+pr\s+(?:edit|comment|review|merge|close|reopen|ready)\b/.test(value)) return "Update pull request";
  if (/\bgh(?:\.exe)?\s+issue\s+(?:view|list|status)\b/.test(value)) return "Inspect GitHub issues";
  if (/\bgh(?:\.exe)?\s+issue\s+(?:create|edit|comment|close|reopen)\b/.test(value)) return "Update GitHub issue";
  if (/\bgh(?:\.exe)?\s+auth\s+status\b/.test(value)) return "Check GitHub authentication";
  if (/\bgh(?:\.exe)?\s+api\b/.test(value)) return "Query GitHub";
  if (/\brg(?:\.exe)?\b[^\r\n]*--files\b|get-childitem/.test(value)) return "List workspace files";
  if (/\brg(?:\.exe)?\b|select-string/.test(value)) return "Search workspace";
  if (/get-content/.test(value)) return "Read files";
  if (/test-path/.test(value)) return "Check files";
  if (/invoke-restmethod|\bcurl(?:\.exe)?\b/.test(value)) return "Check service";
  if (/get-nettcpconnection|get-winevent|get-process/.test(value)) return "Inspect system state";
  if (/\bnode(?:\.exe)?\b/.test(value)) return "Run Node script";
  if (/\bnpm(?:\.cmd)?\s+run\s+dev\b/.test(value)) return "Start development server";
  if (/\bnpm(?:\.cmd)?\s+run\s+[^\s"'`]+/.test(value)) return "Run project script";
  if (/\bdotnet(?:\.exe)?\b/.test(value)) return "Run .NET tool";
  if (/\.ps1\b/.test(value)) return "Run PowerShell script";
  return "Shell command";
}

function execCellShellEvidence(payload) {
  if (payload?.type !== "custom_tool_call" || normalizedFunctionName(payload.name) !== "exec") return [];
  if (typeof payload.input !== "string") return [];
  const matches = [...payload.input.matchAll(/\btools\s*\.\s*(?:shell_command|exec_command)\s*\(/g)].slice(0, MAX_TASKS);
  return matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? payload.input.length;
    const segment = payload.input.slice(match.index, end);
    const property = /\b(?:command|cmd)\s*:\s*/.exec(segment);
    const literalStart = property ? property.index + property[0].length : -1;
    let command = literalStart >= 0 ? quotedLiteral(segment, literalStart) : "";
    if (!command) {
      const prefix = payload.input.slice(0, match.index);
      const assignments = [...prefix.matchAll(/\b(?:const|let|var)\s+(?:command|cmd)\s*=\s*/g)];
      const assignment = assignments.at(-1);
      if (assignment) command = quotedLiteral(prefix, assignment.index + assignment[0].length);
    }
    if (!command && matches.length === 1) command = payload.input;
    return { label: safeCommandDescription(command) };
  });
}

function execCellOutput(payload, taskCount) {
  const texts = (Array.isArray(payload?.output) ? payload.output : [])
    .flatMap((item) => typeof item?.text === "string" ? [item.text] : []);
  const failed = texts.some((value) => /^Script failed\b/m.test(value));
  const exitCodes = texts.flatMap((value) => [...value.matchAll(/^Exit code:\s*(-?\d+)\s*$/gm)])
    .map((match) => safeExitCode(Number(match[1])))
    .filter((value) => value !== null);
  return {
    failed,
    exitCodes: exitCodes.length === taskCount ? exitCodes : taskCount === 1 && exitCodes.length ? [exitCodes[0]] : [],
    failureCause: classifyExecutionFailure(texts, { failed, exitCode: exitCodes[0] ?? null }),
  };
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

function makeTask({ id, timestamp, status = "running", label, background = false, backgroundId = null, exitCode = null, finishedAt = null, failureCause = null }) {
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
    failureCause: normalizedTaskStatus === "failed"
      ? safeExecutionFailureCause(failureCause) || classifyExecutionFailure([], { exitCode: normalizedExitCode })
      : null,
    signal: null,
  };
}

function cachedTask(value) {
  if (!value || typeof value !== "object" || value.kind !== "shell") return null;
  return makeTask({
    id: value.id,
    timestamp: value.startedAt,
    status: value.status,
    label: value.label,
    background: value.background,
    backgroundId: value.backgroundId,
    exitCode: value.exitCode,
    finishedAt: value.finishedAt,
    failureCause: value.failureCause,
  });
}

function statusRank(status) {
  if (status === "stopped") return 4;
  if (status === "failed") return 3;
  if (status === "completed") return 2;
  return 1;
}

function failureCauseRank(value) {
  return value && !["non_zero_exit", "provider_error"].includes(value) ? 2 : value ? 1 : 0;
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
    failureCause: nextStatusWins && failureCauseRank(next.failureCause) >= failureCauseRank(previous.failureCause)
      ? next.failureCause
      : previous.failureCause,
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
    failureCause: classifyExecutionFailure([
      item.aggregatedOutput,
      item.aggregated_output,
      item.output,
      item.stderr,
      item.error,
      item.message,
    ], { failed: status === "failed", exitCode }),
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
    failureCause: classifyExecutionFailure([
      item.aggregatedOutput,
      item.aggregated_output,
      item.output,
      item.stderr,
      item.error,
      item.message,
    ], { failed: status === "failed", exitCode }),
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
    failureCause: classifyExecutionFailure([
      payload?.aggregatedOutput,
      payload?.aggregated_output,
      payload?.output,
      payload?.stderr,
      payload?.error,
      payload?.message,
    ], { failed: status === "failed", exitCode }),
  });
}

export function parseCodexExecutionTaskStateRecords(records, options = {}) {
  const tasks = new Map();
  const commandCallIds = new Set();
  const execCellTaskIds = new Map();
  const fallbackTimestamp = codexTimestamp(options.fallbackTimestamp);
  const add = (task) => {
    if (task) tasks.set(task.id, mergeTask(tasks.get(task.id), task));
  };

  const existingState = options.existingState && typeof options.existingState === "object"
    ? options.existingState
    : { tasks: [], execCellLinks: [] };
  for (const value of Array.isArray(existingState.tasks) ? existingState.tasks : []) {
    const task = cachedTask(value);
    if (task) add(task);
  }
  const linkedTaskIds = new Set();
  for (const value of Array.isArray(existingState.execCellLinks) ? existingState.execCellLinks : []) {
    const callId = safeId(value?.callId);
    const taskCount = Number.isInteger(value?.taskCount) && value.taskCount >= 1 && value.taskCount <= MAX_TASKS
      ? value.taskCount
      : null;
    if (!callId || !taskCount || !Array.isArray(value?.tasks) || value.tasks.length > MAX_TASKS) continue;
    const taskIds = new Map();
    for (const linked of value.tasks) {
      const index = Number.isInteger(linked?.index) && linked.index >= 0 && linked.index < taskCount ? linked.index : null;
      const taskId = safeId(linked?.id);
      if (index === null || !taskId || !tasks.has(taskId) || taskIds.has(index)) continue;
      taskIds.set(index, taskId);
      linkedTaskIds.add(taskId);
    }
    if (taskIds.size) execCellTaskIds.set(callId, { taskCount, taskIds });
  }
  for (const taskId of tasks.keys()) if (!linkedTaskIds.has(taskId)) commandCallIds.add(taskId);

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
      const shellEvidence = execCellShellEvidence(payload);
      if (shellEvidence.length > 0) {
        const callId = commandIdentity(payload);
        if (!callId) continue;
        const taskIds = new Map();
        for (const [index, evidence] of shellEvidence.entries()) {
          const id = `${callId}-shell-${index + 1}`;
          const task = makeTask({ id, timestamp, status: "running", label: evidence.label });
          if (!task) continue;
          taskIds.set(index, task.id);
          add(task);
        }
        if (taskIds.size) execCellTaskIds.set(callId, { taskCount: shellEvidence.length, taskIds });
        continue;
      }
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
      if (payload.type === "custom_tool_call_output") {
        const callId = commandIdentity(payload);
        const link = callId ? execCellTaskIds.get(callId) : null;
        const result = execCellOutput(payload, link?.taskCount || 0);
        for (const [index, id] of link?.taskIds || []) {
          const exitCode = result.exitCodes[index] ?? null;
          add(makeTask({
            id,
            timestamp,
            status: result.failed ? "failed" : "completed",
            label: "Shell command",
            exitCode,
            finishedAt: timestamp,
            failureCause: result.failureCause,
          }));
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

  const normalizedTasks = mergeCodexExecutionTasks([[...tasks.values()]], options);
  const retainedTaskIds = new Set(normalizedTasks.map((task) => task.id));
  const execCellLinks = [...execCellTaskIds].flatMap(([callId, link]) => {
    const linkedTasks = [...link.taskIds]
      .filter(([, taskId]) => retainedTaskIds.has(taskId))
      .map(([index, id]) => ({ index, id }));
    return linkedTasks.length ? [{ callId, taskCount: link.taskCount, tasks: linkedTasks }] : [];
  });
  return { tasks: normalizedTasks, execCellLinks };
}

export function parseCodexExecutionTaskRecords(records, options = {}) {
  return parseCodexExecutionTaskStateRecords(records, options).tasks;
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
