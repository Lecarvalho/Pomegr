
import crypto from "node:crypto";
import { bindReview } from "./task-review.mjs";
import { CHECK_LABELS, digestOf, featureLine, TASK_START_PROVIDERS, TOKEN_PATTERN } from "./task-dispatch-parts.mjs";
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { moveTaskToRole } from "./task-columns.mjs";
import { recordTaskEvent } from "./task-events.mjs";
import { TASK_DISPATCH_UNBOUND_TTL_MS, isLive, parseStoredDispatch } from "./task-dispatch-standing.mjs";
import { withTaskRemoteControl } from "./task-remote-control.mjs";
import { taskSourceOf, withTaskSource } from "./task-source.mjs";
import { taskRunsInGroup } from "./task-groups.mjs";
import { withTaskKeepWorktree } from "./task-worktree-cleanup.mjs";
import { TASK_IMAGE_MARKER, isRepositoryId, isTaskId, isTaskSessionId, normalizeStoredTask } from "./task-record.mjs";

export { TASK_DISPATCH_UNBOUND_TTL_MS };

export const TASK_START_ERRORS = Object.freeze(["invalid", "not_found", "not_startable", "unsupported_provider", "plugin_missing", "gate_held", "tree_dirty", "unavailable"]);

const STARTABLE_STATES = new Set(["not_queued", "queued", "scheduled"]);
export { TASK_START_PROVIDERS };
export const TASK_PROMPT_OPENING = "You are working on one task from the Pomegr task board.";


function issueLine(task) {
  const source = taskSourceOf(task.source?.kind === "github_issue" ? task.source.number : undefined);
  return source === null ? [] : [`This task comes from GitHub issue #${source.number}. Write "Closes #${source.number}" in the pull request description.`];
}

// A task's images are files in the private task store.
function imageLines(images) {
  if (images.length === 0) return [];
  return [
    images.length === 1
      ? "The task has 1 attached image. The task text shows where it belongs as [Image #1]. Read it before you start:"
      : `The task has ${images.length} attached images. The task text shows where each belongs as [Image #n]. Read each one before you start:`,
    ...images.map((image, index) => `- [Image #${index + 1}] ${image.file}`),
  ];
}

function promptText(text, images) {
  const numbers = new Map(images.map((image, index) => [image.id, index + 1]));
  return text.replace(TASK_IMAGE_MARKER, (_marker, id) => (numbers.has(id) ? `[Image #${numbers.get(id)}]` : "[image]"));
}


// The fixed session prompt.
export function buildTaskPrompt(task, images = [], feature = null) {
  const conditions = task.completeWhen.checks.map((check) => `- ${CHECK_LABELS[check]}`);
  if (task.completeWhen.own) conditions.push(`- ${task.completeWhen.own}`);
  return [
    TASK_PROMPT_OPENING,
    `Task ${task.id}:`,
    promptText(task.text, images),
    ...imageLines(images),
    ...featureLine(feature),
    "Complete when:",
    ...(conditions.length > 0 ? conditions : ["- No condition is checked: your report alone completes the task."]),
    ...issueLine(task),
    "When the task is complete, call the Pomegr MCP tool complete_task. It puts the task in Review for the owner. It takes two optional fields: attention, one line for what needs the owner's attention, and task_id, only when you have more than one task. A finished task with nothing to flag is reported with no field. If you cannot proceed, call the Pomegr MCP tool block_task with a short reason. The latest report wins until the owner marks the task done. Reporting completion after a block runs the checks and moves the task to Review, but keeps the queue hold until the owner chooses Mark done or Requeue.",
  ].join("\n");
}

function taskNumber(payload, keys) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (!Object.keys(payload).every((key) => keys.includes(key)) || !keys.every((key) => Object.hasOwn(payload, key))) return undefined;
  return isTaskId(payload.id) ? Number(payload.id.slice(2)) : undefined;
}

const loadRow = (database, repositoryId, number) =>
  withTaskKeepWorktree(database, withTaskRemoteControl(database, withTaskSource(database, preparedStatement(database, "SELECT * FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, number))));

// A member of a parallel group starts in its own worktree; every other task starts in the repository root.
const worktreeRequired = (database, row) => taskRunsInGroup(database, row.repository_id, Number(row.number));

const startable = (row, now) => STARTABLE_STATES.has(row.state) && (row.session_id ?? null) === null
  && !isLive(parseStoredDispatch(row.dispatch_token), now);

// `start-plan`.
export function startPlan({ database, transaction, repositoryId, payload, resolveFacts, gatesHold, imagePaths = null, featureOf = null, now }) {
  const separate = payload !== null && typeof payload === "object" && !Array.isArray(payload) && Object.hasOwn(payload, "worktree");
  if (separate && payload.worktree !== true) return { ok: false, error: "invalid" };
  const number = isRepositoryId(repositoryId) ? taskNumber(payload, separate ? ["id", "worktree"] : ["id"]) : undefined;
  if (number === undefined) return { ok: false, error: "invalid" };
  const row = loadRow(database, repositoryId, number);
  if (!row) return { ok: false, error: "not_found" };
  const task = normalizeStoredTask(row);
  if (!task) return { ok: false, error: "unavailable" };
  const at = now();
  if (!startable(row, at)) return { ok: false, error: "not_startable" };
  const provider = task.run.provider ?? "claude";
  if (!TASK_START_PROVIDERS.includes(provider)) return { ok: false, error: "unsupported_provider" };
  let facts;
  try { facts = resolveFacts(provider); } catch { facts = null; }
  if (typeof facts?.root !== "string" || facts.root.length === 0) return { ok: false, error: "unavailable" };
  if (facts.pluginReady !== true) return { ok: false, error: "plugin_missing" };
  const held = gatesHold(task.id);
  if (held === "tree_dirty" ? !separate : held !== false) return { ok: false, error: held === "tree_dirty" ? "tree_dirty" : "gate_held" };
  const token = crypto.randomBytes(32).toString("base64url");
  const minted = transaction(() => {
    // The state may have moved since the read above; the mint stands only if the task is still startable.
    const fresh = loadRow(database, repositoryId, number);
    if (!fresh || !startable(fresh, at)) return null;
    preparedStatement(database, "UPDATE tasks SET dispatch_token = ? WHERE repository_id = ? AND number = ?")
      .run(`${digestOf(token)}:${at}`, repositoryId, number);
    return { worktree: separate || worktreeRequired(database, fresh) };
  });
  if (!minted) return { ok: false, error: "not_startable" };
  // The images the task holds now are the ones the session gets; one attached later is not sent to it.
  let images = [];
  try { images = (typeof imagePaths === "function" ? imagePaths(task.id) : []).filter((image) => typeof image?.id === "string" && typeof image.file === "string"); } catch { images = []; }
  let feature = null;
  try { feature = task.featureId !== null && typeof featureOf === "function" ? featureOf(task.featureId) : null; } catch { feature = null; }
  return {
    ok: true,
    plan: {
      taskId: task.id, provider, model: task.run.model, effort: task.run.effort, remoteControl: provider === "claude" && task.run.remoteControl,
      repositoryRoot: facts.root, worktree: minted.worktree, prompt: buildTaskPrompt(task, images, feature), images: images.map((image) => image.file), token,
    },
  };
}

// `start-abort`: clears the unbound dispatch only when the token matches.
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

const BIND_REFUSED = Object.freeze({ ok: false, error: "not_found" });

export function bindDispatch({ database, transaction, payload, now }) {
  const shaped = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    && Object.keys(payload).length === 2 && Object.hasOwn(payload, "token") && Object.hasOwn(payload, "sessionId");
  if (!shaped || typeof payload.token !== "string" || !TOKEN_PATTERN.test(payload.token) || !isTaskSessionId(payload.sessionId)) {
    return { ok: false, error: "invalid" };
  }
  const supplied = Buffer.from(digestOf(payload.token), "hex");
  const at = now();
  return transaction(() => {
    // Every unlinked dispatch is compared, so the time taken does not depend on which row matches.
    let match = null;
    const candidates = preparedStatement(database, "SELECT repository_id, number, dispatch_token FROM tasks WHERE session_id IS NULL AND dispatch_token IS NOT NULL").all();
    for (const row of candidates) {
      const stored = parseStoredDispatch(row.dispatch_token);
      const matches = stored !== null && crypto.timingSafeEqual(supplied, Buffer.from(stored.digest, "hex"));
      if (matches && isLive(stored, at)) match = row;
    }
    if (match === null) return bindReview(database, supplied, payload.sessionId, at);
    if (preparedStatement(database, "SELECT 1 FROM tasks WHERE session_id = ?").get(payload.sessionId) !== undefined) return BIND_REFUSED;
    try {
      const linked = preparedStatement(database, "UPDATE tasks SET session_id = ?, dispatch_token = NULL, updated_at = ? WHERE repository_id = ? AND number = ? AND session_id IS NULL AND dispatch_token = ?")
        .run(payload.sessionId, Date.now(), match.repository_id, match.number, match.dispatch_token);
      if (Number(linked.changes) !== 1) return BIND_REFUSED;
      recordTaskEvent(database, match.repository_id, Number(match.number), "started", at, payload.sessionId);
      moveTaskToRole(database, match.repository_id, Number(match.number), "in_progress");
      return { ok: true };
    } catch (error) {
      if (/constraint/iu.test(String(error?.message))) return BIND_REFUSED;
      throw error;
    }
  });
}
