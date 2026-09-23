import path from "node:path";
import { normalizedSkillName } from "../skill-usage.mjs";
import { shellFileChangeCandidates } from "./shell-file-writes.mjs";

function boundedOneLine(value, maximum = 54) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
    : "";
}

const FILE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Recognize only an unambiguous whole-command `mv a b` or `git mv a b`: the
 * POSIX shell-file-writes grammar applied to the whole command, kept to
 * exactly this shape by requiring it to be the command's only candidate and
 * that candidate to be a move. The command text itself never leaves this
 * function.
 */
export function claudeMoveCommandCandidate(command) {
  const candidates = shellFileChangeCandidates(command, { shell: "posix" });
  if (candidates.length !== 1 || candidates[0].kind !== "moved") return null;
  return { from: candidates[0].previousTarget, to: candidates[0].target };
}

/** Candidate {target, kind, previousTarget} file changes for one successful Claude tool call. */
export function claudeFileChangeCandidates(tool, input = {}, toolUseResult) {
  if (tool === "Write") {
    const target = input.file_path || input.path;
    if (typeof target !== "string" || !target) return [];
    const kind = toolUseResult && typeof toolUseResult === "object" && toolUseResult.type === "create" ? "created" : "edited";
    return [{ target, kind }];
  }
  if (FILE_EDIT_TOOLS.has(tool)) {
    const target = input.file_path || input.path;
    return typeof target === "string" && target ? [{ target, kind: "edited" }] : [];
  }
  if (tool === "Bash") return shellFileChangeCandidates(input.command, { shell: "posix" });
  if (tool === "PowerShell") return shellFileChangeCandidates(input.command, { shell: "powershell" });
  return [];
}

/** Per tool_use_id outcome index built once per transcript file: ordered {timestamp, isError, toolUseResult}. */
export function claudeToolOutcomes(records) {
  const outcomes = new Map();
  for (const record of records) {
    if (record?.type !== "user") continue;
    const rawTimestamp = record.timestamp ?? record.message?.timestamp;
    const time = typeof rawTimestamp === "string" ? Date.parse(rawTimestamp) : NaN;
    if (!Number.isFinite(time)) continue;
    for (const part of Array.isArray(record.message?.content) ? record.message.content : []) {
      if (part?.type !== "tool_result" || typeof part.tool_use_id !== "string" || !part.tool_use_id) continue;
      const list = outcomes.get(part.tool_use_id) || [];
      list.push({ timestamp: new Date(time).toISOString(), isError: part.is_error === true, toolUseResult: record.toolUseResult });
      outcomes.set(part.tool_use_id, list);
    }
  }
  return outcomes;
}

/** The first non-error outcome recorded at or after a call's start, or null when nothing succeeded. */
export function firstSuccessfulClaudeToolOutcome(outcomes, toolUseId, startedAt) {
  const start = Date.parse(startedAt || "");
  if (!Number.isFinite(start)) return null;
  const match = (outcomes.get(toolUseId) || []).find((entry) => Date.parse(entry.timestamp) >= start);
  return match && !match.isError ? match : null;
}

export function safeDetail(tool, input = {}) {
  const skill = tool === "Skill" ? normalizedSkillName(input) : "";
  if (skill) return skill;
  if (tool === "TaskCreate" && typeof input.subject === "string") {
    return boundedOneLine(input.subject);
  }
  if (tool === "TaskUpdate" && typeof input.taskId === "string") return boundedOneLine(`task ${input.taskId}`);
  const file = input.file_path || input.path;
  if (typeof file === "string") return boundedOneLine(path.basename(file));
  if (typeof input.pattern === "string") return boundedOneLine(input.pattern);
  if (typeof input.description === "string") return boundedOneLine(input.description);
  if (typeof input.taskId === "string") return boundedOneLine(`task ${input.taskId}`);
  if (typeof input.delaySeconds === "number") return `${input.delaySeconds}s`;
  return "";
}
