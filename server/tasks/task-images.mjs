// Images attached to a task. They are user-authored content like the task text and live only in the private task
// store: the bytes as one file per image under `images/<repositoryId>/<taskId>/` beside the database, and the list of a
// task's images in the existing `meta` table under `task_images:<repositoryId>:<taskId>`, so the schema version does
// not change. The list is the authority: a file no list names is never served, and a listed image whose file is gone
// reads as `not_found`. A file name is built from validated identifiers only, never from anything the user typed.
//
// The type is decided here from the leading bytes, never from a name or a declared type. Only the four raster formats
// below are kept; anything else is refused before a byte is written.

import crypto from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { TASK_BOUNDS, isRepositoryId, isTaskId, normalizeStoredImages } from "./task-record.mjs";

const IMAGE_DIRECTORY = "images";
const IMAGE_ID = /^img-[0-9a-f]{12}$/u;
const EXTENSIONS = Object.freeze({ png: "png", jpeg: "jpg", gif: "gif", webp: "webp" });
const keyOf = (repositoryId, taskId) => `task_images:${repositoryId}:${taskId}`;
const prefixOf = (repositoryId) => `task_images:${repositoryId}:`;

const startsWith = (bytes, signature, offset = 0) => bytes.length >= offset + signature.length
  && signature.every((value, index) => bytes[offset + index] === value);

/** The fixed type of an image from its leading bytes, or null when it is none of the four. */
export function sniffImageType(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

function parseList(value) {
  if (typeof value !== "string") return [];
  try { return normalizeStoredImages(JSON.parse(value)); } catch { return []; }
}

/** Every stored image list of one repository as `Map<taskNumber, { id, type, bytes }[]>`. */
export function readTaskImages(database, repositoryId) {
  const images = new Map();
  if (!isRepositoryId(repositoryId)) return images;
  const prefix = prefixOf(repositoryId);
  const rows = preparedStatement(database, "SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix);
  for (const row of rows) {
    const taskId = String(row.key).slice(prefix.length);
    if (isTaskId(taskId)) images.set(Number(taskId.slice(2)), parseList(row.value));
  }
  return images;
}

function readList(database, repositoryId, taskId) {
  return parseList(preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(keyOf(repositoryId, taskId))?.value);
}

function writeList(database, repositoryId, taskId, list) {
  if (list.length === 0) {
    preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(keyOf(repositoryId, taskId));
    return;
  }
  preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(keyOf(repositoryId, taskId), JSON.stringify(list));
}

/** Drops a deleted task's list. The caller owns the transaction; the files go after it commits. */
export function deleteTaskImageList(database, repositoryId, taskNumber) {
  preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(keyOf(repositoryId, `T-${taskNumber}`));
}

const taskDirectory = (directory, repositoryId, taskId) => path.join(directory, IMAGE_DIRECTORY, repositoryId, taskId);
const imageFile = (directory, repositoryId, taskId, image) => path.join(taskDirectory(directory, repositoryId, taskId), `${image.id}.${EXTENSIONS[image.type]}`);

/** Removes the image files of one task. Best effort and never throws: a task number is never reused, so a leftover file is never served. */
export function removeTaskImageFiles(directory, repositoryId, taskId) {
  if (typeof directory !== "string" || !isRepositoryId(repositoryId) || !isTaskId(taskId)) return;
  try { rmSync(taskDirectory(directory, repositoryId, taskId), { recursive: true, force: true }); } catch { /* left behind, never served */ }
}

const taskExists = (database, repositoryId, taskId) =>
  preparedStatement(database, "SELECT 1 FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, Number(taskId.slice(2))) !== undefined;

const touchTask = (database, repositoryId, taskId) =>
  preparedStatement(database, "UPDATE tasks SET updated_at = ? WHERE repository_id = ? AND number = ?").run(Date.now(), repositoryId, Number(taskId.slice(2)));

function shaped(payload, keys) {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    && Object.keys(payload).length === keys.length && keys.every((key) => Object.hasOwn(payload, key));
}

/**
 * Attaches one image to an existing task. `payload` is `{ taskId, bytes }` and, optionally, `imageId`: the ID the
 * caller already put in the task's text as a marker. It must have the ID shape, and one the task already holds is
 * `conflict`; without it the store makes the ID. The file is written first and
 * the list in one transaction after it; a refused or failed list write removes the file again. Answers
 * `{ ok: true, imageId }` or a fixed error: `invalid` (not one of the four types, empty, or over the size bound),
 * `not_found`, or `limit` (the task already holds the most it may).
 */
export function addTaskImage({ database, transaction, directory, repositoryId, payload }) {
  const named = payload !== null && typeof payload === "object" && Object.hasOwn(payload, "imageId");
  if (!isRepositoryId(repositoryId) || !shaped(payload, named ? ["taskId", "bytes", "imageId"] : ["taskId", "bytes"]) || !isTaskId(payload.taskId)
    || (named && (typeof payload.imageId !== "string" || !IMAGE_ID.test(payload.imageId)))) return { ok: false, error: "invalid" };
  const { taskId, bytes } = payload;
  const type = sniffImageType(bytes);
  if (type === null || bytes.length > TASK_BOUNDS.imageBytes) return { ok: false, error: "invalid" };
  if (!taskExists(database, repositoryId, taskId)) return { ok: false, error: "not_found" };
  const held = readList(database, repositoryId, taskId);
  if (named && held.some((entry) => entry.id === payload.imageId)) return { ok: false, error: "conflict" };
  if (held.length >= TASK_BOUNDS.imagesPerTask) return { ok: false, error: "limit" };
  const image = { id: named ? payload.imageId : `img-${crypto.randomBytes(6).toString("hex")}`, type, bytes: bytes.length };
  const file = imageFile(directory, repositoryId, taskId, image);
  mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.part`;
  try {
    writeFileSync(partial, bytes, { flag: "wx" });
    renameSync(partial, file);
    const result = transaction(() => {
      // The task may have gone, or filled up, since the read above.
      if (!taskExists(database, repositoryId, taskId)) return { ok: false, error: "not_found" };
      const list = readList(database, repositoryId, taskId);
      if (list.some((entry) => entry.id === image.id)) return { ok: false, error: "conflict" };
      if (list.length >= TASK_BOUNDS.imagesPerTask) return { ok: false, error: "limit" };
      writeList(database, repositoryId, taskId, [...list, image]);
      touchTask(database, repositoryId, taskId);
      return { ok: true, imageId: image.id };
    });
    if (!result.ok) rmSync(file, { force: true });
    return result;
  } catch (error) {
    try { rmSync(partial, { force: true }); rmSync(file, { force: true }); } catch { /* left behind, never served */ }
    throw error;
  }
}

function imagePayload(repositoryId, payload) {
  return isRepositoryId(repositoryId) && shaped(payload, ["taskId", "imageId"]) && isTaskId(payload.taskId)
    && typeof payload.imageId === "string" && IMAGE_ID.test(payload.imageId);
}

/** Removes one image from a task: the list first, in one transaction, then the file. `{ ok: true }` or `invalid` / `not_found`. */
export function removeTaskImage({ database, transaction, directory, repositoryId, payload }) {
  if (!imagePayload(repositoryId, payload)) return { ok: false, error: "invalid" };
  const { taskId, imageId } = payload;
  const removed = transaction(() => {
    const list = readList(database, repositoryId, taskId);
    const image = list.find((entry) => entry.id === imageId);
    if (!image || !taskExists(database, repositoryId, taskId)) return null;
    writeList(database, repositoryId, taskId, list.filter((entry) => entry.id !== imageId));
    touchTask(database, repositoryId, taskId);
    return image;
  });
  if (!removed) return { ok: false, error: "not_found" };
  try { rmSync(imageFile(directory, repositoryId, taskId, removed), { force: true }); } catch { /* left behind, never served */ }
  return { ok: true };
}

/** One listed image's bytes: `{ ok: true, type, bytes }`, or `invalid` / `not_found`. A file that no longer matches its listed type or size is `not_found`. */
export function readTaskImage({ database, directory, repositoryId, payload }) {
  if (!imagePayload(repositoryId, payload)) return { ok: false, error: "invalid" };
  const image = readList(database, repositoryId, payload.taskId).find((entry) => entry.id === payload.imageId);
  if (!image) return { ok: false, error: "not_found" };
  let bytes;
  try { bytes = readFileSync(imageFile(directory, repositoryId, payload.taskId, image)); } catch { return { ok: false, error: "not_found" }; }
  return bytes.length === image.bytes && sniffImageType(bytes) === image.type ? { ok: true, type: image.type, bytes } : { ok: false, error: "not_found" };
}

/** A task's listed images whose file exists with its listed size, as `{ id, file }` with the absolute file, in list order, for a session start. */
export function taskImagePaths({ database, directory, repositoryId, taskId }) {
  if (typeof directory !== "string" || !isRepositoryId(repositoryId) || !isTaskId(taskId)) return [];
  const paths = [];
  for (const image of readList(database, repositoryId, taskId)) {
    const file = path.resolve(imageFile(directory, repositoryId, taskId, image));
    try { if (statSync(file).size === image.bytes) paths.push({ id: image.id, file }); } catch { /* a missing file is not handed to a session */ }
  }
  return paths;
}
