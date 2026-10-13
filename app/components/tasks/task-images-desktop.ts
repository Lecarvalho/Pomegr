"use client";

import { TASK_BOUNDS, TASK_IMAGE_TYPES, type TaskImageType } from "../../../shared/task-contract";
import { clientAccessMode } from "../../hooks/ClientAccessContext";
import { getPairedTaskImage, postPairedTaskImageAdd, postPairedTaskImageRemove } from "./task-paired";

// The renderer's only way to a task's images: the desktop bridge, or a paired device's fixed routes.

export type TaskImageError = "invalid" | "not_found" | "limit" | "conflict" | "unavailable";
export type TaskImageResult<Value> = ({ ok: true } & Value) | { ok: false; error: TaskImageError };

type Operation = "add" | "remove" | "read";
type Bridge = { taskImage(repositoryId: string, operation: Operation, payload: Record<string, unknown>): Promise<unknown> };

const ERRORS = new Set<string>(["invalid", "not_found", "limit", "conflict", "unavailable"]);
const MEDIA_TYPES: Record<TaskImageType, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
export const TASK_IMAGE_ACCEPT = TASK_IMAGE_TYPES.map((type) => MEDIA_TYPES[type]).join(",");

function imageBridge(): Bridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as Window & { pomegrDesktop?: Partial<Bridge> }).pomegrDesktop;
  return typeof bridge?.taskImage === "function" ? bridge as Bridge : undefined;
}

const pairedDevice = () => imageBridge() === undefined && clientAccessMode() === "lan";

export function taskImagesAvailable(): boolean {
  return imageBridge() !== undefined || pairedDevice();
}

/** The same operation over the paired device's routes; the answer has the bridge's shape. */
function pairedCall(repositoryId: string, operation: Operation, payload: Record<string, unknown>): Promise<unknown> {
  const { taskId, imageId } = payload as { taskId: string; imageId: string };
  if (operation === "add") return postPairedTaskImageAdd(repositoryId, taskId, imageId, payload.bytes as Uint8Array);
  if (operation === "remove") return postPairedTaskImageRemove(repositoryId, taskId, imageId);
  return getPairedTaskImage(repositoryId, taskId, imageId).then((answer) => (answer.ok ? { ok: true, type: pairedType(answer.type), bytes: answer.bytes } : answer));
}

const pairedType = (mediaType: string | undefined) => TASK_IMAGE_TYPES.find((type) => MEDIA_TYPES[type] === mediaType);

/** One bridge call. */
async function call<Value>(repositoryId: string, operation: Operation, payload: Record<string, unknown>, parse: (answer: Record<string, unknown>) => Value | null): Promise<TaskImageResult<Value>> {
  const bridge = imageBridge();
  if (!bridge && !pairedDevice()) return { ok: false, error: "unavailable" };
  try {
    const answer: unknown = bridge ? await bridge.taskImage(repositoryId, operation, payload) : await pairedCall(repositoryId, operation, payload);
    if (typeof answer === "object" && answer !== null && !Array.isArray(answer)) {
      const record = answer as Record<string, unknown>;
      if (record.ok === true) {
        const value = parse(record);
        if (value !== null) return { ok: true, ...value };
      } else if (typeof record.error === "string" && ERRORS.has(record.error)) return { ok: false, error: record.error as TaskImageError };
    }
  } catch {
  }
  return { ok: false, error: "unavailable" };
}

export function newTaskImageId(): string {
  return `img-${[...crypto.getRandomValues(new Uint8Array(6))].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function addDesktopTaskImage(repositoryId: string, taskId: string, imageId: string, bytes: Uint8Array): Promise<TaskImageResult<{ imageId: string }>> {
  return call(repositoryId, "add", { taskId, imageId, bytes }, (answer) => (answer.imageId === imageId ? { imageId } : null));
}

export function removeDesktopTaskImage(repositoryId: string, taskId: string, imageId: string): Promise<TaskImageResult<object>> {
  return call(repositoryId, "remove", { taskId, imageId }, () => ({}));
}

export function readDesktopTaskImage(repositoryId: string, taskId: string, imageId: string): Promise<TaskImageResult<{ blob: Blob }>> {
  return call(repositoryId, "read", { taskId, imageId }, (answer) => {
    const type = TASK_IMAGE_TYPES.find((candidate) => candidate === answer.type);
    const bytes = answer.bytes;
    if (!type || !(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > TASK_BOUNDS.imageBytes) return null;
    return { blob: new Blob([new Uint8Array(bytes)], { type: MEDIA_TYPES[type] }) };
  });
}

const MEGABYTES = TASK_BOUNDS.imageBytes / (1024 * 1024);
export const TASK_IMAGE_HELPER = `Paste or drop an image into the text, or attach one: it shows where you put it, and Backspace removes it. PNG, JPEG, GIF or WebP; up to ${TASK_BOUNDS.imagesPerTask} images of ${MEGABYTES} MB each.`;
export const TASK_IMAGE_TYPE_MESSAGE = "Only PNG, JPEG, GIF and WebP images can be attached.";
export const TASK_IMAGE_SIZE_MESSAGE = `An image can be at most ${MEGABYTES} MB.`;
export const TASK_IMAGE_LIMIT_MESSAGE = `A task holds at most ${TASK_BOUNDS.imagesPerTask} images.`;
export const TASK_IMAGE_ADD_FAILURE_MESSAGE = "The image could not be attached.";
export const TASK_IMAGE_REMOVE_FAILURE_MESSAGE = "The image could not be removed.";
export const TASK_IMAGE_CREATE_FAILURE_MESSAGE = "The task was created, but an image could not be stored. Put it in again here.";

/** One short fixed message per failed attach. */
export function imageAddFailureMessage(error: TaskImageError): string {
  return error === "invalid" ? TASK_IMAGE_TYPE_MESSAGE : error === "limit" ? TASK_IMAGE_LIMIT_MESSAGE : TASK_IMAGE_ADD_FAILURE_MESSAGE;
}

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

const createFailures = new Set<string>();

export function rememberImageCreateFailure(repositoryId: string, taskId: string): void {
  createFailures.add(`${repositoryId}:${taskId}`);
}

export function takeImageCreateFailure(repositoryId: string, taskId: string): boolean {
  return createFailures.delete(`${repositoryId}:${taskId}`);
}
