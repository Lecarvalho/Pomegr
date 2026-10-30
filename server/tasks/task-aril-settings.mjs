import { applyMemoryUpdate, ARIL_MEMORY, isMemoryText, legacyMemory, normalizeMemoryText } from "../../shared/aril-memory.mjs";
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isTaskId, normalizeModelIdentifier } from "./task-record.mjs";
import { TASK_GROUP_LIMIT } from "./task-groups.mjs";
import { splitTaskTags } from "./task-tags.mjs";

export function ensureArilSettings(database) {
  // `aril_memory` is the older list of memory lines. It is read until the repository's text exists and is deleted in the same
  // transaction that writes the text, so a failed migration leaves the lines as they were.
  database.exec(`
    CREATE TABLE IF NOT EXISTS aril_settings (
      repository_id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS aril_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id TEXT NOT NULL, text TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS aril_memory_text (
      repository_id TEXT PRIMARY KEY, text TEXT NOT NULL, previous TEXT, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
}

const defaults = () => ({
  actions: { start: false, review: false, sendBack: false, merge: false, writeTasks: false, markDone: false },
  mergeMethod: null, mergeMode: null, deleteBranch: null,
  limits: { hours: null, tasks: null, tasksAtATime: null, sendBacks: null, usagePercent: null },
  workRules: [], reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false, followUps: true,
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
// Actions saved before an action existed read it as off.
export const normalizeArilActions = (value) => ({ ...defaults().actions, ...value });
function currentSettings(value) {
  const saved = JSON.parse(value);
  return { ...defaults(), ...saved, actions: normalizeArilActions(saved.actions ?? {}), limits: normalizeArilLimits(saved.limits ?? {}) };
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
const legacyEntry = (row) => ({ id: Number(row.id), text: row.text, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });
const legacyRows = (database, repositoryId) => preparedStatement(database,
  "SELECT id, text, created_at, updated_at FROM aril_memory WHERE repository_id = ? ORDER BY created_at, id").all(repositoryId).map(legacyEntry);

/**
 * A repository's memory: `{ text, previous, updatedAt, updatedBy }`. The text is the stored one; before it is stored, the older lines of
 * the repository read as text (one `- ` line each, oldest first), so the memory is whole while a migration has not succeeded. `previous`
 * is the text before the last change (null when there was none), and `updatedBy` is `owner` or `aril`.
 */
export function readArilMemory(database, repositoryId) {
  const row = preparedStatement(database, "SELECT text, previous, updated_at, updated_by FROM aril_memory_text WHERE repository_id = ?").get(repositoryId);
  if (row) return { text: row.text, previous: row.previous ?? null, updatedAt: Number(row.updated_at), updatedBy: row.updated_by === "aril" ? "aril" : "owner" };
  const rows = legacyRows(database, repositoryId);
  if (rows.length === 0) return { text: "", previous: null, updatedAt: null, updatedBy: null };
  const legacy = legacyMemory(rows);
  return { text: legacy.text, previous: legacy.previous, updatedAt: legacy.updatedAt, updatedBy: "owner" };
}

// Writes the text and removes the repository's older lines in the caller's transaction: both stand or neither does.
function writeMemory(database, repositoryId, { text, previous, at, by }) {
  preparedStatement(database, `INSERT INTO aril_memory_text (repository_id, text, previous, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repository_id) DO UPDATE SET text = excluded.text, previous = excluded.previous, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(repositoryId, text, previous, at, by);
  preparedStatement(database, "DELETE FROM aril_memory WHERE repository_id = ?").run(repositoryId);
}

/**
 * Moves every repository's older memory lines into its text, once. Each repository is its own transaction that writes the text and deletes
 * the lines together, so a failure leaves that repository's lines exactly where they were, still read as its memory. It never throws.
 */
export function migrateArilMemory(database) {
  let repositories = [];
  try { repositories = preparedStatement(database, "SELECT DISTINCT repository_id FROM aril_memory").all().map((row) => row.repository_id); } catch { return; }
  for (const repositoryId of repositories) {
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        if (preparedStatement(database, "SELECT 1 FROM aril_memory_text WHERE repository_id = ?").get(repositoryId) === undefined) {
          const { text, previous, updatedAt } = legacyMemory(legacyRows(database, repositoryId));
          writeMemory(database, repositoryId, { text, previous, at: updatedAt ?? Date.now(), by: "owner" });
        } else preparedStatement(database, "DELETE FROM aril_memory WHERE repository_id = ?").run(repositoryId);
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* connection may already be unusable */ }
        throw error;
      }
    } catch { /* The lines stay as they are and are read as the memory; the next open tries again. */ }
  }
}

// settledAt is when the owner last settled the settings (the row's update time), or null while nothing is stored.
export function readAril(database, repositoryId) {
  const row = preparedStatement(database, "SELECT updated_at FROM aril_settings WHERE repository_id = ?").get(repositoryId);
  const settledAt = row ? new Date(Number(row.updated_at)).toISOString() : null;
  return { settings: { ...readSettings(database, repositoryId), settledAt }, memory: readArilMemory(database, repositoryId) };
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

// `pairedDevices` is the first version's per-repository permission for paired devices. It stays stored and served, read only by desktop main's one-time
// carry-over to the owner's one global permission, and no action sets it any more: the permission is the Aril switch's `pairedOn`.
const SETTABLE = Object.freeze(Object.keys(defaults()).filter((field) => field !== "pairedDevices"));

export function arilSettingsSet({ database, repositoryId, ensureRepository, now }, payload) {
  const base = defaults();
  if (!exact(payload, ["settings"]) || !keys(payload.settings, SETTABLE)) return invalid();
  const input = payload.settings;
  for (const [field, value] of Object.entries(input)) {
    if (field === "actions" && (!exact(value, Object.keys(base.actions)) || !Object.values(value).every((v) => typeof v === "boolean"))) return invalid();
    if (field === "mergeMethod" && value !== null && !["squash", "merge", "rebase"].includes(value)) return invalid();
    if (field === "mergeMode" && ![null, "direct", "auto"].includes(value)) return invalid();
    if (field === "deleteBranch" && ![null, true, false].includes(value)) return invalid();
    if (field === "limits" && (!exact(value, Object.keys(bounds)) || !Object.entries(value).every(([key, v]) => v === null
      || (Number.isInteger(v) && v >= bounds[key][0] && v <= bounds[key][1])))) return invalid();
    if (field === "workRules" && (!Array.isArray(value) || value.length > 20 || !value.every((rule) => validRule(database, repositoryId, rule)))) return invalid();
    if (field === "reviewer" && (!exact(value, Object.keys(base.reviewer)) || ![null, "claude", "codex"].includes(value.provider)
      || normalizeModelIdentifier(value.model) === undefined || typeof value.differentFromBuilder !== "boolean")) return invalid();
    if (field === "followUps" && typeof value !== "boolean") return invalid();
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

/** The owner replaces a repository's memory text whole. The text before the change is kept as `previous`. `limit` is a text over 6,000 characters. */
export function arilMemorySet({ database, repositoryId, ensureRepository, now }, payload) {
  if (!exact(payload, ["text"]) || typeof payload.text !== "string") return invalid();
  const text = normalizeMemoryText(payload.text);
  if (text.length > ARIL_MEMORY.textLength) return { ok: false, error: "limit" };
  if (!isMemoryText(text)) return invalid();
  const current = readArilMemory(database, repositoryId);
  if (text === current.text) return { ok: true, memory: current };
  ensureRepository(database, repositoryId);
  const memory = { text, previous: current.text, updatedAt: now(), updatedBy: "owner" };
  writeMemory(database, repositoryId, { text, previous: current.text, at: memory.updatedAt, by: "owner" });
  return { ok: true, memory };
}

/**
 * Aril's update of a repository's memory, applied to the text as it is now: lines to add and lines to remove (`applyMemoryUpdate`).
 * Answers `{ ok: true, added, removed }`, with zero counts when nothing changed, or `invalid`, `not_found` (a line to remove is not there),
 * or `limit` (the result would pass 6,000 characters). Only desktop main reaches it.
 */
export function arilMemoryApply({ database, repositoryId, ensureRepository, now }, payload) {
  if (!exact(payload, ["add", "remove"])) return invalid();
  const current = readArilMemory(database, repositoryId);
  const result = applyMemoryUpdate(current.text, payload);
  if (!result.ok) return { ok: false, error: result.error === "too_long" ? "limit" : result.error };
  if (result.added + result.removed === 0) return { ok: true, added: 0, removed: 0 };
  ensureRepository(database, repositoryId);
  writeMemory(database, repositoryId, { text: result.text, previous: current.text, at: now(), by: "aril" });
  return { ok: true, added: result.added, removed: result.removed };
}
