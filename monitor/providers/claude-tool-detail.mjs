import path from "node:path";
import { normalizedSkillName } from "../skill-usage.mjs";

function boundedOneLine(value, maximum = 54) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
    : "";
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
