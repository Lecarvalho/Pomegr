// Shared setup for the queue tests: a temporary task store with a controllable clock, and raw access to
// its private file for the facts no action sets (a task's session, a stored dispatch, the queue status).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

export const REPOSITORY = `repo-${"a1".repeat(12)}`;
export const OTHER_REPOSITORY = `repo-${"b2".repeat(12)}`;
export const FACTS = Object.freeze({ root: "C:/Work/SECRET-ROOT/repo", pluginReady: true });
/** Start-gate facts that let every start through, and the resolver the store takes. */
export const GATE_FACTS = Object.freeze({
  usage: { claude: { fiveHourPercent: 10, sevenDayPercent: 10 }, codex: { fiveHourPercent: 10, sevenDayPercent: 10 } },
  providerStatus: { claude: "operational", codex: "operational" },
  treeClean: true,
});
export const passingGates = () => GATE_FACTS;
export const SESSION = "claude:0b8f2c1e-1111-4222-8333-444455556666";
export const START_TIME = 1_000_000;
const DIGEST = "ab".repeat(32);

export async function removeDirectory(directory) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await rm(directory, { recursive: true, force: true }); return; } catch (error) {
      if (attempt === 19 || (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** A store in a temporary directory whose clock only moves when the test moves `clock.now`. */
export async function openTemporaryStore(context, prefix = "pomegr-task-queue-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const clock = { now: START_TIME };
  const store = openTaskStore({ directory, now: () => clock.now });
  context.after(async () => {
    store.close();
    await removeDirectory(directory);
  });
  return { store, clock, directory };
}

export function withDatabase(directory, work) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  try { return work(database); } finally { database.close(); }
}

/** `repo-` plus 24 hex characters made from a number, so a test can mint many ordered repositories. */
export const repositoryNumber = (number) => `repo-${number.toString(16).padStart(24, "0")}`;

export function createTask(store, repositoryId = REPOSITORY, payload = {}) {
  const result = store.apply(repositoryId, "create", { text: "task text", ...payload });
  assert.equal(result.ok, true);
  return result.board;
}

export const queueTask = (store, id, repositoryId = REPOSITORY) => assert.equal(store.apply(repositoryId, "queue_add", { id }).ok, true);
export const queueSettings = (store, on, repositoryId = REPOSITORY) => store.apply(repositoryId, "queue_settings", { on });

/** Writes any task columns straight into the file. */
export function updateTask(directory, number, columns, repositoryId = REPOSITORY) {
  const names = Object.keys(columns);
  return withDatabase(directory, (database) => database.prepare(`UPDATE tasks SET ${names.map((name) => `${name} = ?`).join(", ")} WHERE repository_id = ? AND number = ?`)
    .run(...names.map((name) => columns[name]), repositoryId, number));
}

export const setQueueRow = (directory, status, blockedBy = null, repositoryId = REPOSITORY) =>
  withDatabase(directory, (database) => database.prepare("UPDATE repositories SET queue_status = ?, queue_blocked_by = ? WHERE repository_id = ?").run(status, blockedBy, repositoryId));
export const queueRow = (directory, repositoryId = REPOSITORY) =>
  withDatabase(directory, (database) => ({ ...database.prepare("SELECT queue_status, queue_blocked_by FROM repositories WHERE repository_id = ?").get(repositoryId) }));
export const metaValue = (directory, key) => withDatabase(directory, (database) => database.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null);
export const setMeta = (directory, key, value) => withDatabase(directory, (database) =>
  database.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value));
export const pauseReasonKey = (repositoryId = REPOSITORY) => `queue_pause_reason:${repositoryId}`;
export const storedDispatch = (directory, number, repositoryId = REPOSITORY) =>
  withDatabase(directory, (database) => database.prepare("SELECT dispatch_token FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, number).dispatch_token);

/** A stored dispatch value as `startPlan` writes it: a digest and the mint time. */
export const dispatchMintedAt = (mintedAt) => `${DIGEST}:${mintedAt}`;

/** Writes a task's stored start: a dispatch minted at `mintedAt` and/or a linked session, and optionally its state. */
export function startedTask(directory, number, { mintedAt = null, session = null, state = undefined, repositoryId = REPOSITORY } = {}) {
  updateTask(directory, number, {
    dispatch_token: mintedAt === null ? null : dispatchMintedAt(mintedAt), session_id: session, ...(state === undefined ? {} : { state }),
  }, repositoryId);
}
