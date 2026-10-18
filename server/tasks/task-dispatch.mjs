
import crypto from "node:crypto";
import { taskStartRevision } from "../../shared/task-start-revision.mjs";
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { moveTaskToRole } from "./task-columns.mjs";
import { TASK_DISPATCH_UNBOUND_TTL_MS, isLive, parseStoredDispatch } from "./task-dispatch-standing.mjs";
import { withTaskRemoteControl } from "./task-remote-control.mjs";
import { taskSourceOf, withTaskSource } from "./task-source.mjs";
import { taskRunsInGroup } from "./task-groups.mjs";
import { withTaskKeepWorktree } from "./task-worktree-cleanup.mjs";
import { TASK_IMAGE_MARKER, isRepositoryId, isTaskId, isTaskSessionId, normalizeRun, normalizeStoredTask } from "./task-record.mjs";

export { TASK_DISPATCH_UNBOUND_TTL_MS };

export const TASK_START_ERRORS = Object.freeze(["invalid", "not_found", "not_startable", "unsupported_provider", "plugin_missing", "gate_held", "tree_dirty", "already_attempted", "unavailable"]);

const STARTABLE_STATES = new Set(["not_queued", "queued", "scheduled"]);
export const TASK_START_PROVIDERS = Object.freeze(["claude", "codex"]);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const CHECK_LABELS = Object.freeze({
  pr_open: "Pull request open",
  tree_clean: "Working tree clean",
  commit_on_branch: "Commit on task branch",
  pr_merged: "Pull request merged",
  ci_passed: "CI passed",
  user_validated: "Validated with the user",
});
export const TASK_PROMPT_OPENING = "You are working on one task from the Pomegr task board.";

const digestOf = (token) => crypto.createHash("sha256").update(token, "utf8").digest("hex");

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

// The feature's title and ID only: the session reads the rest with `get_feature` when it needs it.
function featureLine(feature) {
  if (typeof feature?.id !== "string" || typeof feature.title !== "string") return [];
  return [`This task is part of the feature "${feature.title}" (${feature.id}). When you need the feature's description or app version, call the Pomegr MCP tool get_feature.`];
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

const sameRun = (left, right) => left.provider === right.provider && left.model === right.model && left.effort === right.effort
  && (left.remoteControl === true) === (right.remoteControl === true) && (left.keepWorktree === true) === (right.keepWorktree === true);

function autonomousInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Object.keys(value).every((key) => ["attemptId", "expectedUpdatedAt", "expectedTaskDigest", "expectedRun", "run"].includes(key))
    || !Object.hasOwn(value, "expectedRun")
    || typeof value.attemptId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.attemptId)
    || typeof value.expectedTaskDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.expectedTaskDigest)
    || typeof value.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(value.expectedUpdatedAt))) return null;
  const expectedRun = normalizeRun(value.expectedRun);
  const run = Object.hasOwn(value, "run") ? normalizeRun(value.run) : null;
  return expectedRun && (run === null || run && run.provider !== null) ? { ...value, expectedRun, run } : null;
}

// `start-plan`.
export function startPlan({ database, transaction, repositoryId, payload, resolveFacts, gatesHold, taskOf = null, imagePaths = null, featureOf = null, now }) {
  const separate = payload !== null && typeof payload === "object" && !Array.isArray(payload) && Object.hasOwn(payload, "worktree");
  if (separate && payload.worktree !== true) return { ok: false, error: "invalid" };
  const autonomous = payload && Object.hasOwn(payload, "autonomous") ? autonomousInput(payload.autonomous) : undefined;
  if (autonomous === null) return { ok: false, error: "invalid" };
  const number = isRepositoryId(repositoryId) ? taskNumber(payload, ["id", ...(separate ? ["worktree"] : []), ...(autonomous ? ["autonomous"] : [])]) : undefined;
  if (number === undefined) return { ok: false, error: "invalid" };
  const row = loadRow(database, repositoryId, number);
  if (!row) return { ok: false, error: "not_found" };
  let task = normalizeStoredTask(row);
  if (!task) return { ok: false, error: "unavailable" };
  const attemptKey = autonomous ? `autonomous_start:${repositoryId}:${digestOf(autonomous.attemptId)}` : null;
  if (attemptKey && preparedStatement(database, "SELECT 1 FROM meta WHERE key = ?").get(attemptKey)) return { ok: false, error: "already_attempted" };
  if (autonomous && (task.updatedAt !== autonomous.expectedUpdatedAt || !sameRun(task.run, autonomous.expectedRun))) return { ok: false, error: "not_startable" };
  // An explicit provider (including its default model) is the owner's selection. Only an unset provider may be filled.
  const selectedRun = autonomous?.run && task.run.provider === null
    ? normalizeRun({ ...task.run, provider: autonomous.run.provider, model: autonomous.run.model, effort: task.run.effort ?? autonomous.run.effort }) : task.run;
  if (!selectedRun) return { ok: false, error: "invalid" };
  task = { ...task, run: selectedRun };
  const at = now();
  if (!startable(row, at)) return { ok: false, error: "not_startable" };
  const provider = task.run.provider ?? "claude";
  if (!TASK_START_PROVIDERS.includes(provider)) return { ok: false, error: "unsupported_provider" };
  let facts;
  try { facts = resolveFacts(provider); } catch { facts = null; }
  if (typeof facts?.root !== "string" || facts.root.length === 0) return { ok: false, error: "unavailable" };
  if (facts.pluginReady !== true) return { ok: false, error: "plugin_missing" };
  const token = crypto.randomBytes(32).toString("base64url");
  const minted = transaction(() => {
    // The state may have moved since the read above; the mint stands only if the task is still startable.
    const fresh = loadRow(database, repositoryId, number);
    if (!fresh || !startable(fresh, at)) return { error: "not_startable" };
    const freshTask = normalizeStoredTask(fresh);
    if (!freshTask || JSON.stringify(fresh) !== JSON.stringify(row)) return { error: "not_startable" };
    if (attemptKey && preparedStatement(database, "SELECT 1 FROM meta WHERE key = ?").get(attemptKey)) return { error: "already_attempted" };
    if (autonomous) {
      const committed = typeof taskOf === "function" ? taskOf(task.id) : null;
      if (!committed || taskStartRevision(committed) !== autonomous.expectedTaskDigest) return { error: "not_startable" };
    }
    const held = gatesHold(task.id, { run: selectedRun, autonomous: autonomous !== undefined });
    if (held === "tree_dirty" ? !separate : held !== false) return { error: held === "tree_dirty" ? "tree_dirty" : "gate_held" };
    if (autonomous) {
      preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?)").run(attemptKey, task.id);
      preparedStatement(database, "UPDATE tasks SET run_provider = ?, run_model = ?, run_effort = ? WHERE repository_id = ? AND number = ?")
        .run(selectedRun.provider, selectedRun.model, selectedRun.effort, repositoryId, number);
    }
    preparedStatement(database, "UPDATE tasks SET dispatch_token = ? WHERE repository_id = ? AND number = ?")
      .run(`${digestOf(token)}:${at}${autonomous ? ":autonomous" : ""}`, repositoryId, number);
    return { worktree: separate || worktreeRequired(database, fresh) };
  });
  if (minted.error) return { ok: false, error: minted.error };
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

// Recheck the committed start gates after native worktree preparation. It never mints or returns a plan.
export function startCheck({ database, repositoryId, payload, gatesHold, now }) {
  const separate = payload !== null && typeof payload === "object" && !Array.isArray(payload) && Object.hasOwn(payload, "worktree");
  if (separate && payload.worktree !== true) return { ok: false, error: "invalid" };
  const number = isRepositoryId(repositoryId) ? taskNumber(payload, ["id", "token", ...(separate ? ["worktree"] : [])]) : undefined;
  if (number === undefined || typeof payload.token !== "string" || !TOKEN_PATTERN.test(payload.token)) return { ok: false, error: "invalid" };
  const row = loadRow(database, repositoryId, number);
  const stored = parseStoredDispatch(row?.dispatch_token);
  if (!row || !stored?.autonomous || !isLive(stored, now()) || (row.session_id ?? null) !== null || !STARTABLE_STATES.has(row.state)
    || !crypto.timingSafeEqual(Buffer.from(digestOf(payload.token), "hex"), Buffer.from(stored.digest, "hex"))) return { ok: false, error: "not_startable" };
  const held = gatesHold(payload.id, { autonomous: true, ignoreOwnClaim: true, separateWorktree: separate });
  return held === false ? { ok: true } : { ok: false, error: held === "tree_dirty" ? "tree_dirty" : "gate_held" };
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
    if (match === null) return BIND_REFUSED;
    if (preparedStatement(database, "SELECT 1 FROM tasks WHERE session_id = ?").get(payload.sessionId) !== undefined) return BIND_REFUSED;
    try {
      const linked = preparedStatement(database, "UPDATE tasks SET session_id = ?, dispatch_token = NULL, updated_at = ? WHERE repository_id = ? AND number = ? AND session_id IS NULL AND dispatch_token = ?")
        .run(payload.sessionId, Date.now(), match.repository_id, match.number, match.dispatch_token);
      if (Number(linked.changes) !== 1) return BIND_REFUSED;
      moveTaskToRole(database, match.repository_id, Number(match.number), "in_progress");
      return { ok: true };
    } catch (error) {
      if (/constraint/iu.test(String(error?.message))) return BIND_REFUSED;
      throw error;
    }
  });
}
