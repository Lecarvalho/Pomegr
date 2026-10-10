"use client";

import { TASK_BOUNDS, TASK_IMAGE_TYPES, type TaskImageType } from "../../../shared/task-contract";

// The renderer's only way to a task's images: the desktop preload's `taskImage` bridge (fixed IPC channel
// `pomegr:task-image`). Image bytes are user-authored content: they are held in renderer memory only while a modal
// shows them, and never in browser storage, a URL that leaves the page, or a request. A plain browser has no bridge.

export type TaskImageError = "invalid" | "not_found" | "limit" | "conflict" | "unavailable";
export type TaskImageResult<Value> = ({ ok: true } & Value) | { ok: false; error: TaskImageError };

type Operation = "add" | "remove" | "read";
type Bridge = { taskImage(repositoryId: string, operation: Operation, payload: Record<string, unknown>): Promise<unknown> };

const IMAGE_ID = /^img-[0-9a-f]{12}$/u;
const ERRORS = new Set<string>(["invalid", "not_found", "limit", "conflict", "unavailable"]);
const MEDIA_TYPES: Record<TaskImageType, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** The file types the Attach image picker offers; the monitor still decides the type from the bytes. */
export const TASK_IMAGE_ACCEPT = TASK_IMAGE_TYPES.map((type) => MEDIA_TYPES[type]).join(",");

function imageBridge(): Bridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as Window & { pomegrDesktop?: Partial<Bridge> }).pomegrDesktop;
  return typeof bridge?.taskImage === "function" ? bridge as Bridge : undefined;
}

/** False in a browser and on a desktop build from before the bridge: images are then not offered. */
export function taskImagesAvailable(): boolean {
  return imageBridge() !== undefined;
}

/** One bridge call. Never throws: a missing bridge, an IPC failure and an unreadable answer are all `unavailable`. */
async function call<Value>(repositoryId: string, operation: Operation, payload: Record<string, unknown>, parse: (answer: Record<string, unknown>) => Value | null): Promise<TaskImageResult<Value>> {
  const bridge = imageBridge();
  if (!bridge) return { ok: false, error: "unavailable" };
  try {
    const answer: unknown = await bridge.taskImage(repositoryId, operation, payload);
    if (typeof answer === "object" && answer !== null && !Array.isArray(answer)) {
      const record = answer as Record<string, unknown>;
      if (record.ok === true) {
        const value = parse(record);
        if (value !== null) return { ok: true, ...value };
      } else if (typeof record.error === "string" && ERRORS.has(record.error)) return { ok: false, error: record.error as TaskImageError };
    }
  } catch {
    // Falls through to the fixed unavailable result.
  }
  return { ok: false, error: "unavailable" };
}

/** Attaches one image to an existing task. The monitor refuses anything that is not one of the four formats. */
export function addDesktopTaskImage(repositoryId: string, taskId: string, bytes: Uint8Array): Promise<TaskImageResult<{ imageId: string }>> {
  return call(repositoryId, "add", { taskId, bytes }, (answer) => (typeof answer.imageId === "string" && IMAGE_ID.test(answer.imageId) ? { imageId: answer.imageId } : null));
}

export function removeDesktopTaskImage(repositoryId: string, taskId: string, imageId: string): Promise<TaskImageResult<object>> {
  return call(repositoryId, "remove", { taskId, imageId }, () => ({}));
}

/** One image as a Blob of its fixed media type, to draw from an object URL. */
export function readDesktopTaskImage(repositoryId: string, taskId: string, imageId: string): Promise<TaskImageResult<{ blob: Blob }>> {
  return call(repositoryId, "read", { taskId, imageId }, (answer) => {
    const type = TASK_IMAGE_TYPES.find((candidate) => candidate === answer.type);
    const bytes = answer.bytes;
    if (!type || !(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > TASK_BOUNDS.imageBytes) return null;
    return { blob: new Blob([new Uint8Array(bytes)], { type: MEDIA_TYPES[type] }) };
  });
}

const MEGABYTES = TASK_BOUNDS.imageBytes / (1024 * 1024);
export const TASK_IMAGE_HELPER = `Paste an image into the task, or attach one. PNG, JPEG, GIF or WebP; up to ${TASK_BOUNDS.imagesPerTask} images of ${MEGABYTES} MB each. A session gets the images the task holds when it starts.`;
export const TASK_IMAGE_TYPE_MESSAGE = "Only PNG, JPEG, GIF and WebP images can be attached.";
export const TASK_IMAGE_SIZE_MESSAGE = `An image can be at most ${MEGABYTES} MB.`;
export const TASK_IMAGE_LIMIT_MESSAGE = `A task holds at most ${TASK_BOUNDS.imagesPerTask} images.`;
export const TASK_IMAGE_ADD_FAILURE_MESSAGE = "The image could not be attached.";
export const TASK_IMAGE_REMOVE_FAILURE_MESSAGE = "The image could not be removed.";
export const TASK_IMAGE_CREATE_FAILURE_MESSAGE = "The task was created, but an image could not be attached. Attach it again here.";

/** One short fixed message per failed attach; the monitor's own wording never reaches the modal. */
export function imageAddFailureMessage(error: TaskImageError): string {
  return error === "invalid" ? TASK_IMAGE_TYPE_MESSAGE : error === "limit" ? TASK_IMAGE_LIMIT_MESSAGE : TASK_IMAGE_ADD_FAILURE_MESSAGE;
}

/**
 * The files of one paste or pick that may be attached, given how many images the task already holds: an image of an
 * offered type, within the size bound, up to the per-task bound. `message` names the first reason a file was left out.
 */
export function acceptImageFiles(files: readonly File[], held: number): { accepted: File[]; message: string | null } {
  const accepted: File[] = [];
  let message: string | null = null;
  for (const file of files) {
    const reason = !TASK_IMAGE_ACCEPT.split(",").includes(file.type) ? TASK_IMAGE_TYPE_MESSAGE
      : file.size === 0 || file.size > TASK_BOUNDS.imageBytes ? TASK_IMAGE_SIZE_MESSAGE
        : held + accepted.length >= TASK_BOUNDS.imagesPerTask ? TASK_IMAGE_LIMIT_MESSAGE : null;
    if (reason === null) accepted.push(file);
    else message ??= reason;
  }
  return { accepted, message };
}

// The tasks whose New task form could not attach every image, so the task's own modal can say so once. Renderer memory
// only, and it holds no image and no task text.
const createFailures = new Set<string>();

export function rememberImageCreateFailure(repositoryId: string, taskId: string): void {
  createFailures.add(`${repositoryId}:${taskId}`);
}

/** True once for a task whose New task form left an image behind. */
export function takeImageCreateFailure(repositoryId: string, taskId: string): boolean {
  return createFailures.delete(`${repositoryId}:${taskId}`);
}
