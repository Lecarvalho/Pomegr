import fs from "node:fs";
import path from "node:path";

const TASK_STATUSES = new Set(["pending", "in_progress", "completed"]);

function cleanId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id) ? id : "";
}

export function normalizeSessionTask(task, fallbackId = "") {
  const id = cleanId(task?.id) || cleanId(fallbackId);
  const subject = typeof task?.subject === "string"
    ? task.subject.replace(/\s+/g, " ").trim().slice(0, 160)
    : "";
  if (!id || !subject) return null;
  const status = TASK_STATUSES.has(task.status) ? task.status : "pending";
  const dependencyIds = (value) => Array.isArray(value)
    ? [...new Set(value.map(cleanId).filter(Boolean))].slice(0, 40)
    : [];
  return {
    id,
    subject,
    status,
    blocks: dependencyIds(task.blocks),
    blockedBy: dependencyIds(task.blockedBy),
  };
}

export function readSessionTasks(tasksRoot, sessionId) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(sessionId || "")) return [];
  const directory = path.join(tasksRoot, sessionId);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !/^[a-zA-Z0-9_-]+\.json$/.test(entry.name)) return [];
    try {
      const task = JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8"));
      const normalized = normalizeSessionTask(task, path.basename(entry.name, ".json"));
      return normalized ? [normalized] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
