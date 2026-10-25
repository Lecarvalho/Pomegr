import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isTaskId, normalizeModelIdentifier } from "./task-record.mjs";
import { TASK_GROUP_LIMIT } from "./task-groups.mjs";
import { splitTaskTags } from "./task-tags.mjs";

export function ensureArilSettings(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS aril_settings (
      repository_id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS aril_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id TEXT NOT NULL, text TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
}

const defaults = () => ({
  actions: { start: false, review: false, sendBack: false, merge: false, writeTasks: false },
  mergeMethod: null,
  limits: { hours: null, tasks: null, tasksAtATime: null, sendBacks: null, usagePercent: null },
  workRules: [], reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false,
});
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const exact = (value, allowed) => keys(value, allowed) && Object.keys(value).length === allowed.length;
const invalid = () => ({ ok: false, error: "invalid" });
const line = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\p{Cc}\u2028\u2029]/u.test(value);
const bounds = { hours: [1, 72], tasks: [1, 100], tasksAtATime: [1, Math.min(10, TASK_GROUP_LIMIT)], sendBacks: [0, 10], usagePercent: [1, 100] };

export function normalizeArilLimits(value) {
  const limits = { ...value };
  if (!Object.hasOwn(limits, "tasks") && Object.hasOwn(limits, "starts")) limits.tasks = limits.starts;
  if (!Object.hasOwn(limits, "tasksAtATime") && Object.hasOwn(limits, "concurrent")) limits.tasksAtATime = limits.concurrent;
  if (!Object.hasOwn(limits, "usagePercent") && Object.hasOwn(limits, "allowancePercent")) limits.usagePercent = limits.allowancePercent;
  for (const key of ["starts", "concurrent", "allowancePercent"]) delete limits[key];
  return { ...defaults().limits, ...limits };
}
function currentSettings(value) {
  const saved = JSON.parse(value);
  return { ...defaults(), ...saved, limits: normalizeArilLimits(saved.limits ?? {}) };
}

function readSettings(database, repositoryId) {
  const row = preparedStatement(database, "SELECT value FROM aril_settings WHERE repository_id = ?").get(repositoryId);
  return row ? currentSettings(row.value) : defaults();
}
function writeSettings(database, repositoryId, settings, at) {
  preparedStatement(database, `INSERT INTO aril_settings (repository_id, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(repository_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(repositoryId, JSON.stringify(settings), at);
}
const entry = (row) => ({ id: Number(row.id), text: row.text, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });
// settledAt is when the owner last settled the settings (the row's update time), or null while nothing is stored.
export function readAril(database, repositoryId) {
  const row = preparedStatement(database, "SELECT updated_at FROM aril_settings WHERE repository_id = ?").get(repositoryId);
  const settledAt = row ? new Date(Number(row.updated_at)).toISOString() : null;
  return { settings: { ...readSettings(database, repositoryId), settledAt }, memory: preparedStatement(database,
    "SELECT id, text, created_at, updated_at FROM aril_memory WHERE repository_id = ? ORDER BY created_at, id").all(repositoryId).map(entry) };
}

function validRule(database, repositoryId, rule) {
  if (!exact(rule, ["kind", "value"])) return false;
  const { kind, value } = rule;
  if (kind === "tag") return line(value, 40) && !/\s/u.test(value) && splitTaskTags(`[ ${value} ]`, 40).tags[0] === value;
  if (kind === "text") return line(value, 80);
  if (kind === "plan") return line(value, 200) && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.md$/u.test(value)
    && !value.split("/").some((segment) => segment === "." || segment === "..");
  if (kind === "feature") return typeof value === "string" && preparedStatement(database,
    "SELECT 1 FROM features WHERE repository_id = ? AND id = ?").get(repositoryId, value) !== undefined;
  return kind === "tasks" && Array.isArray(value) && value.length >= 1 && value.length <= 50
    && value.every((id) => isTaskId(id) && preparedStatement(database,
      "SELECT 1 FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, Number(id.slice(2))) !== undefined);
}

export function arilSettingsSet({ database, repositoryId, ensureRepository, now }, payload) {
  const base = defaults();
  if (!exact(payload, ["settings"]) || !keys(payload.settings, Object.keys(base))) return invalid();
  const input = payload.settings;
  for (const [field, value] of Object.entries(input)) {
    if (field === "actions" && (!exact(value, Object.keys(base.actions)) || !Object.values(value).every((v) => typeof v === "boolean"))) return invalid();
    if (field === "mergeMethod" && value !== null && !["squash", "merge", "rebase"].includes(value)) return invalid();
    if (field === "limits" && (!exact(value, Object.keys(bounds)) || !Object.entries(value).every(([key, v]) => v === null
      || (Number.isInteger(v) && v >= bounds[key][0] && v <= bounds[key][1])))) return invalid();
    if (field === "workRules" && (!Array.isArray(value) || value.length > 20 || !value.every((rule) => validRule(database, repositoryId, rule)))) return invalid();
    if (field === "reviewer" && (!exact(value, Object.keys(base.reviewer)) || ![null, "claude", "codex"].includes(value.provider)
      || normalizeModelIdentifier(value.model) === undefined || typeof value.differentFromBuilder !== "boolean")) return invalid();
    if (field === "pairedDevices" && typeof value !== "boolean") return invalid();
  }
  const settings = { ...readSettings(database, repositoryId), ...input };
  if (input.reviewer) settings.reviewer = { ...input.reviewer, model: normalizeModelIdentifier(input.reviewer.model) };
  ensureRepository(database, repositoryId);
  writeSettings(database, repositoryId, settings, now());
  return { ok: true, settings };
}

export function pruneArilTask({ database, repositoryId, now }, taskId) {
  const settings = readSettings(database, repositoryId);
  if (!settings.workRules.some((rule) => rule.kind === "tasks" && rule.value.includes(taskId))) return;
  settings.workRules = settings.workRules.map((rule) => rule.kind === "tasks" ? { ...rule, value: rule.value.filter((id) => id !== taskId) } : rule)
    .filter((rule) => rule.kind !== "tasks" || rule.value.length > 0);
  writeSettings(database, repositoryId, settings, now());
}

export function arilMemoryAdd({ database, repositoryId, ensureRepository, now }, payload) {
  if (!exact(payload, ["text"]) || !line(payload.text, 300)) return invalid();
  if (preparedStatement(database, "SELECT COUNT(*) AS n FROM aril_memory WHERE repository_id = ?").get(repositoryId).n >= 100) return { ok: false, error: "limit" };
  ensureRepository(database, repositoryId);
  const at = now();
  const result = preparedStatement(database, "INSERT INTO aril_memory (repository_id, text, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(repositoryId, payload.text, at, at);
  return { ok: true, entry: { id: Number(result.lastInsertRowid), text: payload.text, createdAt: at, updatedAt: at } };
}
export function arilMemoryUpdate({ database, repositoryId, now }, payload) {
  if (!exact(payload, ["id", "text"]) || !Number.isSafeInteger(payload.id) || payload.id < 1 || !line(payload.text, 300)) return invalid();
  const row = preparedStatement(database, "UPDATE aril_memory SET text = ?, updated_at = ? WHERE repository_id = ? AND id = ? RETURNING *")
    .get(payload.text, now(), repositoryId, payload.id);
  return row ? { ok: true, entry: entry(row) } : { ok: false, error: "not_found" };
}
export function arilMemoryRemove({ database, repositoryId }, payload) {
  if (!exact(payload, ["id"]) || !Number.isSafeInteger(payload.id) || payload.id < 1) return invalid();
  const result = preparedStatement(database, "DELETE FROM aril_memory WHERE repository_id = ? AND id = ?").run(repositoryId, payload.id);
  return result.changes ? { ok: true } : { ok: false, error: "not_found" };
}
