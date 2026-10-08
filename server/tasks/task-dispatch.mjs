// Session dispatch for one task: the start plan the desktop turns into a terminal, and its abort.
//
// A plan is minted only after every refusal passed. The opaque token leaves this module once, inside
// the plan; the store keeps only its SHA-256 digest and the mint time, in the existing `dispatch_token`
// column as `<digest>:<mintMs>`, so no schema change is needed. The digest is never projected onto the
// board. Task text is untrusted: it is concatenated only into the fixed prompt string, never into a
// path or command line. Start gates (capacity, incident, clean tree, previous step) belong to a later part.

import crypto from "node:crypto";
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isRepositoryId, isTaskId, normalizeStoredTask } from "./task-record.mjs";

/** An unbound dispatch is live for this long after its mint; a session start binds it earlier (a later part). */
export const TASK_DISPATCH_UNBOUND_TTL_MS = 10 * 60 * 1000;
export const TASK_START_ERRORS = Object.freeze(["invalid", "not_found", "not_startable", "unsupported_provider", "plugin_missing", "unavailable"]);

const STARTABLE_STATES = new Set(["not_queued", "queued", "scheduled"]);
const STORED_DISPATCH = /^([0-9a-f]{64}):(\d{1,16})$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const CHECK_LABELS = Object.freeze({
  pr_open: "Pull request open",
  tree_clean: "Working tree clean",
  commit_on_branch: "Commit on task branch",
  pr_merged: "Pull request merged",
  ci_passed: "CI passed",
});
export const TASK_PROMPT_OPENING = "You are working on one task from the Pomegr task board.";

const digestOf = (token) => crypto.createHash("sha256").update(token, "utf8").digest("hex");

/**
 * The fixed session prompt. It begins with a fixed non-dash sentence, so it can never parse as a CLI
 * flag, and holds the task text only as quoted data between fixed sentences.
 */
export function buildTaskPrompt(task) {
  const conditions = task.doneWhen.checks.map((check) => `- ${CHECK_LABELS[check]}`);
  if (task.doneWhen.own) conditions.push(`- ${task.doneWhen.own}`);
  return [
    TASK_PROMPT_OPENING,
    `Task ${task.id}:`,
    task.text,
    "Done when:",
    ...(conditions.length > 0 ? conditions : ["- No condition is checked: your report alone completes the task."]),
    "When the task is done, call the Pomegr MCP tool complete_task. If you cannot proceed, call the Pomegr MCP tool block_task with a short reason.",
  ].join("\n");
}

function parseStoredDispatch(value) {
  const match = typeof value === "string" ? STORED_DISPATCH.exec(value) : null;
  return match ? { digest: match[1], mintedAt: Number(match[2]) } : null;
}

const isLive = (stored, now) => stored !== null && now - stored.mintedAt < TASK_DISPATCH_UNBOUND_TTL_MS && now >= stored.mintedAt;

function taskNumber(payload, keys) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (!Object.keys(payload).every((key) => keys.includes(key)) || !keys.every((key) => Object.hasOwn(payload, key))) return undefined;
  return isTaskId(payload.id) ? Number(payload.id.slice(2)) : undefined;
}

const loadRow = (database, repositoryId, number) =>
  preparedStatement(database, "SELECT * FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, number);

// Startable: a startable state, no linked session, no live dispatch.
const startable = (row, now) => STARTABLE_STATES.has(row.state) && (row.session_id ?? null) === null
  && !isLive(parseStoredDispatch(row.dispatch_token), now);

/**
 * `start-plan`. `resolveFacts()` returns `{ root, pluginReady }` from committed facts and is called only
 * after the task, provider, and state refusals. `transaction(work)` runs `work` in one write transaction.
 */
export function startPlan({ database, transaction, repositoryId, payload, resolveFacts, now }) {
  const number = isRepositoryId(repositoryId) ? taskNumber(payload, ["id"]) : undefined;
  if (number === undefined) return { ok: false, error: "invalid" };
  const row = loadRow(database, repositoryId, number);
  if (!row) return { ok: false, error: "not_found" };
  const task = normalizeStoredTask(row);
  if (!task) return { ok: false, error: "unavailable" };
  const at = now();
  if (!startable(row, at)) return { ok: false, error: "not_startable" };
  if ((task.run.provider ?? "claude") !== "claude") return { ok: false, error: "unsupported_provider" };
  let facts;
  try { facts = resolveFacts(); } catch { facts = null; }
  if (typeof facts?.root !== "string" || facts.root.length === 0) return { ok: false, error: "unavailable" };
  if (facts.pluginReady !== true) return { ok: false, error: "plugin_missing" };
  const token = crypto.randomBytes(32).toString("base64url");
  const minted = transaction(() => {
    // The state may have moved since the read above; the mint stands only if the task is still startable.
    const fresh = loadRow(database, repositoryId, number);
    if (!fresh || !startable(fresh, at)) return false;
    preparedStatement(database, "UPDATE tasks SET dispatch_token = ? WHERE repository_id = ? AND number = ?")
      .run(`${digestOf(token)}:${at}`, repositoryId, number);
    return true;
  });
  if (!minted) return { ok: false, error: "not_startable" };
  return {
    ok: true,
    plan: {
      taskId: task.id, provider: "claude", model: task.run.model, effort: task.run.effort,
      repositoryRoot: facts.root, prompt: buildTaskPrompt(task), token,
    },
  };
}

/** `start-abort`: clears the unbound dispatch only when the token matches. Idempotent for an existing task. */
export function startAbort({ database, transaction, repositoryId, payload }) {
  const number = isRepositoryId(repositoryId) ? taskNumber(payload, ["id", "token"]) : undefined;
  if (number === undefined || typeof payload.token !== "string" || !TOKEN_PATTERN.test(payload.token)) return { ok: false, error: "invalid" };
  const row = loadRow(database, repositoryId, number);
  if (!row) return { ok: false, error: "not_found" };
  const stored = parseStoredDispatch(row.dispatch_token);
  if (stored !== null) {
    const supplied = Buffer.from(digestOf(payload.token), "hex");
    const matches = crypto.timingSafeEqual(supplied, Buffer.from(stored.digest, "hex"));
    if (matches) {
      transaction(() => {
        preparedStatement(database, "UPDATE tasks SET dispatch_token = NULL WHERE repository_id = ? AND number = ? AND dispatch_token = ?")
          .run(repositoryId, number, row.dispatch_token);
      });
    }
  }
  return { ok: true };
}
