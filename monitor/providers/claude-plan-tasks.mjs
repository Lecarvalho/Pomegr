import fs from "node:fs";
import readline from "node:readline";
import { normalizeSessionTask } from "../session-tasks.mjs";

const MAX_TRANSCRIPT_PLAN_TASKS = 40;
const MAX_PENDING_TASK_CALLS = 80;
const TASK_STATUSES = new Set(["pending", "in_progress", "completed"]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanTaskId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id) ? id : "";
}

function cleanTaskSubject(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 160) : "";
}

function cleanDependencyIds(value) {
  return Array.isArray(value) ? [...new Set(value.map(cleanTaskId).filter(Boolean))].slice(0, 40) : [];
}

function taskToolCalls(record) {
  if (record?.type !== "assistant" || !Array.isArray(record.message?.content)) return [];
  return record.message.content.flatMap((content) => {
    const id = cleanTaskId(content?.id);
    if (content?.type !== "tool_use" || !id || !plainObject(content.input)) return [];
    if (content.name === "TaskCreate") return [{
      id,
      name: content.name,
      input: {
        subject: cleanTaskSubject(content.input.subject),
        blocks: cleanDependencyIds(content.input.blocks),
        blockedBy: cleanDependencyIds(content.input.blockedBy),
      },
    }];
    if (content.name === "TaskUpdate") return [{
      id,
      name: content.name,
      input: {
        taskId: cleanTaskId(content.input.taskId),
        subject: content.input.subject === undefined ? undefined : cleanTaskSubject(content.input.subject),
        status: content.input.status,
        addBlocks: cleanDependencyIds(content.input.addBlocks),
        addBlockedBy: cleanDependencyIds(content.input.addBlockedBy),
      },
    }];
    return [];
  });
}

function successfulTaskResult(record, call) {
  if (record?.type !== "user" || !Array.isArray(record.message?.content)) return null;
  const matched = record.message.content.some((content) => content?.type === "tool_result"
    && content.tool_use_id === call.id
    && content.is_error !== true);
  if (!matched || !plainObject(record.toolUseResult)) return null;
  if (call.name === "TaskCreate") {
    return plainObject(record.toolUseResult.task) ? {
      id: cleanTaskId(record.toolUseResult.task.id),
      subject: cleanTaskSubject(record.toolUseResult.task.subject),
    } : null;
  }
  return record.toolUseResult.success === true ? {
    success: true,
    taskId: cleanTaskId(record.toolUseResult.taskId),
  } : null;
}

function applySuccessfulTaskCall(tasks, call, result) {
  if (call.name === "TaskCreate") {
    if (tasks.size >= MAX_TRANSCRIPT_PLAN_TASKS) return;
    const resultSubject = cleanTaskSubject(result.subject);
    const task = normalizeSessionTask({
      id: result.id,
      subject: call.input.subject,
      status: "pending",
      blocks: call.input.blocks,
      blockedBy: call.input.blockedBy,
    });
    if (task && resultSubject === task.subject) tasks.set(task.id, task);
    return;
  }

  const taskId = cleanTaskId(call.input.taskId);
  if (!taskId || cleanTaskId(result.taskId) !== taskId || !tasks.has(taskId)) return;
  if (call.input.status !== undefined && !TASK_STATUSES.has(call.input.status)) return;
  const previous = tasks.get(taskId);
  const appendDependencies = (current, added) => Array.isArray(added) ? [...current, ...added] : current;
  const task = normalizeSessionTask({
    ...previous,
    subject: typeof call.input.subject === "string" ? call.input.subject : previous.subject,
    status: typeof call.input.status === "string" ? call.input.status : previous.status,
    blocks: appendDependencies(previous.blocks, call.input.addBlocks),
    blockedBy: appendDependencies(previous.blockedBy, call.input.addBlockedBy),
  });
  if (task) tasks.set(taskId, task);
}

export async function readClaudeTranscriptPlanTasks(file) {
  const tasks = new Map();
  const pending = new Map();
  let input;
  try {
    input = fs.createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      for (const call of taskToolCalls(record)) {
        if (pending.size >= MAX_PENDING_TASK_CALLS) pending.delete(pending.keys().next().value);
        pending.set(call.id, call);
      }
      if (record?.type !== "user" || !Array.isArray(record.message?.content)) continue;
      for (const content of record.message.content) {
        if (content?.type !== "tool_result" || typeof content.tool_use_id !== "string") continue;
        const call = pending.get(content.tool_use_id);
        if (!call) continue;
        pending.delete(content.tool_use_id);
        const result = successfulTaskResult(record, call);
        if (result) applySuccessfulTaskCall(tasks, call, result);
      }
    }
  } catch {
    return [];
  } finally {
    input?.destroy();
  }
  return [...tasks.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
