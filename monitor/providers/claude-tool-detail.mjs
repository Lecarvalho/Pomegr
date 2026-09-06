import path from "node:path";
import { normalizedSkillName } from "../skill-usage.mjs";

export function safeDetail(tool, input = {}) {
  const skill = tool === "Skill" ? normalizedSkillName(input) : "";
  if (skill) return skill;
  if (tool === "TaskCreate" && typeof input.subject === "string") {
    return input.subject.replace(/\s+/g, " ").trim().slice(0, 54);
  }
  if (tool === "TaskUpdate" && typeof input.taskId === "string") return `task ${input.taskId}`;
  const file = input.file_path || input.path;
  if (typeof file === "string") return path.basename(file);
  if (typeof input.pattern === "string") return input.pattern.slice(0, 54);
  if (typeof input.description === "string") return input.description.replace(/\s+/g, " ").slice(0, 54);
  if (typeof input.taskId === "string") return `task ${input.taskId}`;
  if (typeof input.delaySeconds === "number") return `${input.delaySeconds}s`;
  return "";
}
